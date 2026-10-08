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

/**
 * 跨模块共享的可写状态。
 *
 * `$state` 只在编译期可见——两个组件各自 import 同一个模块时，编译器看不到它们
 * 之间的依赖，所以跨模块的追踪交回给运行时：值变了就通知订阅者。
 *
 * 配合内置宏 `$store` 使用（它生成订阅代码），手写 `bind:value` 也能直接用。
 */
export interface Writable<T> {
    /** 当前值 */
    get(): T;
    /** 写新值，返回**最终值**；值没变就不通知 */
    set(next: T): T;
    /**
     * 订阅：立刻用当前值调一次，之后值变了再调。返回退订函数。
     *
     * 立刻调这一次是刻意的：绑定因此拿到初始值，不需要另外的 getter。
     */
    subscribe(listener: (value: T) => void): () => void;
}

/** `for` 块里的一项：节点，加一个"换成新值"的更新函数 */
export interface ListEntry {
    nodes: Node[];
    /** 复用这一项时调用：把循环变量重新绑到新值上，再刷依赖它的片段 */
    update(next: unknown, index: number): void;
}

export interface ListOptions {
    /** 建一项。第一次调用后，同样的项靠 `update` 复用，不再重建 */
    render(item: unknown, index: number): ListEntry;
    /** `with key = ...` 给出来的键；没有就按位置复用 */
    key?: (item: unknown, index: number) => unknown;
    /** 列表为空时渲染的分支 */
    fallback?: () => Node[];
    /**
     * 重新取一次列表。
     *
     * 有它，父级刷新这一段（`list()`）就是"重新取 + 比对"；没有的话只能靠编译器
     * 在写入点自己调 `sync` / `push`。
     */
    source?: () => Iterable<unknown>;
}

/**
 * `for` 块产出的那一段。
 *
 * 它是有 `el` 的 updater（父级只挂载一次，之后调 `update`），`el` 是一个锚点注释，
 * 真实节点插在它前面 —— 所以更新时可以只动变化的那几项，已有的 DOM 留着复用。
 */
export interface List extends Updater {
    el: Node;
    /** 落在这段里的节点（含末尾的锚点），父级搬动 / 移除时用 */
    nodes: Node[];
    /** 按 key（或位置）比对，只更新变化的项。数组 / Map / Set / `entries()` 都行 */
    sync(items: Iterable<unknown>): void;
    /** `push(...)`：追加，已有的不动 */
    push(...added: unknown[]): void;
    /** `shift()`：去掉第一项 */
    shift(): void;
    /** `unshift(...)`：插到最前面 */
    unshift(...added: unknown[]): void;
    /** `splice(at, remove, ...added)` */
    splice(at: number, remove: number, ...added: unknown[]): void;
    /** 响应式容器发来的一次改动：按它动，说不清就整块比对 */
    apply(change: ContainerChange): void;
}

