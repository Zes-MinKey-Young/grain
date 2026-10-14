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
 * 子组件额外挂一个 `setProps` —— 父组件靠它推新 props，
 * 不用重新 `create()`（重建会把子组件自己的 state 丢掉）。
 */
export interface Updater {
    (...indices: number[]): void;
    el: Node;
    setProps?: (props: Props, children?: (() => unknown) | null) => void;
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
    /**
     * 这一项里某个属性被改了（`items[i].prop = v`）：只刷读了它的那些片段。
     *
     * 编译器按属性名分组生成；没给的属性名就什么都不做（那一行没读它）。
     */
    updatePath?(prop: string): void;
}

/**
 * 内部记的一项：比 `ListEntry` 多了两项
 *
 * - `key`：`with key = ...` 算出来的身份
 * - `item`：这一项**当前**是什么值。比对时值没变就不用调 `update` —— 否则光换个
 *   顺序也会把每项的片段重跑一遍（行里写了 `Math.random()` 的话，数字就跳了）
 */
type Entry = ListEntry & { key?: unknown; item?: unknown };

export interface ListOptions {
    /** 建一项。第一次调用后，同样的项靠 `update` 复用，不再重建 */
    render(item: unknown, index: number): ListEntry;
    /** `with key = ...` 给出来的键；没有就按位置复用 */
    key?: (item: unknown, index: number) => unknown;
    /**
     * 项本身怎么从「键 + 值」拼出来。
     *
     * `{#for [k, v] of map}` 的项是 `[k, v]`，而 `map.set(k, v)` 只给了键和值 ——
     * 要更新那一项，得先把它拼回项的形状。`{#for k of set}` 那种不需要（值就是项）。
     */
    entry?: (key: unknown, value: unknown) => unknown;
    /**
     * 项**带下标**（`{#for [i, x] of items.entries()}`）。
     *
     * 这种列表追加时只拿到值，项得用 `entry` 拼出来（`[下标, 值]`），下标就是当前长度。
     */
    indexed?: boolean;
    /**
     * 交换时按**值**重排（行跟着值走，只刷下标）。
     *
     * 只影响这一个列表自己的 DOM —— 交换数组元素那件事是用户代码做的，所以同一个
     * 数组喂几个 `for` 都不相干。
     */
    swapByValue?: boolean;
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
    /**
     * 按 key（或位置）比对，只更新变化的项。数组 / Map / Set / `entries()` 都行。
     *
     * `force` 为真时每一项都重跑一遍 —— 用于"整个变量被重新赋值"（`items = [...]`）：
     * 那种写法在语义上就是换了个数组，全量刷才对得上。
     */
    sync(items: Iterable<unknown>, force?: boolean): void;
    /** `push(...)`：追加，已有的不动 */
    push(...added: unknown[]): void;
    /** `shift()`：去掉第一项 */
    shift(): void;
    /** `unshift(...)`：插到最前面 */
    unshift(...added: unknown[]): void;
    /** `splice(at, remove, ...added)` */
    splice(at: number, remove: number, ...added: unknown[]): void;
    /** `items[i] = v`：只换那一项（复用它的 DOM），不碰其余的 */
    setAt(index: number, value: unknown): void;
    /**
     * `items[i].prop = v`：只刷那一行里**读了 `prop`** 的片段。
     *
     * 整项没换（还是同一个对象引用），所以按值比对的 `sync` 会跳过它 —— 但它的某个
     * 属性确实变了，读那个属性的片段得重算。整行重跑的话，行里其它部分（比如
     * `Math.random()`）也会被重算一遍。
     */
    setPath(index: number, prop: string): void;
    /**
     * 一次改多个位置 —— 解构赋值用（`[a[0], a[1]] = [a[1], a[0]]`）。
     *
     * 为什么必须是批量的：那种赋值是**同时**写入所有目标。拆成多个 `setAt` 的话，
     * 第二个会读到第一个已经覆盖掉的值，而且中途会出现同一个值占着两个位置的状态。
     */
    setRows(pairs: Array<[number, unknown]>): void;
    /**
     * `map.set(k, v)` / `set.add(v)`：键有了就只换那一项，没有就追加。
     *
     * 需要 `{#for ... with key = ...}` —— 没有键就说不清是哪一项。
     */
    setKey(key: unknown, value: unknown): void;
    /** `map.delete(k)` / `set.delete(v)`：删掉那一项，后面的内容跟着换 */
    removeKey(key: unknown): void;
    /** `map.clear()` / `set.clear()`：清空（空列表分支会重新出现） */
    clear(): void;
    /** 响应式容器发来的一次改动：按它动，说不清就整块比对 */
    apply(change: ContainerChange): void;
}

