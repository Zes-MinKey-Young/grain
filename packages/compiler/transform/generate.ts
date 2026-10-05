import type {
    AttributeValue,
    Element,
    Expression,
    ForBlock,
    IfBlock,
    Root,
    Script,
    TemplateNode
} from '../types.js';
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
                    if (value === true || typeof value === 'string') continue;
                    const chunks = Array.isArray(value) ? value : [value];
                    for (const chunk of chunks) {
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

function escape_template(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

class Generator {
    private statements: string[] = [];
    private slots: Slot[] = [];
    private wrappers: PendingWrapper[] = [];
    private counter = 0;
    private wrapper_counter = 0;
    private root_name = 'update$0';

    constructor(
        private source: string,
        private root: Root,
        private runtime: string,
        private analysis: ScriptAnalysis | null,
        /** 组件级样式的类名；`<style global>` 或没有样式时为 null */
        private scope_id: string | null
    ) {}

    run(): CompileResult {
        // 先定下根调度器的名字：bindactive 的 setter 要在最后触发它的全量刷新
        const root_name = `update$${this.counter++}`;
        this.root_name = root_name;

        this.fragment(this.root.template.children, root_name);

        const output: string[] = [`import { creEle, creFragment } from ${JSON.stringify(this.runtime)};`];

        if (this.root.module) {
            output.push('', '/* <script module> */', this.root.module.raw.trim());
        }

        if (this.root.script) {
            output.push('', '/* <script> */', this.script(this.root.script));
        }

        // 事件包装：原函数体 + 触发受影响的片段（README 里的 `increment_$1`）
        const wrappers = this.wrapper_statements();
        if (wrappers.length > 0) output.push('', ...wrappers);

        output.push('', '/* template */', ...this.statements);

        output.push(
            '',
            '/** 挂载组件。`mount.target` 留给 HMR 重新挂载用 */',
            'export default function mount(target) {',
            '  mount.target = target;',
            `  target.appendChild(${root_name}.el);`,
            `  return ${root_name};`,
            '}'
        );

        const stylesheet = this.root.stylesheet;
        const css = !stylesheet
            ? ''
            : this.scope_id
              ? scope_stylesheet(stylesheet, this.scope_id)
              : stylesheet.raw;

        return { js: output.join('\n'), css };
    }

    // ------------------------------------------------------------ script

    /** 去掉 `$state(...)` 包装，其余原样保留 */
    private script(block: Script): string {
        let code = block.raw;
        const offset = block.contentStart;

        const states = [...(this.analysis?.states.values() ?? [])].sort((a, b) => b.range[0] - a.range[0]);

        for (const state of states) {
            const start = state.range[0] - offset;
            const end = state.range[1] - offset;
            code = code.slice(0, start) + state.init + code.slice(end);
        }

        return code.trim();
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
                const source = this.slice(node.body.range);
                body = updates ? `${source.slice(0, -1)} ${updates}}` : source;
            } else {
                body = `{ ${this.slice(node.body.range)}${updates ? `; ${updates}` : ''} }`;
            }

            output.push(`const ${wrapper.name} = ${head} ${body};`);
        }

        return output;
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

        const chunks = Array.isArray(existing) ? existing : [existing];

        return { ...attributes, class: [...chunks, ` ${scope}`] };
    }

    private element(node: Element): string {
        const name = `update$${this.counter++}`;
        const items = this.children(node.children, name);

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

    /** 生成一个属性；`slot` 表示它占用了一个动态片段编号 */
    private attribute(
        key: string,
        value: AttributeValue | true,
        owner: string,
        slot_index: number
    ): { code: string; slot: boolean } {
        const name = JSON.stringify(key);

        if (value === true) return { code: `${name}: true`, slot: false };
        if (typeof value === 'string') return { code: `${name}: ${JSON.stringify(value)}`, slot: false };

        const chunks = Array.isArray(value) ? value : [value];
        const expressions = chunks.filter((chunk): chunk is Expression => typeof chunk !== 'string');

        // README 第 4 条：源不是响应式变量，编译期算不出谁依赖它，
        // 所以 setter 之后直接让根调度器全量刷新（运行时也会重跑 getter）
        if (key.startsWith('bindactive:')) {
            const expression = expressions[0];

            return {
                code: expression
                    ? `${name}: { get: () => (${expression.raw}), set: ($value) => { ${expression.raw} = $value; ${this.root_name}(); } }`
                    : `${name}: { get: () => undefined, set: () => {} }`,
                slot: false
            };
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

        this.slots.push({ update: owner, index: slot_index, deps });

        return { code: `${name}: () => \`${parts.join('')}\``, slot: true };
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
            if (code !== null) items.push(code);
        }

        return items;
    }

    private child(node: TemplateNode, index: number, owner: string | null): string | null {
        switch (node.type) {
            case 'comment':
                return null;

            case 'text':
                return JSON.stringify(node.content);

            case 'expression':
                if (owner) this.slots.push({ update: owner, index, deps: collect_reads(node.content) });
                return `() => (${node.raw})`;

            case 'element':
                return this.element(node);

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

        const binding =
            left.type === 'VariableDeclaration'
                ? `${left.kind} ${this.slice(left.declarations[0].id.range)} = ${item};`
                : `${this.slice(left.range)} = ${item};`;

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
        const inner: string[] = [];

        this.statements = inner;

        try {
            return [run(), inner];
        } finally {
            this.statements = saved;
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

    return new Generator(source, root, options.runtimeModule ?? 'grain', analysis, scope_id).run();
}
