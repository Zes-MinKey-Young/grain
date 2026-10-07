// 这个包标了 `__esModule` 却没有 default 导出，所以只能具名导入：
// 默认导入在 CJS 下拿到的是 undefined（扩展就是 CJS 编译的）
import { simpleTraverse } from '@typescript-eslint/typescript-estree';
import type { TSESTree } from '@typescript-eslint/typescript-estree';

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// npm 上的 typescript 是 CommonJS：ESM 里具名导入它，Node 认不出具名导出
// （打包工具会替我们转换，但发布出去的 dist 是直接被 Node 加载的）
import ts from 'typescript';

const { transpileModule, ModuleKind, ScriptTarget } = ts;

import { ParseError } from './errors.js';
import { parse_snippet } from './read/expression.js';
import type {
    AttributeValue,
    BindingValue,
    Element,
    Expression,
    MacroReplacement,
    MacroUse,
    RawAttributeValue,
    RawBindingValue,
    RawExpression,
    Root,
    Script,
    TemplateNode
} from './types.js';

/**
 * 把展开出来的文本重新读一遍。
 *
 * 由 parser 注入：读绑定值 / 属性值需要一个 Parser 实例，而 parser 又要调
 * `expand_macros` —— 这边直接 import 它就成了循环依赖，源码下能跑，
 * 但打成一个 bundle（扩展就是这么发布的）时初始化顺序会塌。
 */
export interface MacroReparse {
    binding: (text: string, filename?: string) => RawBindingValue;
    attribute: (text: string, filename?: string) => RawAttributeValue;
    /**
     * 属性值 / 模板插值的位置：可能是绑定值（`listen: ...`），也可能是普通表达式。
     * 宏展开出来的东西两种都有可能，所以交给它判断。
     */
    value: (text: string, filename?: string) => RawAttributeValue;
}

/** 绑定值里的键，顺序跟 `read_binding_value` 认的一致 */
const BINDING_KEYS = ['expression', 'get', 'set', 'listen'] as const;

/**
 * 内置 runes。
 *
 * 宏跟它们长得像（都带 `$`），但不是一回事：runes 由编译器自己处理
 * （`$state` 展开成读写对、`$props()` 换成参数），宏只是**展开**成别的语法，
 * 而且跑得更早。名字不能撞。
 */
const BUILT_IN_RUNES = new Set(['$state', '$props', '$bindable']);

/**
 * 内置宏：不用在 `<script macro>` 里定义，也不用 import。
 *
 * 参数跟用户宏一样，拿不到值，拿到的是那段表达式的**源码文本**。
 */
const BUILT_IN_MACROS: Record<string, (...args: unknown[]) => string> = {
    /**
     * `$store(counter)`：把跨模块的 writable 接成一个绑定。
     *
     * `subscribe` 会立刻用当前值调一次 update，所以不需要 `get`——
     * 值由 listener 提供（正是"没有 getter 的绑定"那条规则）。
     */
    $store(source: unknown) {
        const store = String(source ?? '').trim();

        if (!store) throw new Error('`$store` needs a writable, for example `$store(counter)`');

        return `listen: (update) => (${store}).subscribe(update), set: (v) => (${store}).set(v)`;
    },

    /**
     * `$read(counter)`：单向——只订阅，不写回。
     *
     * 用在**普通属性**和**模板插值**上（`bind:` 用 `$store`）。
     * 没有 `get` 时值由 subscribe 推（它立刻回调当前值）；
     * 也可以自己给值：`title={counter.get(), $read(counter)}`。
     */
    $read(source: unknown) {
        const store = String(source ?? '').trim();

        if (!store) throw new Error('`$read` needs a writable, for example `$read(counter)`');

        return `listen: (update) => (${store}).subscribe(update)`;
    }
};

