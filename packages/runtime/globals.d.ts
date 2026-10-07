/**
 * Grain 的全局类型。
 *
 * 这个文件是 ambient 的（没有 import / export），所以里面的 `$state` / `$props` /
 * `$bindable` 和 `*.grain` 模块声明都是全局的 —— 只要它被加进 TS 程序就生效。
 *
 * 项目里不需要拷贝它：包的 `types` 入口（`dist/index.d.ts`）引用了这里，
 * tsconfig 里写 `"types": ["@graints/runtime"]` 即可。
 *
 * VS Code 扩展注入的是同一份声明（见 packages/vscode 的 GRAIN_TYPE_SOURCE），
 * 改这里的时候记得同步。
 */

/**
 * Reactive state. Compiled down to a plain variable; functions that write to it
 * get the matching update calls appended.
 */
declare function $state<T>(initial: T): T;

/**
 * Component props — the type parameter is the props type.
 * `let { label, children } = $props<{ label: string; children?: () => unknown }>();`
 */
declare function $props<T extends Record<string, unknown> = Record<string, unknown>>(): T;

/**
 * A prop that supports two-way binding. When the parent writes `bind:name={x}`,
 * assigning to it in the child writes back to the parent's `x`.
 * The parameter is the fallback used when the parent passes nothing and binds nothing.
 */
declare function $bindable<T>(fallback?: T): T;

/** What a compiled component looks like from the outside */
interface GrainComponent {
    /** Mounts into the target element (top-level usage) */
    (target: Element): unknown;
    /** Kept for HMR re-mounting */
    target?: Element;
    /** Called by the parent component to create a child instance */
    create(props?: Record<string, unknown>, children?: (() => unknown) | null): unknown;
}

declare module '*.grain' {
    const component: GrainComponent;
    export default component;
}

declare module '*?grain-ast' {
    /** `App.grain?grain-ast` returns the parse result (Root) of that component */
    const root: unknown;
    export default root;
}