/**
 * 一个 `for` 块产出的那一段。
 *
 * 方法都在这个类的原型上，实例的字段只有状态（锚点、当前项、当前值）—— 之前是每建一个
 * `for` 就造七个闭包，现在一个都不用。
 */
class ListImpl {
    el!: Node;
    /** 当前存活的项，顺序跟列表一致 */
    entries: Entry[] = [];
    /** 空列表分支的节点（列表非空时要撤掉） */
    empty: Node[] = [];
    /** 当前列表的值：容器方法改完，靠它把剩下的项重新绑一遍 */
    values: unknown[] = [];

    private options!: ListOptions;

    /**
     * 初始化（不用 constructor，是因为载体是个函数——要能被 `update$0(0)` 直接调用，
     * 而 class 的构造器没法用在函数身上）
     */
    init(options: ListOptions): void {
        this.options = options;
        this.el = document.createComment('');
        this.entries = [];
        this.empty = [];
        this.values = [];
    }

    /** 作为 updater 被父级调用时：重新取一次列表再比对（没有 source 就什么都不做） */
    /**
     * 作为 updater 被父级调用：整块刷新。
     *
     * 走到这儿说明依赖变了（`items = [...]` 或读了这个变量的表达式变了），语义上就是
     * 全量刷 —— 所以传 `force`，每一项都重跑一遍。
     */
    invoke(): void {
        if (this.options.source) this.sync(this.options.source(), true);
    }

    /** 落在这段里的节点（含末尾的锚点），父级搬动 / 移除时用 */
    get nodes(): Node[] {
        return [...this.entries.flatMap((entry) => entry.nodes), ...this.empty, this.el];
    }

    private place(nodes: Node[], before: Node | null): void {
        for (const node of nodes) this.el.parentNode?.insertBefore(node, before ?? this.el);
    }

    private drop(nodes: Node[]): void {
        for (const node of nodes) node.parentNode?.removeChild(node);
    }

    private add(item: unknown, index: number, before: Node | null): Entry {
        const entry = this.options.render(item, index) as Entry;

        entry.key = this.options.key?.(item, index);
        // 记住这一项当前是什么值：下次比对时值没变就不用重跑它的片段
        entry.item = item;

        this.place(entry.nodes, before);

        return entry;
    }

    private setEmpty(on: boolean): void {
        if (on && this.empty.length === 0 && this.options.fallback) {
            // 过一遍 toNodes：fallback 里可能有静态文本（字符串），那不是节点
            this.empty = toNodes(this.options.fallback());

            this.place(this.empty, null);
        } else if (!on && this.empty.length > 0) {
            this.drop(this.empty);

            this.empty = [];
        }
    }

    /** 从 `at` 起把项重绑到 `values` 上 —— 值或位置变了的那些才需要 */
    private rebindFrom(at: number): void {
        for (let i = at; i < this.entries.length; i += 1) {
            const entry = this.entries[i];

            if (entry.item === this.values[i]) continue;

            entry.update(this.values[i], i);
            entry.item = this.values[i];
        }
    }

    sync(items: Iterable<unknown>, force = false): void {
        // 只在这里展开一次：`entries()` 这类迭代器是一次性的，展开两遍第二遍就是空的
        const next = Array.from(items);

        this.values = next;

        this.setEmpty(next.length === 0);

        if (this.options.key) {
            // keyed：按 key 匹配，能对上就复用
            const oldByKey = new Map<unknown, Entry>();

            for (const entry of this.entries) oldByKey.set(entry.key, entry);

            const kept: Entry[] = [];

            for (let i = 0; i < next.length; i += 1) {
                const key = this.options.key(next[i], i);
                const found = oldByKey.get(key);

                if (found) {
                    oldByKey.delete(key);
                    // 值没变就不用重跑片段 —— 换顺序时几乎总是这种情况。
                    // 整个变量被重新赋值时（`force`）例外：那种语义就是全量刷。
                    // 项带下标时总是要调 update：下标变了，由它自己决定刷哪一块
                    // （值没换就只刷读了下标的那些片段）
                    if (force || found.item !== next[i]) found.update(next[i], i);

                    found.item = next[i];
                    kept.push(found);
                } else {
                    kept.push(this.add(next[i], i, null));
                }
            }

            // 没对上的旧项：删掉
            for (const stale of oldByKey.values()) this.drop(stale.nodes);

            this.entries = kept;

            this.reorderIfNeeded();
        } else {
            // 没有 key：按位置复用，多出来的追加 / 删掉
            for (let i = 0; i < next.length; i += 1) {
                if (i < this.entries.length) {
                    const entry = this.entries[i];

                    if (force || entry.item !== next[i]) entry.update(next[i], i);

                    entry.item = next[i];
                } else {
                    this.entries.push(this.add(next[i], i, null));
                }
            }

            while (this.entries.length > next.length) this.drop(this.entries.pop()!.nodes);
        }
    }

