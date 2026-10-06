/**
 * Global types every grain project needs (`$state`, `$props`, `$bindable`,
 * `import x from './x.grain'`).
 *
 * The VS Code extension injects the same declarations for the editor, so this
 * file is what makes `tsc --noEmit` agree with it.
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
