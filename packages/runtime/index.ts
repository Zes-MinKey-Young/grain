/**
 * Grain 运行时。
 *
 * 编译期已经把依赖关系分析完了，运行时只做三件事：
 * 1. `creEle` / `creFragment` 建 DOM
 * 2. 动态内容（函数）注册成一个个"片段"，按编号放好
 * 3. `update(n)` 重新求值第 n 号片段 —— 编译器生成的事件包装里直接写死了编号，
 *    运行时不需要再做任何依赖追踪
 */

/// <reference path="./globals.d.ts" />

/**
 * `creEle` / `creFragment` 的返回值：既是更新调度器，也带着根节点。
 *
 * 子组件额外挂一个 `set_props` —— 父组件靠它推新 props，
 * 不用重新 `create()`（重建会把子组件自己的 state 丢掉）。
 */
export interface Updater {
    (...indices: number[]): void;
    el: Node;
    set_props?: (props: Props, children?: (() => unknown) | null) => void;
    /** `<script onmount>`：元素挂上之后跑。根组件由生成出来的 mount 调，子组件由这里调 */
    onmount?: () => void;
}

/**
 * `Foo.create(props, children)` 返回的外壳。
 *
 * 内层实例可以被整个换掉（HMR 就这么做），外壳不变 ——
 * 父组件持有的引用、它在父组件 `nested` 里的位置都不受影响。
 */
export interface ComponentShell extends Updater {
    __grain: ComponentMeta;
}

interface ComponentMeta {
    create: (props?: unknown, children?: unknown) => Updater;
    /** 最近一次的 props / children，重建时原样传回去 */
    props: unknown;
    children: unknown;
    /** 真正落进 DOM 的节点；组件根是 fragment，appendChild 之后它自己就空了 */
    nodes: Node[];
    /** 内层实例 */
    current: Updater;
}

export interface Binding<T = unknown> {
    get(): T;
    /**
     * 写入，并把**最终值**返回——父组件可能在 setter 里改写过。
     * 非受控时就是写进去的那个值。
     */
    set(value: T): T;
    /**
     * 这个绑定是不是来自父组件的 `bind:`。
     * true = 听外面的（父改了值，子组件跟着变）；false = 里面自己搞（父传的只当初始值）
     */
    external?: boolean;
    /**
     * 挂载时跑一次，拿到一个 `update` 回调。
     * 用在"非响应式但有事件总线"的源上：外部事件来了调一下 `update()`，getter 就重新求值。
     */
    listen?: (update: () => void) => void;
    /**
     * setter 跑完之后主动跑一次 getter。
     * 源不是响应式变量时才需要标记它 —— 编译期算不出谁依赖它，只能整棵子树刷新。
     */
    active?: boolean;
}

type Props = Record<string, unknown>;

const FRAGMENT_NODE = 11;

/** 活着的组件外壳，`hot_replace` 遍历它找要重建的实例 */
const components = new Set<ComponentShell>();

interface Slot {
    /** 属性更新器没有锚点——它不改 DOM，只是把新 props 推给子组件 */
    anchor: Comment | null;
    render: () => unknown;
    nodes: Node[];
    /** 为 true 时 render() 的返回值不用管，调一次就行 */
    props?: boolean;
}

/** 属性更新器：父组件用它把新 props 推给已经创建好的子组件 */
export interface PropsUpdater {
    (): void;
    props: true;
}

/**
 * 把片段的返回值统一成 DOM 节点数组。
 *
 * 布尔值不渲染（if 块不成立时返回 null / false 就是这个意思）。
 * DocumentFragment 要展开成它的子节点——挂进 DOM 之后 fragment 本身不在文档里，
 * 记录 fragment 的话重渲染时删不掉旧节点。
 */
function to_nodes(value: unknown): Node[] {
    if (value === null || value === undefined || value === false || value === true) return [];

    if (value instanceof Node) {
        return (value as Node & { nodeType: number }).nodeType === FRAGMENT_NODE
            ? [...value.childNodes]
            : [value];
    }

    if (Array.isArray(value)) return value.flatMap(to_nodes);

    if (typeof value === 'function') {
        const updater = value as Partial<Updater>;
        // 递归：Updater 的 el 可能是 fragment，要展开
        if (updater.el) return to_nodes(updater.el);
        return to_nodes((value as () => unknown)());
    }

    return [document.createTextNode(String(value))];
}

/** 控件回写用哪个事件：checked 和 select 用 change，其余用 input */
function event_for(el: Element, name: string): string {
    if (name === 'checked') return 'change';
    if (name === 'value' && el.tagName === 'SELECT') return 'change';

    return 'input';
}

