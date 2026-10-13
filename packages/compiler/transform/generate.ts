// 这个包标了 `__esModule` 却没有 default 导出，所以只能具名导入：
// 默认导入在 CJS 下拿到的是 undefined（扩展就是 CJS 编译的）
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
// npm 上的 typescript 是 CommonJS：ESM 里具名导入它，Node 认不出具名导出
// （打包工具会替我们转换，但发布出去的 dist 是直接被 Node 加载的）
import ts from 'typescript';

const { transpileModule, ModuleKind, ScriptTarget } = ts;

import { parseInline } from '../nodes.js';
import { ParseError } from '../errors.js';

import {
    analyzeScript,
    collectReads,
    collectWrites,
    intersects,
    type FunctionLike,
    type ScriptAnalysis
} from './analyze.js';
import { createScopeId, isGlobal, scopeStylesheet } from './style.js';

export interface CompileOptions {
    /** 运行时模块路径，默认 `@graints/runtime` */
    runtimeModule?: string;
    /** 文件名，参与 scope id 计算 */
    filename?: string;
    /**
     * 开发模式。
     *
     * 会往刷新函数里埋循环检测点（`guard`），循环了就在运行时抛 ——
     * 编译期抓不到的那些环（store 通知、条件分支）靠它兜底。产物会变大一点，
     * 所以只有 dev 下埋。
     */
    dev?: boolean;
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

function addAll(target: Set<string>, source: Set<string>): void {
    for (const value of source) target.add(value);
}

/** 收集一棵模板子树里出现过的所有 state 读取 */
function templateReads(node: TemplateNode): Set<string> {
    const names = new Set<string>();

    const visit = (current: TemplateNode): void => {
        // 单向绑定（模板插值 / 属性值）：读的是它的 get / 变量形式
        if (!('type' in current)) {
            const binding = current as BindingValue;
            const source = binding.get ?? binding.expression;

            if (source) addAll(names, collectReads(source.content));
            if (binding.listen) addAll(names, collectReads(binding.listen.content));

            return;
        }

        switch (current.type) {
            case 'expression':
                addAll(names, collectReads(current.content));
                break;

            case 'element':
                for (const value of Object.values(current.attributes)) {
                    for (const chunk of chunksOf(value)) {
                        if (typeof chunk !== 'string') addAll(names, collectReads(chunk.content));
                    }
                }
                current.children.forEach(visit);
                break;

            case 'IfBlock':
                addAll(names, collectReads(current.test.content));
                for (const alternate of current.alternates) {
                    if (alternate.test) addAll(names, collectReads(alternate.test.content));
                    alternate.children.forEach(visit);
                }
                current.children.forEach(visit);
                break;

            case 'ForBlock':
                addAll(names, collectReads(current.content.right));
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

function isChildren(property: unknown): boolean {
    const node = property as { type?: string; key?: { type?: string; name?: string } };

    return node?.key?.type === 'Identifier' && node.key.name === 'children';
}

/** 找出 `$props()`：调用位置 + 解构模式 */
function findProps(script: Script | null): PropsInfo | null {
    if (!script) return null;

    for (const statement of script.content.body) {
        if (statement.type !== 'VariableDeclaration') continue;

        for (const declarator of statement.declarations) {
            const init = declarator.init;

            if (init?.type !== 'CallExpression') continue;
            if (init.callee.type !== 'Identifier' || init.callee.name !== '$props') continue;

            const info: PropsInfo = { call: init.range, id: null, keep: [], names: [] };

            if (declarator.id.type === 'ObjectPattern') {
                const kept = declarator.id.properties.filter((property) => !isChildren(property));

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
    statementEnd: number;
}

/** script 源码里的一处改写，区间是相对 script 内容开头的原始偏移 */
interface Edit {
    start: number;
    end: number;
    text: string;
}

/** 从后往前应用，前面的改写不会影响后面区间的计算 */
function applyEdits(code: string, edits: Edit[], base: number): string {
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
function findBindables(block: Script, source: string): BindableInfo[] {
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
                    statementEnd: statement.range[1]
                });
            }
        }
    }

    return found;
}

/** `+=` -> `+`、`??=` -> `??`：把赋值运算符还原成二元运算符 */
function binaryOperator(operator: string): string {
    return operator.slice(0, -1);
}

/**
 * 能精确定位到"动了哪几行"的容器方法。
 *
 * `reverse` / `sort` / `fill` 之类的改动是全局的，没有"受影响的行"可言 —— 它们仍然
 * 走整块比对。
 */
const LIST_MUTATIONS = new Set(['push', 'pop', 'shift', 'unshift', 'splice']);

/**
 * Map / Set 上那些"按一个键就能定位到某一项"的方法。
 *
 * 数组的方法是按位置（`setAt(i, v)`），这两个是按键（`setKey(k, v)`）—— 所以只有写了
 * `with key = ...` 的 for 才认，否则说不清是哪一项，退回整块比对。
 */
const KEYED_MUTATIONS = new Set(['set', 'add', 'delete', 'clear']);

/** 这些工厂造出来的是"自己会通知改动"的容器 */
const REACTIVE_FACTORIES = new Set(['reactiveArray', 'reactiveMap', 'reactiveSet']);

/**
 * 找出用 `reactiveArray(...)` 之类声明的变量。
 *
 * 它们自己知道动了什么，所以 `for` 订阅它就行 —— 不用编译期去猜。
 */
function reactiveContainersIn(root: Root): Set<string> {
    const names = new Set<string>();

    for (const block of [root.script, root.module]) {
        if (!block) continue;

        for (const statement of block.content.body) {
            if (statement.type !== 'VariableDeclaration') continue;

            for (const item of statement.declarations) {
                const init = item.init;

                if (item.id.type !== 'Identifier') continue;
                if (init?.type !== 'CallExpression') continue;
                if (init.callee.type !== 'Identifier') continue;
                if (!REACTIVE_FACTORIES.has(init.callee.name)) continue;

                names.add(item.id.name);
            }
        }
    }

    return names;
}

/**
 * `for` 的源是不是"直接就是这个容器变量"。
 *
 * 只认 `items` —— 这样 `items.push(x)` 才能换成列表自己的 `push`。
 * `items.entries()` 也指向同一个容器，但它的每一项是 `[index, value]`：加一项会让
 * 后面所有项的索引都变，不是"追加一行"那么简单，所以它走整块比对。
 * 别的（`list.filter(...)`、`a.concat(b)`）一概不认。
 */
function sourceVariableOf(right: TSESTree.Expression): string | null {
    if (right.type === 'Identifier') return right.name;

    // `items.entries()` 也认：项是 `[下标, 值]`，而**追加 / 删末尾不动前面那些项的下标**
    // —— 所以 `push` / `pop` 依然能精确（`shift` / `unshift` / `splice` 会让所有下标
    // 变，那种走整块比对，见 mutationCalls 里的 forShifted）
    if (
        right.type === 'CallExpression' &&
        right.callee.type === 'MemberExpression' &&
        right.callee.property.type === 'Identifier' &&
        right.callee.property.name === 'entries' &&
        right.callee.object.type === 'Identifier'
    ) {
        return right.callee.object.name;
    }

    return null;
}

function isFunctionLike(node: TSESTree.Node): node is FunctionLike {
    return (
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression' ||
        node.type === 'FunctionDeclaration'
    );
}

/** `A && B && C` -> `['A', 'B', 'C']`（带括号的整体算一个条件） */
function splitAnd(node: TSESTree.Node, source: string): string[] {
    if (node.type === 'LogicalExpression' && node.operator === '&&') {
        return [...splitAnd(node.left, source), ...splitAnd(node.right, source)];
    }

    return [source.slice(node.range[0], node.range[1])];
}

/** 谓词合并出来的 if 树：一层是一个条件，叶子是要跑的槽位 */
interface ListenBranch {
    /** 走到这一步就该跑的槽位（没有更多条件了） */
    leaves: number[];
    /** 条件 -> 下一层 */
    branches: Map<string, ListenBranch>;
}

/**
 * 把一组槽位的条件链织成一棵树。
 *
 * `A && B` 和 `A && C` 共用 A 那一层，于是 A 只求一次：
 * `if (A) { if (B) { … } if (C) { … } }`
 */
function buildBranch(slots: Array<{ chain: string[] }>): ListenBranch {
    const root: ListenBranch = { leaves: [], branches: new Map() };

    slots.forEach((slot, index) => {
        let at = root;

        for (const condition of slot.chain) {
            let next = at.branches.get(condition);

            if (!next) {
                next = { leaves: [], branches: new Map() };
                at.branches.set(condition, next);
            }

            at = next;
        }

        at.leaves.push(index);
    });

    return root;
}

function emitBranch(node: ListenBranch, slots: string): string {
    const parts: string[] = [];

    for (const leaf of node.leaves) parts.push(`${slots}[${leaf}]?.();`);
    for (const [condition, child] of node.branches) {
        parts.push(`if (${condition}) { ${emitBranch(child, slots)} }`);
    }

    return parts.join(' ');
}

/** 绑定值没有 `type` 字段，表达式有 */
function isBindingValue(value: string | Expression | BindingValue): value is BindingValue {
    return typeof value === 'object' && value !== null && !('type' in value);
}

/**
 * 属性值里的文本 / 表达式片段。
 * 绑定值不算在里面 —— 它走 `bindingAttribute` 那条路。
 */
function chunksOf(value: AttributeValue | true): Array<string | Expression> {
    if (value === true || typeof value === 'string') return [];
    if (Array.isArray(value)) return value.filter((chunk) => !isBindingValue(chunk));
    if (isBindingValue(value)) return [];

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
function isComponentName(name: string): boolean {
    return /^[A-Z]/.test(name) || name.includes('.');
}

function escapeTemplate(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function isIdentifier(text: string): boolean {
    return /^[A-Za-z_$][\w$]*$/.test(text);
}

/** 子树里有没有用到这些变量 */
function mentions(node: TSESTree.Node, names: Set<string>): boolean {
    let found = false;

    simpleTraverse(node, {
        enter: (child) => {
            if (child.type === 'Identifier' && names.has(child.name)) found = true;
        }
    });

    return found;
}

/**
 * 这些变量在 `node` 里的写入是不是**全是赋值**。
 *
 * `x = v`、`x += v`、`x++` 用"新旧值比一比"就知道有没有变；
 * 但 `arr.push(v)` 改的是引用里面的内容，变量本身一直相等 ——
 * 有这种写法就别加比较，老老实实刷新，否则列表永远不会更新。
 */
function writesAreAssignments(node: TSESTree.Node, names: Set<string>): boolean {
    if (names.size === 0) return false;

    let plain = true;

    simpleTraverse(node, {
        enter: (child) => {
            if (child.type === 'CallExpression') {
                const object = child.callee.type === 'MemberExpression' ? child.callee.object : null;

                if (object?.type === 'Identifier' && names.has(object.name)) plain = false;

                return;
            }

            if (child.type === 'AssignmentExpression') {
                // 给别的变量赋值无所谓；目标变量被赋成别的东西（obj.x、[a]）就算不了
                if (child.left.type === 'Identifier' && names.has(child.left.name)) return;
                if (mentions(child.left, names)) plain = false;

                return;
            }

            if (child.type === 'UpdateExpression') {
                if (child.argument.type === 'Identifier' && names.has(child.argument.name)) return;
                if (mentions(child.argument, names)) plain = false;
            }
        }
    });

    return plain;
}

class Generator {
    private statements: string[] = [];
    private slots: Slot[] = [];
    private wrappers: PendingWrapper[] = [];
    /**
     * `bind:` 的 setter。要等所有片段都收集完才知道刷新哪些，
     * 所以先记下"拿到 update 调用之后怎么渲染"。
     */
    private pendingBinds: Array<{
        name: string;
        /** `names` 是这次写入涉及到的响应式变量，用来生成"值没变就不刷新"的判断 */
        render: (updates: string, names: string[]) => string;
        writes: Set<string>;
    }> = [];
    /**
     * 简写 `listen(bus, "event", guard)` 按「总线 + 事件」分到一组。
     *
     * 同组的只挂**一次**监听：每个绑定把自己的 update 存进槽位数组
     * （运行时挂载时填），再由组里那一个 handler 按谓词决定叫谁。
     */
    private listenGroups: Array<{
        bus: string;
        event: string;
        slots: Array<{ chain: string[]; params: string[] }>;
    }> = [];
    private counter = 0;
    private wrapperCounter = 0;
    private prevCounter = 0;
    private rootName = 'update$0';
    /** `$bindable` 声明的双向绑定 prop */
    private bindables: BindableInfo[] = [];
    /**
     * `$bindable` 变量的写入改写（SFC 绝对偏移）。
     * script 和事件包装都要用——包装是复制函数体，不改写的话子组件写不回父组件。
     */
    private bindableEdits: Edit[] = [];
    /**
     * 是否处在"每次重建都会重新创建"的上下文里（for 块、组件插槽）。
     * 这里面的片段不用注册——重建后旧节点就失效了，注册了只会产生无效的 update 调用。
     */
    private insideFragment = false;
    /** 正在生成插槽内容：这里的 `{expr}` 得有自己的文本节点，父组件才能刷新它 */
    private insideSlot = false;
    /** 用到了 creText */
    private needsText = false;
    /** 用到了 creBound（单向属性 / 模板插值的绑定） */
    private needsBound = false;
    /** 用到了 creList（`{#for ...}`） */
    private needsList = false;
    /**
     * 容器变量 -> 那个 `for` 产出的列表。
     *
     * 只有"of 后面直接跟着这个变量"（或它的 `entries()`）才登记 —— 改的就是这个
     * 容器，才能换成精确的 `push` / `splice` 调用。
     */
    private forSources = new Map<string, string[]>();
    /** 每个 for 在父级里的片段坐标：精确调用顶掉它之后，就别再让它 sync 一遍 */
    private forSlots = new Map<string, { update: string; index: number }>();
    /** 哪些列表写了 `with key = ...`：只有它们能按键定位（Map / Set 的方法要靠这个） */
    private forKeyed = new Set<string>();
    /**
     * 哪些列表的项**带下标**（`{#for [i, x] of items.entries()}`）。
     *
     * 这种只有 `push` / `pop` 能精确 —— 别的会让所有项的下标都变。
     */
    private forShifted = new Set<string>();
    /** `reactiveArray(...)` 之类声明的变量：它们自己会通知改动 */
    private readonly reactiveContainers: Set<string>;
    /** `$props()` 解构出来的变量，生成 `setProps` 要用 */
    private propNames: Array<{ name: string; key: string }> = [];
    /**
     * `bind:this={x}` 里由它自己声明的变量名。
     *
     * 写标识符时不需要（也不该）在 `<script>` 里先声明；只有 `<script onmount>` 能看见。
     */
    private thisNames = new Set<string>();
    /** script / module 里声明过的名字（算一次就够） */
    private declared: Set<string> | null = null;
    /**
     * 已经自带刷新的顶层函数（写了 `$state` 的那些）。
     *
     * 刷新写在函数自己身上，而不是挂在调用处 —— 这样谁调用它都会刷新
     * （事件处理器、箭头函数、onmount、定时器……），也不用去改调用点的名字。
     */
    private wrappedFunctions = new Set<string>();
    /** `$bindable` 变量 -> 它的刷新函数名 */
    private refreshNames = new Map<string, string>();
    /** 待生成的刷新函数（要等片段收集完才知道刷哪些） */
    private pendingRefreshes: Array<{ name: string; deps: Set<string> }> = [];
    /** 刷新函数开头要跑的赋值（`$node` 的重算） */
    private refreshAssigns = new Map<string, string>();
    /** `$node`：源变量 -> 重算它的刷新函数 */
    private nodeTriggers: Array<{ refresh: string; deps: Set<string> }> = [];
    /** `$node` 的变量名 -> 读写对 / 刷新函数（写入改写要用） */
    private nodePairs = new Map<string, { pair: string; refresh: string; set: boolean }>();
    /** `$node` 变量 -> 它的 `get` 读了哪些变量（环检测用，也决定谁来触发重算） */
    private nodeDeps = new Map<string, Set<string>>();
    /** `$node` 变量 -> 声明语句的位置（环检测报错要指到那儿） */
    private nodeSpans = new Map<string, [number, number]>();
    /** `$node` 变量的写入改写（事件处理器复制函数体时也要应用） */
    private nodeWriteEdits: Edit[] = [];
    /** `$node` 的订阅：等元素建好再挂 */
    private nodeListens: Array<{ pair: string; refresh: string }> = [];
    /** 容器的精确调用（`list.push(...)`），紧跟在原调用之后插入 */
    private mutationEdits: Edit[] = [];


    constructor(
        private source: string,
        private root: Root,
        private runtime: string,
        private analysis: ScriptAnalysis | null,
        /** 组件级样式的类名；`<style global>` 或没有样式时为 null */
        private scopeId: string | null,
        private filename: string,
        /** 开发模式：往刷新函数里埋循环检测点 */
        private dev: boolean
    ) {
        this.reactiveContainers = reactiveContainersIn(root);
    }

    run(): CompileResult {
        // 先定下根调度器的名字：bindactive 的 setter 要在最后触发它的全量刷新
        const rootName = `update$${this.counter++}`;
        this.rootName = rootName;

        this.fragment(this.root.template.children, rootName);

        // script 要先处理：`$bindable` 会决定要不要 import toBinding
        const parts = this.root.script ? this.script(this.root.script) : { head: [], body: '' };
        // onmount 跟 script 走同一套处理（`$state` 展开、`$props()` 换成 props）
        const onmount = this.root.onmount ? this.script(this.root.onmount) : null;

        const imported = ['creEle', 'creFragment', 'component'];
        if (this.bindables.length > 0) imported.push('toBinding');
        if (this.needsText) imported.push('creText');
        if (this.needsBound) imported.push('creBound');
        if (this.needsList) imported.push('creList');
        if (this.dev && this.pendingRefreshes.length > 0) imported.push('guard');

        const output: string[] = [`import { ${imported.join(', ')} } from ${JSON.stringify(this.runtime)};`];

        if (this.root.module) {
            output.push('', '/* <script module> */', this.root.module.raw.trim());
        }

        // import / export 留在模块顶层
        if (parts.head.length > 0) output.push('', ...parts.head);
        if (onmount && onmount.head.length > 0)
            output.push('', '/* <script onmount> 的 import */', ...onmount.head);

        // 实例代码：每个组件实例各跑一遍，所以放进 create()
        const instance: string[] = [];

        if (parts.body) {
            instance.push('/* <script> */', parts.body);
        }

        // 事件包装：原函数体 + 触发受影响的片段（README 里的 `increment_$1`）
        const wrappers = this.wrapperStatements();
        if (wrappers.length > 0) instance.push('', ...wrappers);

        // bind: 的 setter
        const binds = this.bindStatements();
        if (binds.length > 0) instance.push('', ...binds);

        // $bindable 非受控时的刷新函数
        const refreshes = this.refreshStatements();
        if (refreshes.length > 0) instance.push('', ...refreshes);

        // `bind:this={x}` 声明的变量：放在这里，模板里的赋值才够得着
        if (this.thisNames.size > 0) {
            instance.push('', `/* bind:this 声明的变量 */`, `let ${[...this.thisNames].join(', ')};`);
        }

        // 槽位数组要在元素创建之前声明——元素创建时会往里填各自的 update
        const listenSlots = this.listenSlotDeclarations();
        if (listenSlots.length > 0) instance.push('', ...listenSlots);

        instance.push('', '/* template */', ...this.statements);

        // `$node` 的订阅：元素建好之后才挂（刷新函数要用到它们）
        if (this.nodeListens.length > 0) {
            instance.push(
                '',
                ...this.nodeListens.map((item) => `${item.pair}.listen?.(${item.refresh});`)
            );
        }

        // 监听本身等元素都建好再挂：同一总线 + 同一事件只挂一次，谓词合并成 if 树
        const listens = this.listenRegistrations();
        if (listens.length > 0) instance.push('', '/* 合并的事件监听 */', ...listens);

        // 静态看得出来的环：直接报错，别让它过编译
        this.checkReactiveCycles();

        // 属性修改触发器：得等所有片段都收集完，才知道 props 变了要刷哪些
        const setProps = this.propsStatements();
        if (setProps.length > 0) instance.push('', ...setProps);

        // 挂上之后才跑：这时候 bind:this 的变量已经被赋上元素了
        if (onmount && onmount.body) {
            // onmount 里的顶层写 $state 也算数据流动 —— 挂载完立刻安排一次刷新。
            // （里面定义的**函数**本来就有刷新，走的是 wrapper 那条路）
            const writes = collectWrites(this.root.onmount!.content);
            const reactive = [...this.reactiveWrites(writes)];
            const updates = this.updateCalls(new Set(reactive));

            instance.push(
                '',
                '/* <script onmount> */',
                `${rootName}.onmount = () => {`,
                onmount.body,
                updates ? ` ${updates}` : '',
                '};'
            );
        }

        // 套一层稳定的外壳：HMR 换实例时只换里面，父组件持有的引用不动
        instance.push('', `return component(${rootName}, create, props, children);`);

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
            // 子组件那一份由运行时在挂上时调（见 runtime 的 create）
            '  update.onmount?.();',
            '  return update;',
            '}',
            'mount.create = create;'
        );

        const stylesheet = this.root.stylesheet;
        const css = !stylesheet
            ? ''
            : this.scopeId
              ? scopeStylesheet(stylesheet, this.scopeId)
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

        // 0. 宏展开：script 里的宏调用换成宏返回的源码
        edits.push(
            ...this.root.replacements.filter(
                (item) => item.start >= block.contentStart && item.end <= block.contentEnd
            )
        );

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
            // 派生局部变量（`const minkey = arr[2]`）没有 `$state(...)` 调用要替换，
            // 它只是"写它等于写根上那个"的登记
            if (state.fromPath) continue;

            edits.push({ start: state.range[0], end: state.range[1], text: state.init });
        }

        // 3. `$props()` -> `props`
        const props = findProps(block);
        const bindables = props ? findBindables(block, this.source) : [];

        this.bindables = bindables;
        if (props) this.propNames = props.names;

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
        this.bindableEdits = this.bindableWrites(block, bindables);
        edits.push(...this.bindableEdits);

        // 5. `$node(...)` -> 读写对 + 变量；它的写入走 setter（没有 `set` 就报错）
        edits.push(...this.nodeDeclarations(block));

        this.nodeWriteEdits = this.nodeWrites(block);
        edits.push(...this.nodeWriteEdits);

        // 5.5 写了 `$state` 的顶层函数：刷新直接写进函数体
        edits.push(...this.functionWrappers(block));

        // 6. 读写对的声明，插在 `let { ... } = $props()` 之后
        for (const bindable of bindables) {
            const { start, end } = { start: bindable.statementEnd, end: bindable.statementEnd };

            edits.push({
                start,
                end,
                text: `\nconst ${bindable.binding} = toBinding(props[${JSON.stringify(bindable.prop)}], ${bindable.fallback});\nlet ${bindable.name} = ${bindable.binding}.get();`
            });
        }

        return { head, body: applyEdits(block.raw, edits, block.contentStart).trim() };
    }

    /**
     * `$bindable` 变量的写入，两条路分开走：
     *
     * ```js
     * a++;
     * // ->
     * if (__binding$a.external) __binding$a.set(a + 1);        // 受控：值归父组件管，只推过去
     * else { const __next$1 = a + 1; if (__next$1 !== a) { a = __next$1; __refresh$a(); } }
     * ```
     */
    private bindableWrites(block: Script, bindables: BindableInfo[]): Edit[] {
        if (bindables.length === 0) return [];

        const byName = new Map(bindables.map((bindable) => [bindable.name, bindable]));
        const edits: Edit[] = [];
        let nextCounter = 0;

        /** 每个变量一个"刷新依赖它的片段"的函数，片段收集完之后才生成 */
        const refreshOf = (name: string): string => {
            const existing = this.refreshNames.get(name);
            if (existing) return existing;

            const generated = `__refresh$${this.counter++}`;

            this.refreshNames.set(name, generated);
            this.pendingRefreshes.push({ name: generated, deps: new Set([name]) });

            return generated;
        };

        /** 这次写入：变量名、新值的表达式、读写对 */
        const readWrite = (
            node: TSESTree.Node
        ): { name: string; value: string; binding: string } | null => {
            if (node.type === 'AssignmentExpression') {
                if (node.left.type !== 'Identifier') return null;

                const bindable = byName.get(node.left.name);
                if (!bindable) return null;

                const right = this.slice(node.right.range);
                const value =
                    node.operator === '='
                        ? right
                        : `${node.left.name} ${binaryOperator(node.operator)} ${right}`;

                return { name: node.left.name, value, binding: bindable.binding };
            }

            if (node.type === 'UpdateExpression') {
                if (node.argument.type !== 'Identifier') return null;

                const bindable = byName.get(node.argument.name);
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
                const write = readWrite(node);
                if (!write) return;

                const { name, value, binding } = write;

                // 赋值语句：展开成 if / else 两条路。
                // 非受控那一路比一下新旧值 —— 值没变就别刷新（受控那一路交给父组件的 setter 比）
                if (parent?.type === 'ExpressionStatement') {
                    const next = `__next$${++nextCounter}`;

                    edits.push({
                        start: parent.range[0],
                        end: parent.range[1],
                        text:
                            `if (${binding}.external) ${binding}.set(${value}); ` +
                            `else { const ${next} = ${value}; if (${next} !== ${name}) { ${name} = ${next}; ${refreshOf(name)}(); } }`
                    });

                    return;
                }

                // 塞在表达式里的写入（`f(a = 1)` 这种）展开不成语句，用三元
                edits.push({
                    start: node.range[0],
                    end: node.range[1],
                    text: `(${binding}.external ? ${binding}.set(${value}) : (${name} = ${value}, ${refreshOf(name)}()))`
                });
            }
        });

        return edits;
    }

    /**
     * 非受控时 `$bindable` 就是个普通变量，改完得自己刷依赖它的片段。
     * 用 function 声明（会提升），这样 script 顶层的写入也不会踩到 TDZ。
     */
    private refreshStatements(): string[] {
        return this.pendingRefreshes.map((refresh) => {
            const updates = this.updateCalls(refresh.deps);
            // `$node` 的刷新函数：先重算这个节点
            const assign = this.refreshAssigns.get(refresh.name) ?? '';
            // dev 下埋个检测点：真循环起来，运行时会抛
            const guard = this.dev ? `guard(${JSON.stringify(refresh.name)}); ` : '';

            return `function ${refresh.name}() {${guard}${assign ? ` ${assign}` : ''}${updates ? ` ${updates}` : ' '}}`;
        });
    }

    /**
     * 响应式循环里**静态看得出来**的那部分。
     *
     * `$node` 之间互相依赖时，重算链自己就成环了（`x` 的 `get` 读 `y`，`y` 又读 `x`），
     * 跑起来必然停不下来 —— 这种编译期就能定下来，直接报错，别让它过编译。
     *
     * 靠运行时的条件分支或者 store 通知才成立的环抓不到（那些路径静态看不见），
     * 交给 dev 下埋的 `guard`。
     */
    private checkReactiveCycles(): void {
        if (this.nodeDeps.size === 0) return;

        const done = new Set<string>();
        const visiting = new Set<string>();
        const stack: string[] = [];

        const visit = (name: string): void => {
            if (done.has(name)) return;

            if (visiting.has(name)) {
                const cycle = [...stack.slice(stack.indexOf(name)), name];
                const [start, end] = this.nodeSpans.get(name) ?? [0, 0];

                throw new ParseError(
                    `Reactive loop: ${cycle.join(' -> ')} — each one reads the next, so recomputing never settles`,
                    start,
                    end
                );
            }

            visiting.add(name);
            stack.push(name);

            for (const read of this.nodeDeps.get(name) ?? []) {
                // 只有读的是另一个 `$node` 才可能成环：普通 $state 不会自己重算
                if (this.nodeDeps.has(read)) visit(read);
            }

            stack.pop();
            visiting.delete(name);
            done.add(name);
        };

        for (const name of this.nodeDeps.keys()) visit(name);
    }

    /**
     * 写了 `$state` 的顶层函数：把 `function later() { ... }` 换成
     * `const later = function later() { ... 刷新 }`。
     *
     * 名字不变，所以调用处一个字都不用改 —— 无论谁调用它（事件、箭头函数、onmount、
     * 定时器）都会刷新。之前只有直接挂在事件属性上的函数才带刷新。
     */
    private functionWrappers(block: Script): Edit[] {
        const edits: Edit[] = [];

        for (const [name, info] of this.analysis?.functions ?? []) {
            const node = info.node;

            if (node.type !== 'FunctionDeclaration' || !node.id) continue;
            if (node.range[0] < block.contentStart || node.range[1] > block.contentEnd) continue;

            const reactive = [...this.reactiveWrites(info.writes)];
            if (reactive.length === 0) continue;

            // 容器方法（`items.push(x)` / `items[i] = v`）换成列表自己的精确调用，
            // 并顶掉整块比对。这些插入紧跟原语句，所以先登记再取函数体
            const mutations = this.mutationCalls(node);

            this.mutationEdits = mutations.edits;

            const params = node.params.map((param) => this.slice(param.range)).join(', ');
            // 去掉外层花括号，交给 guardChanges 重新包一层
            const inner = this.bodySource(node.body.range).slice(1, -1);
            const updates = this.updateCalls(new Set(reactive), mutations.skip);

            this.mutationEdits = [];

            const body = this.guardChanges(
                reactive,
                updates,
                // 用**原始**写入名判断，不是换成根名之后的：派生局部变量
                // （`const minkey = arr[2]`）写的是 `minkey.name`，提到的是 `minkey`，
                // 换成 `arr` 之后就查不到它了 —— 而那种改动引用不变、内容变了，
                // 加上"新旧值比一比"的守卫就会把刷新挡掉
                writesAreAssignments(node, info.writes),
                inner
            );

            edits.push({
                start: node.range[0],
                end: node.range[1],
                text: `const ${name} = function ${name}(${params}) {${body}}`
            });

            this.wrappedFunctions.add(name);
        }

        return edits;
    }

    /**
     * `$node` 变量的写入：有 `set` 就走 setter，没有就报错——单向就是单向。
     *
     * ```js
     * shown = 'x';   // ->  shown = __node$1.set('x'); __refresh$2();
     * shown++;       // ->  shown = __node$1.set(shown + 1); __refresh$2();
     * ```
     */
    private nodeWrites(block: Script): Edit[] {
        if (this.nodePairs.size === 0) return [];

        const edits: Edit[] = [];

        for (const statement of block.content.body) {
            simpleTraverse(statement as unknown as TSESTree.Node, {
                enter: (node, parent) => {
                    const target =
                        node.type === 'AssignmentExpression' && node.left.type === 'Identifier'
                            ? node.left.name
                            : node.type === 'UpdateExpression' && node.argument.type === 'Identifier'
                              ? node.argument.name
                              : null;

                    if (!target) return;

                    const entry = this.nodePairs.get(target);
                    if (!entry) return;

                    if (!entry.set) {
                        throw new ParseError(
                            `\`${target}\` is a one-way \`$node\` — give it a \`set\` to write through it`,
                            node.range[0],
                            node.range[1]
                        );
                    }

                    let value: string;

                    if (node.type === 'UpdateExpression') {
                        value = `${target} ${node.operator === '++' ? '+' : '-'} 1`;
                    } else {
                        const right = (node as TSESTree.AssignmentExpression).right;

                        value = this.source.slice(right.range[0], right.range[1]);
                    }

                    const assign = `${target} = ${entry.pair}.set(${value})`;

                    if (parent?.type === 'ExpressionStatement') {
                        edits.push({
                            start: parent.range[0],
                            end: parent.range[1],
                            text: `${assign}; ${entry.refresh}();`
                        });

                        return;
                    }

                    // 塞在表达式里的写入展开不成语句，用逗号
                    edits.push({
                        start: node.range[0],
                        end: node.range[1],
                        text: `(${assign}, ${entry.refresh}())`
                    });
                }
            });
        }

        return edits;
    }

    /**
     * `$node(...)`：声明换成读写对，变量名照旧。
     *
     * 变量还是个普通变量（`{doubled}` 照常读它），刷新函数负责"重算 + 刷依赖它的片段"，
     * 所以源变量一变就调那个刷新函数（见 `updateCalls`）。
     */
    private nodeDeclarations(block: Script): Edit[] {
        const edits: Edit[] = [];

        const nodes = this.root.nodes.filter(
            (node) => node.statement[0] >= block.contentStart && node.statement[1] <= block.contentEnd
        );

        for (const node of nodes) {
            const pair = `__node$${this.counter++}`;
            const refresh = `__refresh$${this.counter++}`;
            // 没有 `get` 时值由 listener 推，得有个地方放
            const current = node.get ? null : `__current$${this.counter++}`;

            const parts: string[] = [node.get ? `get: ${node.get}` : `get: () => ${current}`];

            if (node.set) parts.push(`set: ${node.set}`);
            if (node.active) parts.push('active: true');

            if (node.listen) {
                parts.push(
                    current
                        ? `listen: (__update) => (${node.listen})((__value) => { if (__value !== undefined) ${current} = __value; __update(); })`
                        : `listen: ${node.listen}`
                );
            }

            // 订阅等元素都建好再挂（见 instance 里的 nodeListens）——
            // 这时候调的话，刷新函数里引用的 update$N 还没声明
            this.nodeListens.push({ pair, refresh });

            const lines = [
                ...(current ? [`let ${current};`] : []),
                `const ${pair} = { ${parts.join(', ')} };`,
                `let ${node.name} = ${pair}.get();`
            ];

            edits.push({ start: node.statement[0], end: node.statement[1], text: lines.join('\n') });

            this.nodePairs.set(node.name, { pair, refresh, set: Boolean(node.set) });

            const deps = node.get ? collectReads(parseInline(node.get)) : new Set<string>();

            this.nodeDeps.set(node.name, deps);
            this.nodeSpans.set(node.name, node.statement);

            this.pendingRefreshes.push({ name: refresh, deps: new Set([node.name]) });
            this.refreshAssigns.set(refresh, `${node.name} = ${pair}.get();`);
            this.nodeTriggers.push({ refresh, deps });
        }

        return edits;
    }


    /** 函数体源码；`$bindable` 的写入顺带改成读写对调用 */
    private bodySource(range: [number, number]): string {
        const [from, to] = range;

        // `$bindable` 的写入改写、`$node` 的写入改写、容器的精确调用，都算进去
        const edits = [...this.bindableEdits, ...this.nodeWriteEdits, ...this.mutationEdits];

        if (edits.length === 0) return this.source.slice(from, to);

        const inside = edits.filter((edit) => edit.start >= from && edit.end <= to);

        return applyEdits(this.source.slice(from, to), inside, from);
    }

    private wrapperStatements(): string[] {
        const output: string[] = [];

        for (const wrapper of this.wrappers) {
            const node = wrapper.node;
            const params = node.params.map((param) => this.slice(param.range)).join(', ');
            const reactive = [...this.reactiveWrites(wrapper.writes)];

            // 直接改容器（`items.push(x)`）的话，用列表自己的精确调用顶掉整块比对。
            // 这些插入紧跟原调用（见 mutationCalls），所以先登记再取函数体
            const mutations = this.mutationCalls(node);

            this.mutationEdits = mutations.edits;

            const updates = this.updateCalls(new Set(reactive), mutations.skip);

            const head =
                node.type === 'ArrowFunctionExpression'
                    ? `(${params}) =>`
                    : `function ${node.id?.name ?? ''}(${params})`;

            let body: string;

            if (node.body.type === 'BlockStatement') {
                // 去掉外层花括号，交给 guardChanges 重新包一层
                const inner = this.bodySource(node.body.range).slice(1, -1);

                body = `{ ${this.guardChanges(reactive, updates, writesAreAssignments(node, wrapper.writes), inner)} }`;
            } else {
                const inner = this.bodySource(node.body.range);

                body = `{ ${this.guardChanges(reactive, updates, writesAreAssignments(node, wrapper.writes), inner)} }`;
            }

            output.push(`const ${wrapper.name} = ${head} ${body};`);
        }

        return output;
    }

    /** `bind:` 的 setter：赋值 + 刷新受影响的片段（延迟到这里才能算全片段） */
    private bindStatements(): string[] {
        return this.pendingBinds.map((bind) => {
            const reactive = [...this.reactiveWrites(bind.writes)];
            const updates = this.updateCalls(new Set(reactive));

            return `const ${bind.name} = ${bind.render(updates, reactive)};`;
        });
    }

    /**
     * 值真的变了才刷新：`const 旧值 = x; ...写入...; if (x !== 旧值) { 刷新 }`
     *
     * `plain` 为 false（写入里有 `arr.push(v)` 之类）时不加比较 ——
     * 那种写法变量本身不会变，加了就永远不刷新了。
     */
    private guardChanges(names: string[], updates: string, plain: boolean, inner: string): string {
        // 函数体源码结尾通常已经有 `;` 或 `}`，别再补一个
        const joiner = /[;}]$/.test(inner.trim()) ? ' ' : '; ';

        if (!updates || !plain || names.length === 0) {
            return updates ? `${inner}${joiner}${updates}` : inner;
        }

        const previous = names.map(() => `__prev$${this.prevCounter++}`);
        const snapshot = previous.map((name, index) => `${name} = ${names[index]}`).join(', ');
        const changed = names.map((name, index) => `${name} !== ${previous[index]}`).join(' || ');

        return `const ${snapshot}; ${inner}${joiner}if (${changed}) { ${updates} }`;
    }

    /**
     * 子组件的属性修改触发器：`update.setProps(props, children)`。
     *
     * 父组件 props 变了只调这个，不重新 create —— 重新 create 会把子组件自己的 state 丢掉。
     */
    private propsStatements(): string[] {
        const changed = new Set<string>();
        const assignments: string[] = [];
        // `$bindable` 的 prop 是个绑定对象，不能直接赋给变量，下面单独处理
        const bound = new Set(this.bindables.map((bindable) => bindable.name));

        for (const entry of this.propNames) {
            if (bound.has(entry.name)) continue;

            assignments.push(`  ${entry.name} = $props[${JSON.stringify(entry.key)}];`);
            changed.add(entry.name);
        }

        // `$bindable`：只有受控（父用了 `bind:`）才跟着父的值走。
        // 父只是普通传值时，子组件自己维护，父推过来的值不再覆盖它
        for (const bindable of this.bindables) {
            assignments.push(
                `  if (${bindable.binding}.external) ${bindable.name} = ${bindable.binding}.get();`
            );
            changed.add(bindable.name);
        }

        // 先存旧值，赋完再比 —— 父推过来一样的值就不用刷新了
        const names = [...changed];
        const previous = names.map(() => `__prev$${this.prevCounter++}`);
        const body: string[] = [];

        if (names.length > 0) {
            body.push(`  const ${previous.map((name, index) => `${name} = ${names[index]}`).join(', ')};`);
        }

        body.push(...assignments);

        const updates = this.updateCalls(changed);

        // 插槽：引用没变就别重新挂，父组件已经把里面的节点刷新过了
        const slotUpdates = this.updateCalls(new Set(['children']));

        if (slotUpdates) {
            body.push('  if ($children !== undefined && $children !== children) {');
            body.push('    children = $children;');
            body.push(`    ${slotUpdates}`);
            body.push('  }');
        }

        if (updates) {
            const test = names.map((name, index) => `${name} !== ${previous[index]}`).join(' || ');

            body.push(test ? `  if (${test}) { ${updates} }` : `  ${updates}`);
        }

        // 既没有 props 也没有插槽，就不用给父组件留这个入口了
        if (body.length === 0) return [];

        return [`${this.rootName}.setProps = ($props, $children) => {`, ...body, '};'];
    }

    /**
     * 只有 `$state` 变量的变化才由编译期写死刷新调用。
     *
     * 普通变量（比如 counter 里的 `draft`）编译期不知道它什么时候变，
     * 交给 `active` 在运行时全量 update —— 否则会多出这些没用的 update。
     */
    private reactiveWrites(writes: Set<string>): Set<string> {
        const states = this.analysis?.states;
        if (!states) return new Set();

        const kept = new Set<string>();

        for (const write of writes) {
            const root = write.split(/[.\[]/)[0];
            const state = states.get(root);

            if (!state) continue;

            // 派生局部变量：换成它对应的路径，剩下的属性接在后面 ——
            // `minkey.name` 变成 `arr[2].name`，这样才能只刷读它的片段
            if (state.fromPath) {
                kept.add(`${state.fromPath}${write.slice(root.length)}`);
            } else {
                kept.add(write);
            }
        }

        return kept;
    }

    /**
     * 写了 `writes` 里的 state 之后，需要刷新哪些片段。
     *
     * `skip` 里的是已经被精确调用（`list.push(...)`）顶掉的 for —— 再 sync 一遍就白做了。
     */
    private updateCalls(writes: Set<string>, skip?: Set<string>): string {
        const grouped = new Map<string, number[]>();

        for (const slot of this.slots) {
            if (skip?.has(`${slot.update}#${slot.index}`)) continue;
            if (!intersects(slot.deps, writes)) continue;

            const indices = grouped.get(slot.update) ?? [];
            if (!indices.includes(slot.index)) indices.push(slot.index);
            grouped.set(slot.update, indices);
        }

        const calls: string[] = [];

        for (const [update, indices] of grouped) {
            indices.sort((a, b) => a - b);
            // `?.()`：刷新函数是 `var` 声明的（下面会提升），所以元素还没建好时
            // 调用它也只是什么都不做，不会抛 —— 比如 `<script>` 顶层的代码
            calls.push(`${update}?.(${indices.join(', ')});`);
        }

        // `$node` 的源变量变了：重算那个节点，再由它刷自己的片段
        for (const trigger of this.nodeTriggers) {
            if (intersects(trigger.deps, writes)) calls.push(`${trigger.refresh}();`);
        }

        return calls.join(' ');
    }

    // ------------------------------------------------------------ 模板

    private fragment(children: TemplateNode[], name: string): string {
        const items = this.children(children, name);

        // `var`：刷新函数要在 `<script>` 之前就能被引用到（值为 undefined，
        // 配合调用处的 `?.()` 就是安全的），否则顶层代码会踩到 TDZ
        this.statements.push(`var ${name} = creFragment([${items.join(', ')}]);`);

        return name;
    }

    /** 给每个元素挂上 scope 类名，原有 class 保留 */
    private scopedAttributes(
        attributes: Record<string, AttributeValue | true>
    ): Record<string, AttributeValue | true> {
        if (!this.scopeId) return attributes;

        const scope = this.scopeId;
        const existing = attributes['class'];

        if (existing === undefined || existing === true) return { ...attributes, class: scope };
        if (typeof existing === 'string') return { ...attributes, class: `${existing} ${scope}` };
        // class 不会是绑定值
        if (!Array.isArray(existing) && isBindingValue(existing)) {
            return { ...attributes, class: scope };
        }

        const chunks = (Array.isArray(existing) ? existing : [existing]).filter(
            (chunk) => !isBindingValue(chunk)
        );

        return { ...attributes, class: [...chunks, ` ${scope}`] };
    }

    private element(node: Element, owner: string | null, index: number): string | string[] {
        return isComponentName(node.name)
            ? this.component(node, owner, index)
            : this.plainElement(node);
    }

    /**
     * 子组件：`<Foo count={count}>slot</Foo>`。
     *
     * 只 `create()` 一次。依赖的 state 变化时推新 props 给它（`setProps`），
     * 不重新 create —— 重建会把子组件自己的 state 一起丢掉。
     */
    private component(node: Element, owner: string | null, index: number): string[] {
        const parts: string[] = [];
        const deps = new Set<string>();

        for (const [key, value] of Object.entries(this.scopedAttributes(node.attributes))) {
            parts.push(this.componentAttribute(key, value));

            // 绑定值走的是 bindingAttribute，但它 getter 读的变量同样是依赖：
            // 那些变量变了，父组件要把新的绑定推给子组件
            if (value !== true && !Array.isArray(value) && isBindingValue(value)) {
                const getter = value.get ?? value.expression;
                if (getter) addAll(deps, collectReads(getter.content));

                continue;
            }

            for (const chunk of chunksOf(value)) {
                if (typeof chunk !== 'string') addAll(deps, collectReads(chunk.content));
            }
        }

        const propsCode = `{${parts.join(', ')}}`;

        // 插槽只建一次；里面的 updater 记下来，父组件推 props 之前先刷它们
        let slotCode = 'null';
        let slotUpdaters: string[] = [];

        if (node.children.length > 0) {
            const saved = this.insideSlot;
            this.insideSlot = true;

            let items: string[] = [];
            let statements: string[] = [];

            try {
                [items, statements] = this.capture(() => this.children(node.children, null));
            } finally {
                this.insideSlot = saved;
            }

            // 静态文本是字符串字面量，剩下的是可以刷新的 updater
            slotUpdaters = items.filter((item) => !item.startsWith('"'));
            this.statements.push(...statements);

            const slotName = `slot$${this.counter++}`;
            this.statements.push(`const ${slotName} = () => [${items.join(', ')}];`);

            slotCode = slotName;
        }

        const name = `update$${this.counter++}`;
        this.statements.push(`const ${name} = ${node.name}.create(${propsCode}, ${slotCode});`);

        // 没有依赖（或不在能注册片段的上下文里）：建一次就完事
        if (deps.size === 0 || !owner) return [name];

        // 有依赖：属性更新器占 children 的下一个编号，props 变了只推 props，不重建
        const updater = `props$${this.counter++}`;
        const refresh = slotUpdaters.map((item) => `${item}();`).join(' ');

        this.statements.push(
            `const ${updater} = () => { ${refresh}${name}.setProps(${propsCode}, ${slotCode}); };`,
            `${updater}.props = true;`
        );

        this.slots.push({ update: owner, index: index + 1, deps });

        return [name, updater];
    }

    /**
     * 组件属性：按**值**传（不是 getter）。
     * `bind:` / `bindactive:` 例外，传 `{ get, set }` 给子组件。
     */
    private componentAttribute(key: string, value: AttributeValue | true): string {
        const name = JSON.stringify(key);

        if (key.startsWith('bind:')) {
            // 子组件那边就是个普通 prop，前缀去掉（前缀只有 creEle 才认）
            const plain = key.slice('bind:'.length);

            return this.attribute(key, value, null, 0, plain).code;
        }

        if (value === true) return `${name}: true`;
        if (typeof value === 'string') return `${name}: ${JSON.stringify(value)}`;

        const chunks = chunksOf(value);

        // 单个表达式直接传值，混合的用模板字符串
        if (chunks.length === 1 && typeof chunks[0] !== 'string') {
            return `${name}: (${chunks[0].raw})`;
        }

        const parts = chunks.map((chunk) =>
            typeof chunk === 'string' ? escapeTemplate(chunk) : '${' + chunk.raw + '}'
        );

        return `${name}: \`${parts.join('')}\``;
    }

    /** 注册一个动态片段。`owner` 为 null 时（组件属性、for 块内）不用注册 */
    private registerSlot(owner: string | null, index: number, deps: Set<string>): void {
        if (owner) this.slots.push({ update: owner, index, deps });
    }

    /**
     * 生成 `bind:this`：把元素交给一个变量或者回调。
     *
     * - `bind:this={x}` —— x 由 bind:this 自己声明（`let x;`），不用在 `<script>` 里先写；
     *   只有 `<script onmount>` 能看见它
     * - `bind:this={(el) => ...}` —— 不声明变量，元素挂上时把它当参数传进去跑
     */
    private thisAttribute(binding: BindingValue): { code: string; slot: boolean } {
        const expression = binding.expression;

        if (!expression) return { code: '"this": undefined', slot: false };

        const node = expression.content;

        if (node.type === 'Identifier') {
            // 标识符指向一个函数时是回调形式：`bind:this={grab}` 会在建好元素时调 grab(el)。
            // 注意不能用 handler() 的包装版：回调是建树过程中跑的，那时候根调度器还没建出来，
            // 包装里追加的刷新调用会踩 TDZ（"Cannot access ... before initialization"）
            if (this.analysis?.functions.has(node.name)) {
                return { code: `"this": ${node.name}`, slot: false };
            }

            // 否则由 bind:this 自己声明这个变量（script 里已经声明过就只赋值）
            if (!this.scriptNames().has(node.name)) this.thisNames.add(node.name);

            return { code: `"this": ($el) => { ${node.name} = $el; }`, slot: false };
        }

        // 别的写法都当成回调：元素建好时传进去
        return { code: `"this": (${expression.raw})`, slot: false };
    }

    /** `<script>` / `<script module>` 里已经声明过的名字 */
    private scriptNames(): Set<string> {
        if (this.declared) return this.declared;

        const names = new Set<string>();

        for (const block of [this.root.script, this.root.module]) {
            if (!block) continue;

            simpleTraverse(block.content as unknown as TSESTree.Node, {
                enter: (node) => {
                    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
                        names.add(node.id.name);
                    } else if (
                        (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
                        node.id?.type === 'Identifier'
                    ) {
                        names.add(node.id.name);
                    } else if (node.type === 'ImportDefaultSpecifier' || node.type === 'ImportSpecifier') {
                        names.add(node.local.name);
                    }
                }
            });
        }

        return (this.declared = names);
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
    private bindingAttribute(
        name: string,
        binding: BindingValue,
        owner: string | null,
        slotIndex: number
    ): { code: string; slot: boolean } {
        const get = binding.get ?? binding.expression;

        if (!get) {
            /**
             * 没有 getter：值由 listener 提供（`update(新值)`），运行时存下来当 getter 的结果。
             * 所以这里**不能**生成 `get` —— 生成了就把 listener 喂的值盖住了。
             * 连 listener 都没有、或者 listener 提供不了值的写法，编译期已经报过。
             */
            // 连 listener 都没有的写法编译期已经报错了，这里兜个底
            if (!binding.listen) return { code: `${name}: { set: ($value) => $value }`, slot: false };

            const parts: string[] = [];

            if (binding.set) {
                const written = this.setterFrom(binding.set);
                const setterName = `__bind$${this.counter++}`;

                // 没有 getter，所以 setter 的"最终值"就是它拿到的那个值；
                // 刷新依赖 set 自己写了哪些 state，其余刷新全靠 listener 那次 update
                this.pendingBinds.push({
                    name: setterName,
                    render: (updates, names) =>
                        `(${written.param}) => { ${this.guardChanges(names, updates, written.plain, written.body)} return ${written.param}; }`,
                    writes: written.writes
                });

                parts.push(`set: ${setterName}`);
            } else {
                parts.push('set: ($value) => $value');
            }

            parts.push(`listen: ${this.listenSource(binding.listen.content)}`);
            if (binding.active) parts.push('active: true');

            return { code: `${name}: { ${parts.join(', ')} }`, slot: false };
        }

        const getter = this.getterSource(get.content);
        const setter = `__bind$${this.counter++}`;
        const written = binding.set
            ? this.setterFrom(binding.set)
            : {
                  param: '$value',
                  body: `${get.raw} = $value; `,
                  writes: collectReads(get.content),
                  // 简写形式生成的是一句赋值；`bind:value={obj.x}` 这种不是，比较不出来
                  plain: isIdentifier(get.raw.trim())
              };

        this.pendingBinds.push({
            name: setter,
            // setter 把最终值返回：子组件 `x = binding.set(v)` 拿到的就是父组件的值
            render: (updates, names) =>
                `(${written.param}) => { ${this.guardChanges(names, updates, written.plain, written.body)} return (${getter})(); }`,
            writes: written.writes
        });

        const parts = ['external: true', `get: ${getter}`, `set: ${setter}`];

        if (binding.listen) parts.push(`listen: ${this.listenSource(binding.listen.content)}`);
        if (binding.active) parts.push('active: true');

        // get 读了哪些变量 -> 那些变量变化时精确重跑这个 getter
        this.registerSlot(owner, slotIndex, collectReads(get.content));

        return { code: `${name}: { ${parts.join(', ')} }`, slot: true };
    }

    /** 用户自己写的 `set`：参数名和主体都搬进产物，写过的变量拿去算 update 调用 */
    private setterFrom(set: Expression): {
        param: string;
        body: string;
        writes: Set<string>;
        plain: boolean;
    } {
        const node = set.content;

        if (!isFunctionLike(node)) {
            // 不是函数就当成一个可调用的 setter，写没写到响应式变量看不出来
            return { param: '$value', body: `(${set.raw})($value); `, writes: new Set(), plain: false };
        }

        const { param, body } = this.setterSource(node);
        const writes = collectWrites(node);

        return { param, body, writes, plain: writesAreAssignments(node, writes) };
    }

    /** getter：`() => target.value` 这样的箭头函数，或者干脆就是一个表达式 */
    private getterSource(get: TSESTree.Node): string {
        if (!isFunctionLike(get)) return `() => (${this.slice(get.range)})`;

        const body = get.body;

        return body.type === 'BlockStatement'
            ? `() => ${this.slice(body.range)}`
            : `() => (${this.slice(body.range)})`;
    }

    /** setter：参数名用用户写的那个，主体搬进产物 */
    private setterSource(set: FunctionLike): { param: string; body: string } {
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
    private listenSource(listen: TSESTree.Node): string {
        const call = listen.type === 'CallExpression' ? listen : null;

        if (!call || call.callee.type !== 'Identifier' || call.callee.name !== 'listen') {
            return this.slice(listen.range);
        }

        const [bus, event, guard] = call.arguments;
        if (!bus || !event) return this.slice(listen.range);

        const busText = this.slice(bus.range);
        const eventText = this.slice(event.range);

        let index = this.listenGroups.findIndex((item) => item.bus === busText && item.event === eventText);

        if (index < 0) {
            this.listenGroups.push({ bus: busText, event: eventText, slots: [] });
            index = this.listenGroups.length - 1;
        }

        const group = this.listenGroups[index];
        const slot = group.slots.length;

        group.slots.push(this.guardChain(guard));

        // 不在这儿挂监听：把 update 存进槽位，等所有元素建好由组里那一个 handler 统一处理
        return `(update) => { __listen$${index}[${slot}] = update; }`;
    }

    /**
     * 谓词 -> 条件链。
     *
     * `(ev) => A && B` 拆成 `['A', 'B']`——公共前缀（A）就能在同组里共用一个 `if`。
     * 拆不开的（块体、不是函数字面量）整条当一个条件，用 `$event` 调它。
     */
    private guardChain(guard: TSESTree.Node | undefined): { chain: string[]; params: string[] } {
        if (!guard) return { chain: [], params: [] };

        if (guard.type === 'ArrowFunctionExpression' || guard.type === 'FunctionExpression') {
            const first = guard.params[0];
            const name = first?.type === 'Identifier' ? first.name : null;

            // 表达式体的 && 链能拆；块体没法拆，整条当谓词
            if (guard.body.type !== 'BlockStatement') {
                return { chain: splitAnd(guard.body, this.source), params: name ? [name] : [] };
            }
        }

        return { chain: [`(${this.slice(guard.range)})($event)`], params: [] };
    }

    /** 槽位数组的声明：得在元素创建之前（元素创建时会往里填 update） */
    private listenSlotDeclarations(): string[] {
        return this.listenGroups.map((_group, index) => `const __listen$${index} = [];`);
    }

    /** 每组挂一次监听，handler 里是合并好的 if 树 */
    private listenRegistrations(): string[] {
        return this.listenGroups.map((group, index) => {
            const slots = `__listen$${index}`;

            // 各槽位的谓词可能给事件参数起了不同的名字，这里统一绑到 $event 上
            const names = [...new Set(group.slots.flatMap((slot) => slot.params))].filter(
                (name) => name !== '$event'
            );
            const bindings = names.map((name) => `const ${name} = $event;`).join(' ');

            const body = emitBranch(buildBranch(group.slots), slots);
            const handler = `($event) => { ${bindings} ${body} }`;

            return (
                `const $bus$${index} = (${group.bus}); ` +
                `($bus$${index}.addEventListener ?? $bus$${index}.on)` +
                `.call($bus$${index}, ${group.event}, ${handler});`
            );
        });
    }

    private plainElement(node: Element): string {
        const name = `update$${this.counter++}`;
        const items = this.children(node.children, this.insideFragment ? null : name);

        const props: string[] = [];
        let propIndex = 0;

        for (const [key, value] of Object.entries(this.scopedAttributes(node.attributes))) {
            const attribute = this.attribute(key, value, name, items.length + propIndex);
            if (attribute.slot) propIndex += 1;
            props.push(attribute.code);
        }

        this.statements.push(
            `var ${name} = creEle(${JSON.stringify(node.name)}, {${props.join(', ')}}, [${items.join(', ')}]);`
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
        slotIndex: number,
        /** 写进产物里的键名。组件属性会去掉 `bind:` 前缀——前缀只有 creEle 才认 */
        outputKey = key
    ): { code: string; slot: boolean } {
        const name = JSON.stringify(outputKey);

        if (value === true) return { code: `${name}: true`, slot: false };
        if (typeof value === 'string') return { code: `${name}: ${JSON.stringify(value)}`, slot: false };

        const chunks = chunksOf(value);
        const expressions = chunks.filter((chunk): chunk is Expression => typeof chunk !== 'string');

        if (key === 'bind:this') {
            return this.thisAttribute(value as BindingValue);
        }

        if (key.startsWith('bind:')) {
            return this.bindingAttribute(name, value as BindingValue, owner, slotIndex);
        }

        // 普通属性也可以写绑定值（`title={ get: ..., listen: ... }`）：单向，不往回写
        if (!Array.isArray(value) && isBindingValue(value)) {
            return { code: `${name}: ${this.boundSource(value)}`, slot: false };
        }

        if (key.startsWith('on')) {
            const expression = expressions[0];

            return { code: `${name}: ${expression ? this.handler(expression) : 'undefined'}`, slot: false };
        }

        const parts = chunks.map((chunk) =>
            typeof chunk === 'string' ? escapeTemplate(chunk) : '${' + chunk.raw + '}'
        );

        const deps = new Set<string>();
        for (const expression of expressions) addAll(deps, collectReads(expression.content));

        if (owner) this.slots.push({ update: owner, index: slotIndex, deps });

        return { code: `${name}: () => \`${parts.join('')}\``, slot: Boolean(owner) };
    }

    /** 事件处理器：复制原函数体，末尾追加受影响的片段刷新 */
    private handler(expression: Expression): string {
        const node = expression.content;

        if (node.type === 'Identifier') {
            const info = this.analysis?.functions.get(node.name);

            if (info) {
                // 写了 state 的函数会自带刷新（见 functionWrappers），直接用它。
                // 这里按写入判断而不是查 wrappedFunctions —— 模板先于 script() 处理，
                // 那时候那张表还是空的
                if ([...this.reactiveWrites(info.writes)].length > 0) return node.name;

                const name = `${node.name}_$${++this.wrapperCounter}`;
                this.wrappers.push({ name, node: info.node, writes: info.writes });
                return name;
            }
        }

        if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
            const name = `__handler$${this.counter++}`;

            this.wrappers.push({ name, node, writes: collectWrites(node) });

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

    /**
     * 单向绑定：普通属性 / 模板插值用的绑定值（`{ get: ..., listen: ... }`）。
     *
     * 产物是 `creBound(render, listen)`：render 给出值（不给就是"值由 listen 推"），
     * listen 决定什么时候重跑——编译期不需要知道依赖是什么，所以跨模块的 store
     * 也能驱动它。跟 `bind:` 的区别是不往回写。
     */
    private boundSource(binding: BindingValue): string {
        const getter = binding.get ?? binding.expression;
        const render = getter ? this.getterSource(getter.content) : 'null';
        const listen = binding.listen ? this.listenSource(binding.listen.content) : null;

        this.needsBound = true;

        return `creBound(${render}${listen ? `, ${listen}` : ''})`;
    }

    private child(node: TemplateNode, index: number, owner: string | null): string | string[] | null {
        // 模板插值里的绑定值：`{ listen: (update) => ... }`
        if (!('type' in node)) return this.boundSource(node as BindingValue);

        switch (node.type) {
            case 'comment':
                return null;

            case 'text':
                return JSON.stringify(node.content);

            case 'expression':
                // 插槽里的表达式要插到子组件里去，没有父元素能挂它的片段，
                // 所以给它一个自己的文本节点，父组件拿到返回值就能刷新
                if (this.insideSlot) {
                    const name = `update$${this.counter++}`;

                    this.needsText = true;
                    this.statements.push(`const ${name} = creText(() => (${node.raw}));`);

                    return name;
                }

                if (owner) this.slots.push({ update: owner, index, deps: collectReads(node.content) });
                return `() => (${node.raw})`;

            case 'element':
                return this.element(node, owner, index);

            case 'IfBlock':
                return this.ifBlock(node, index, owner);

            case 'ForBlock':
                return this.forBlock(node, index, owner);
        }
    }

    private ifBlock(node: IfBlock, index: number, owner: string | null): string {
        const deps = templateReads(node);

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

    /**
     * `{#for ...}`：产出一个 `creList`，自己管一段（不用每次重建）。
     *
     * 每一项被包成一个 updater（`__row$N`）：块内的片段注册到它身上，于是复用一项时
     * 只要重新绑一次循环变量再刷那些片段，DOM 不动。写了 `with key = ...` 就按 key
     * 匹配，没写就按位置 —— 两种都不重建已有的项。
     */
    private forBlock(node: ForBlock, index: number, owner: string | null): string {
        const deps = templateReads(node);
        const iter = `__iter$${this.counter++}`;
        const row = `__row$${this.counter++}`;
        const right = this.slice(node.content.right.range);
        const left = node.content.left;

        // 循环变量必须是 let：复用一项时要重新绑到新值上
        const pattern =
            left.type === 'VariableDeclaration'
                ? this.slice(left.declarations[0].id.range)
                : this.slice(left.range);

        const binding = `let ${pattern} = ${iter};`;

        // 块内的片段要注册（这一项是复用的，不是每次重建）—— 有了编号才能精确刷新
        // 记下起点，后面只挑"块内"的
        const slotBase = this.slots.length;

        const [inner, innerStatements] = this.capture(() => this.children(node.children, row), false);

        let fallback = 'null';

        if (node.fallback) {
            // 空列表分支：整个 for 共用一份，放在 render 外面
            const [items, statements] = this.capture(() => this.children(node.fallback!.children, null));

            fallback = `() => [${items.join(', ')}]`;
            this.statements.push(...statements);
        }

        // 只有 of 后面直接是这个变量（或它的 entries()）才认：改它就能精确定位
        const source = sourceVariableOf(node.content.right);

        // 源先取一次：后面 sync、订阅都用它，避免把表达式求值两遍
        const sourceName = `__src$${this.counter++}`;
        const render = `render$${this.counter++}`;
        const list = `__list$${this.counter++}`;

        // `with key = ...`：键是拿循环变量算的，所以参数就是那个绑定模式
        const key = node.key ? `(${pattern}) => (${node.key.raw})` : 'null';

        // `{#for [k, v] of map}`：项是 [键, 值] 拼出来的。`map.set(k, v)` 只给键和值，
        // 更新那一项之前得先拼回项的形状（`set.add(v)` 和普通数组用不着）
        const pair = left.type === 'ArrayPattern' ? left.elements : null;
        const names = pair
            ? pair.map((element) => (element ? this.slice(element.range) : 'undefined'))
            : [];
        const entry =
            node.key && names.length === 2 ? `(${names.join(', ')}) => [${names.join(', ')}]` : 'null';

        // 项带下标：`entries()` 这种，源不是容器变量本身
        const indexed = node.content.right.type !== 'Identifier';

        // 每个列表只管自己的 DOM —— 交换数组元素那件事是用户代码做的，所以同一个
        // 数组喂几个 for 都没关系
        const swapByValue = indexed;

        /**
         * 块内读了下标变量的片段，按它们挂在哪个 updater 上分组。
         *
         * 值没换、只是位置变了的时候只刷这些 —— 下标和值写在同一个插值里的话那个
         * 片段两边都读，会一起刷（`{i}:{item.id}`），分成两个插值才能真的只刷下标。
         */
        const indexGroups = new Map<string, number[]>();

        if (indexed && names.length === 2) {
            for (const slot of this.slots.slice(slotBase)) {
                if (!slot.deps.has(names[0])) continue;

                const indices = indexGroups.get(slot.update) ?? [];

                indices.push(slot.index);
                indexGroups.set(slot.update, indices);
            }
        }

        const indexRefresh = [...indexGroups]
            .map(([updater, indices]) => `${updater}(${[...indices].sort((a, b) => a - b).join(', ')});`)
            .join(' ');

        this.needsList = true;

        this.statements.push(
            `const ${render} = (${iter}) => {`,
            `  ${binding}`,
            ...innerStatements.map((line) => `  ${line}`),
            `  const ${row} = creFragment([${inner.join(', ')}]);`,
            `  return {`,
            // 拿 fragment 里的真实节点：fragment 本身一插入就摊平了，不能拿它当节点
            `    nodes: Array.from(${row}.el.childNodes),`,
            // 复用这一项时把循环变量重新绑到新值上，再刷依赖它的片段（DOM 不动）。
            //
            // 项带下标时（`entries()`）特殊处理：值没换、只是位置变了的话，只有下标
            // 那一块需要更新 —— 整行重跑会把行里其它部分（比如 `Math.random()`）
            // 也一并重算
            swapByValue && names.length === 2 && indexRefresh !== ''
                ? `    update: (next) => { if (next[1] === ${names[1]}) { ${names[0]} = next[0]; ${indexRefresh} } else { ${pattern} = next; ${row}(); } },`
                : `    update: (next) => { ${pattern} = next; ${row}(); },`,
            `  };`,
            '};',
            // 只给订阅判断用（有没有 subscribe）。source 仍写 `${right}`：
            // 每次重新求值，`entries()` 这种一次性迭代器才不会被耗尽
            `const ${sourceName} = ${right};`,
            `var ${list} = creList({ render: ${render}, key: ${key}, entry: ${entry}, indexed: ${indexed}, swapByValue: ${swapByValue}, fallback: ${fallback}, source: () => ${right} });`,
            `${list}.sync(${right});`,
            // 响应式容器：订阅它的改动。编译期不一定知道谁是响应式（可能是 import 进来的），
            // 所以运行时看有没有 subscribe——连"编译期看不见的改动"也能精确更新
            `if (typeof ${sourceName}?.subscribe === 'function') ${sourceName}.subscribe((change) => ${list}.apply(change));`
        );

        // 依赖变了由父级刷新这一段 -> creList 重新取一次再比对（不是重建）
        if (owner) this.slots.push({ update: owner, index, deps });

        // 精确调用（`list.push(...)`）只给 `$state` 的容器：响应式容器有自己的订阅，
        // 两边都做就重复了。而 `$state` 变量不会是响应式容器，所以这条分得开
        if (source && this.analysis?.states.has(source)) {
            // 同一个容器可能喂给好几个 for（`items` 和 `items.entries()`），
            // 改动要同时更新它们，所以这里是一对多
            const known = this.forSources.get(source);

            if (known) known.push(list);
            else this.forSources.set(source, [list]);

            if (node.key) this.forKeyed.add(list);

            // 项带下标的（`entries()`）跟普通数组不一样，见 forShifted
            if (node.content.right.type !== 'Identifier') this.forShifted.add(list);

            if (owner) this.forSlots.set(list, { update: owner, index });
        }

        return list;
    }

    /**
     * 这次写入里有没有"直接改某个 for 的容器"的调用（`items.push(x)` 之类）。
     *
     * 有就生成列表自己的精确调用，并把它对应的那次整块 sync 顶掉 —— 数组大了，
     * 每次都重新取 + 比对是灾难。
     */
    /**
     * @returns `edits` 是"紧跟在原调用之后"的插入（不是追加到函数末尾——
     * 参数里可能引用了会被后面语句改掉的变量，`nextId` 就是个例子）
     */
    private mutationCalls(node: TSESTree.Node): { edits: Edit[]; skip: Set<string> } {
        const edits: Edit[] = [];
        const skip = new Set<string>();

        /** 记下这次改动：紧跟原语句插一句精确调用，并顶掉整块比对 */
        const precise = (list: string, call: string, node: TSESTree.Node, parent?: TSESTree.Node): void => {
            const statement = parent?.type === 'ExpressionStatement' ? parent : node;

            edits.push({ start: statement.range[1], end: statement.range[1], text: ` ${list}?.${call};` });

            const slot = this.forSlots.get(list);
            if (slot) skip.add(`${slot.update}#${slot.index}`);
        };

        /**
         * 容器变量 -> 以它为源的**所有**列表。
         *
         * 响应式容器自己会通知 `for`，这里返回空数组，别重复。
         */
        const listsOf = (name: string): string[] =>
            this.reactiveContainers.has(name) ? [] : (this.forSources.get(name) ?? []);

        /**
         * 值表达式在产物里会用到两次（原调用一次、精确调用一次）—— 不是简单表达式就先
         * 赋给一个局部变量，否则它会被求值两遍（`a.push({ ... })` 每次都是新对象）。
         *
         * 做法：声明插到整句之前，原位置换成那个变量。
         */
        const reuse = (text: string, at: [number, number], parent?: TSESTree.Node): string => {
            // 标识符 / 数字 / 字符串 直接用，不必提取
            if (/^[$A-Za-z_][\w$]*$/.test(text) || /^-?[\d.]+$/.test(text) || /^['"`]/.test(text)) {
                return text;
            }

            const name = `__value$${this.counter++}`;
            const statement = parent?.type === 'ExpressionStatement' ? parent.range[0] : at[0];

            edits.push({ start: statement, end: statement, text: `const ${name} = ${text}; ` });
            edits.push({ start: at[0], end: at[1], text: name });

            return name;
        };

        simpleTraverse(node, {
            enter: (child, parent) => {
                // `items[i] = v`：只换那一项，其余的 DOM 不动。
                // 复合赋值（`items[i] += 1`）和改元素内部（`items[i].name = x`）都不认 ——
                // 前者还要读旧值，后者动的不是这个容器本身，都退回整块比对
                if (child.type === 'AssignmentExpression') {
                    if (child.operator !== '=') return;

                    /** 每一处「改了哪个容器的哪一格」 */
                    const targets: Array<{ name: string; index: string; value: string; at: [number, number] }> = [];
                    const left = child.left;

                    // `a[i] = v`
                    if (left.type === 'MemberExpression' && left.computed && left.object.type === 'Identifier') {
                        targets.push({
                            name: left.object.name,
                            index: this.slice(left.property.range),
                            value: this.slice(child.right.range),
                            at: child.right.range
                        });
                    }

                    // `[a[0], a[1]] = [x, y]` —— 一次调用改多个位置
                    const right = child.right;

                    if (left.type === 'ArrayPattern' && right.type === 'ArrayExpression') {
                        // 只认每一项都是 `X[i]` 的简单形状，且两边一样长。rest、嵌套、
                        // 默认值一概不分析 —— 那种交给整体比对（写了 key 就是 keyed 比对）
                        const simple =
                            left.elements.length > 0 &&
                            left.elements.length === right.elements.length &&
                            left.elements.every(
                                (element) =>
                                    element &&
                                    element.type === 'MemberExpression' &&
                                    element.computed &&
                                    element.object.type === 'Identifier'
                            );

                        if (simple) {
                            /** 同一个容器的放一组 */
                            const rows = new Map<string, Array<{ index: string; value: string }>>();

                            left.elements.forEach((element, at) => {
                                const target = element as TSESTree.MemberExpression;
                                const value = right.elements[at];

                                if (!value) return;

                                const name = (target.object as TSESTree.Identifier).name;
                                const group = rows.get(name) ?? [];

                                group.push({
                                    index: this.slice(target.property.range),
                                    value: reuse(this.slice(value.range), value.range, parent)
                                });

                                rows.set(name, group);
                            });

                            for (const [name, group] of rows) {
                                for (const list of listsOf(name)) {
                                    // 只有一项就用 setAt，多项才需要批量
                                    const call =
                                        group.length === 1
                                            ? `setAt(${group[0].index}, ${group[0].value})`
                                            : `setRows([${group.map((row) => `[${row.index}, ${row.value}]`).join(', ')}])`;

                                    precise(list, call, child, parent);
                                }
                            }

                            return;
                        }

                        // 形状太复杂：不做精确调用，后面的刷新会走整体比对
                        return;
                    }

                    for (const target of targets) {
                        for (const list of listsOf(target.name)) {
                            const value = reuse(target.value, target.at, parent);

                            precise(list, `setAt(${target.index}, ${value})`, child, parent);
                        }
                    }

                    return;
                }

                if (child.type !== 'CallExpression') return;

                const callee = child.callee;
                if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return;

                const method = callee.property.name;
                if (callee.object.type !== 'Identifier') return;

                const lists = listsOf(callee.object.name);
                if (lists.length === 0) return;

                const args = child.arguments
                    .filter((arg) => arg.type !== 'SpreadElement')
                    .map((arg) => reuse(this.slice(arg.range), arg.range, parent))
                    .join(', ');

                for (const list of lists) {
                    // Map / Set：按一个键就能定位到某一项
                    if (KEYED_MUTATIONS.has(method)) {
                        // 没有 `with key = ...` 就说不清是哪一项，退回整块比对
                        if (!this.forKeyed.has(list)) continue;

                        if (method === 'clear') precise(list, 'clear()', child, parent);
                        else if (method === 'delete') precise(list, `removeKey(${args})`, child, parent);
                        // `map.set(k, v)` 是键 + 值；`set.add(v)` 里值本身就是键
                        else if (method === 'add') precise(list, `setKey(${args}, ${args})`, child, parent);
                        else precise(list, `setKey(${args})`, child, parent);

                        continue;
                    }

                    if (!LIST_MUTATIONS.has(method)) continue;

                    // `{#for [i, x] of items.entries()}`：项是 [下标, 值]。追加 / 删末尾不动
                    // 前面那些项的下标，所以这两个仍然精确；别的会让所有下标变，退回整块比对
                    if (this.forShifted.has(list) && method !== 'push' && method !== 'pop') continue;

                    // 紧跟在那句调用之后：此刻参数还是原值
                    precise(list, `${method}(${args})`, child, parent);
                }
            }
        });

        return { edits, skip };
    }

    /**
     * 临时把生成语句收集到别处，用于 render 函数体。
     *
     * `insideFragment` 默认 true：里面的东西每次重建都会新建，旧节点失效，注册片段没意义。
     * 但 `for` 的项是**复用**的（靠 `update` 刷新），所以它要传 false —— 不然块内的
     * 片段没有编号，精确刷新无从下手。
     */
    private capture<T>(run: () => T, insideFragment = true): [T, string[]] {
        const saved = this.statements;
        const savedFragment = this.insideFragment;
        const inner: string[] = [];

        this.statements = inner;
        this.insideFragment = insideFragment;

        try {
            return [run(), inner];
        } finally {
            this.statements = saved;
            this.insideFragment = savedFragment;
        }
    }

    private slice(range: [number, number]): string {
        return this.source.slice(range[0], range[1]);
    }
}

/**
 * 把几个 script 的分析结果并起来（`<script>` 和 `<script onmount>`）。
 * 区间都是绝对偏移，所以并一份用不会串；同名保留先出现的那个。
 */
function mergeAnalyses(list: ScriptAnalysis[]): ScriptAnalysis | null {
    if (list.length === 0) return null;

    const merged: ScriptAnalysis = { states: new Map(), functions: new Map() };

    for (const item of list) {
        for (const [name, info] of item.states) {
            if (!merged.states.has(name)) merged.states.set(name, info);
        }

        for (const [name, info] of item.functions) {
            if (!merged.functions.has(name)) merged.functions.set(name, info);
        }
    }

    return merged;
}

/** 把 Root 变成可执行的 JS（以及 CSS） */
export function generate(root: Root, source: string, options: CompileOptions = {}): CompileResult {
    // onmount 里也能写 $state / 事件处理函数，所以一起分析
    const analysis = mergeAnalyses(
        [root.script, root.onmount]
            .filter((block): block is Script => block != null)
            .map((block) => analyzeScript(block.content, source))
    );

    // `<style global>` 和没有样式的组件都不需要 scope 类名
    const scopeId =
        root.stylesheet && !isGlobal(root.stylesheet)
            ? createScopeId(source, options.filename)
            : null;

    return new Generator(
        source,
        root,
        options.runtimeModule ?? '@graints/runtime',
        analysis,
        scopeId,
        options.filename ?? 'component.grain',
        options.dev ?? false
    ).run();
}
