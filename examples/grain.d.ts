/**
 * grain 项目里要有一份这个（或者由 `grain` 包提供）。
 * 改动时同步 `packages/vscode/src/typescript.ts` 里的 GRAIN_TYPE_SOURCE —— 那边管编辑器里的提示。
 */

/**
 * 响应式状态。编译期展开成普通变量，写了它的函数会自动接上 update 调用。
 */
declare function $state<T>(initial: T): T;

/**
 * 组件 props —— 泛型就是 props 的类型。
 * `let { label, children } = $props<{ label: string; children?: () => unknown }>();`
 */
declare function $props<T extends Record<string, unknown> = Record<string, unknown>>(): T;

/**
 * 可双向绑定的 prop。父组件写 `bind:name={x}` 时，
 * 子组件里对它的赋值会写回父组件的 `x`；参数是父组件没传值也没绑定时的兜底。
 */
declare function $bindable<T>(fallback?: T): T;

declare module '*.grain' {
    interface GrainComponent {
        /** 挂到目标元素上（根组件用法） */
        (target: Element): unknown;
        /** HMR 重新挂载用 */
        target?: Element;
        /** 作为子组件被父组件调用 */
        create(props?: Record<string, unknown>, children?: (() => unknown) | null): unknown;
    }

    const component: GrainComponent;
    export default component;
}

declare module '*?grain-ast' {
    /** `App.grain?grain-ast` 返回该组件的解析结果（Root） */
    const root: unknown;
    export default root;
}