    push(...added: unknown[]): void {
        this.setEmpty(false);

        // 已有的项一点没动，所以只需要建新的
        for (const item of added) {
            // 项带下标时（`entries()`）只拿到值，项要拼出来，下标就是当前长度
            const entry = this.options.indexed ? this.itemFor(this.values.length, item) : item;

            this.values.push(entry);

            this.entries.push(this.add(entry, this.entries.length, null));
        }
    }

    shift(): void {
        if (this.entries.length === 0) return;

        this.drop(this.entries[0].nodes);

        this.entries = this.entries.slice(1);
        this.values = this.values.slice(1);

        // 后面的项都往前挪了一位：内容跟着换
        this.rebindFrom(0);
    }

    unshift(...added: unknown[]): void {
        this.setEmpty(false);

        const created = added.map((item, at) =>
            this.add(item, at, this.entries[0]?.nodes[0] ?? this.el)
        );

        this.entries = [...created, ...this.entries];
        this.values = [...added, ...this.values];

        this.rebindFrom(added.length);
    }

    splice(at: number, remove: number, ...added: unknown[]): void {
        const from = Math.max(0, at);

        for (const entry of this.entries.slice(from, from + remove)) this.drop(entry.nodes);

        const created = added.map((item, offset) =>
            this.add(item, from + offset, this.entries[from + remove]?.nodes[0] ?? this.el)
        );

        this.entries = [
            ...this.entries.slice(0, from),
            ...created,
            ...this.entries.slice(from + remove)
        ];
        this.values.splice(from, remove, ...added);

        this.rebindFrom(from);
    }

    /**
     * 顺序不对就按当前 entries 的顺序重排 —— 移动节点，不重建。
     *
     * 交换、splice 之后 DOM 的先后可能跟 entries 不一致，这时候才动；顺序没乱就一下
     * 都不碰。
     */
    private reorderIfNeeded(): void {
        for (let i = 0; i < this.entries.length - 1; i += 1) {
            const last = this.entries[i].nodes[this.entries[i].nodes.length - 1];
            const next = this.entries[i + 1].nodes[0];

            if (!last || last.nextSibling !== next) {
                for (const entry of this.entries) this.place(entry.nodes, null);

                return;
            }
        }
    }

    /**
     * 一次改多个位置（解构赋值）。
     *
     * 值先全部写进 `values` 再动 DOM —— 顺序执行的话，后面那个会读到前面覆盖掉的值。
     */
    setRows(pairs: Array<[number, unknown]>): void {
        if (pairs.length === 0) return;

        // 项带下标时（`entries()`）值是拼出来的：`[at, value]`，不能拿裸值去 update，
        // 否则循环变量会被绑到值本身（`let [i, item] = { id: 2 }`）
        const items = pairs.map(([at, value]) => [at, this.itemFor(at, value)] as [number, unknown]);

        for (const [at, item] of items) {
            if (Number.isInteger(at) && at >= 0 && at < this.values.length) this.values[at] = item;
        }





        // 项带下标（`entries()`）：行跟着**值**走。
        //
        // 按位置刷的话，交换会让每一行都变成"值也换了"，于是整行重跑；而行的身份
        // 其实是值 —— 下标只是位置。所以这里按值把已有的行重新排一遍，值没换的行
        // 只更新下标（由编译器生成的 update 判断），最后调一次 DOM 顺序。
        if (this.options.swapByValue) {
            const byValue = new Map<unknown, Entry>();

            for (const entry of this.entries) {
                byValue.set((entry.item as [number, unknown])?.[1], entry);
            }

            const kept: Entry[] = [];

            for (let i = 0; i < this.values.length; i += 1) {
                const item = this.values[i];
                const found = byValue.get((item as [number, unknown])[1]);

                if (found) {
                    found.update(item, i);
                    found.item = item;

                    kept.push(found);
                } else {
                    kept.push(this.add(item, i, null));
                }
            }

            for (const stale of this.entries) {
                if (!kept.includes(stale)) this.drop(stale.nodes);
            }

            this.entries = kept;

            this.reorderIfNeeded();

            return;
        }

        // 有 key 时，只要有一项的身份变了，就地更新就不成立 —— 交给整体比对
        if (this.options.key) {
            for (const [at, item] of items) {
                const entry = this.entries[at];

                if (!entry || entry.key !== this.options.key(item, at)) {
                    this.sync(this.values);

                    return;
                }
            }
        }

        for (const [at, item] of items) {
            const entry = this.entries[at];

            if (!entry) continue;

            entry.update(item, at);
            entry.item = item;
        }

        // 交换之后 DOM 的先后要跟着换
        this.reorderIfNeeded();
    }