/** 宏名（或导入进来的本地名）必须是 `$` 开头，且不能是内置 rune */
function check_macro_name(name: string, start: number, end: number): void {
    if (!name.startsWith('$')) {
        throw new ParseError(
            `A macro must be named with a \`$\` prefix, like the runes — \`${name}\` is not`,
            start,
            end
        );
    }

    if (BUILT_IN_RUNES.has(name)) {
        throw new ParseError(`\`${name}\` is a built-in rune — a macro cannot reuse its name`, start, end);
    }

    if (name in BUILT_IN_MACROS) {
        throw new ParseError(`\`${name}\` is a built-in macro — pick another name`, start, end);
    }
}

// ---------------------------------------------------------------- 模块加载

/** `./macros` -> 实际文件（补扩展名） */
function resolve_module(from: string, specifier: string): string {
    const target = resolve(dirname(from), specifier);

    if (existsSync(target) && statSync(target).isFile()) return target;

    for (const extension of ['.ts', '.mts', '.js', '.mjs']) {
        if (existsSync(target + extension)) return target + extension;
    }

    throw new Error(`Cannot find \`${specifier}\`, imported from ${from}`);
}

/**
 * 编译期跑一个外部模块。
 *
 * 转 CommonJS 之后用 `new Function` 跑，拿到它的 exports——宏脚本只能 import
 * 相对路径，所以这条链是封闭的：不会碰到 node_modules，也不会有原生模块。
 */
function run_module(path: string, cache: Map<string, unknown>): unknown {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;

    const js = transpileModule(readFileSync(path, 'utf8'), {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
    }).outputText;

    const module: { exports: Record<string, unknown> } = { exports: {} };

    cache.set(path, module.exports);

    const require = (specifier: string): unknown => {
        if (!specifier.startsWith('.')) {
            throw new Error(`\`${specifier}\` is not a relative path — macros can only import relative files`);
        }

        return run_module(resolve_module(path, specifier), cache);
    };

    try {
        new Function('require', 'exports', 'module', js)(require, module.exports, module);
    } catch (error) {
        throw new Error(`Failed to run \`${path}\`: ${error instanceof Error ? error.message : String(error)}`);
    }

    cache.set(path, module.exports);

    return module.exports;
}

// ---------------------------------------------------------------- 宏作用域

/**
 * `<script macro>` 里定义的编译期函数。
 *
 * 宏在**编译时**跑：它返回一段要插进去的源码，例如
 * `['get', ':', '() => name', ',', 'set', ':', '(v) => name = v']`
 * （也可以直接给一个字符串），编译器按周围的语法重新解析它——
 * 于是宏能生成绑定值、属性值，也能生成 `<script>` 里的表达式。
 *
 * 宏脚本不会出现在产物里。
 */
export class MacroScope {
    /** 可用的宏名（本机定义的 + import 进来的） */
    private readonly names: string[] = [];
    /** `import ... from './x'` 转出来的取用代码 */
    private readonly imports: string[] = [];
    /** import 语句在脚本里的区间，跑之前要抹掉 */
    private readonly holes: Array<[number, number]> = [];
    private readonly functions: Record<string, (...args: unknown[]) => unknown> = {};
    /** script 内容在整份源码里的起点：AST 的 range 是绝对的，raw 是相对的 */
    private readonly offset: number;

    constructor(
        private readonly block: Script | null,
        private readonly filename?: string
    ) {
        this.offset = block?.contentStart ?? 0;

        if (!block) return;

        this.collect(block);

        if (this.names.length === 0) return;

        this.functions = this.run(block);
    }

    /** 可用的宏：内置的那几个总在，加上自己定义的 */
    get size(): number {
        return this.names.length + Object.keys(BUILT_IN_MACROS).length;
    }

    has(name: string): boolean {
        return name in BUILT_IN_MACROS || Object.prototype.hasOwnProperty.call(this.functions, name);
    }

