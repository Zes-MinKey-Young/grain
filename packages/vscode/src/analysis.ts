import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { compile, parse, parse_root, split_for_header, ParseError } from '../../compiler/index.js';
import type { Expression, Root, RootStage, Script, TemplateNode } from '../../compiler/index.js';
import { log } from './log.js';
import {
    build_virtual,
    typescript_service,
    virtual_name,
    type CompletionDetail,
    type CompletionEntry,
    type QuickInfo,
    type SemanticProblem,
    type SemanticSpan,
    type VirtualScript
} from './typescript.js';
import { walk } from './ast-utils.js';

export interface Declaration {
    name: string;
    /** 声明在源文本里的区间 */
    start: number;
    end: number;
    /** 声明源码，悬停时显示 */
    detail: string;
    kind: 'variable' | 'function';
}

/** `$props<{...}>()` 里的一个属性 */
export interface ComponentProp {
    name: string;
    /** 类型源码，如 `string` / `() => unknown` */
    type: string;
    optional: boolean;
    /** 子组件里用 `$bindable()` 声明过，可以双向绑定 */
    bindable: boolean;
}

/** 模板里的一个元素。属性没有位置信息，靠重新扫描标签头部得到 */
export interface ElementInfo {
    name: string;
    /** `<` 的位置 */
    start: number;
    /** 标签名结束的位置 */
    name_end: number;
    /** 元素结束的位置 */
    end: number;
}

export interface Analysis {
    root: Root | null;
    error: ParseError | null;
    /** script（含 module）顶层的声明，补全用 */
    declarations: Map<string, Declaration>;
    /** 所有层级的声明（含函数内部），script 里 hover / 跳转用 */
    all: Map<string, Declaration>;
    /** 找出覆盖某个偏移的模板表达式（要拿它的 TS AST 时才用得到） */
    expression_at(offset: number): Expression | null;
    /** 找出覆盖某个偏移的 script（模板之外、script 内容之内） */
    script_at(offset: number): Script | null;
    /** 找出覆盖某个偏移的元素（模板里） */
    element_at(offset: number): ElementInfo | null;
    /** 导入的某个组件接受哪些属性（来自它自己的 `$props<...>()`） */
    component_props(name: string): ComponentProp[];
    /** 语义高亮用：TS 给的符号分类（类名 / 接口 / 参数 …） */
    classifications(): SemanticSpan[];
    /** script 里的补全（模板里返回空） */
    completions(offset: number): CompletionEntry[];
    /** 补全项的签名和文档 */
    completion_detail(offset: number, name: string): CompletionDetail | null;
    /** TypeScript 语言服务给的悬停信息（带类型），只在 script 区域里有效 */
    quick_info(offset: number): QuickInfo | null;
    /** TypeScript 的语义诊断（类型错误、未定义变量等） */
    semantic(): SemanticProblem[];
    /** 后台预热 TS 语言服务（加载它比较重，别放在第一次 hover 时才做） */
    warmup(): void;
    /** 编译产物（命令用） */
    compiled(): { js: string; css: string } | null;
    /** 文档关闭时把虚拟文件从语言服务里摘掉 */
    dispose(): void;
}

function collect_declarations(source: string, script: Script | null): Map<string, Declaration> {
    const declarations = new Map<string, Declaration>();
    if (!script) return declarations;

    for (const statement of script.content.body) {
        // `export const title = ...` 外面包了一层 ExportNamedDeclaration
        const target = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (!target) continue;

        if (target.type === 'VariableDeclaration') {
            for (const declarator of target.declarations) {
                if (declarator.id.type !== 'Identifier') continue;

                const [start, end] = target.range;

                declarations.set(declarator.id.name, {
                    name: declarator.id.name,
                    start,
                    end,
                    detail: source.slice(start, end),
                    kind: 'variable'
                });
            }
        } else if (target.type === 'FunctionDeclaration' && target.id) {
            const [start, end] = target.range;

            declarations.set(target.id.name, {
                name: target.id.name,
                start,
                end,
                detail: source.slice(start, end),
                kind: 'function'
            });
        }
    }

    return declarations;
}

