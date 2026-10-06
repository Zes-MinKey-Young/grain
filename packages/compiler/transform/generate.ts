import { simpleTraverse } from '@typescript-eslint/typescript-estree';
import type { TSESTree } from '@typescript-eslint/typescript-estree';

import type {
    AttributeValue,
    BindingValue,
    Element,
    Expression,
    ForBlock,
    IfBlock,
    Root,
    Script,
    TemplateNode
} from '../types.js';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

import {
    analyze_script,
    collect_reads,
    collect_writes,
    intersects,
    type FunctionLike,
    type ScriptAnalysis
} from './analyze.js';
import { create_scope_id, is_global, scope_stylesheet } from './style.js';

export interface CompileOptions {
    /** 运行时模块路径，默认 `grain` */
    runtimeModule?: string;
    /** 文件名，参与 scope id 计算 */
    filename?: string;
}

export interface CompileResult {
    js: string;
    css: string;
}

/** 一个动态片段：属于哪个元素的调度器、编号是多少、依赖哪些 state */
interface Slot {
    update: string;
    index: number;
    deps: Set<string>;
}

interface PendingWrapper {
    name: string;
    node: FunctionLike;
    writes: Set<string>;
}

function add_all(target: Set<string>, source: Set<string>): void {
    for (const value of source) target.add(value);
}

/** 收集一棵模板子树里出现过的所有 state 读取 */
function template_reads(node: TemplateNode): Set<string> {
    const names = new Set<string>();

    const visit = (current: TemplateNode): void => {
        switch (current.type) {
            case 'expression':
                add_all(names, collect_reads(current.content));
                break;

            case 'element':
                for (const value of Object.values(current.attributes)) {
                    for (const chunk of chunks_of(value)) {
                        if (typeof chunk !== 'string') add_all(names, collect_reads(chunk.content));
                    }
                }
                current.children.forEach(visit);
                break;

            case 'IfBlock':
                add_all(names, collect_reads(current.test.content));
                for (const alternate of current.alternates) {
                    if (alternate.test) add_all(names, collect_reads(alternate.test.content));
                    alternate.children.forEach(visit);
                }
                current.children.forEach(visit);
                break;

            case 'ForBlock':
                add_all(names, collect_reads(current.content.right));
                current.fallback?.children.forEach(visit);
                current.children.forEach(visit);
                break;
        }
    };

    visit(node);

    return names;
}

interface PropsInfo {
    /** `$props()` 调用本身的区间 */
    call: [number, number];

    /** 解构模式的区间 */
    id: [number, number] | null;
    /** 要保留的解构项（children 由 create 的参数提供，得剔掉） */
    keep: Array<[number, number]>;
    /** 解构出来的变量：局部变量名 + 它在 props 上的键名 */
    names: Array<{ name: string; key: string }>;
}

function is_children(property: unknown): boolean {
    const node = property as { type?: string; key?: { type?: string; name?: string } };

    return node?.key?.type === 'Identifier' && node.key.name === 'children';
}

/** 找出 `$props()`：调用位置 + 解构模式 */
function find_props(script: Script | null): PropsInfo | null {
    if (!script) return null;

    for (const statement of script.content.body) {
        if (statement.type !== 'VariableDeclaration') continue;

        for (const declarator of statement.declarations) {
            const init = declarator.init;

            if (init?.type !== 'CallExpression') continue;
            if (init.callee.type !== 'Identifier' || init.callee.name !== '$props') continue;

            const info: PropsInfo = { call: init.range, id: null, keep: [], names: [] };

            if (declarator.id.type === 'ObjectPattern') {
                const kept = declarator.id.properties.filter((property) => !is_children(property));

                info.id = declarator.id.range;
                info.keep = kept.map((property) => property.range);

                info.names = kept
                    .filter((property): property is TSESTree.Property => property.type === 'Property')
                    .map((property) => {
                        // `{ label: l = 1 }` 取 `l`，`{ label }` 取 `label`
                        const value = property.value;
                        const target = value.type === 'AssignmentPattern' ? value.left : value;
                        const name = target.type === 'Identifier' ? target.name : '';
                        const key =
                            property.key.type === 'Identifier' && !property.computed
                                ? property.key.name
                                : name;

                        return { name, key };
                    })
                    .filter((entry) => entry.name !== '');
            }

            return info;
        }
    }

    return null;
}

/** `let { value = $bindable(0) } = $props()` 里的 `value` */
interface BindableInfo {
    /** 子组件里的局部变量名 */
    name: string;
    /** props 上的键名（`{ value: v = $bindable() }` 时是 `value`） */
    prop: string;
    /** 兜底值源码；`$bindable()` 没给参数时为 `undefined` */
    fallback: string;
    /** 生成的读写对变量名 */
    binding: string;
    /** 这一项在解构里的区间（要从解构里剔掉） */
    property: [number, number];
    /** `let { ... } = $props()` 这条语句的结束位置，绑定声明插在它后面 */
    statement_end: number;
}

/** script 源码里的一处改写，区间是相对 script 内容开头的原始偏移 */
interface Edit {
    start: number;
    end: number;
    text: string;
}