function read_prop(el: Element, name: string): unknown {
    return name in el ? (el as unknown as Record<string, unknown>)[name] : el.getAttribute(name);
}

function apply_prop(el: Element, key: string, value: unknown): void {
    if (value === null || value === undefined || value === false) {
        el.removeAttribute(key);
    } else if (key === 'class' || !(key in el)) {
        el.setAttribute(key, String(value));
    } else {
        (el as unknown as Record<string, unknown>)[key] = value;
    }
}

function render_slot(slot: Slot): void {
    // 属性更新器：只跑一次，不动 DOM
    if (slot.props) {
        slot.render();
        return;
    }

    const nodes = to_nodes(slot.render());

    for (const node of slot.nodes) node.parentNode?.removeChild(node);
    slot.nodes = nodes;

    const parent = slot.anchor?.parentNode;
    if (!parent) return;

    for (const node of nodes) parent.insertBefore(node, slot.anchor);
}

/**
 * @param tag 为 `null` 时创建 fragment（用于组件根）
 */
function create(tag: string | null, props: Props, children: unknown[]): Updater {
    const el: Node = tag === null ? document.createDocumentFragment() : document.createElement(tag);
    const element = el as Element;

    // children 里的动态片段按 children 下标编号；属性里的动态片段接着往下编号
    const slots: Array<Slot | null> = new Array(children.length).fill(null);
    const prop_slots: Array<() => void> = [];
    // 嵌套的子元素，用于 `update()` 无参时的递归全量刷新
    const nested: Updater[] = [];

    for (const [key, value] of Object.entries(props)) {
        if (key.startsWith('bind:')) {
            const name = key.slice('bind:'.length);
            const binding = value as Binding;

            // 注册成属性片段，`update()` 全量刷新时会重新跑 getter
            const apply = () => apply_prop(element, name, binding.get());
            prop_slots.push(apply);
            apply();

            // 外部事件源的钩子：挂载时跑一次，它自己决定什么时候叫 update
            binding.listen?.(apply);

            element.addEventListener(event_for(element, name), () => {
                binding.set(read_prop(element, name));

                // 源不是响应式变量，编译期没写死任何 update 调用，只能这里主动全量刷一次
                if (binding.active) update();
            });
        } else if (key === 'this' && typeof value === 'function') {
            // `bind:this`：元素建好就把元素交出去（变量赋值 / 回调都由编译器生成）
            (value as (element: Element) => void)(element);
        } else if (key.startsWith('on') && typeof value === 'function') {
            element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        } else if (typeof value === 'function') {
            const render = value as () => unknown;
            prop_slots.push(() => apply_prop(element, key, render()));
            apply_prop(element, key, render());
        } else {
            apply_prop(element, key, value);
        }
    }

    children.forEach((child, index) => {
        if (typeof child === 'function') {
            // 属性更新器：占一个片段编号，但不产生 DOM
            if ((child as Partial<PropsUpdater>).props === true) {
                slots[index] = { anchor: null, render: child as () => unknown, nodes: [], props: true };
                return;
            }

            // 嵌套元素（creEle 的返回值）直接挂上去，不算动态片段
            const child_el = (child as Partial<Updater>).el;
            if (child_el) {
                const before = el.childNodes.length;

                el.appendChild(child_el);
                nested.push(child as Updater);

                // 组件根是 fragment，appendChild 之后它自己就空了 ——
                // 记下真正落进去的节点，HMR 换实例时才知道要替换哪一段
                const meta = (child as Partial<ComponentShell>).__grain;
                if (meta) meta.nodes = [...el.childNodes].slice(before);

                // 子组件挂上了（根组件由生成出来的 mount 负责）
                (child as Partial<Updater>).onmount?.();

                return;
            }

            const anchor = document.createComment('');
            el.appendChild(anchor);

            const slot: Slot = { anchor, render: child as () => unknown, nodes: [] };
            slots[index] = slot;
            render_slot(slot);
        } else {
            for (const node of to_nodes(child)) el.appendChild(node);
        }
    });

    function update(...indices: number[]): void {
        // 不带编号 = 刷新整棵子树（bindactive 这类编译期算不出依赖的场景用它）
        if (indices.length === 0) {
            for (const slot of slots) if (slot) render_slot(slot);
            for (const run of prop_slots) run();
            for (const child of nested) child();
            return;
        }

        for (const index of indices) {
            if (index < slots.length) {
                const slot = slots[index];
                if (slot) render_slot(slot);
            } else {
                prop_slots[index - slots.length]?.();
            }
        }
    }

    update.el = el;

    return update as Updater;
}