/** 递归收集所有层级的声明，同名时保留最靠前的那个 */
function collect_all(source: string, script: Script | null): Map<string, Declaration> {
    const declarations = new Map<string, Declaration>();
    if (!script) return declarations;

    const add = (name: string, start: number, end: number, kind: Declaration['kind']) => {
        if (!declarations.has(name)) {
            declarations.set(name, { name, start, end, detail: source.slice(start, end), kind });
        }
    };

    walk(script.content, (node) => {
        if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.range) {
            const [start, end] = node.range;
            const init = node.init;

            add(
                node.id.name,
                start,
                end,
                init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression'
                    ? 'function'
                    : 'variable'
            );
        } else if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier' && node.range) {
            const [start, end] = node.range;
            add(node.id.name, start, end, 'function');
        }
    });

    return declarations;
}

/**
 * `{for (const item of list)}` 里的循环变量。
 *
 * 循环头不铺进虚拟文件（它不是表达式），所以模板里一用 `item` 就"找不到名字"——
 * 补一个声明抵消掉。取的是循环头原文，两个阶段都拿得到。
 */
function collect_loop_names(nodes: readonly unknown[]): string[] {
    const names = new Set<string>();
    const pattern = /[A-Za-z_$][\w$]*/g;
    const keywords = new Set(['const', 'let', 'var']);

    const visit = (node: unknown): void => {
        const current = node as Record<string, unknown>;

        if (current?.type === 'ForBlock' && typeof current.raw === 'string') {
            // 循环头是 `item of list`：只看 `of` 左边那段（可能是 `[a, b]` / `{x}`）
            const header = current.raw;
            const binding = split_for_header(header)?.binding ?? header.split(/\s+of\s/)[0];

            for (const match of binding.matchAll(pattern)) {
                if (keywords.has(match[0])) continue;

                names.add(match[0]);
            }
        }

        for (const key of ['children', 'fallback'] as const) {
            const next = current?.[key];

            if (Array.isArray(next)) next.forEach(visit);
            else if (next) visit(next);
        }
    };

    nodes.forEach(visit);

    return [...names];
}

/** 常见标签 -> DOM 类型，给 `bind:this` 声明的变量用（认不出的退成 HTMLElement） */
const ELEMENT_TYPES: Record<string, string> = {
    a: 'HTMLAnchorElement',
    br: 'HTMLBRElement',
    button: 'HTMLButtonElement',
    canvas: 'HTMLCanvasElement',
    div: 'HTMLDivElement',
    form: 'HTMLFormElement',
    h1: 'HTMLHeadingElement',
    h2: 'HTMLHeadingElement',
    h3: 'HTMLHeadingElement',
    h4: 'HTMLHeadingElement',
    h5: 'HTMLHeadingElement',
    h6: 'HTMLHeadingElement',
    img: 'HTMLImageElement',
    input: 'HTMLInputElement',
    label: 'HTMLLabelElement',
    li: 'HTMLLIElement',
    ol: 'HTMLOListElement',
    option: 'HTMLOptionElement',
    p: 'HTMLParagraphElement',
    pre: 'HTMLPreElement',
    select: 'HTMLSelectElement',
    span: 'HTMLSpanElement',
    table: 'HTMLTableElement',
    textarea: 'HTMLTextAreaElement',
    ul: 'HTMLUListElement',
    video: 'HTMLVideoElement'
};

/**
 * `bind:this={x}` 声明的变量。
 *
 * 只有写标识符时才声明——写函数的是回调形式，不声明变量。
 */
/** `bind:this={x}` 声明的一个变量 */
interface ThisName {
    name: string;
    type: string;
    /** 声明处（`x` 本身）的区间，别把它自己当成"在别处引用" */
    start: number;
    end: number;
}

