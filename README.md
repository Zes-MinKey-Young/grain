
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

`tsconfig.json` 里的 `paths` 两边都认：

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

- **编辑器**：`paths` 会喂给语言服务，alias 指向的文件就算从没打开过也会被临时载入，
  所以跳转、补全、组件属性提示都正常
- **构建**：Vite 自带 `resolve.tsconfigPaths`，但它认不了 `.grain` 这种扩展名，
  所以插件自己按 tsconfig 又解析了一遍

`paths` 是启动时读的，改完 tsconfig 要重启 dev server。

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

The loop head is `binding of iterable` — **no parentheses**, exactly like `for...of` in ES6:

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

- A block tag without the `#` is an error: `Block tags need a `#`: write `{#if ...}`.
- The loop variable only exists inside the block — the editor declares it for you, so it is
  typed and completed there, and go-to-definition jumps to the loop head.
- Blocks nest freely and can contain elements, components, expressions and other blocks.
- Iterating a `$state` array re-renders the block when it changes (`push`, `splice`, …).

# bind
`bind:` is used for two-way binding. It is used to bind a reactive variable to a non-reactive variable.
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
  },
  active
}>
```

The listener is run only once when the `<input>` is mounted. In this scene, both the operationList's event listener and the changes of the variable `target` can trigger the re-evaluation of `get: () => target.value`.

The `listen` sub-expression could be shortened into `listen(operationList, "do", (ev) => ev instanceof NodeValueChangeOperation && ev.target === target)` (i.e. `listen(eventBus, eventName, guard_predicate)`). Grain expands it into the equivalent of the long form at compile time — no `listen` function exists at runtime. If `addEventListener` method does not exist, Grain will try to find an `on` method.

The guard is optional: `listen(operationList, "do")` is the always-true predicate, i.e. `update()` runs on every event. So the shortest form is just the event bus plus the event name:
```grain
<input bind:value={ get: () => stamp, set: (value) => stamp = value, listen(bus, "tick") } />
```

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

A binding does not need a `get` if it has a `listen` — the listener becomes the **only**
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