export function creEle(tag: string, props?: Props, children?: unknown[]): Updater {
    return create(tag, props ?? {}, children ?? []);
}

/** 组件根：不产生真实元素，内容直接挂到挂载点上 */
export function creFragment(children?: unknown[]): Updater {
    return create(null, {}, children ?? []);
}

/**
 * 插槽里的 `{expr}`。
 *
 * 普通位置上的 `{expr}` 是父元素的一个片段，靠父元素的 `update(n)` 刷新；
 * 插槽里的没有父元素可挂（节点要插到子组件里），所以给它一个自己的文本节点，
 * 父组件拿到的返回值可以直接调用来刷新它。
 */
export function creText(value: () => unknown): Updater {
    const node = document.createTextNode('');

    const update = () => {
        const next = value();

        node.data = next === null || next === undefined || next === false || next === true ? '' : String(next);
    };

    update();
    update.el = node;

    return update as Updater;
}

/**
 * 组件实例的外壳。
 *
 * 编译产物里 `create()` 最后一行是 `return component(update$0, create, props, children)`。
 * 外壳是稳定的，内层实例可以随时换 —— HMR 就靠这个做到"只换一个组件"。
 */
export function component(
    instance: Updater,
    create: (props?: unknown, children?: unknown) => Updater,
    props: unknown,
    children: unknown
): Updater {
    let current = instance;

    const shell = ((...indices: number[]) => current(...indices)) as Updater;

    const meta: ComponentMeta = {
        create,
        props,
        children,
        nodes: [],
        get current() {
            return current;
        },
        set current(next: Updater) {
            current = next;
        }
    };

    Object.defineProperty(shell, 'el', {
        configurable: true,
        get: () => current.el
    });

    shell.set_props = (next_props: Props, next_children?: unknown) => {
        meta.props = next_props ?? {};
        meta.children = next_children ?? null;

        current.set_props?.(next_props, next_children as (() => unknown) | null);
    };

    shell.onmount = () => current.onmount?.();

    (shell as ComponentShell).__grain = meta;
    components.add(shell as ComponentShell);

    return shell;
}

/**
 * HMR：用新的 `create` 重建这个组件的所有实例。
 *
 * 只替换组件自己那一段 DOM —— 父组件、兄弟节点、以及父组件的状态都不动。
 *
 * @returns 换掉的实例数；0 表示这个组件现在没有活着的实例（比如它自己就是根组件），
 *          调用方该退回重新挂载。
 */
export function hot_replace(
    old_create: (props?: unknown, children?: unknown) => Updater,
    next_create: (props?: unknown, children?: unknown) => Updater
): number {
    let replaced = 0;

    for (const shell of [...components]) {
        const meta = shell.__grain;
        if (meta.create !== old_create) continue;

        const parent = meta.nodes[0]?.parentNode;

        // 还没挂上、或者已经卸载了
        if (!parent) {
            components.delete(shell);
            continue;
        }

        const fresh = next_create(meta.props, meta.children);

        // 临时插一个标记，新节点才能落在原来的位置
        const marker = document.createComment('');

        parent.insertBefore(marker, meta.nodes[0]);
        for (const node of meta.nodes) parent.removeChild(node);

        const nodes = [...fresh.el.childNodes];
        for (const node of nodes) parent.insertBefore(node, marker);

        parent.removeChild(marker);

        meta.nodes = nodes;
        meta.current = fresh;
        // 记下新的 create，下一次 HMR 才匹配得上
        meta.create = next_create;

        // 重建出来的实例 DOM 已经就位，onmount 现在就能跑
        fresh.onmount?.();

        replaced += 1;
    }

    return replaced;
}

function is_binding(value: unknown): value is Binding {
    if (typeof value !== 'object' || value === null) return false;

    const candidate = value as Partial<Binding>;

    return typeof candidate.get === 'function' && typeof candidate.set === 'function';
}

/**
 * `$bindable` 声明的 prop 在子组件里的落地形式。
 *
 * 父组件用了 `bind:x` 时传进来的是 `{ get, set }`，直接用它——子组件写入就会写回父组件的变量。
 * 父组件只是普通传值时，退化成一个本地读写对，子组件自己玩。
 */
export function to_binding<T>(value: unknown, fallback: T): Binding<T> {
    // 父组件用了 `bind:` 时传进来的就是绑定本身，直接用它（external 由父那边打上）
    if (is_binding(value)) return value as Binding<T>;

    let current = (value === undefined ? fallback : value) as T;

    return {
        external: false,
        get: () => current,
        set: (next: T) => (current = next)
    };
}