    /**
     * `items[i].prop = v`：只刷那一行里读了 `prop` 的片段。
     *
     * 整项没换（还是同一个对象引用），按值比对的 `sync` 会跳过它 —— 所以这里直接
     * 问那一行要一个"属性级"的更新。没实现 `updatePath` 的行（老产物）就退回整行刷。
     */
    setPath(index: number, prop: string): void {
        const entry = this.entries[Number(index)];

        if (!entry) return;

        if (entry.updatePath) entry.updatePath(prop);
        else entry.update(entry.item, Number(index));
    }

    /** `items[i] = v`：只换那一项（复用它的 DOM），不碰其余的 */
    setAt(index: number, value: unknown): void {
        const at = Number(index);

        if (!Number.isInteger(at) || at < 0 || at >= this.entries.length) return;

        // 项带下标时（`entries()`）同样要拼成 `[at, value]`
        const item = this.itemFor(at, value);

        this.values[at] = item;

        // 有 key 且这一项的身份变了：它不再对应这个位置，只能重新比对
        if (this.options.key) {
            const key = this.options.key(item, at);

            if (this.entries[at].key !== key) {
                this.sync(this.values);

                return;
            }
        }

        this.entries[at].update(item, at);
        this.entries[at].item = item;
    }

    /**
     * 项本身：`{#for [k, v] of map}` 要把键和值拼成 `[k, v]`，别的形状就是值本身。
     */
    private itemFor(key: unknown, value: unknown): unknown {
        return this.options.entry ? this.options.entry(key, value) : value;
    }

    /** `map.set(k, v)` / `set.add(v)`：键有了就只换那一项，没有就追加 */
    setKey(key: unknown, value: unknown): void {
        // 没有键就说不清是哪一项。编译器不会给这种 for 生成调用，这里只是兜底
        if (!this.options.key) return;

        const at = this.entries.findIndex((entry) => entry.key === key);
        const item = this.itemFor(key, value);

        // 新键：跟 push 一样是追加
        if (at < 0) {
            this.push(item);

            return;
        }

        this.values[at] = item;

        this.entries[at].update(item, at);
        this.entries[at].item = item;
    }

    /** `map.delete(k)` / `set.delete(v)`：删掉那一项，后面的内容跟着换 */
    removeKey(key: unknown): void {
        const at = this.entries.findIndex((entry) => entry.key === key);

        if (at < 0) return;

        this.drop(this.entries[at].nodes);

        this.entries = [...this.entries.slice(0, at), ...this.entries.slice(at + 1)];
        this.values.splice(at, 1);

        this.rebindFrom(at);
        this.setEmpty(this.entries.length === 0);
    }

    /** `map.clear()` / `set.clear()`：清空（空列表分支会重新出现） */
    clear(): void {
        for (const entry of this.entries) this.drop(entry.nodes);

        this.entries = [];
        this.values = [];

        this.setEmpty(true);
    }

    /** 响应式容器发来的一次改动：按它动，说不清就整块比对 */
    apply(change: ContainerChange): void {
        switch (change[0]) {
            case CHANGE_PUSH:
                this.push(...change[1]);
                break;

            case CHANGE_POP: {
                const last = this.entries.pop();

                if (last) this.drop(last.nodes);

                this.values.pop();
                break;
            }

            case CHANGE_SHIFT:
                this.shift();
                break;

            case CHANGE_UNSHIFT:
                this.unshift(...change[1]);
                break;

            case CHANGE_SPLICE:
                this.splice(change[1], change[2], ...change[3]);
                break;

            default:
                // `set` / `delete` / `clear`，以及说不清的那些：重新取一次再比对
                if (this.options.source) {
                    this.values = Array.from(this.options.source());

                    this.sync(this.values);
                }
        }
    }
}

/**
 * 所有列表共用这一个 handler —— 所以实例上不用挂任何闭包。
 *
 * `get` 不传 receiver 是刻意的：传了 Proxy 的话，`size` 这类 getter 会报
 * "called on incompatible receiver"。
 */
const LIST_HANDLER: ProxyHandler<ListImpl> = {
    apply: (target) => target.invoke(),
    get: (target, key) => Reflect.get(target, key),
    has: (target, key) => Reflect.has(target, key)
};

export function creList(options: ListOptions): List {
    // 载体是个空函数（这样它能被调用），原型指向 ListImpl —— 于是方法走原型，
    // 实例上只有状态，一个闭包都不用建
    const self = function () {} as unknown as ListImpl;

    Object.setPrototypeOf(self, ListImpl.prototype);

    self.init(options);

    return new Proxy(self, LIST_HANDLER) as unknown as List;
}