/** 从后往前应用，前面的改写不会影响后面区间的计算 */
function apply_edits(code: string, edits: Edit[], base: number): string {
    let result = code;

    for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
        const start = edit.start - base;
        const end = edit.end - base;

        if (start < 0 || end > result.length) continue;

        result = result.slice(0, start) + edit.text + result.slice(end);
    }

    return result;
}

/** 找出 `$props()` 解构里用 `$bindable(...)` 声明的项 */
function find_bindables(block: Script, source: string): BindableInfo[] {
    const found: BindableInfo[] = [];

    for (const statement of block.content.body) {
        if (statement.type !== 'VariableDeclaration') continue;

        for (const declarator of statement.declarations) {
            const init = declarator.init;

            if (init?.type !== 'CallExpression') continue;
            if (init.callee.type !== 'Identifier' || init.callee.name !== '$props') continue;
            if (declarator.id.type !== 'ObjectPattern') continue;

            for (const property of declarator.id.properties) {
                if (property.type !== 'Property') continue;
                if (property.value.type !== 'AssignmentPattern') continue;

                const right = property.value.right;

                if (right.type !== 'CallExpression') continue;
                if (right.callee.type !== 'Identifier' || right.callee.name !== '$bindable') continue;
                if (property.value.left.type !== 'Identifier') continue;

                const name = property.value.left.name;
                const key =
                    property.key.type === 'Identifier' && !property.computed ? property.key.name : name;
                const argument = right.arguments[0];

                found.push({
                    name,
                    prop: key,
                    fallback: argument ? source.slice(argument.range[0], argument.range[1]) : 'undefined',
                    binding: `__binding$${name}`,
                    property: property.range,
                    statement_end: statement.range[1]
                });
            }
        }
    }

    return found;
}

/** `+=` -> `+`、`??=` -> `??`：把赋值运算符还原成二元运算符 */
function binary_operator(operator: string): string {
    return operator.slice(0, -1);
}

function is_function_like(node: TSESTree.Node): node is FunctionLike {
    return (
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression' ||
        node.type === 'FunctionDeclaration'
    );
}

/** 绑定值没有 `type` 字段，表达式有 */
function is_binding_value(value: string | Expression | BindingValue): value is BindingValue {
    return typeof value === 'object' && value !== null && !('type' in value);
}

/**
 * 属性值里的文本 / 表达式片段。
 * 绑定值不算在里面 —— 它走 `binding_attribute` 那条路。
 */
function chunks_of(value: AttributeValue | true): Array<string | Expression> {
    if (value === true || typeof value === 'string') return [];
    if (Array.isArray(value)) return value.filter((chunk) => !is_binding_value(chunk));
    if (is_binding_value(value)) return [];

    return [value];
}

/**
 * 去掉类型标注：`<script>` 里写的是 TS，产物必须是纯 JS。
 *
 * 作用于整个模块（含模板代码）而不是只转 script 片段——这样 TS 能看见
 * `B` 在模板代码里被用（`<B />` 会生成 `B.create(...)`），不会把 import 当成"只用于类型"删掉。
 */
function transpile(code: string, filename: string): string {
    const result = transpileModule(code, {
        fileName: `${filename}.ts`,
        compilerOptions: {
            target: ScriptTarget.ES2022,
            module: ModuleKind.ESNext,
            // 不改写 import / export 的写法，避免"看起来没用到"的 import 被删
            verbatimModuleSyntax: true,
            removeComments: false
        }
    });

    return result.outputText;
}

/** 首字母大写（`<Foo />`）或带点（`<Foo.Bar />`）的标签是子组件 */
function is_component_name(name: string): boolean {
    return /^[A-Z]/.test(name) || name.includes('.');
}

