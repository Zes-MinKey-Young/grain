
**Grain** is a Svelte-like Frontend Template Engine, allowing you to build tiny yet powerful and fast web applications.

Grain is a framework that prioritizes TypeScript. You don't need a `lang="ts"` attribute on your `<script>` tags.

# Getting started

## Scaffold a project

```sh
npx @graints/create-grain my-app
# or, inside this repository — links the local packages instead of the published ones
pnpm create-grain my-app

cd my-app
pnpm install
pnpm dev
```

Templates: `basic` (default — `App.grain` + a child component, covering `$state`, `{#if}` / `{#for}`, `bind:value`, `bind:this` with `<script onmount>`, `$props` / `$bindable` and component `<style>`) and `minimal` (one file). Pick one with `--template minimal`.

## What you get

```
index.html          has #app
src/main.ts         mounts the root component into #app
src/App.grain       root component
src/Counter.grain   child component (basic template only)
vite.config.mts     the grain vite plugin
tsconfig.json       types: ["@graints/runtime"]
```

`pnpm dev` / `pnpm build` / `pnpm preview` / `pnpm typecheck` do what you expect.

The smallest useful component:

```grain
<script>
  let count = $state(0);
</script>

<button onclick={() => count++}>
  clicked {count} times
</button>
```

## Editor

Install the **`grain.grain-vscode`** extension (`.vscode/extensions.json` in the template
recommends it) for highlighting, diagnostics, completion, go-to-definition and component
prop hints inside `.grain` files.

## Types

`$state`, `$props`, `$bindable` and the `*.grain` module type come from the runtime
(`@graints/runtime`), picked up by `tsconfig.json` via `"types": ["@graints/runtime"]` —
there is no declaration file to copy into your project. The extension injects the same
declarations for the editor.

## Path aliases

`paths` from `tsconfig.json` works on both sides:

```json
{
    "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@/*": ["src/*"] }
    }
}
```

```grain
<script>
    import Counter from '@/Counter.grain';
</script>
```

- **Editor**: `paths` is handed to the language service, and the file an alias points to
  is loaded on demand even if it has never been opened — so go-to-definition, completions
  and component attribute hints all work through aliases
- **Build**: Vite ships `resolve.tsconfigPaths`, but it cannot handle unknown extensions
  like `.grain`, so the plugin resolves `paths` itself

`paths` is read at startup — restart the dev server after changing `tsconfig.json`.

# How reactivity works in Grain
Grain does most work during compile time. Grain compiles reactive variable through analyzing dependencies during compile time and generating the reactive code there. For example, the following code:
```grain
<script>
  let count = $state(0);
  const increment = () => count++;
</script>

<button onclick={increment}>
  count is {count}
</button>
```
Should be compiled into:
```js
import { creEle } from "grain";
let count = 0;
const increment = () => {
  count++;
  update$0(1);
}
const update$0 = creEle('button', { onclick: increment_$1 }, ["count is", () => count]);
```
Here `update$0(1)` tells `() => count` to re-evaluate after `increment` is called. No functions like `$.get` is presented. Dependencies are tracked during compile time.

# Blocks: if and for

Block tags always carry a `#`, and are closed with `{/if}` / `{/for}`:

```grain
{#if count > 0}
    <p>{count} clicks</p>
{:else if count === 0}
    <p>click something</p>
{:else}
    <p>how did we get here</p>
{/if}
```

The test is an ordinary TypeScript expression, so it is checked and completed like any
other one. `{:else if ...}` and `{:else}` are both optional.

## for

The loop head is `binding of iterable` — like `for (const item of items)` in ES6, but with **no parentheses**:

```grain
<ul>
    {#for item of items}
        <li>{item}</li>
    {:else}
        <li>nothing here yet</li>
    {/for}
</ul>
```

`{:else}` renders when the iterable is empty. The binding can be a destructuring pattern,
and `const` / `let` in front of it is optional:

```grain
{#for [key, value] of entries}   <li>{key}: {value}</li>  {/for}
{#for { name } of people}        <li>{name}</li>          {/for}
{#for const item of items}       <li>{item}</li>          {/for}
```

## Notes

- A block tag without the `#` is an error: ``Block tags need a `#`: write `{#if ...}`.``.
- The loop variable only exists inside the block — the editor declares it for you, so it is
  typed and completed there, and go-to-definition jumps to the loop head.
- Blocks nest freely and can contain elements, components, expressions and other blocks.
- Iterating a `$state` array re-renders the block when it changes (`push`, `splice`, …).