export function creList(options: ListOptions): List {
    const anchor: Node = document.createComment('');

    /** 当前存活的项，顺序跟列表一致 */
    let entries: Array<ListEntry & { key?: unknown }> = [];
    /** 空列表分支的节点（有它时列表非空，就撤掉） */
    let empty: Node[] = [];

    const place = (nodes: Node[], before: Node | null): void => {
        for (const node of nodes) anchor.parentNode?.insertBefore(node, before ?? anchor);
    };

    const drop = (nodes: Node[]): void => {
        for (const node of nodes) node.parentNode?.removeChild(node);
    };

    /** 建一项并插到 `before` 之前 */
    const add = (item: unknown, index: number, before: Node | null): ListEntry & { key?: unknown } => {
        const entry = options.render(item, index);

        (entry as ListEntry & { key?: unknown }).key = options.key?.(item, index);

        place(entry.nodes, before);

        return entry as ListEntry & { key?: unknown };
    };

    const set_empty = (on: boolean): void => {
        if (on && empty.length === 0 && options.fallback) {
            // 过一遍 to_nodes：fallback 里可能有静态文本（字符串），那不是节点
            empty = to_nodes(options.fallback());

            place(empty, null);
        } else if (!on && empty.length > 0) {
            drop(empty);

            empty = [];
        }
    };

    const sync = (items: Iterable<unknown>): void => {
        // 只在这里展开一次：`entries()` 这类迭代器是一次性的，展开两遍第二遍就是空的
        const next = Array.from(items);

        values = next;

        set_empty(next.length === 0);

        if (options.key) {
            // keyed：按 key 匹配，能对上就复用（内容靠 update 换掉）
            const old_by_key = new Map<unknown, ListEntry & { key?: unknown }>();

            for (const entry of entries) old_by_key.set(entry.key, entry);

            const kept: Array<ListEntry & { key?: unknown }> = [];

            for (let i = 0; i < next.length; i += 1) {
                const key = options.key(next[i], i);
                const found = old_by_key.get(key);

                if (found) {
                    old_by_key.delete(key);
                    found.update(next[i], i);
                    kept.push(found);
                } else {
                    kept.push(add(next[i], i, null));
                }
            }

            // 没对上的旧项：删掉
            for (const stale of old_by_key.values()) drop(stale.nodes);

            entries = kept;

            // 顺序没乱就不动 DOM；乱了才按新顺序依次挪到锚点前（移动，不重建）
            let ordered = true;

            for (let i = 0; i < entries.length - 1; i += 1) {
                const last = entries[i].nodes[entries[i].nodes.length - 1];
                const next = entries[i + 1].nodes[0];

                if (!last || last.nextSibling !== next) {
                    ordered = false;
                    break;
                }
            }

            if (!ordered) for (const entry of entries) place(entry.nodes, null);
        } else {
            // 没有 key：按位置复用，多出来的追加 / 删掉
            for (let i = 0; i < next.length; i += 1) {
                if (i < entries.length) entries[i].update(next[i], i);
                else entries.push(add(next[i], i, null));
            }

            while (entries.length > next.length) drop(entries.pop()!.nodes);
        }
    };

    /** 当前列表的值：容器方法改完之后，靠它把剩下的项重新绑一遍 */
    let values: unknown[] = [];

    /** 从 `at` 起把项重绑到 `values` 上 —— 值或位置变了的那些才需要 */
    const rebind_from = (at: number): void => {
        for (let i = at; i < entries.length; i += 1) entries[i].update(values[i], i);
    };

    // 作为 updater 被父级调用时：重新取一次列表再比对（没有 source 就什么都不做）
    const list = ((): void => {
        if (options.source) sync(options.source());
    }) as unknown as List;

    list.el = anchor;

    Object.defineProperty(list, 'nodes', {
        configurable: true,
        get: () => [...entries.flatMap((entry) => entry.nodes), ...empty, anchor]
    });

    list.sync = (items: Iterable<unknown>): void => {
        sync(items);
    };

    list.push = (...added: unknown[]): void => {
        set_empty(false);

        // 已有的项一点没动，所以只需要建新的
        for (const item of added) {
            values.push(item);

            entries.push(add(item, entries.length, null));
        }
    };

    list.shift = (): void => {
        if (entries.length === 0) return;

        drop(entries[0].nodes);

        entries = entries.slice(1);
        values = values.slice(1);

        // 后面的项都往前挪了一位：内容跟着换
        rebind_from(0);
    };

    list.unshift = (...added: unknown[]): void => {
        set_empty(false);

        const created = added.map((item, at) => add(item, at, entries[0]?.nodes[0] ?? anchor));

        entries = [...created, ...entries];
        values = [...added, ...values];

        rebind_from(added.length);
    };

    list.splice = (at: number, remove: number, ...added: unknown[]): void => {
        const from = Math.max(0, at);

        for (const entry of entries.slice(from, from + remove)) drop(entry.nodes);

        const created = added.map((item, offset) =>
            add(item, from + offset, entries[from + remove]?.nodes[0] ?? anchor)
        );

        entries = [...entries.slice(0, from), ...created, ...entries.slice(from + remove)];
        values.splice(from, remove, ...added);

        rebind_from(from);
    };

    list.apply = (change: ContainerChange): void => {
        switch (change.type) {
            case 'push':
                list.push(...change.items);
                break;

            case 'pop': {
                const last = entries.pop();

                if (last) drop(last.nodes);

                values.pop();
                break;
            }

            case 'shift':
                list.shift();
                break;

            case 'unshift':
                list.unshift(...change.items);
                break;

            case 'splice':
                list.splice(change.at, change.removed, ...change.items);
                break;

            default:
                // `set` / `delete` / `clear`，以及说不清的那些：重新取一次再比对
                if (options.source) {
                    values = Array.from(options.source());

                    sync(values);
                }
        }
    };

    return list;
}

