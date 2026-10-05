/**
 * Grain 运行时。
 *
 * 编译期已经把依赖关系分析完了，运行时只做三件事：
 * 1. `creEle` / `creFragment` 建 DOM
 * 2. 动态内容（函数）注册成一个个"片段"，按编号放好
 * 3. `update(n)` 重新求值第 n 号片段 —— 编译器生成的事件包装里直接写死了编号，
 *    运行时不需要再做任何依赖追踪
 */

/** `creEle` 的返回值：既是更新调度器，也带着根节点 */
export interface Updater {
    (...indices: number[]): void;
    el: Node;
}

export interface Binding<T = unknown> {
    get(): T;
    set(value: T): void;
}

type Props = Record<string, unknown>;

interface Slot {
    anchor: Comment;
    render: () => unknown;
    nodes: Node[];
}

/** 把片段的返回值统一成 DOM 节点数组 */
function to_nodes(value: unknown): Node[] {
    if (value === null || value === undefined || value === false || value === true) return [];
    if (value instanceof Node) return [value];
    if (Array.isArray(value)) return value.flatMap(to_nodes);

    if (typeof value === 'function') {
        const updater = value as Partial<Updater>;
        if (updater.el) return [updater.el];
        return to_nodes((value as () => unknown)());
    }

    return [document.createTextNode(String(value))];
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
    const nodes = to_nodes(slot.render());

    for (const node of slot.nodes) node.parentNode?.removeChild(node);
    slot.nodes = nodes;

    const parent = slot.anchor.parentNode;
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
        if (key.startsWith('bindactive:')) {
            // README 第 4 条：setter 跑完之后主动跑一次 getter
            const name = key.slice('bindactive:'.length);
            const binding = value as Binding;

            // 注册成属性片段，`update()` 全量刷新时会重新跑 getter
            const apply = () => apply_prop(element, name, binding.get());
            prop_slots.push(apply);
            apply();

            element.addEventListener('input', () => {
                binding.set(
                    name in element
                        ? (element as unknown as Record<string, unknown>)[name]
                        : element.getAttribute(name)
                );
                update();
            });
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
            // 嵌套元素（creEle 的返回值）直接挂上去，不算动态片段
            const child_el = (child as Partial<Updater>).el;
            if (child_el) {
                el.appendChild(child_el);
                nested.push(child as Updater);
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