    /**
     * 跑一次宏，拿回要插进去的那段源码。
     *
     * 返回值可以是一段字符串，也可以是字符串数组（按空格拼起来——数组只是分行写着
     * 方便，拼完跟直接给一个字符串没有区别）。
     *
     * 注意这不是词法意义上的 token 流：每一段都是**任意代码**，编译器把它整段
     * 交给对应位置的语法去解析，不是自己分词。
     */
    call(name: string, args: unknown[], start: number, end: number): string {
        const built_in = BUILT_IN_MACROS[name];

        if (built_in) {
            try {
                return built_in(...args);
            } catch (error) {
                throw new ParseError(
                    `The macro \`${name}\`: ${error instanceof Error ? error.message : String(error)}`,
                    start,
                    end
                );
            }
        }

        const macro = this.functions[name];

        let result: unknown;

        try {
            result = macro(...args);
        } catch (error) {
            throw new ParseError(
                `The macro \`${name}\` threw while running: ${error instanceof Error ? error.message : String(error)}`,
                start,
                end
            );
        }

        if (typeof result === 'string') return result;

        if (Array.isArray(result) && result.every((piece) => typeof piece === 'string')) {
            return result.join(' ');
        }

        throw new ParseError(
            `The macro \`${name}\` must return a string (or an array of strings) — the code to splice in, got ${describe(result)}`,
            start,
            end
        );
    }

    /** 收集顶层定义的宏，顺手把 import 转成"取用代码" */
    private collect(block: Script): void {
        // AST 的 range 已经是整份源码的绝对偏移（parse_script 用 masked 前缀换来的）
        const at = (node: { range: [number, number] }): [number, number] => [node.range[0], node.range[1]];

        for (const node of block.content.body) {
            if (node.type === 'FunctionDeclaration') {
                if (!node.id) continue;

                check_macro_name(node.id.name, ...at(node));
                this.names.push(node.id.name);

                continue;
            }

            if (node.type === 'VariableDeclaration') {
                for (const item of node.declarations) {
                    const init = item.init;
                    const callable =
                        init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression';

                    if (item.id.type !== 'Identifier' || !callable) continue;

                    check_macro_name(item.id.name, ...at(node));
                    this.names.push(item.id.name);
                }

                continue;
            }

            if (node.type === 'ImportDeclaration') {
                this.read_import(node, at(node));

                continue;
            }

            if (node.type.startsWith('Export')) {
                throw new ParseError(
                    '`<script macro>` is not a module — it cannot export (it never reaches the output)',
                    ...at(node)
                );
            }
        }
    }

    /**
     * 一条 import。
     *
     * 只允许相对路径（node_modules 里的东西编译期没法保证能跑），
     * 而且**本地名必须带 `$`**——跟 runes 一致，一眼能看出是编译期的东西。
     */
    private read_import(node: TSESTree.ImportDeclaration, [start, end]: [number, number]): void {
        const source = node.source.value;

        if (typeof source !== 'string' || !source.startsWith('.')) {
            throw new ParseError(
                `Macros can only import relative paths — \`${String(source)}\` is not one (it runs at compile time, so packages from node_modules are not available)`,
                start,
                end
            );
        }

        for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportNamespaceSpecifier') {
                throw new ParseError(
                    'A macro import cannot use a namespace — import the macro by name and rename it with a `$` prefix',
                    start,
                    end
                );
            }

            const local = specifier.local.name;

            check_macro_name(local, start, end);

            const imported =
                specifier.type === 'ImportDefaultSpecifier'
                    ? 'default'
                    : specifier.imported.type === 'Identifier'
                      ? specifier.imported.name
                      : String(specifier.imported.value);