/**
 * 一次容器改动。
 *
 * 响应式容器（`reactive_array` / `reactive_map` / `reactive_set`）改完自己发这个，
 * `for` 拿它决定动哪几行。`unknown` 是兜底 —— 说不清动了哪几行就整块比对。
 */
export type ContainerChange =
    | { type: 'push'; items: unknown[] }
    | { type: 'pop' }
    | { type: 'shift' }
    | { type: 'unshift'; items: unknown[] }
    | { type: 'splice'; at: number; removed: number; items: unknown[] }
    | { type: 'set' }
    | { type: 'delete' }
    | { type: 'clear' }
    | { type: 'unknown' };

export interface ReactiveContainer {
    /** 订阅改动；返回退订函数 */
    subscribe(listener: (change: ContainerChange) => void): () => void;
}

const ARRAY_METHODS: Record<string, (change: ContainerChange, args: unknown[]) => ContainerChange> = {
    push: (_change, args) => ({ type: 'push', items: args }),
    pop: () => ({ type: 'pop' }),
    shift: () => ({ type: 'shift' }),
    unshift: (_change, args) => ({ type: 'unshift', items: args }),
    splice: (_change, args) => ({
        type: 'splice',
        at: Number(args[0] ?? 0),
        removed: Number(args[1] ?? 0),
        items: args.slice(2)
    })
};

const MAP_METHODS: Record<string, () => ContainerChange> = {
    set: () => ({ type: 'set' }),
    add: () => ({ type: 'set' }),
    delete: () => ({ type: 'delete' }),
    clear: () => ({ type: 'clear' })
};

/**
 * 会改数组的、但说不清动了哪几行的方法。
 *
 * 只有它们（和上面那些精确的）才通知 —— 迭代、取值这类只读操作不能通知，
 * 否则 `Array.from(store)` 会触发 sync，sync 里又迭代，就无限递归了。
 */
const ARRAY_UNTARGETED = new Set(['sort', 'reverse', 'fill', 'copyWithin']);

/**
 * 包一个容器：改动照样生效，但会顺带告诉订阅者动了什么。
 *
 * 用在"编译器没法静态看清所有改动"的场景 —— 容器被传出去、在回调里改、或者
 * 改它的代码压根不在这个组件里。看得清的时候用 `$state([])` 就够（编译期直接生成
 * `list.push(...)`，连这层都不需要）。
 */
/** `describe` 返回 null 表示"这不改动内容，不用通知" */
function wrap<T extends object>(
    target: T,
    describe: (key: string, args: unknown[]) => ContainerChange | null
): T & ReactiveContainer {
    const listeners = new Set<(change: ContainerChange) => void>();

    const emit = (change: ContainerChange): void => {
        for (const listener of [...listeners]) listener(change);
    };

    return new Proxy(target, {
        get(current, key, receiver) {
            // 改了元素内部（`items[0].name = ...`）容器看不见 —— 手动喊一声，整块比对
            if (key === 'touch') {
                return () => emit({ type: 'unknown' });
            }

            if (key === 'subscribe') {
                return (listener: (change: ContainerChange) => void) => {
                    listeners.add(listener);

                    return () => {
                        listeners.delete(listener);
                    };
                };
            }

            // 不传 receiver：`size` 这类 getter 拿到 Proxy 会报
            // "called on incompatible receiver"。方法那边下面用 apply 绑回 target 了
            const value = Reflect.get(current, key) as unknown;

            if (typeof value !== 'function') return value;

            return (...args: unknown[]) => {
                const out = (value as (...rest: unknown[]) => unknown).apply(current, args);
                const change = describe(String(key), args);

                if (change) emit(change);

                return out;
            };
        },

        set(current, key, value) {
            const ok = Reflect.set(current, key, value);

            // 索引赋值之类的：说不清影响哪些行，整块比对
            emit({ type: 'unknown' });

            return ok;
        }
    }) as T & ReactiveContainer;
}