# bind
`bind:` is used for two-way binding. It is used to bind a reactive variable to a sub-component that has a `$bindable` property or some native elements (like `<input>`).
```grain
<script>
  let count = $state(0);
</script>

<MyInput bind:value={count} />
```

You can also use `{getter, setter}` for `bind:value`. The `getter` should contain reactive variables.
```grain
<script>
  let count = $state(0);
  const increment = () => count++;
</script>

<MyInput bind:value={
    get: () => count,
    set: (value) => count = value
} />
```

You can also add an extra listener. See the next section.

## with extra listener
You may want to interop with a system that is non-reactive but armed with a strong event bus. Traditionally, you can track the changes of the variable itself but cannot see changes of its properties. But with a listener, you can make use of that event bus.
```grain
<script>
  import { operationList, NodeValueChangeOperation } from "./store";
  let { target } = $props<{ target: Node }>();
</script>
<input bind:value={
    get: () => target.value,
    set: (val) => operationList.do(new NodeValueChangeOperation(target, val)),
    listen: (update) => {
      operationList.addEventListener("do", (ev) => {
        if (ev instanceof NodeValueChangeOperation && ev.target === target) {
          update();
        }
      })
    }
}>
```

The listener is run only once when the `<input>` is mounted. In this scene, both the operationList's event listener and the changes of the variable `target` can trigger the re-evaluation of `get: () => target.value`.

The `listen` sub-expression could be shortened into `listen(operationList, "do", (ev) => ev instanceof NodeValueChangeOperation && ev.target === target)` (i.e. `listen(eventBus, eventName, guard_predicate)`). Grain expands it into the equivalent of the long form at compile time — no `listen` function exists at runtime. If `addEventListener` method does not exist, Grain will try to find an `on` method.

The guard is optional: `listen(operationList, "do")` is the always-true predicate, i.e. `update()` runs on every event. So the shortest form is just the event bus plus the event name:
```grain
<input bind:value={ get: () => stamp, set: (value) => stamp = value, listen(bus, "tick") } />
```

Listeners that share an event bus **and** an event name are merged into a single
`addEventListener` call. When the guards are `&&` chains, the leading conditions they have in
common are hoisted into one `if`:

```grain
<input bind:value={ one, listen(bus, "tick", (ev) => ev.open && ev.mine) } />
<input bind:value={ two, listen(bus, "tick", (ev) => ev.open && !ev.mine) } />
<input bind:value={ three, listen(bus, "tick") } />
```
```js
bus.addEventListener('tick', ($event) => {
    const ev = $event;
    __listen$0[2]?.();                       // no guard — runs on every event
    if (ev.open) {                           // shared by both guards, evaluated once
        if (ev.mine) __listen$0[0]?.();
        if (!ev.mine) __listen$0[1]?.();
    }
});
```

Only the shorthand form merges — a hand-written `listen: (update) => ...` is passed through
untouched, since the compiler cannot see what it subscribes to.

## bind: shape of get / set / listen
`bind:value={ ... }` is grain syntax, not TypeScript, so the three functions are checked at compile time:

| key | required shape | note |
| --- | --- | --- |
| `get` | `() => T` | no parameters — `get` provides the **getter**, not a value, so `get: count` means "`count` is the getter function". A callable expression (`get: read_count`) is also accepted. To bind a plain variable use the short form `bind:value={count}` |
| `set` | `(value) => void` | exactly one parameter, the new value; a callable expression (`set: do_set`) is also accepted |
| `listen` | `(update) => void` or `listen(bus, "name")` | `listen(bus, "name", guard)` — `guard` optional, must be a function, and the event name must be a string literal |

## bind with active
`active` is used to bind a non-reactive variable to a reactive variable. It tells the compiler that the getter should be called after the setter is called.
```grain
<script>
</script>
<Label>AutoSave</Label>
<ToggleButton bind:value={
    get: () => localStorage.get("autosaveEnabled"),
    set: (value) => localStorage.set("autosaveEnabled", value),
    active
} />
```

## listen-only bindings

`get` can be omitted if the `bind:` has a `listen` — the listener becomes the **only**
source of the value. The `update` callback it receives then takes one extra argument:

```grain
<input bind:value={ set: (v) => save(v), listen: (update) => bus.on('tick', () => update(next())) } />
```

`update(newValue)` stores the value and re-runs the element's property.
`update()` without an argument just refreshes, and the value stays whatever it was.

Compile-time rules for a binding without `get`:

| case | result |
| --- | --- |
| no `listen` either | error — nothing supplies the value |
| `listen(bus, "tick")` shorthand | error — it expands to `update()` and cannot supply a value; write the listener by hand |
| listener never calls `update(value)` | error — the value would never change |