            this.names.push(local);
            this.imports.push(`const ${local} = __require(${JSON.stringify(source)})[${JSON.stringify(imported)}];`);
        }

        // 扣代码用的是 raw（相对 script 内容），所以换算回去
        this.holes.push([node.range[0] - this.offset, node.range[1] - this.offset]);
    }

    /** 抹掉 import、转 CommonJS 之外什么都不做，跑一遍拿到那些函数 */
    private run(block: Script): Record<string, (...args: unknown[]) => unknown> {
        const raw = block.raw;

        let code = raw;

        // import 语句按区间扣掉（留空格，偏移不变）
        for (const [from, to] of this.holes) {
            code = code.slice(0, from) + ' '.repeat(to - from) + code.slice(to);
        }

        if (this.imports.length > 0 && !this.filename) {
            throw new ParseError(
                'A macro script that imports needs the component filename to resolve the path against',
                block.contentStart,
                block.contentEnd
            );
        }

        // 宏脚本是 TS（可以写类型标注），得先转译成 JS 才能交给 new Function
        const js = transpileModule(code, {
            compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext }
        }).outputText;

        const body = `${js}\n${this.imports.join('\n')}\n;return { ${this.names.join(', ')} };`;
        const cache = new Map<string, unknown>();

        const require = (specifier: string): unknown => {
            if (!specifier.startsWith('.')) {
                throw new Error(`\`${specifier}\` is not a relative path — macros can only import relative files`);
            }

            return run_module(resolve_module(this.filename as string, specifier), cache);
        };

        try {
            return new Function('__require', body)(require) as Record<string, (...args: unknown[]) => unknown>;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            throw new ParseError(
                `Failed to run \`<script macro>\`: ${message}`,
                block.contentStart,
                block.contentEnd
            );
        }
    }
}

function describe(value: unknown): string {
    if (Array.isArray(value)) return 'an array with non-string entries';
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    const type = typeof value;

    return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
}

/**
 * 宏的实参在编译期求值：
 *
 * 字面量（`'tick'` / `3` / `true`）求成真正的值，求不出来的（运行时才有值的表达式）
 * 给它的**源码文本**——宏拿到的是字符串，想怎么用都行。
 */
function argument_value(node: TSESTree.Node, source: string): unknown {
    if (node.type === 'Literal') return node.value;

    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis[0]?.value.cooked ?? '';
    }

    if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
        const inner = Number(argument_value(node.argument, source));

        return node.operator === '-' ? -inner : inner;
    }

    return source.slice(node.range[0], node.range[1]);
}

// ---------------------------------------------------------------- 展开

/** 展开出来的片段落在源码末尾的追加区，range 指向那儿（详见 `expanded`） */
interface Placement {
    place: (text: string) => { contentStart: number; contentEnd: number };
}

/**
 * 把展开的片段原文登记到追加区，并解析成表达式。
 *
 * 解析失败时错误要落回**宏调用上**：片段的位置在源码末尾的追加区里，
 * 直接用会勾到文件末尾去，看着像别处的错。
 */
function expression_from_raw(
    item: RawExpression,
    at: { start: number; end: number },
    placement: Placement,
    label: string
): Expression {
    const wrapped = item.raw.trimStart().startsWith('{');
    const stored = wrapped ? `(${item.raw})` : item.raw;
    const range = placement.place(stored);

    let content: Expression['content'];

    try {
        // 前缀空白：解析出来的 range 从 contentStart 起算，正好落在追加区
        content = parse_snippet({ ...item, ...range }, ' '.repeat(range.contentStart), label);
    } catch (error) {
        // 只重新定位：parse_snippet 的消息里已经说了是哪个宏的哪一项
        throw new ParseError(error instanceof Error ? error.message : String(error), at.start, at.end);
    }

    return {
        type: 'expression',
        raw: item.raw,
        start: at.start,
        end: at.end,
        ...range,
        content
    };
}

/**
 * 把宏返回的源码重新解析成一个绑定值。
 *
 * 那段源码就是 `bind:` 那套语法（`get: ..., set: ...`），所以直接交给
 * `read_binding_value` 读；读出来的各项再用 TS 解析一遍。
 */
function binding_from_text(
    text: string,
    name: string,
    at: { start: number; end: number },
    placement: Placement,
    reparse: MacroReparse,
    filename?: string
): BindingValue {
    let raw: RawBindingValue;

    try {
        raw = reparse.binding(text, filename);
    } catch (error) {
        throw new ParseError(
            `The macro \`${name}\` did not produce a binding value: ${error instanceof Error ? error.message : String(error)}`,
            at.start,
            at.end
        );
    }

    const binding: BindingValue = {
        start: at.start,
        end: at.end,
        expression: null,
        get: null,
        set: null,
        listen: null,
        active: raw.active
    };

    for (const key of BINDING_KEYS) {
        const item = raw[key] as RawExpression | null;
        if (!item) continue;

        binding[key] = expression_from_raw(item, at, placement, `The \`${key}\` from the macro \`${name}\``);
    }

    return binding;
}

