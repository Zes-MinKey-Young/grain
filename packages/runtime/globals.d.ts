/**
 * Grain's global types.
 *
 * This file is ambient (it has no import / export), so everything in it — `$state`,
 * `$props`, `$bindable`, `$node`, the built-in macros and the `*.grain` module
 * declarations — is global as soon as the file is part of the TS program.
 *
 * Projects don't need a copy: the package's `types` entry (`dist/index.d.ts`) points here,
 * so `"types": ["@graints/runtime"]` in tsconfig is enough.
 *
 * The VS Code extension injects the very same declarations (GRAIN_TYPE_SOURCE in
 * `packages/vscode/src/typescript.ts`) — keep the two in sync when you change this.
 */

/**
 * Reactive state. Compiled down to a plain variable; functions that write to it
 * get the matching update calls appended.
 *
 * @example
 * ```ts
 * let count = $state(0);
 *
 * function bump() {
 *     count += 1;      // writes to it get the refresh calls appended
 * }
 * ```
 */
declare function $state<T>(initial: T): T;

/**
 * Component props — the type parameter is the props type.
 *
 * @example
 * ```ts
 * let { label, children } = $props<{
 *     label: string;
 *     children?: () => unknown
 * }>();
 * ```
 */
declare function $props<T extends Record<string, unknown> = Record<string, unknown>>(): T;

/**
 * A prop that supports two-way binding. When the parent writes `bind:name={x}`,
 * assigning to it in the child writes back to the parent's `x`.
 * The parameter is the fallback used when the parent passes nothing and binds nothing.
 *
 * @example
 * ```ts
 * let { value = $bindable(0) } = $props();
 * ```
 */
declare function $bindable<T>(fallback?: T): T;

/**
 * A derived value in `<script>`.
 *
 * The argument is a **binding value** — grain syntax, not a TypeScript object — so `set`
 * decides the direction, and `get` may be omitted when `listen` supplies the value.
 * Purely compile-time: no object survives into the output.
 *
 * @example one-way (read-only)
 * ```ts
 * let count = $state(0);
 * const doubled = $node({ get: () => count * 2 });
 * ```
 *
 * @example short form — the same thing
 * ```ts
 * const tripled = $node(count * 3);
 * ```
 *
 * @example two-way
 * ```ts
 * const shown = $node({ get: () => name.get(), set: (v) => name.set(v) });
 * ```
 *
 * @example no `get` — the value comes from `listen`
 * ```ts
 * const pushed = $node({ listen: (update) => name.subscribe(update) });
 * ```
 *
 * @example derived from a store — `listen` triggers the recompute
 * ```ts
 * const upper = $node({
 *     get: () => name.get().toUpperCase(),
 *     listen: (update) => name.subscribe(update)
 * });
 * ```
 */
declare function $node<T>(value: {
    get: () => T;
    set?: (value: any) => any;
    listen?: (update: (value?: any) => void) => void;
    active?: boolean;
}): T;
declare function $node(value: {
    get?: undefined;
    listen: (update: (value?: any) => void) => void;
    set?: (value: any) => any;
    active?: boolean;
}): any;
declare function $node<T>(value: T): T;

/**
 * Built-in macro: connects a cross-module `writable` to a binding — two-way.
 * Only usable as the value of `bind:`.
 *
 * @example on a `bind:` attribute — shown as a comment, since this is template syntax
 * ```ts
 * // <input bind:value={$store(name)} />
 * ```
 */
declare function $store<T>(store: {
    subscribe(listener: (value: T) => void): unknown;
    set(next: T): T;
}): void;

/**
 * Built-in macro: read-only — emits only the `listen` part, so the value is pushed onto
 * the element and nothing flows back. Only usable on a plain attribute or in a template
 * interpolation.
 *
 * @example on an attribute and in an interpolation — template syntax, so as a comment
 * ```ts
 * // <p>value is {$read(name)}</p>
 * // <span title={$read(name)}></span>
 * ```
 */
declare function $read<T>(store: {
    subscribe(listener: (value: T) => void): unknown;
    set?(next: T): T;
}): void;

/** What a compiled component looks like from the outside */
interface GrainComponent {
    /** Mounts into the target element (top-level usage) */
    (target: Element): unknown;
    /** Kept for HMR re-mounting */
    target?: Element;
    /** Called by the parent component to create a child instance */
    create(props?: Record<string, unknown>, children?: (() => unknown) | null): unknown;
}

/**
 * Only used when TS cannot resolve an imported component by itself — for example when the
 * `.grain` file is not open in the editor and nothing maps it to a type. Once it can be
 * resolved, this ambient declaration no longer applies.
 */
declare module '*.grain' {
    const component: GrainComponent;
    export default component;
}

declare module '*?grain-ast' {
    /** `App.grain?grain-ast` returns the parse result (Root) of that component */
    const root: unknown;
    export default root;
}