/**
 * 一次容器改动的种类。
 *
 * 用整数而不是字符串：改动是热路径（每次 push / splice 都要比一次），
 * 整数比较比字符串快，也省掉字符串常量的分配。
 */
export const CHANGE_PUSH = 0;
export const CHANGE_POP = 1;
export const CHANGE_SHIFT = 2;
export const CHANGE_UNSHIFT = 3;
export const CHANGE_SPLICE = 4;
export const CHANGE_SET = 5;
export const CHANGE_DELETE = 6;
export const CHANGE_CLEAR = 7;
/** 说不清动了哪几行 —— 兜底，整块比对 */
export const CHANGE_UNKNOWN = 8;

/**
 * 一次容器改动：元组，第一个元素是种类（见上面那些常量）。
 *
 * 用元组而不是对象，是因为它每次改动都要新建一个 —— 数组比对象轻。
 */
export type ContainerChange =
    | [typeof CHANGE_PUSH, unknown[]]
    | [typeof CHANGE_POP]
    | [typeof CHANGE_SHIFT]
    | [typeof CHANGE_UNSHIFT, unknown[]]
    | [typeof CHANGE_SPLICE, number, number, unknown[]]
    | [typeof CHANGE_SET]
    | [typeof CHANGE_DELETE]
    | [typeof CHANGE_CLEAR]
    | [typeof CHANGE_UNKNOWN];

export interface ReactiveContainer {
    /** 订阅改动；返回退订函数 */
    subscribe(listener: (change: ContainerChange) => void): () => void;
}

const ARRAY_METHODS: Record<string, (args: unknown[]) => ContainerChange> = {
    push: (args) => [CHANGE_PUSH, args],
    pop: () => [CHANGE_POP],
    shift: () => [CHANGE_SHIFT],
    unshift: (args) => [CHANGE_UNSHIFT, args],
    splice: (args) => [CHANGE_SPLICE, Number(args[0] ?? 0), Number(args[1] ?? 0), args.slice(2)]
};

const MAP_METHODS: Record<string, () => ContainerChange> = {
    set: () => [CHANGE_SET],
    add: () => [CHANGE_SET],
    delete: () => [CHANGE_DELETE],
    clear: () => [CHANGE_CLEAR]
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
                return () => emit([CHANGE_UNKNOWN]);
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
            emit([CHANGE_UNKNOWN]);

            return ok;
        }
    }) as T & ReactiveContainer;
}

/** 会通知改动的数组 */
export function reactiveArray<T>(initial: T[] = []): T[] & ReactiveContainer {
    return wrap(initial, (key, args) => {
        const precise = ARRAY_METHODS[key];

        if (precise) return precise(args);

        return ARRAY_UNTARGETED.has(key) ? [CHANGE_UNKNOWN] : null;
    });
}

/** 会通知改动的 Map（给 entries 数组也行） */
export function reactiveMap<K, V>(
    initial: Iterable<readonly [K, V]> = []
): Map<K, V> & ReactiveContainer {
    return wrap(new Map(initial), (key) => MAP_METHODS[key]?.() ?? null);
}