/**
 * 把宏返回的源码解析成一个属性值。
 *
 * 属性值可能是纯文本、单个表达式、或者"文本 + 表达式"的混合，所以按属性值的
 * 语法读一遍。宏给的东西里没有花括号时（比如 `() => count++`）当成
 * 单个表达式，自动补上花括号——否则会被读成一段字面文本。
 */
/**
 * 属性值 / 模板插值的位置：宏给回来的可能是绑定值（`listen: ...`），也可能是普通表达式。
 *
 * 单向属性（`title={$read(store)}`）和模板插值（`{$read(store)}`）走这里——
 * 它们只往元素上推，不往回写。
 */
/** 把重新读出来的值解析成最终形式（表达式 / 绑定值都要过一遍 TS） */
function realize_value(
    raw: RawAttributeValue,
    name: string,
    at: { start: number; end: number },
    placement: Placement
): AttributeValue {
    if (typeof raw === 'string') return raw;

    if (Array.isArray(raw)) {
        return raw.map((chunk) => {
            if (typeof chunk === 'string') return chunk;

            // 绑定值只能独占一个位置，跟文本混在一起没法表达
            if (!('type' in chunk)) {
                throw new ParseError(
                    `A binding value cannot be mixed with text — use it as the whole value`,
                    at.start,
                    at.end
                );
            }

            return expression_from_raw(chunk, at, placement, `A chunk from the macro \`${name}\``);
        });
    }

    // 绑定值：`get` / `set` / `listen` 各自解析
    if (!('type' in raw)) {
        const source = raw as RawBindingValue;

        const binding: BindingValue = {
            start: at.start,
            end: at.end,
            expression: null,
            get: null,
            set: null,
            listen: null,
            active: source.active
        };

        for (const key of BINDING_KEYS) {
            const item = source[key] as RawExpression | null;
            if (!item) continue;

            binding[key] = expression_from_raw(item, at, placement, `The \`${key}\` from the macro \`${name}\``);
        }

        return binding;
    }

    return expression_from_raw(raw as RawExpression, at, placement, `The result of the macro \`${name}\``);
}

function value_from_text(
    text: string,
    name: string,
    at: { start: number; end: number },
    placement: Placement,
    reparse: MacroReparse,
    filename?: string
): AttributeValue {
    let raw: RawAttributeValue;

    try {
        raw = reparse.value(text, filename);
    } catch (error) {
        throw new ParseError(
            `The macro \`${name}\` did not produce a value: ${error instanceof Error ? error.message : String(error)}`,
            at.start,
            at.end
        );
    }

    return realize_value(raw, name, at, placement);
}

/** 绑定值没有 `type` 字段，表达式有 */
function is_binding(value: AttributeValue | true): value is BindingValue {
    return typeof value === 'object' && value !== null && !('type' in value);
}

function macro_call(node: TSESTree.Node | null, scope: MacroScope): TSESTree.CallExpression | null {
    if (!node || node.type !== 'CallExpression') return null;

    const callee = node.callee;

    if (callee.type !== 'Identifier' || !scope.has(callee.name)) return null;

    return node;
}

function call_arguments(call: TSESTree.CallExpression, source: string, start: number, end: number): unknown[] {
    const args: unknown[] = [];

    for (const argument of call.arguments) {
        if (argument.type === 'SpreadElement') {
            throw new ParseError('Macros do not take spread arguments', start, end);
        }

        args.push(argument_value(argument, source));
    }

    return args;
}

/**
 * 展开 `<script>` / `<script module>` / `<script onmount>` 里的宏调用。
 *
 * 宏在这儿展开成**表达式**：`const bump = $handler(count)` 里的调用会被换成
 * 宏返回的 token 拼出来的那段代码。所以遍历 AST，找到宏调用就整个替换掉。
 */