function collect_this_names(
    nodes: readonly unknown[],
    /** script 里的声明，用来判断某个名字是不是函数 */
    all: Map<string, Declaration>
): ThisName[] {
    const found: ThisName[] = [];

    const visit = (node: unknown): void => {
        const current = node as Record<string, unknown>;

        if (current?.type === 'element') {
            for (const [key, value] of Object.entries((current.attributes ?? {}) as Record<string, unknown>)) {
                if (key !== 'bind:this' || typeof value !== 'object' || value === null || 'type' in value) continue;

                const expression = (value as Record<string, unknown>).expression as
                    | { content?: { type?: string; name?: string }; contentStart?: number; contentEnd?: number }
                    | null
                    | undefined;

                // 解析失败时没有 AST，认不出是不是标识符，那就不声明
                if (expression?.content?.type !== 'Identifier' || !expression.content.name) continue;

                // 指向函数的是回调形式（`bind:this={grab}`），不声明变量
                if (all.get(expression.content.name)?.kind === 'function') continue;

                const tag = String(current.name ?? '');

                found.push({
                    name: expression.content.name,
                    type: ELEMENT_TYPES[tag] ?? 'HTMLElement',
                    start: expression.contentStart ?? 0,
                    end: expression.contentEnd ?? 0
                });
            }
        }

        for (const next of ['children', 'alternates', 'fallback'] as const) {
            const value = current?.[next];

            if (Array.isArray(value)) value.forEach(visit);
            else if (value) visit(value);
        }
    };

    nodes.forEach(visit);

    return found;
}

/**
 * `bind:this` 声明的变量只在 `<script onmount>` 里有效，别处引用就该报错。
 *
 * TS 那边没法用作用域表达（变量是编译期才声明的，虚拟文件里只能全局声明），
 * 所以自己扫一遍：不在 onmount 里、也不是声明处本身的引用都报出来。
 */
function this_leaks(
    root: Root | null,
    expressions: Expression[],
    names: ThisName[]
): SemanticProblem[] {
    if (!root || names.length === 0) return [];

    const wanted = new Map(names.map((item) => [item.name, item]));
    const onmount = root.onmount;
    const problems: SemanticProblem[] = [];

    const check = (node: any): void => {
        if (node?.type !== 'Identifier' || !node.range) return;

        const item = wanted.get(node.name);
        if (!item) return;

        const [start, end] = node.range;

        // 声明处本身（`bind:this={box}` 里的 box）不算
        if (start >= item.start && start <= item.end) return;

        // onmount 里可以用
        if (onmount && start >= onmount.contentStart && start <= onmount.contentEnd) return;

        problems.push({
            start,
            end,
            message: `\`${node.name}\` is declared by \`bind:this\` and can only be used inside \`<script onmount>\``
        });
    };

    for (const script of [root.script, root.module]) if (script) walk(script.content, check);
    for (const expression of expressions) walk(expression.content, check);

    return problems;
}

/** `(value) => ...` / `(ev) => ...` 这种参数，类型不在我们手里，不报 */
const REGEX_IMPLICIT_ANY = /implicitly has an 'any' type/;

/**
 * 模板里的表达式 / 绑定项：只要区间和原文。
 *
 * 铺虚拟文件、判断光标位置都用这些就够了，所以解析失败（表达式没有 TS AST）
 * 时照样能收 —— 敲到一半的 `obj.` 不至于把高亮和补全全弄丢。
 */
export interface ExpressionRegion {
    contentStart: number;
    contentEnd: number;
    raw: string;
}

function collect_expressions(nodes: readonly unknown[]): ExpressionRegion[] {
    const expressions: ExpressionRegion[] = [];

    const push = (value: unknown): void => {
        if (value) expressions.push(value as ExpressionRegion);
    };

    const children_of = (node: Record<string, unknown>): unknown[] =>
        Array.isArray(node.children) ? (node.children as unknown[]) : [];

    const visit = (node: unknown): void => {
        const current = node as Record<string, unknown>;

        switch (current?.type) {
            case 'expression':
                push(node);
                break;

            case 'element':
                for (const value of Object.values((current.attributes ?? {}) as Record<string, unknown>)) {
                    if (value === true || typeof value === 'string') continue;

                    for (const chunk of Array.isArray(value) ? value : [value]) {
                        if (typeof chunk === 'string') continue;

                        // 绑定值（`bind:value={ ... }`）不是表达式；
                        // 但里面 get / set / listen / 变量这些照样要铺进虚拟文件
                        if (typeof chunk === 'object' && chunk !== null && !('type' in chunk)) {
                            const binding = chunk as Record<string, unknown>;

                            for (const key of ['expression', 'get', 'set', 'listen']) push(binding[key]);

                            continue;
                        }

                        push(chunk);
                    }
                }

                children_of(current).forEach(visit);
                break;

            case 'IfBlock':
                push(current.test);
                for (const alternate of (current.alternates ?? []) as Array<Record<string, unknown>>) {
                    if (alternate.test) push(alternate.test);
                    children_of(alternate).forEach(visit);
                }

                children_of(current).forEach(visit);
                break;

            case 'ForBlock': {
                // 循环头（`for (const x of y)`）不是表达式，不铺
                const fallback = current.fallback as Record<string, unknown> | null | undefined;
                if (fallback) children_of(fallback).forEach(visit);

                children_of(current).forEach(visit);
                break;
            }
        }
    };

    nodes.forEach(visit);

    return expressions;
}