## Macros

`<script macro>` defines functions that run **at compile time**. A macro returns the code to
splice in — a string, or an array of strings (which is joined with spaces, handy for writing
it across a few lines):

```grain
<script macro>
    import { flip as $flip } from './macros';

    function $field(name) {
        return ['get', ':', `() => ${name}`, ',', 'set', ':', `(v) => ${name} = v`];
    }
</script>

<script>
    let name = $state('ada');

    // expands into a function
    const flip = $flip('name');
</script>

<input bind:value={$field('name')} />
<button onclick={flip}>flip</button>
```

Whatever it returns is re-read with the syntax of whatever spot the macro sits in, so
`$field('name')` above expands to exactly `bind:value={ get: () => name, set: (v) => name = v }`.

These are **not** lexical tokens — each piece is arbitrary code; the compiler hands the whole
thing to that spot's parser. Returning a plain string (`'get: () => name, set: (v) => name = v'`)
does the same thing as the array above.

### Naming

A macro is named like a rune — `$` prefix — and may not shadow one, because the two are
handled at different stages:

| | runes (`$state`, `$props`, `$bindable`) | macros |
| --- | --- | --- |
| when | part of the language, handled by the compiler itself | run first, purely at compile time |
| what they do | `$state` becomes a read/write pair, `$props()` becomes the props argument | expand into other syntax |
| where | `<script>` | `bind:`, attribute values, `<script>` |

So `function $state()` in a macro script is an error, and so is a macro named `field`.

### Where a macro can be used

- **`bind:`** — read as a binding value
- **an attribute value** — read as an attribute value; a result without `{` or quotes
  is treated as one expression (`() => count++` on `onclick` becomes a handler)
- **inside `<script>`** — expands into an expression

Not in a template `{ ... }` interpolation: macros do not exist at runtime, so using one there
is a compile error rather than a `ReferenceError` later.

### Imports in `<script macro>`

Macros may import, but only **relative paths** — a package from `node_modules` is not
guaranteed to be loadable at build time — and the local name must be renamed with a `$`:

```grain
<script macro>
    import { flip as $flip } from './macros';   // ok
    import { flip } from './macros';            // error: local name needs the `$`
    import { flip as $flip } from 'lodash';     // error: not a relative path
</script>
```

Namespace imports are rejected for the same reason. `<script macro>` still cannot `export` —
it never reaches the output.

### Arguments

Arguments are evaluated at compile time: literals (`'name'`, `3`, `true`) arrive as values,
anything else arrives as **source text**. The return value must be a string, or an array of
strings.

## Stores: state that crosses modules

`$state` is compile-time — the compiler can only track dependencies it can see, and two
components that import the same module are invisible to each other. Shared state therefore
needs a little runtime: `writable` from the runtime package.

```ts
// counter.ts
import { writable } from '@graints/runtime';

export const counter = writable(0);
```

```grain
<script>
    import { counter } from './counter';
</script>

<input bind:value={$store(counter)} />
```

`$store` is a **built-in macro** — no `<script macro>` needed, no import. It expands to:

```js
{ listen: (update) => counter.subscribe(update), set: (v) => counter.set(v) }
```

`subscribe` calls back straight away with the current value, which is why there is no `get`:
the listener supplies the value (see *listen-only bindings*). Every subscriber is notified on
`set`, so any number of components stay in sync, in either direction.

- `set` returns the value written; writing the same value notifies nobody
- `subscribe` returns an unsubscribe function — hold onto it if you need to detach
- `$store` is reserved: you cannot define a macro with that name

### Showing a store's value

`{counter.get()}` in the template is evaluated at runtime like anything else, but **nothing
re-runs it**: refreshes are wired up at compile time and only for `$state`, while a store
announces changes through `subscribe`. So it renders once and then never moves.

`$read` is the read-only counterpart of `$store` — it emits only the `listen` part:

```grain
<p>value is {$read(counter)}</p>
<span title={$read(counter)}></span>
```

It works because `listen:` is not exclusive to `bind:` — a **plain attribute** or a **template
interpolation** can be written as a binding value too, and then it is one-way: the value gets
pushed onto the element, nothing flows back. The long form does the same thing:

```grain
<span title={ get: () => counter.get(), listen: (update) => counter.subscribe(update) }></span>
```

Give `get` and the value comes from it; leave it out and the value comes from the listener
(`subscribe` calls back with the current value right away). A binding value cannot be mixed
into text — it has to be the whole value.

## $node: derived values in `<script>`

`$node` declares a derived value. Its argument is a **binding value** — the same syntax as an
attribute or a template interpolation, even though it looks like a TypeScript object:

```grain
<script>
    let count = $state(0);

    const doubled = $node({ get: () => count * 2 });                         // one-way
    const tripled = $node(count * 3);                                        // short form, one-way
    const shown   = $node({ get: () => name.get(), set: (v) => name.set(v) }); // two-way
    const pushed  = $node({ listen: (update) => name.subscribe(update) });     // value from listen
</script>
```

- **`set` decides the direction.** With it, `shown = x` goes through the setter; without it, writing
  to the variable is a compile error — one-way means one-way
- **`get` is optional.** Missing it, the value comes from `listen` (`subscribe` calls back with the
  current value right away), exactly like a one-way attribute. Neither `get` nor `listen` is an error
- **`active` has to be written `active: true`**, so the argument stays valid TypeScript
- **Compile-time only.** No object survives into the output — just a getter/setter pair plus a
  function that recomputes the variable and refreshes whatever reads it

`listen` plays two different roles, depending on whether there is also a `get`:

- **with a `get`** — it only *triggers* a recompute. This is what you need when the source is a
  store: the compiler cannot see that dependency, so nothing would refresh without it
- **without a `get`** — it *is* the source. Whatever it hands to `update(newValue)` becomes the
  value, same as a one-way attribute

```grain
// listen triggers; get supplies the value
const upper = $node({ get: () => name.get().toUpperCase(), listen: (update) => name.subscribe(update) });

// listen is the source; there is no get
const pushed = $node({ listen: (update) => name.subscribe(update) });
```

## bind:this
`bind:this` hands you the element itself instead of one of its properties.

### as a variable
Write a bare name and `bind:this` **declares it for you** — there is nothing to add to your `<script>`:
```grain
<input bind:this={box} />

<script onmount>
  box.focus();
  box.placeholder = 'set in onmount';
</script>
```
The variable is created when the component instance is created, and assigned when the element is built.

### as a callback
Write a function (or any callable expression) and **no variable is declared** — the function is called with the element as soon as it is built:
```grain
<script>
  function grab(el: HTMLElement) {
    el.setAttribute('data-grabbed', 'yes');
  }
</script>

<p bind:this={grab}>grab(el) runs when this &lt;p&gt; is built。
```
An inline arrow works the same way: `bind:this={(el) => el.focus()}`.

Which one you get follows a single rule: an identifier that is **not** a function is the variable form, everything else is the callback form. `bind:this={grab}`, `bind:this={handlers.grab}`, `bind:this={makeHandler()}` and `bind:this={(el) => el.focus()}` are all callbacks.

Nothing else is hard-coded — whether the callback really accepts an element, or whether the variable can hold one, is checked by TypeScript in the editor:
```grain
<script>
  let s = $state('a');
</script>
<p bind:this={s}>...</p>   <!-- Type 'HTMLParagraphElement' is not assignable to type 'string' -->
```
Only obvious nonsense is rejected at compile time:
```grain
<p bind:this={123}>...</p>   <!-- error -->
```

## <script onmount>
`<script onmount>` runs right after the component's element is mounted — by then every `bind:this` variable has been assigned, so this is where you touch the DOM directly:
```grain
<script>
  let count = $state(0);
</script>

<script onmount>
  // only this block can see `box`
  box.focus();
</script>

<input bind:this={box} />
```

Rules:
- **Only `<script onmount>` can access a `bind:this` variable.** Using it anywhere else is a compile-time error in the editor: `` `box` is declared by `bind:this` and can only be used inside `<script onmount>` ``.
- It runs once per component instance — for the root component after it is appended to the target, for a child component when the parent attaches it.
- `$state(...)` and `$props()` work inside it, exactly like in `<script>`.
- It is not an event handler: writes to a `$state` there do not schedule a refresh. Set up the DOM instead, or do reactive work in `<script>`.

A `bind:this` variable is typed with the matching DOM interface (`HTMLInputElement` for `<input>`, `HTMLDivElement` for `<div>`, …), so `box.value` and `box.focus()` are checked and completed. Unknown tags fall back to `HTMLElement`.

### no second data flow
A `bind:this` variable is a plain variable, not reactive state. The binding plus `active` is its **only** data flow — `active` re-reads the getter and writes the value back to that element, and nothing else. Reading the same variable elsewhere in the template does not update when it changes:
```grain
<script>
  let draft = '';
</script>

<input bind:value={ get: () => draft, set: (value) => draft = value, active } />
<span>draft: {draft}</span>   <!-- never changes; compile time has no way to know -->
```
Use `$state` if you want the rest of the template to follow.