function expand_script(
    block: Script,
    scope: MacroScope,
    source: string,
    placement: Placement,
    replacements: MacroReplacement[],
    macros: MacroUse[]
): void {
    const expand = (call: TSESTree.CallExpression): TSESTree.Expression => {
        const name = (call.callee as TSESTree.Identifier).name;
        const [start, end] = call.range;
        const args = call_arguments(call, source, start, end);
        const text = scope.call(name, args, start, end);

        const item: RawExpression = {
            type: 'expression',
            raw: text,
            start,
            end,
            contentStart: 0,
            contentEnd: 0
        };

        // script 是按区间切原文的，所以除了换 AST 节点，还要登记一段替换
        replacements.push({ start, end, text: item.raw });
        macros.push({ name, start, end, text: item.raw, where: 'script' });

        return expression_from_raw(item, { start, end }, placement, `the result of the macro \`${name}\``).content;
    };

    const visit = (node: unknown): unknown => {
        if (!node || typeof node !== 'object') return node;

        if (Array.isArray(node)) {
            for (let index = 0; index < node.length; index += 1) node[index] = visit(node[index]);

            return node;
        }

        const current = node as Record<string, unknown>;

        if (typeof current.type === 'string') {
            const call = macro_call(node as TSESTree.Node, scope);

            if (call) return expand(call);
        }

        for (const key of Object.keys(current)) {
            if (key === 'loc' || key === 'range' || key === 'parent') continue;

            const value = current[key];

            if (value && typeof value === 'object') current[key] = visit(value);
        }

        return node;
    };

    visit(block.content.body);
}

/**
 * 展开模板与 script 里的宏调用。
 *
 * 三种地方能用宏：
 * - `bind:` —— 按绑定值的语法读
 * - 一般属性 —— 按属性值的语法读
 * - `<script>` 里 —— 展开成表达式
 *
 * 模板里的 `{ ... }`（文本插值）不在此列：宏名出现在那里是错误——它只在编译期
 * 存在，与其等运行到那儿 ReferenceError，不如编译期就报出来。
 */