/** 类型字面量的最小结构（够用就行，不把整个 TSESTree 拉进来） */
interface TypeLiteralLike {
    type: string;
    members?: Array<{
        type: string;
        optional?: boolean;
        key?: { type: string; name?: string };
        typeAnnotation?: { typeAnnotation?: { range?: [number, number] } };
    }>;
}

/** 从 `{ label: string; count?: number }` 这样的类型字面量读出属性 */
function members_of(node: TypeLiteralLike, source: string): ComponentProp[] {
    if (node.type !== 'TSTypeLiteral' || !node.members) return [];

    const props: ComponentProp[] = [];

    for (const member of node.members) {
        if (member.type !== 'TSPropertySignature') continue;
        if (member.key?.type !== 'Identifier' || !member.key.name) continue;

        const range = member.typeAnnotation?.typeAnnotation?.range;

        props.push({
            name: member.key.name,
            optional: member.optional === true,
            type: range ? source.slice(range[0], range[1]) : 'unknown',
            bindable: false
        });
    }

    return props;
}

/** 组件的 `$props<{...}>()` 接受哪些属性 */
function props_of(script: Script | null, source: string): ComponentProp[] {
    if (!script) return [];

    for (const statement of script.content.body) {
        if (statement.type !== 'VariableDeclaration') continue;

        for (const declarator of statement.declarations) {
            const init = declarator.init;

            if (init?.type !== 'CallExpression') continue;
            if (init.callee.type !== 'Identifier' || init.callee.name !== '$props') continue;

            // 泛型参数：新版 estree 放 typeArguments，旧版放 typeParameters
            const call = init as unknown as {
                typeArguments?: { params: TypeLiteralLike[] };
                typeParameters?: { params: TypeLiteralLike[] };
            };
            const argument = (call.typeArguments ?? call.typeParameters)?.params[0];
            const props = argument ? members_of(argument, source) : [];

            // 哪些属性是双向绑定的，看解构里有没有 `$bindable(...)`
            const bound = bindable_names(declarator.id);

            for (const prop of props) prop.bindable = bound.has(prop.name);

            return props;
        }
    }

    return [];
}

/** 解构模式里写了 `$bindable(...)` 的项：`{ count = $bindable(0) }` */
function bindable_names(id: unknown): Set<string> {
    const names = new Set<string>();

    const pattern = id as {
        type?: string;
        properties?: Array<{
            type?: string;
            value?: {
                type?: string;
                left?: { type?: string; name?: string };
                right?: { type?: string; callee?: { type?: string; name?: string } };
            };
        }>;
    };

    if (pattern.type !== 'ObjectPattern' || !pattern.properties) return names;

    for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        if (property.value?.type !== 'AssignmentPattern') continue;
        if (property.value.right?.type !== 'CallExpression') continue;
        if (property.value.right.callee?.name !== '$bindable') continue;

        const target = property.value.left;
        if (target?.type !== 'Identifier' || !target.name) continue;

        names.add(target.name);
    }

    return names;
}

/** 解析过的组件：路径 -> 属性。文件保存时失效 */
const component_cache = new Map<string, ComponentProp[]>();

export function forget_component(path: string): void {
    component_cache.delete(path);
}

function component_props_at(path: string): ComponentProp[] {
    const cached = component_cache.get(path);
    if (cached) return cached;

    let props: ComponentProp[] = [];

    try {
        const source = readFileSync(path, 'utf8');

        props = props_of(parse(source, { filename: path }).script, source);
    } catch {
        props = [];
    }

    component_cache.set(path, props);

    return props;
}