/** 会通知改动的数组 */
export function reactive_array<T>(initial: T[] = []): T[] & ReactiveContainer {
    return wrap(initial, (key, args) => {
        const precise = ARRAY_METHODS[key];

        if (precise) return precise({ type: 'unknown' }, args);

        return ARRAY_UNTARGETED.has(key) ? { type: 'unknown' } : null;
    });
}

/** 会通知改动的 Map（给 entries 数组也行） */
export function reactive_map<K, V>(
    initial: Iterable<readonly [K, V]> = []
): Map<K, V> & ReactiveContainer {
    return wrap(new Map(initial), (key) => MAP_METHODS[key]?.() ?? null);
}

/** 会通知改动的 Set（给数组也行） */
export function reactive_set<T>(initial: Iterable<T> = []): Set<T> & ReactiveContainer {
    return wrap(new Set(initial), (key) => MAP_METHODS[key]?.() ?? null);
}

/**
 * 响应式循环的检测点。
 *
 * 开发模式下编译器会把它埋进每个刷新函数：这里记的是"某个刷新函数在
 * `GUARD_WINDOW_MS` 内被叫了多少次"，超过 `GUARD_LIMIT` 就抛。
 *
 * 编译期只能发现静态看得出来的环（`$node` 互相依赖那种）。运行时的环——
 * store 通知、条件分支——只有跑起来才知道，所以留这一层兜底。
 */
const GUARD_WINDOW_MS = 10;
const GUARD_LIMIT = 100;

const guard_hits = new Map<string, { start: number; count: number }>();

export function guard(name: string): void {
    const now = Date.now();
    const at = guard_hits.get(name);

    if (!at || now - at.start > GUARD_WINDOW_MS) {
        guard_hits.set(name, { start: now, count: 1 });

        return;
    }

    at.count += 1;

    if (at.count < GUARD_LIMIT) return;

    // 抛之前清掉：下一轮从零开始，不然第一次触发之后就永远卡着
    guard_hits.clear();

    throw new Error(
        `\`${name}\` ran ${GUARD_LIMIT} times within ${GUARD_WINDOW_MS}ms — ` +
            'this is almost always a reactive loop: a value that keeps triggering its own update.'
    );
}

/**
 * 一个带外部订阅的渲染函数。
 *
 * 属性值和文本插值都可以是它：`listen` 决定什么时候重跑（store 的通知走这里），
 * 编译期不需要知道依赖是什么。
 */
export interface Bound {
    (): unknown;
    listen?: (update: () => void) => void;
}

/**
 * 单向绑定（属性值 / 文本插值用）：只往元素上推，不往回写。
 *
 * - 给了 `render`：值由它算（比如 `() => name.get()`）
 * - 没给 `render`：值由 listener 推 —— `update(新值)` 存下来当当前值
 *   （跟 `bind:` 里"没有 getter 的绑定"一个道理）
 */
export function creBound(
    render?: (() => unknown) | null,
    listen?: (update: (value?: unknown) => void) => void
): Bound {
    let current: unknown;

    const bound = (() => (render ? render() : current)) as Bound;

    if (listen) {
        bound.listen = (update) => {
            listen((value) => {
                if (value !== undefined) current = value;

                update();
            });
        };
    }

    return bound;
}