export function expand_macros(
    root: Root,
    source: string,
    filename: string | undefined,
    reparse: MacroReparse
): { appended: string; replacements: MacroReplacement[]; macros: MacroUse[] } {
    const scope = new MacroScope(root.macro, filename);

    const macros: MacroUse[] = [];

    if (scope.size === 0) return { appended: '', replacements: [], macros };

    let appended = '';
    const base = source.length + 1;

    function place(text: string): { contentStart: number; contentEnd: number } {
        const contentStart = base + appended.length;

        appended += `${text}\n`;

        return { contentStart, contentEnd: contentStart + text.length };
    }

    const placement: Placement = { place };

    function reject(node: TSESTree.Node | null, start: number, end: number): void {
        if (!node) return;

        simpleTraverse(node, {
            enter: (child) => {
                if (child.type === 'Identifier' && scope.has(child.name)) {
                    throw new ParseError(
                        `\`${child.name}\` is a macro — it only exists at compile time, and it can only be used as a \`bind:\` value, an attribute value, or inside \`<script>\``,
                        start,
                        end
                    );
                }
            }
        });
    }

    function visit_value(node: Element, key: string, value: AttributeValue | true): void {
        if (value === true || typeof value === 'string') return;

        // 混合值（文本 + 表达式）：宏调用可以展开成表达式；展开成绑定值就不行了
        // —— 那得是整个值才表达得了
        if (Array.isArray(value)) {
            for (let at = 0; at < value.length; at += 1) {
                const chunk = value[at];

                if (typeof chunk === 'string' || !('type' in chunk)) continue;

                const expression = chunk as Expression;
                const call = macro_call(expression.content, scope);

                if (!call) {
                    reject(expression.content, expression.start, expression.end);

                    continue;
                }

                const name = (call.callee as TSESTree.Identifier).name;
                const args = call_arguments(call, source, expression.start, expression.end);
                const text = scope.call(name, args, expression.start, expression.end);
                const expanded = value_from_text(
                    text,
                    name,
                    { start: expression.start, end: expression.end },
                    placement,
                    reparse,
                    filename
                );

                macros.push({ name, start: expression.start, end: expression.end, text, where: 'attribute' });

                if (typeof expanded === 'string' || 'type' in expanded) {
                    value[at] = expanded as string | Expression;

                    continue;
                }

                throw new ParseError(
                    `The macro \`${name}\` expands to a binding value, which cannot be mixed with text — use it as the whole value`,
                    expression.start,
                    expression.end
                );
            }

            return;
        }

        const expression = value as Expression;
        const at = { start: expression.start, end: expression.end };

        if (is_binding(value)) {
            const binding = value as BindingValue;
            const target = binding.expression;

            // 绑定值里只有"整个值就是一个宏调用"这一种用法
            const call = target ? macro_call(target.content, scope) : null;

            if (!target || !call) {
                if (target?.content) reject(target.content, at.start, at.end);

                return;
            }

            const name = (call.callee as TSESTree.Identifier).name;
            const args = call_arguments(call, source, at.start, at.end);
            const text = scope.call(name, args, at.start, at.end);

            macros.push({ name, start: at.start, end: at.end, text, where: 'bind' });

            node.attributes[key] = binding_from_text(text, name, at, placement, reparse, filename);

            return;
        }

        const call = macro_call(expression.content, scope);

        if (!call) {
            reject(expression.content, at.start, at.end);

            return;
        }

        const name = (call.callee as TSESTree.Identifier).name;
        const args = call_arguments(call, source, at.start, at.end);
        const text = scope.call(name, args, at.start, at.end);

        macros.push({ name, start: at.start, end: at.end, text, where: 'attribute' });

        node.attributes[key] = value_from_text(text, name, at, placement, reparse, filename);
    }

    function visit(nodes: TemplateNode[]): void {
        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];

            // 绑定值节点（`{ get: ..., listen: ... }`）：已经是展开的结果，不用管
            if (!('type' in node)) continue;

            switch (node.type) {
                case 'element':
                    for (const [key, value] of Object.entries(node.attributes)) visit_value(node, key, value);
                    visit(node.children);
                    break;

                case 'expression': {
                    // 模板插值：整个插值是一个宏调用时可以展开（`{$read(store)}`）
                    const call = macro_call(node.content, scope);

                    if (!call) {
                        reject(node.content, node.start, node.end);

                        break;
                    }

                    const name = (call.callee as TSESTree.Identifier).name;
                    const at = { start: node.start, end: node.end };
                    const args = call_arguments(call, source, at.start, at.end);
                    const text = scope.call(name, args, at.start, at.end);

                    macros.push({ name, start: at.start, end: at.end, text, where: 'attribute' });

                    const expanded = value_from_text(text, name, at, placement, reparse, filename);

                    if (typeof expanded === 'string') {
                        throw new ParseError(
                            `The macro \`${name}\` cannot expand to plain text in a template interpolation`,
                            at.start,
                            at.end
                        );
                    }

                    nodes[index] = expanded as TemplateNode;

                    break;
                }

                case 'IfBlock':
                    reject(node.test.content, node.test.start, node.test.end);
                    visit(node.children);
                    for (const alternate of node.alternates) {
                        if (alternate.test) reject(alternate.test.content, alternate.test.start, alternate.test.end);
                        visit(alternate.children);
                    }
                    break;

                case 'ForBlock':
                    reject(node.content, node.start, node.end);
                    visit(node.children);
                    if (node.fallback) visit(node.fallback.children);
                    break;
            }
        }
    }

    const replacements: MacroReplacement[] = [];

    for (const block of [root.script, root.module, root.onmount]) {
        if (block) expand_script(block, scope, source, placement, replacements, macros);
    }

    visit(root.template.children);

    replacements.sort((left, right) => left.start - right.start);
    macros.sort((left, right) => left.start - right.start);

    return { appended, replacements, macros };
}