/** script 里 `import Foo from './Foo.grain'` 全收集起来 */
function imported_components(script: Script | null, filename: string): Map<string, ComponentProp[]> {
    const components = new Map<string, ComponentProp[]>();
    if (!script) return components;

    for (const statement of script.content.body) {
        if (statement.type !== 'ImportDeclaration') continue;

        const specifier = statement.source.value;
        if (typeof specifier !== 'string' || !specifier.endsWith('.grain')) continue;

        const binding = statement.specifiers.find((item) => item.type === 'ImportDefaultSpecifier') as
            | { local?: { name?: string } }
            | undefined;

        if (!binding?.local?.name) continue;

        components.set(binding.local.name, component_props_at(resolve(dirname(filename), specifier)));
    }

    return components;
}

function element_at(nodes: TemplateNode[], offset: number): ElementInfo | null {
    for (const node of nodes) {
        const children: TemplateNode[] =
            node.type === 'element' || node.type === 'IfBlock' || node.type === 'ForBlock'
                ? [
                      ...node.children,
                      ...(node.type === 'IfBlock' ? node.alternates.flatMap((item) => item.children) : []),
                      ...(node.type === 'ForBlock' && node.fallback ? node.fallback.children : [])
                  ]
                : [];

        if (node.type === 'element' && offset >= node.start && offset <= node.end) {
            return {
                name: node.name,
                start: node.start,
                name_end: node.start + 1 + node.name.length,
                end: node.end
            };
        }

        const nested = element_at(children, offset);
        if (nested) return nested;
    }

    return null;
}

/**
 * 解析失败时的兜底：把 `<script>` 块抠出来。
 *
 * 模板写坏了（比如 `obj.` 敲一半）编译器会抛错，但 script 本身多半是好的。
 * 不抠出来的话虚拟文件里 script 全变空白，语义高亮和补全就整个没了。
 */
function fallback_scripts(source: string): VirtualScript[] {
    const found: VirtualScript[] = [];
    const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/g;

    for (const match of source.matchAll(pattern)) {
        const open_end = match.index + match[0].indexOf('>') + 1;
        const body = match[2];

        found.push({
            contentStart: open_end,
            contentEnd: open_end + body.length,
            raw: body
        });
    }

    return found;
}