/** 会通知改动的 Set（给数组也行） */
export function reactiveSet<T>(initial: Iterable<T> = []): Set<T> & ReactiveContainer {
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

const guardHits = new Map<string, { start: number; count: number }>();

export function guard(name: string): void {
    const now = Date.now();
    const at = guardHits.get(name);

    if (!at || now - at.start > GUARD_WINDOW_MS) {
        guardHits.set(name, { start: now, count: 1 });

        return;
    }

    at.count += 1;

    if (at.count < GUARD_LIMIT) return;

    // 抛之前清掉：下一轮从零开始，不然第一次触发之后就永远卡着
    guardHits.clear();

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
/** 单向绑定的实现：方法在原型上，每个绑定只建一个空函数当载体 */
class BoundImpl {
    private current: unknown;
    private render: (() => unknown) | null = null;
    private source: ((update: (value?: unknown) => void) => void) | null = null;

    init(render?: (() => unknown) | null, listen?: (update: (value?: unknown) => void) => void): void {
        this.render = render ?? null;
        this.source = listen ?? null;
        this.current = undefined;
    }

    /** 取值：给了 render 就由它算，否则用 listener 推来的那个值 */
    invoke(): unknown {
        return this.render ? this.render() : this.current;
    }

    /** 外部源驱动的单向绑定：什么时候重跑由它决定 */
    listen(update: () => void): void {
        if (!this.source) return;

        this.source((value) => {
            if (value !== undefined) this.current = value;

            update();
        });
    }
}

const BOUND_HANDLER: ProxyHandler<BoundImpl> = {
    apply: (target) => target.invoke(),
    get: (target, key) => Reflect.get(target, key),
    has: (target, key) => Reflect.has(target, key)
};

export function creBound(
    render?: (() => unknown) | null,
    listen?: (update: (value?: unknown) => void) => void
): Bound {
    const self = function () {} as unknown as BoundImpl;

    Object.setPrototypeOf(self, BoundImpl.prototype);

    self.init(render, listen);

    return new Proxy(self, BOUND_HANDLER) as unknown as Bound;
}

/** 方法在原型上，不在每个 store 上新建三个闭包 */
class WritableImpl<T> implements Writable<T> {
    private listeners = new Set<(value: T) => void>();
    private current: T;

    constructor(initial: T) {
        this.current = initial;
    }

    get(): T {
        return this.current;
    }

    set(next: T): T {
        if (next === this.current) return this.current;

        this.current = next;

        for (const listener of [...this.listeners]) listener(this.current);

        return this.current;
    }

    subscribe(listener: (value: T) => void): () => void {
        this.listeners.add(listener);
        listener(this.current);

        return () => {
            this.listeners.delete(listener);
        };
    }
}

export function writable<T>(initial: T): Writable<T> {
    return new WritableImpl(initial);
}

type Props = Record<string, unknown>;

/**
 * 插入点：建好节点就插到 `parent` 里 `before` 之前。
 *
 * 传了它，节点一创建就在文档里（top-down 挂载）；不传就还是装进 DocumentFragment、
 * 由调用方整体插（旧行为）。
 */
export interface Mount {
    parent: Node;
    before: Node | null;
}

const FRAGMENT_NODE = 11;

/** 活着的组件外壳，`hotReplace` 遍历它找要重建的实例 */
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
function toNodes(value: unknown): Node[] {
    if (value === null || value === undefined || value === false || value === true) return [];

    if (value instanceof Node) {
        return (value as Node & { nodeType: number }).nodeType === FRAGMENT_NODE
            ? [...value.childNodes]
            : [value];
    }

    if (Array.isArray(value)) return value.flatMap(toNodes);

    if (typeof value === 'function') {
        const updater = value as Partial<Updater>;
        // 递归：Updater 的 el 可能是 fragment，要展开
        if (updater.el) return toNodes(updater.el);
        return toNodes((value as () => unknown)());
    }

    return [document.createTextNode(String(value))];
}

/** 控件回写用哪个事件：checked 和 select 用 change，其余用 input */
function eventFor(el: Element, name: string): string {
    if (name === 'checked') return 'change';
    if (name === 'value' && el.tagName === 'SELECT') return 'change';

    return 'input';
}

function readProp(el: Element, name: string): unknown {
    return name in el ? (el as unknown as Record<string, unknown>)[name] : el.getAttribute(name);
}

function applyProp(el: Element, key: string, value: unknown): void {
    if (value === null || value === undefined || value === false) {
        el.removeAttribute(key);
    } else if (key === 'class' || !(key in el)) {
        el.setAttribute(key, String(value));
    } else {
        (el as unknown as Record<string, unknown>)[key] = value;
    }
}

function renderSlot(slot: Slot): void {
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

    const nodes = toNodes(slot.render());

    for (const node of slot.nodes) node.parentNode?.removeChild(node);
    slot.nodes = nodes;

    const parent = slot.anchor?.parentNode;
    if (!parent) return;

    for (const node of nodes) parent.insertBefore(node, slot.anchor);
}

/**
 * @param tag 为 `null` 时创建 fragment（用于组件根）
 */
/**
 * 元素 / 组件根的更新器。
 *
 * 刷新逻辑（`invoke`）在原型上，每个元素只建一个空函数当载体 —— 之前每个元素都要
 * 造一个 `update` 闭包（以及它捕获的那三个数组），这是页面里最密的一处分配。
 */
class UpdaterImpl {
    el!: Node;
    /**
     * children 的插入目标。
     *
     * 元素就是它自己；组件根（fragment）没有自己的元素，插到调用方给的位置上。
     * 不给 `at` 时两者相同（都装进一个 DocumentFragment），也就是旧行为。
     */
    host!: Node;
    /** children 里的动态片段，按 children 下标编号 */
    slots: Array<Slot | null> = [];
    /** 属性里的动态片段，接着往下编号 */
    propSlots: Array<() => void> = [];
    /** 嵌套的子元素，用于无参全量刷新时的递归 */
    nested: Updater[] = [];

    init(tag: string | null, props: Props, children: unknown[], at?: Mount): void {
        this.el = tag === null ? document.createDocumentFragment() : document.createElement(tag);

        // 给了插入点就立刻插进去：建树完成时它已经在文档里了（onmount 因此不用是个钩子）
        if (at && tag !== null) at.parent.insertBefore(this.el, at.before);

        // 组件根没有自己的元素，children 直接插到调用方指定的位置
        this.host = at && tag === null ? at.parent : this.el;
        this.slots = new Array(children.length).fill(null);
        this.propSlots = [];
        this.nested = [];

        this.buildProps(props);
        this.buildChildren(children);
    }

    /**
     * 刷新：带编号就只刷那几个片段，不带编号就是整棵子树
     * （`bind` + `active` 这类编译期算不出依赖的场景走无参）
     */
    invoke(...indices: number[]): void {
        if (indices.length === 0) {
            for (const slot of this.slots) if (slot) renderSlot(slot);
            for (const run of this.propSlots) run();
            for (const child of this.nested) child();

            return;
        }

        for (const index of indices) {
            if (index < this.slots.length) {
                const slot = this.slots[index];

                if (slot) renderSlot(slot);
            } else {
                this.propSlots[index - this.slots.length]?.();
            }
        }
    }

    private buildProps(props: Props): void {
        const element = this.el as Element;

        for (const [key, value] of Object.entries(props)) {
            if (key.startsWith('bind:')) {
                const name = key.slice('bind:'.length);
                // 过一遍 toBinding：`bind:value={ set, listen }` 这种没有 getter 的绑定
                // 要由它补上一个"值由 listener 提供"的 getter
                const binding = toBinding(value);

                // 注册成属性片段，`invoke()` 全量刷新时会重新跑 getter
                const apply = () => applyProp(element, name, binding.get());

                this.propSlots.push(apply);
                apply();

                // 外部事件源的钩子：挂载时跑一次，它自己决定什么时候叫刷新
                binding.listen?.(apply);

                element.addEventListener(eventFor(element, name), () => {
                    binding.set(readProp(element, name));

                    // 源不是响应式变量，编译期没写死任何刷新调用，只能这里主动全量刷一次
                    if (binding.active) this.invoke();
                });
            } else if (key === 'this' && typeof value === 'function') {
                // `bind:this`：元素建好就把元素交出去（变量赋值 / 回调都由编译器生成）
                (value as (element: Element) => void)(element);
            } else if (key.startsWith('on') && typeof value === 'function') {
                element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
            } else if (typeof value === 'function') {
                const render = value as Bound;
                const apply = () => applyProp(element, key, render());

                this.propSlots.push(apply);
                apply();

                // 外部源驱动的单向属性：`title={$read(store)}` —— 由 listen 决定什么时候重跑
                render.listen?.(apply);
            } else {
                applyProp(element, key, value);
            }
        }
    }

    private buildChildren(children: unknown[]): void {
        const host = this.host;

        children.forEach((child, index) => {
            if (typeof child === 'function') {
                // 属性更新器：占一个片段编号，但不产生 DOM
                if ((child as Partial<PropsUpdater>).props === true) {
                    this.slots[index] = {
                        anchor: null,
                        render: child as () => unknown,
                        nodes: [],
                        props: true
                    };

                    return;
                }

                // 嵌套元素（creEle 的返回值）直接挂上去，不算动态片段
                const childEl = (child as Partial<Updater>).el;

                if (childEl) {
                    const before = host.childNodes.length;

                    // 块（`{#for ...}` 之类）自己管节点：没挂载时它就把节点攒在 `nodes` 里，
                    // 所以挂载要走这些节点，而不是只有那个锚点
                    const managed = (child as Partial<List>).nodes;

                    if (managed) {
                        // top-down 时块已经自己插进 host 了（见 `inserted`），不用再搬
                        if (!(child as Partial<ListImpl>).inserted) {
                            for (const node of managed) host.appendChild(node);
                        }
                    } else {
                        host.appendChild(childEl);
                    }

                    this.nested.push(child as Updater);

                    // 自管理的块（`{#for ...}`）：也登记成片段，精确刷新才叫得到它。
                    // renderSlot 认得它，只会调一下让它自己比对，不会去重建
                    if (managed) {
                        this.slots[index] = { anchor: null, render: child as () => unknown, nodes: [] };
                    }

                    // 记下真正落进去的节点，HMR 换实例时才知道要替换哪一段
                    const meta = (child as Partial<ComponentShell>).__grain;

                    if (meta) meta.nodes = [...host.childNodes].slice(before);

                    // 子组件挂上了（根组件由生成出来的 mount 负责）
                    (child as Partial<Updater>).onmount?.();

                    return;
                }

                const anchor = document.createComment('');

                host.appendChild(anchor);

                const render = child as Bound;
                const slot: Slot = { anchor, render, nodes: [] };

                this.slots[index] = slot;
                renderSlot(slot);

                // 模板插值也可以是单向绑定：`{$read(store)}`
                render.listen?.(() => renderSlot(slot));
            } else {
                for (const node of toNodes(child)) host.appendChild(node);
            }
        });
    }
}

export {
    createRouter,
    link,
    navigate,
    normalize,
    route
} from './router.js';

export type {
    Page,
    Route,
    RouteDef,
    Router
} from './router.js';

const UPDATER_HANDLER: ProxyHandler<UpdaterImpl> = {
    apply: (target, _this, args) => target.invoke(...(args as number[])),
    get: (target, key) => Reflect.get(target, key),
    has: (target, key) => Reflect.has(target, key)
};

function create(tag: string | null, props: Props, children: unknown[], at?: Mount): Updater {
    // 载体是个空函数（这样 `update$0(0)` 能直接调），原型指向 UpdaterImpl
    const self = function () {} as unknown as UpdaterImpl;

    Object.setPrototypeOf(self, UpdaterImpl.prototype);

    self.init(tag, props, children, at);

    return new Proxy(self, UPDATER_HANDLER) as unknown as Updater;
}

/**
 * 建一个元素。
 *
 * `at` 给了插入点：元素一创建就插进去（top-down 挂载，建树完成时已在文档里）。
 * 不给就装进调用方后续统一插的 DocumentFragment（旧行为）。
 */
export function creEle(tag: string, props?: Props, children?: unknown[], at?: Mount): Updater {
    return create(tag, props ?? {}, children ?? [], at);
}

/** 组件根：不产生真实元素，内容直接挂到挂载点上 */
export function creFragment(children?: unknown[], at?: Mount): Updater {
    return create(null, {}, children ?? [], at);
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
/**
 * 组件外壳：HMR 换实例时只换里面，父组件持有的引用不动。
 *
 * 方法在原型上，每个组件实例只建一个空函数当载体。
 */
class ShellImpl {
    current!: Updater;
    meta!: ComponentMeta;

    init(
        instance: Updater,
        create: (props?: unknown, children?: unknown) => Updater,
        props: unknown,
        children: unknown
    ): void {
        this.current = instance;

        const self = this;

        // `current` 用访问器：HMR 换实例走的是它。
        // 访问器里的 `this` 是这个 meta 对象，所以要靠 self 指回外壳
        this.meta = {
            create,
            props,
            children,
            nodes: [],
            get current() {
                return self.current;
            },
            set current(next: Updater) {
                self.current = next;
            }
        };
    }

    invoke(...indices: number[]): void {
        this.current(...indices);
    }

    get el(): Node | undefined {
        return this.current.el;
    }

    get __grain(): ComponentMeta {
        return this.meta;
    }

    setProps(nextProps: Props, nextChildren?: unknown): void {
        this.meta.props = nextProps ?? {};
        this.meta.children = nextChildren ?? null;

        this.current.setProps?.(nextProps, nextChildren as (() => unknown) | null);
    }

    onmount(): void {
        this.current.onmount?.();
    }
}

const SHELL_HANDLER: ProxyHandler<ShellImpl> = {
    apply: (target, _this, args) => target.invoke(...(args as number[])),
    get: (target, key) => Reflect.get(target, key),
    has: (target, key) => Reflect.has(target, key)
};

export function component(
    instance: Updater,
    create: (props?: unknown, children?: unknown) => Updater,
    props: unknown,
    children: unknown
): Updater {
    const self = function () {} as unknown as ShellImpl;

    Object.setPrototypeOf(self, ShellImpl.prototype);

    self.init(instance, create, props, children);

    const shell = new Proxy(self, SHELL_HANDLER) as unknown as ComponentShell;

    components.add(shell);

    return shell as unknown as Updater;
}

/**
 * HMR：用新的 `create` 重建这个组件的所有实例。
 *
 * 只替换组件自己那一段 DOM —— 父组件、兄弟节点、以及父组件的状态都不动。
 *
 * @returns 换掉的实例数；0 表示这个组件现在没有活着的实例（比如它自己就是根组件），
 *          调用方该退回重新挂载。
 */
export function hotReplace(
    oldCreate: (props?: unknown, children?: unknown) => Updater,
    nextCreate: (props?: unknown, children?: unknown) => Updater
): number {
    let replaced = 0;

    for (const shell of [...components]) {
        const meta = shell.__grain;
        if (meta.create !== oldCreate) continue;

        const parent = meta.nodes[0]?.parentNode;

        // 还没挂上、或者已经卸载了
        if (!parent) {
            components.delete(shell);
            continue;
        }

        const fresh = nextCreate(meta.props, meta.children);

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
        meta.create = nextCreate;

        // 重建出来的实例 DOM 已经就位，onmount 现在就能跑
        fresh.onmount?.();

        replaced += 1;
    }

    return replaced;
}

function isBinding(value: unknown): value is Binding {
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
export function toBinding<T>(value: unknown, fallback?: T): Binding<T> {
    if (isBinding(value)) {
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