export function writable<T>(initial: T): Writable<T> {
    const listeners = new Set<(value: T) => void>();

    let current = initial;

    return {
        get: () => current,

        set(next) {
            if (next === current) return current;

            current = next;

            for (const listener of [...listeners]) listener(current);

            return current;
        },

        subscribe(listener) {
            listeners.add(listener);
            listener(current);

            return () => {
                listeners.delete(listener);
            };
        }
    };
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

    // 自管理的块（`{#for ...}`）：节点归它自己管，调它一下让它重新比对就行 ——
    // 走下面那条路会把它的节点删掉再插一遍，等于重建
    if ((slot.render as Partial<List>).nodes) {
        (slot.render as Updater)();
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
            // 过一遍 to_binding：`bind:value={ set, listen }` 这种没有 getter 的绑定
            // 要由它补上一个"值由 listener 提供"的 getter
            const binding = to_binding(value);

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
            const render = value as Bound;
            const apply = () => apply_prop(element, key, render());

            prop_slots.push(apply);
            apply();

            // 外部源驱动的单向属性：`title={$read(store)}` —— 由 listen 决定什么时候重跑
            render.listen?.(apply);
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

                // 块（`{#for ...}` 之类）已经自己渲染过了：它在没挂载时就把节点攒在
                // `nodes` 里，所以挂载要走这些节点，而不是只有那个锚点
                const managed = (child as Partial<List>).nodes;

                if (managed && managed.length > 0) {
                    for (const node of managed) el.appendChild(node);
                } else {
                    el.appendChild(child_el);
                }

                nested.push(child as Updater);

                // 自管理的块（`{#for ...}`）：也登记成片段，精确刷新才叫得到它。
                // render_slot 认得它，只会调一下让它自己比对，不会去重建
                if (managed) {
                    slots[index] = { anchor: null, render: child as () => unknown, nodes: [] };
                }

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

            const render = child as Bound;
            const slot: Slot = { anchor, render, nodes: [] };

            slots[index] = slot;
            render_slot(slot);

            // 模板插值也可以是单向绑定：`{$read(store)}`
            render.listen?.(() => render_slot(slot));
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

    if (typeof candidate.set !== 'function') return false;

    // 值要么有个 getter，要么由 listener 通过 `update(新值)` 喂进来
    return typeof candidate.get === 'function' || typeof candidate.listen === 'function';
}

/**
 * `$bindable` 声明的 prop 在子组件里的落地形式。
 *
 * 父组件用了 `bind:x` 时传进来的就是绑定本身，直接用它——子组件写入就会写回父组件的变量。
 * 父组件只是普通传值时，退化成一个本地读写对，子组件自己玩。
 *
 * 父那边如果**没有 getter 但有 listener**（`bind:value={ set, listen }`），
 * 值由 listener 提供：它调 `update(新值)`，这里把新值存下来当 getter 的结果。
 */
export function to_binding<T>(value: unknown, fallback?: T): Binding<T> {
    if (is_binding(value)) {
        // 用 Partial 看它：没有 getter 的绑定（值由 listener 提供）也是合法的
        const binding = value as Partial<Binding<T>>;

        if (binding.get) return binding as Binding<T>;

        // 没有 getter：拿 listen 喂进来的值当当前值
        let current = fallback as T;
        const listen: ((update: () => void) => void) | undefined = binding.listen;
        const write: ((next: T) => T) | undefined = binding.set;

        return {
            external: binding.external ?? true,
            get: () => current,
            set: (next: T) => (current = write ? write(next) : next),
            // 包一层：listener 给的 `update(新值)` 先存下来，再让元素重跑 getter
            listen: listen
                ? (update: () => void) =>
                      listen((next?: unknown) => {
                          if (next !== undefined) current = next as T;

                          update();
                      })
                : undefined,
            active: binding.active
        };
    }

    let current = (value === undefined ? fallback : value) as T;

    return {
        external: false,
        get: () => current,
        set: (next: T) => (current = next)
    };
}