function escape_template(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

class Generator {
    private statements: string[] = [];
    private slots: Slot[] = [];
    private wrappers: PendingWrapper[] = [];
    /**
     * `bind:` 的 setter。要等所有片段都收集完才知道刷新哪些，
     * 所以先记下"拿到 update 调用之后怎么渲染"。
     */
    private pending_binds: Array<{
        name: string;
        render: (updates: string) => string;
        writes: Set<string>;
    }> = [];
    private counter = 0;
    private wrapper_counter = 0;
    private root_name = 'update$0';
    /** `$bindable` 声明的双向绑定 prop */
    private bindables: BindableInfo[] = [];
    /**
     * `$bindable` 变量的写入改写（SFC 绝对偏移）。
     * script 和事件包装都要用——包装是复制函数体，不改写的话子组件写不回父组件。
     */
    private bindable_edits: Edit[] = [];
    /**
     * 是否处在"每次重建都会重新创建"的上下文里（for 块、组件插槽）。
     * 这里面的片段不用注册——重建后旧节点就失效了，注册了只会产生无效的 update 调用。
     */
    private inside_fragment = false;
    /** 正在生成插槽内容：这里的 `{expr}` 得有自己的文本节点，父组件才能刷新它 */
    private inside_slot = false;
    /** 用到了 creText */
    private needs_text = false;
    /** `$props()` 解构出来的变量，生成 `set_props` 要用 */
    private prop_names: Array<{ name: string; key: string }> = [];
    /** `$bindable` 变量 -> 它的刷新函数名 */
    private refresh_names = new Map<string, string>();
    /** 待生成的刷新函数（要等片段收集完才知道刷哪些） */
    private pending_refreshes: Array<{ name: string; deps: Set<string> }> = [];

    constructor(
        private source: string,
        private root: Root,
        private runtime: string,
        private analysis: ScriptAnalysis | null,
        /** 组件级样式的类名；`<style global>` 或没有样式时为 null */
        private scope_id: string | null,
        private filename: string
    ) {}

    run(): CompileResult {
        // 先定下根调度器的名字：bindactive 的 setter 要在最后触发它的全量刷新
        const root_name = `update$${this.counter++}`;
        this.root_name = root_name;

        this.fragment(this.root.template.children, root_name);

        // script 要先处理：`$bindable` 会决定要不要 import to_binding
        const parts = this.root.script ? this.script(this.root.script) : { head: [], body: '' };

        const imported = ['creEle', 'creFragment'];
        if (this.bindables.length > 0) imported.push('to_binding');
        if (this.needs_text) imported.push('creText');

        const output: string[] = [`import { ${imported.join(', ')} } from ${JSON.stringify(this.runtime)};`];

        if (this.root.module) {
            output.push('', '/* <script module> */', this.root.module.raw.trim());
        }

        // import / export 留在模块顶层
        if (parts.head.length > 0) output.push('', ...parts.head);

        // 实例代码：每个组件实例各跑一遍，所以放进 create()
        const instance: string[] = [];

        if (parts.body) {
            instance.push('/* <script> */', parts.body);
        }

        // 事件包装：原函数体 + 触发受影响的片段（README 里的 `increment_$1`）
        const wrappers = this.wrapper_statements();
        if (wrappers.length > 0) instance.push('', ...wrappers);

        // bind: 的 setter
        const binds = this.bind_statements();
        if (binds.length > 0) instance.push('', ...binds);

        // $bindable 非受控时的刷新函数
        const refreshes = this.refresh_statements();
        if (refreshes.length > 0) instance.push('', ...refreshes);

        instance.push('', '/* template */', ...this.statements);

        // 属性修改触发器：得等所有片段都收集完，才知道 props 变了要刷哪些
        const set_props = this.props_statements();
        if (set_props.length > 0) instance.push('', ...set_props);

        instance.push('', `return ${root_name};`);

        output.push(
            '',
            '/** 建一个组件实例。父组件通过 `Foo.create(props, children)` 调用 */',
            'export function create(props = {}, children = null) {',
            ...instance.map((line) => (line ? `  ${line}` : '')),
            '}'
        );

        output.push(
            '',
            '/** 挂到页面上。`mount.target` 留给 HMR 重新挂载用 */',
            'export default function mount(target) {',
            '  mount.target = target;',
            '  const update = create();',
            '  target.appendChild(update.el);',
            '  return update;',
            '}',
            'mount.create = create;'
        );

        const stylesheet = this.root.stylesheet;
        const css = !stylesheet
            ? ''
            : this.scope_id
              ? scope_stylesheet(stylesheet, this.scope_id)
              : stylesheet.raw;

        return { js: transpile(output.join('\n'), this.filename), css };
    }

    // ------------------------------------------------------------ script

    /**
     * 处理实例脚本：
     * - `head`：import / export 必须留在模块顶层（不能塞进 create() 里）
     * - `body`：其余代码放进 create()，每个组件实例各跑一遍
     * - `$state(...)` 去掉包装，`$props()` 换成 props 参数
     */
    private script(block: Script): { head: string[]; body: string } {
        const edits: Edit[] = [];

        // 1. import / export 留在模块顶层
        const hoisted = block.content.body.filter(
            (statement) => statement.type === 'ImportDeclaration' || statement.type.startsWith('Export')
        );

        const head = hoisted.map((statement) => this.slice(statement.range).trim());

        for (const statement of hoisted) {
            edits.push({ start: statement.range[0], end: statement.range[1], text: '' });
        }

        // 2. `$state(...)` -> 初始值
        for (const state of this.analysis?.states.values() ?? []) {
            edits.push({ start: state.range[0], end: state.range[1], text: state.init });
        }

        // 3. `$props()` -> `props`
        const props = find_props(block);
        const bindables = props ? find_bindables(block, this.source) : [];

        this.bindables = bindables;
        if (props) this.prop_names = props.names;

        if (props) {
            edits.push({ start: props.call[0], end: props.call[1], text: 'props' });

            // 解构里去掉 children（跟 create() 的参数重名）和 `$bindable` 项
            if (props.id) {
                const dropped = new Set(bindables.map((bindable) => bindable.property[0]));
                const kept = props.keep
                    .filter(([from]) => !dropped.has(from))
                    .map(([from, to]) => this.source.slice(from, to))
                    .join(', ');

                edits.push({ start: props.id[0], end: props.id[1], text: `{${kept}}` });
            }
        }

        // 4. `$bindable` 变量的写入 -> 读写对
        this.bindable_edits = this.bindable_writes(block, bindables);
        edits.push(...this.bindable_edits);

        // 5. 读写对的声明，插在 `let { ... } = $props()` 之后
        for (const bindable of bindables) {
            const { start, end } = { start: bindable.statement_end, end: bindable.statement_end };

            edits.push({
                start,
                end,
                text: `\nconst ${bindable.binding} = to_binding(props[${JSON.stringify(bindable.prop)}], ${bindable.fallback});\nlet ${bindable.name} = ${bindable.binding}.get();`
            });
        }

        return { head, body: apply_edits(block.raw, edits, block.contentStart).trim() };
    }

    /**
     * `$bindable` 变量的写入，两条路分开走：
     *
     * ```js
     * a++;
     * // ->
     * if (__binding$a.external) __binding$a.set(a + 1);        // 受控：值归父组件管，只推过去
     * else { a = a + 1; __refresh$a(); }                        // 非受控：binding 不掺和，自己改自己刷
     * ```
     */
    private bindable_writes(block: Script, bindables: BindableInfo[]): Edit[] {
        if (bindables.length === 0) return [];

        const by_name = new Map(bindables.map((bindable) => [bindable.name, bindable]));
        const edits: Edit[] = [];

        /** 每个变量一个"刷新依赖它的片段"的函数，片段收集完之后才生成 */
        const refresh_of = (name: string): string => {
            const existing = this.refresh_names.get(name);
            if (existing) return existing;

            const generated = `__refresh$${this.counter++}`;

            this.refresh_names.set(name, generated);
            this.pending_refreshes.push({ name: generated, deps: new Set([name]) });

            return generated;
        };

        /** 这次写入：变量名、新值的表达式、读写对 */
        const read_write = (
            node: TSESTree.Node
        ): { name: string; value: string; binding: string } | null => {
            if (node.type === 'AssignmentExpression') {
                if (node.left.type !== 'Identifier') return null;

                const bindable = by_name.get(node.left.name);
                if (!bindable) return null;

                const right = this.slice(node.right.range);
                const value =
                    node.operator === '='
                        ? right
                        : `${node.left.name} ${binary_operator(node.operator)} ${right}`;

                return { name: node.left.name, value, binding: bindable.binding };
            }

            if (node.type === 'UpdateExpression') {
                if (node.argument.type !== 'Identifier') return null;

                const bindable = by_name.get(node.argument.name);
                if (!bindable) return null;

                return {
                    name: node.argument.name,
                    value: `${node.argument.name} ${node.operator === '++' ? '+' : '-'} 1`,
                    binding: bindable.binding
                };
            }

            return null;
        };

        simpleTraverse(block.content as unknown as TSESTree.Node, {
            enter: (node, parent) => {
                const write = read_write(node);
                if (!write) return;

                const { name, value, binding } = write;

                // 赋值语句：展开成 if / else 两条路
                if (parent?.type === 'ExpressionStatement') {
                    edits.push({
                        start: parent.range[0],
                        end: parent.range[1],
                        text:
                            `if (${binding}.external) ${binding}.set(${value}); ` +
                            `else { ${name} = ${value}; ${refresh_of(name)}(); }`
                    });

                    return;
                }

                // 塞在表达式里的写入（`f(a = 1)` 这种）展开不成语句，用三元
                edits.push({
                    start: node.range[0],
                    end: node.range[1],
                    text: `(${binding}.external ? ${binding}.set(${value}) : (${name} = ${value}, ${refresh_of(name)}()))`
                });
            }
        });

        return edits;
    }

    /**
     * 非受控时 `$bindable` 就是个普通变量，改完得自己刷依赖它的片段。
     * 用 function 声明（会提升），这样 script 顶层的写入也不会踩到 TDZ。
     */
    private refresh_statements(): string[] {
        return this.pending_refreshes.map((refresh) => {
            const updates = this.update_calls(refresh.deps);

            return `function ${refresh.name}() {${updates ? ` ${updates}` : ' '}}`;
        });
    }

    /** 函数体源码；`$bindable` 的写入顺带改成读写对调用 */
    private body_source(range: [number, number]): string {
        const [from, to] = range;

        if (this.bindable_edits.length === 0) return this.source.slice(from, to);

        const inside = this.bindable_edits.filter((edit) => edit.start >= from && edit.end <= to);

        return apply_edits(this.source.slice(from, to), inside, from);
    }

    private wrapper_statements(): string[] {
        const output: string[] = [];

        for (const wrapper of this.wrappers) {
            const node = wrapper.node;
            const params = node.params.map((param) => this.slice(param.range)).join(', ');
            const updates = this.update_calls(wrapper.writes);

            const head =
                node.type === 'ArrowFunctionExpression'
                    ? `(${params}) =>`
                    : `function ${node.id?.name ?? ''}(${params})`;

            let body: string;

            if (node.body.type === 'BlockStatement') {
                const source = this.body_source(node.body.range);
                body = updates ? `${source.slice(0, -1)} ${updates}}` : source;
            } else {
                body = `{ ${this.body_source(node.body.range)}${updates ? `; ${updates}` : ''} }`;
            }

            output.push(`const ${wrapper.name} = ${head} ${body};`);
        }

        return output;
    }

    /** `bind:` 的 setter：赋值 + 刷新受影响的片段（延迟到这里才能算全片段） */
    private bind_statements(): string[] {
        return this.pending_binds.map((bind) => {
            const updates = this.update_calls(bind.writes);

            return `const ${bind.name} = ${bind.render(updates)};`;
        });
    }

    /**
     * 子组件的属性修改触发器：`update.set_props(props, children)`。
     *
     * 父组件 props 变了只调这个，不重新 create —— 重新 create 会把子组件自己的 state 丢掉。
     */
    private props_statements(): string[] {
        const changed = new Set<string>();
        const body: string[] = [];
        // `$bindable` 的 prop 是个绑定对象，不能直接赋给变量，下面单独处理
        const bound = new Set(this.bindables.map((bindable) => bindable.name));

        for (const entry of this.prop_names) {
            if (bound.has(entry.name)) continue;

            body.push(`  ${entry.name} = $props[${JSON.stringify(entry.key)}];`);
            changed.add(entry.name);
        }

        // `$bindable`：只有受控（父用了 `bind:`）才跟着父的值走。
        // 父只是普通传值时，子组件自己维护，父推过来的值不再覆盖它
        for (const bindable of this.bindables) {
            body.push(`  if (${bindable.binding}.external) ${bindable.name} = ${bindable.binding}.get();`);
            changed.add(bindable.name);
        }

        const updates = this.update_calls(changed);

        // 插槽：引用没变就别重新挂，父组件已经把里面的节点刷新过了
        const slot_updates = this.update_calls(new Set(['children']));

        if (slot_updates) {
            body.push('  if ($children !== undefined && $children !== children) {');
            body.push('    children = $children;');
            body.push(`    ${slot_updates}`);
            body.push('  }');
        }

        if (updates) body.push(`  ${updates}`);

        // 既没有 props 也没有插槽，就不用给父组件留这个入口了
        if (body.length === 0) return [];

        return [`${this.root_name}.set_props = ($props, $children) => {`, ...body, '};'];
    }

    /** 写了 `writes` 里的 state 之后，需要刷新哪些片段 */
    private update_calls(writes: Set<string>): string {
        const grouped = new Map<string, number[]>();

        for (const slot of this.slots) {
            if (!intersects(slot.deps, writes)) continue;

            const indices = grouped.get(slot.update) ?? [];
            if (!indices.includes(slot.index)) indices.push(slot.index);
            grouped.set(slot.update, indices);
        }

        const calls: string[] = [];

        for (const [update, indices] of grouped) {
            indices.sort((a, b) => a - b);
            calls.push(`${update}(${indices.join(', ')});`);
        }

        return calls.join(' ');
    }

    // ------------------------------------------------------------ 模板

    private fragment(children: TemplateNode[], name: string): string {
        const items = this.children(children, name);

        this.statements.push(`const ${name} = creFragment([${items.join(', ')}]);`);

        return name;
    }

    /** 给每个元素挂上 scope 类名，原有 class 保留 */
    private scoped_attributes(
        attributes: Record<string, AttributeValue | true>
    ): Record<string, AttributeValue | true> {
        if (!this.scope_id) return attributes;

        const scope = this.scope_id;
        const existing = attributes['class'];

        if (existing === undefined || existing === true) return { ...attributes, class: scope };
        if (typeof existing === 'string') return { ...attributes, class: `${existing} ${scope}` };
        // class 不会是绑定值
        if (!Array.isArray(existing) && is_binding_value(existing)) {
            return { ...attributes, class: scope };
        }

        const chunks = (Array.isArray(existing) ? existing : [existing]).filter(
            (chunk) => !is_binding_value(chunk)
        );

        return { ...attributes, class: [...chunks, ` ${scope}`] };
    }

    private element(node: Element, owner: string | null, index: number): string | string[] {
        return is_component_name(node.name)
            ? this.component(node, owner, index)
            : this.plain_element(node);
    }

    /**
     * 子组件：`<Foo count={count}>slot</Foo>`。
     *
     * 只 `create()` 一次。依赖的 state 变化时推新 props 给它（`set_props`），
     * 不重新 create —— 重建会把子组件自己的 state 一起丢掉。
     */
    private component(node: Element, owner: string | null, index: number): string[] {
        const parts: string[] = [];
        const deps = new Set<string>();

        for (const [key, value] of Object.entries(this.scoped_attributes(node.attributes))) {
            parts.push(this.component_attribute(key, value));

            // 绑定值走的是 binding_attribute，但它 getter 读的变量同样是依赖：
            // 那些变量变了，父组件要把新的绑定推给子组件
            if (value !== true && !Array.isArray(value) && is_binding_value(value)) {
                const getter = value.get ?? value.expression;
                if (getter) add_all(deps, collect_reads(getter.content));

                continue;
            }

            for (const chunk of chunks_of(value)) {
                if (typeof chunk !== 'string') add_all(deps, collect_reads(chunk.content));
            }
        }

        const props_code = `{${parts.join(', ')}}`;

        // 插槽只建一次；里面的 updater 记下来，父组件推 props 之前先刷它们
        let slot_code = 'null';
        let slot_updaters: string[] = [];

        if (node.children.length > 0) {
            const saved = this.inside_slot;
            this.inside_slot = true;

            let items: string[] = [];
            let statements: string[] = [];

            try {
                [items, statements] = this.capture(() => this.children(node.children, null));
            } finally {
                this.inside_slot = saved;
            }

            // 静态文本是字符串字面量，剩下的是可以刷新的 updater
            slot_updaters = items.filter((item) => !item.startsWith('"'));
            this.statements.push(...statements);

            const slot_name = `slot$${this.counter++}`;
            this.statements.push(`const ${slot_name} = () => [${items.join(', ')}];`);

            slot_code = slot_name;
        }

        const name = `update$${this.counter++}`;
        this.statements.push(`const ${name} = ${node.name}.create(${props_code}, ${slot_code});`);

        // 没有依赖（或不在能注册片段的上下文里）：建一次就完事
        if (deps.size === 0 || !owner) return [name];

        // 有依赖：属性更新器占 children 的下一个编号，props 变了只推 props，不重建
        const updater = `props$${this.counter++}`;
        const refresh = slot_updaters.map((item) => `${item}();`).join(' ');

        this.statements.push(
            `const ${updater} = () => { ${refresh}${name}.set_props(${props_code}, ${slot_code}); };`,
            `${updater}.props = true;`
        );

        this.slots.push({ update: owner, index: index + 1, deps });

        return [name, updater];
    }

    /**
     * 组件属性：按**值**传（不是 getter）。
     * `bind:` / `bindactive:` 例外，传 `{ get, set }` 给子组件。
     */
    private component_attribute(key: string, value: AttributeValue | true): string {
        const name = JSON.stringify(key);

        if (key.startsWith('bind:')) {
            // 子组件那边就是个普通 prop，前缀去掉（前缀只有 creEle 才认）
            const plain = key.slice('bind:'.length);

            return this.attribute(key, value, null, 0, plain).code;
        }

        if (value === true) return `${name}: true`;
        if (typeof value === 'string') return `${name}: ${JSON.stringify(value)}`;

        const chunks = chunks_of(value);

        // 单个表达式直接传值，混合的用模板字符串
        if (chunks.length === 1 && typeof chunks[0] !== 'string') {
            return `${name}: (${chunks[0].raw})`;
        }

        const parts = chunks.map((chunk) =>
            typeof chunk === 'string' ? escape_template(chunk) : '${' + chunk.raw + '}'
        );

        return `${name}: \`${parts.join('')}\``;
    }

    /** 注册一个动态片段。`owner` 为 null 时（组件属性、for 块内）不用注册 */
    private register_slot(owner: string | null, index: number, deps: Set<string>): void {
        if (owner) this.slots.push({ update: owner, index, deps });
    }

    /**
     * 生成 `bind:` 属性。
     *
     * 绑定值是 grain 自己的语法，解析阶段已经拆成 { expression, get, set, listen, active }：
     * - `get` 当 getter；没写就用变量形式自动生成（`{count}` -> `() => (count)`）
     * - `set` 的主体内联进产物，末尾追加 update 调用（跟事件包装一个套路）；
     *   没写就生成一个赋值（`{count}` -> `count = $value`）
     * - `listen` 原样传下去；`listen(bus, name, guard)` 展开成挂事件监听的代码
     * - `active` 传给运行时：setter 跑完之后主动跑一次 getter
     *
     * 两种形式可以混着写：`{count, active}` 就是"变量 + 主动 getter"。
     */
    private binding_attribute(
        name: string,
        binding: BindingValue,
        owner: string | null,
        slot_index: number
    ): { code: string; slot: boolean } {
        const get = binding.get ?? binding.expression;

        if (!get) {
            // 连值都没有：只剩个监听，照挂不误
            const empty = ['get: () => undefined', 'set: ($value) => $value'];

            if (binding.listen) empty.push(`listen: ${this.listen_source(binding.listen.content)}`);
            if (binding.active) empty.push('active: true');

            return { code: `${name}: { ${empty.join(', ')} }`, slot: false };
        }

        const getter = this.getter_source(get.content);
        const setter = `__bind$${this.counter++}`;
        const written = binding.set
            ? this.setter_from(binding.set)
            : { param: '$value', body: `${get.raw} = $value; `, writes: collect_reads(get.content) };

        this.pending_binds.push({
            name: setter,
            // setter 把最终值返回：子组件 `x = binding.set(v)` 拿到的就是父组件的值
            render: (updates) =>
                `(${written.param}) => { ${written.body}${updates ? ` ${updates}` : ''} return (${getter})(); }`,
            writes: written.writes
        });

        const parts = ['external: true', `get: ${getter}`, `set: ${setter}`];

        if (binding.listen) parts.push(`listen: ${this.listen_source(binding.listen.content)}`);
        if (binding.active) parts.push('active: true');

        // get 读了哪些变量 -> 那些变量变化时精确重跑这个 getter
        this.register_slot(owner, slot_index, collect_reads(get.content));

        return { code: `${name}: { ${parts.join(', ')} }`, slot: true };
    }

    /** 用户自己写的 `set`：参数名和主体都搬进产物，写过的变量拿去算 update 调用 */
    private setter_from(set: Expression): { param: string; body: string; writes: Set<string> } {
        const node = set.content;

        if (!is_function_like(node)) {
            // 不是函数就当成一个可调用的 setter
            return { param: '$value', body: `(${set.raw})($value); `, writes: new Set() };
        }

        const { param, body } = this.setter_source(node);

        return { param, body, writes: collect_writes(node) };
    }

    /** getter：`() => target.value` 这样的箭头函数，或者干脆就是一个表达式 */
    private getter_source(get: TSESTree.Node): string {
        if (!is_function_like(get)) return `() => (${this.slice(get.range)})`;

        const body = get.body;

        return body.type === 'BlockStatement'
            ? `() => ${this.slice(body.range)}`
            : `() => (${this.slice(body.range)})`;
    }

    /** setter：参数名用用户写的那个，主体搬进产物 */
    private setter_source(set: FunctionLike): { param: string; body: string } {
        const first = set.params[0];
        const param = first?.type === 'Identifier' ? first.name : '$value';
        const body = set.body;

        // 块体：去掉花括号，语句原样搬进来（update 调用会追加在后面）
        if (body.type === 'BlockStatement') {
            return { param, body: this.slice([body.range[0] + 1, body.range[1] - 1]) };
        }

        return { param, body: `${this.slice(body.range)}; ` };
    }

    /**
     * `listen`：
     * - 自己写的 `(update) => {...}` 原样传下去
     * - `listen(eventBus, eventName)` / `listen(eventBus, eventName, guard)` 展开成挂事件监听的代码，
     *   没有 `addEventListener` 就用 `on`
     * - 谓词（guard）可省：省了就是恒真，事件来了直接 update
     */
    private listen_source(listen: TSESTree.Node): string {
        const call = listen.type === 'CallExpression' ? listen : null;

        if (!call || call.callee.type !== 'Identifier' || call.callee.name !== 'listen') {
            return this.slice(listen.range);
        }

        const [bus, event, guard] = call.arguments;
        if (!bus || !event) return this.slice(listen.range);

        // guard 存成函数再调用，这样表达式体和块体都支持
        const guard_code = guard ? `const $guard = (${this.slice(guard.range)}); ` : '';
        const handler = guard ? '($event) => { if ($guard($event)) update(); }' : '() => update()';

        return (
            `(update) => { ` +
            `const $bus = (${this.slice(bus.range)}); ${guard_code}` +
            `($bus.addEventListener ?? $bus.on).call($bus, ${this.slice(event.range)}, ${handler}); ` +
            `}`
        );
    }

    private plain_element(node: Element): string {
        const name = `update$${this.counter++}`;
        const items = this.children(node.children, this.inside_fragment ? null : name);

        const props: string[] = [];
        let prop_index = 0;

        for (const [key, value] of Object.entries(this.scoped_attributes(node.attributes))) {
            const attribute = this.attribute(key, value, name, items.length + prop_index);
            if (attribute.slot) prop_index += 1;
            props.push(attribute.code);
        }

        this.statements.push(
            `const ${name} = creEle(${JSON.stringify(node.name)}, {${props.join(', ')}}, [${items.join(', ')}]);`
        );

        return name;
    }

    /**
     * 生成一个属性。`owner` 为 null 时不注册动态片段（组件整体重建，内部片段没意义）。
     * `slot` 表示它占用了一个动态片段编号。
     */
    private attribute(
        key: string,
        value: AttributeValue | true,
        owner: string | null,
        slot_index: number,
        /** 写进产物里的键名。组件属性会去掉 `bind:` 前缀——前缀只有 creEle 才认 */
        output_key = key
    ): { code: string; slot: boolean } {
        const name = JSON.stringify(output_key);

        if (value === true) return { code: `${name}: true`, slot: false };
        if (typeof value === 'string') return { code: `${name}: ${JSON.stringify(value)}`, slot: false };

        const chunks = chunks_of(value);
        const expressions = chunks.filter((chunk): chunk is Expression => typeof chunk !== 'string');

        if (key.startsWith('bind:')) {
            return this.binding_attribute(name, value as BindingValue, owner, slot_index);
        }

        if (key.startsWith('on')) {
            const expression = expressions[0];

            return { code: `${name}: ${expression ? this.handler(expression) : 'undefined'}`, slot: false };
        }

        const parts = chunks.map((chunk) =>
            typeof chunk === 'string' ? escape_template(chunk) : '${' + chunk.raw + '}'
        );

        const deps = new Set<string>();
        for (const expression of expressions) add_all(deps, collect_reads(expression.content));

        if (owner) this.slots.push({ update: owner, index: slot_index, deps });

        return { code: `${name}: () => \`${parts.join('')}\``, slot: Boolean(owner) };
    }

    /** 事件处理器：复制原函数体，末尾追加受影响的片段刷新 */
    private handler(expression: Expression): string {
        const node = expression.content;

        if (node.type === 'Identifier') {
            const info = this.analysis?.functions.get(node.name);

            if (info) {
                const name = `${node.name}_$${++this.wrapper_counter}`;
                this.wrappers.push({ name, node: info.node, writes: info.writes });
                return name;
            }
        }

        if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
            const name = `__handler$${this.counter++}`;
            this.wrappers.push({ name, node, writes: collect_writes(node) });
            return name;
        }

        return expression.raw;
    }

    private children(nodes: TemplateNode[], owner: string | null): string[] {
        const items: string[] = [];

        for (const node of nodes) {
            const code = this.child(node, items.length, owner);
            if (code === null) continue;

            // 子组件会返回两项：实例本身 + 属性更新器
            if (Array.isArray(code)) items.push(...code);
            else items.push(code);
        }

        return items;
    }

    private child(node: TemplateNode, index: number, owner: string | null): string | string[] | null {
        switch (node.type) {
            case 'comment':
                return null;

            case 'text':
                return JSON.stringify(node.content);

            case 'expression':
                // 插槽里的表达式要插到子组件里去，没有父元素能挂它的片段，
                // 所以给它一个自己的文本节点，父组件拿到返回值就能刷新
                if (this.inside_slot) {
                    const name = `update$${this.counter++}`;

                    this.needs_text = true;
                    this.statements.push(`const ${name} = creText(() => (${node.raw}));`);

                    return name;
                }

                if (owner) this.slots.push({ update: owner, index, deps: collect_reads(node.content) });
                return `() => (${node.raw})`;

            case 'element':
                return this.element(node, owner, index);

            case 'IfBlock':
                return this.if_block(node, index, owner);

            case 'ForBlock':
                return this.for_block(node, index, owner);
        }
    }

    private if_block(node: IfBlock, index: number, owner: string | null): string {
        const deps = template_reads(node);

        // 分支内容由 if 片段自己返回，里面的表达式不单独注册片段
        const branches: Array<{ test: string | null; items: string[] }> = [
            { test: node.test.raw, items: this.children(node.children, null) }
        ];

        for (const alternate of node.alternates) {
            branches.push({
                test: alternate.test ? alternate.test.raw : null,
                items: this.children(alternate.children, null)
            });
        }

        const body = branches
            .map((branch, i) => {
                const keyword =
                    i === 0 ? `if (${branch.test})` : branch.test ? `else if (${branch.test})` : 'else';
                return `${keyword} { return [${branch.items.join(', ')}]; }`;
            })
            .join(' ');

        if (owner) this.slots.push({ update: owner, index, deps });

        return `() => { ${body} return []; }`;
    }

    private for_block(node: ForBlock, index: number, owner: string | null): string {
        const deps = template_reads(node);
        const item = `__item$${this.counter++}`;
        const right = this.slice(node.content.right.range);
        const left = node.content.left;

        // 循环头不写声明方式时（`{#for item of list}`）left 就是个模式，自己补 const
        const binding =
            left.type === 'VariableDeclaration'
                ? `${left.kind} ${this.slice(left.declarations[0].id.range)} = ${item};`
                : `const ${this.slice(left.range)} = ${item};`;

        // 每一项都要新建 DOM，所以块内的 creEle 放进 render 函数里，不注册片段
        const render = `render$${this.counter++}`;
        const [inner, inner_statements] = this.capture(() => this.children(node.children, null));

        let fallback = '[]';

        if (node.fallback) {
            // 空列表分支只创建一次，放在 render 外面
            const [items, statements] = this.capture(() => this.children(node.fallback!.children, null));
            fallback = `[${items.join(', ')}]`;
            this.statements.push(...statements);
        }

        this.statements.push(
            `const ${render} = (${item}) => {`,
            `  ${binding}`,
            ...inner_statements.map((line) => `  ${line}`),
            `  return [${inner.join(', ')}];`,
            '};'
        );

        if (owner) this.slots.push({ update: owner, index, deps });

        return `() => { const __nodes$${index} = []; for (const ${item} of ${right}) __nodes$${index}.push(...${render}(${item})); return __nodes$${index}.length ? __nodes$${index} : ${fallback}; }`;
    }

    /** 临时把生成语句收集到别处，用于 render 函数体 */
    private capture<T>(run: () => T): [T, string[]] {
        const saved = this.statements;
        const saved_fragment = this.inside_fragment;
        const inner: string[] = [];

        this.statements = inner;
        this.inside_fragment = true;

        try {
            return [run(), inner];
        } finally {
            this.statements = saved;
            this.inside_fragment = saved_fragment;
        }
    }

    private slice(range: [number, number]): string {
        return this.source.slice(range[0], range[1]);
    }
}

/** 把 Root 变成可执行的 JS（以及 CSS） */
export function generate(root: Root, source: string, options: CompileOptions = {}): CompileResult {
    const analysis = root.script ? analyze_script(root.script.content, source) : null;

    // `<style global>` 和没有样式的组件都不需要 scope 类名
    const scope_id =
        root.stylesheet && !is_global(root.stylesheet)
            ? create_scope_id(source, options.filename)
            : null;

    return new Generator(
        source,
        root,
        options.runtimeModule ?? 'grain',
        analysis,
        scope_id,
        options.filename ?? 'component.grain'
    ).run();
}