export function analyze(source: string, filename: string): Analysis {
    let root: Root | null = null;
    let error: ParseError | null = null;

    try {
        root = parse(source, { filename });
    } catch (caught) {
        error = caught instanceof ParseError ? caught : new ParseError(String(caught), 0, 0);
    }

    // 解析失败（`obj.` 敲一半、标签没闭合…）就退到第一阶段：
    // 结构和区间还在，只是表达式没有 TS AST。铺虚拟文件只要区间和原文，
    // 所以高亮和补全不至于跟着一起没
    let stage: RootStage | null = root;

    if (!stage) {
        try {
            stage = parse_root(source, { filename });
        } catch {
            stage = null;
        }
    }

    const declarations = new Map<string, Declaration>();
    const all = new Map<string, Declaration>();

    for (const script of [root?.module, root?.script]) {
        for (const [name, declaration] of collect_declarations(source, script ?? null)) {
            declarations.set(name, declaration);
        }

        for (const [name, declaration] of collect_all(source, script ?? null)) {
            all.set(name, declaration);
        }
    }

    // 两份：铺虚拟文件 / 判断光标位置用区间那份（解析失败时也有）；
    // 模板里 hover 找声明要 TS AST，只有完整解析成功才有
    const regions = stage ? collect_expressions(stage.template.children) : [];
    const expressions = (root ? collect_expressions(root.template.children) : []) as Expression[];
    const components = imported_components(root?.script ?? null, filename);

    // `bind:this={x}` 声明的变量（写函数的是回调形式，不声明）
    const this_names = root ? collect_this_names(root.template.children, all) : [];

    // 把 script 铺到虚拟 .ts 文件里交给 TS 语言服务
    // 注意用 `!=`：解析失败时 root 为 null，root?.script 是 undefined，用 !== 会漏过去
    const parsed: VirtualScript[] = [root?.module, root?.script].filter(
        (script): script is Script => script != null
    );

    // onmount 跟 script 一样铺进虚拟文件
    if (root?.onmount) parsed.push(root.onmount);
    // 解析失败时第一阶段那两个块只有原文，照样能铺；再不行才用正则抠
    const scripts: VirtualScript[] =
        parsed.length > 0
            ? parsed
            : stage
              ? [stage.module, stage.script].flatMap((script) =>
                    script
                        ? [{ contentStart: script.contentStart, contentEnd: script.contentEnd, raw: script.raw }]
                        : []
                )
              : fallback_scripts(source);
    const virtual = virtual_name(filename);

    // 循环变量在虚拟文件里没有声明，补上（script 里已经声明过同名的就不补）
    const loops = stage
        ? collect_loop_names(stage.template.children).filter((name) => !all.has(name))
        : [];

    // bind:this 声明的变量也补上声明（元素类型），这样 onmount 里能正常用；
    // "只有 onmount 能用"由 this_leaks 单独查
    const declared = [
        ...loops.map((name) => `declare let ${name}: any;`),
        ...this_names.map((item) => `declare let ${item.name}: ${item.type};`)
    ].join('\n');

    typescript_service.update(virtual, build_virtual(source, scripts, regions, declared));

    return {
        root,
        error,
        declarations,
        all,

        expression_at(offset: number): Expression | null {
            return (
                expressions.find(
                    (expression) => offset >= expression.contentStart && offset <= expression.contentEnd
                ) ?? null
            );
        },

        script_at(offset: number): Script | null {
            for (const script of [root?.script, root?.module, root?.onmount]) {
                if (script && offset >= script.contentStart && offset <= script.contentEnd) return script;
            }

            return null;
        },

        element_at(offset: number): ElementInfo | null {
            return root ? element_at(root.template.children, offset) : null;
        },

        component_props(name: string): ComponentProp[] {
            return components.get(name) ?? [];
        },

        classifications(): SemanticSpan[] {
            return typescript_service.classifications(virtual, source.length);
        },

        completions(offset: number): CompletionEntry[] {
            const in_script = scripts.some(
                (script) => offset >= script.contentStart && offset <= script.contentEnd
            );

            // 模板里的表达式（`{x}`、`bind:value={ get: ... }` 里的每一项）也铺进虚拟文件了，
            // 一样能问 TS —— 高亮拿得到，补全也拿得到
            const in_expression = regions.some(
                (expression) => offset >= expression.contentStart && offset <= expression.contentEnd
            );

            log(
                'completions',
                'offset', offset,
                'in script', in_script,
                'in expression', in_expression
            );

            if (!in_script && !in_expression) return [];

            // 点号后面优先自己按类型枚举：TS 在这种地方往往返回一堆全局标识符，
            // 而不是 `Math` 自己的成员
            const members = typescript_service.member_completions(virtual, offset);
            if (members.length > 0) return members;

            return typescript_service.completions(virtual, offset);
        },

        completion_detail(offset: number, name: string): CompletionDetail | null {
            return typescript_service.completion_detail(virtual, offset, name);
        },

        // 虚拟文件与原文件 offset 一一对应，直接把光标偏移传进去就行
        quick_info(offset: number): QuickInfo | null {
            return scripts.some((script) => offset >= script.contentStart && offset <= script.contentEnd)
                ? typescript_service.quick_info(virtual, offset)
                : null;
        },

        semantic(): SemanticProblem[] {
            const problems = typescript_service.semantic_problems(virtual).filter((problem) => {
                // script 里：全部照报
                if (
                    scripts.some(
                        (script) =>
                            problem.start >= script.contentStart && problem.start <= script.contentEnd
                    )
                ) {
                    return true;
                }

                // 模板里的表达式（`{x}`、`onclick={...}`、`bind:value={...}` 里的每一项）
                // 也铺进虚拟文件了，是真代码，照样报
                const region = regions.find(
                    (item) => problem.start >= item.contentStart && problem.start <= item.contentEnd
                );

                if (!region) return false;

                // 只有 implicit any 是包装带来的：`set: (value) => ...`、`onclick={(ev) => ...}`
                // 的参数类型来自 DOM / 父组件，TS 在我们的嵌入形式里看不到，
                // 硬报的话每个 grain 绑定和事件处理器都会挂红线
                return !REGEX_IMPLICIT_ANY.test(problem.message);
            });

            // bind:this 声明的变量只在 onmount 里有效
            return [...problems, ...this_leaks(root, expressions, this_names)];
        },

        warmup(): void {
            typescript_service.warmup();
        },

        compiled(): { js: string; css: string } | null {
            try {
                return compile(source, { filename, runtimeModule: 'grain' });
            } catch {
                return null;
            }
        },

        dispose(): void {
            typescript_service.remove(virtual);
        }
    };
}


