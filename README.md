
**Grain** is a Svelte-like Frontend Template Engine, allowing you to build tiny yet powerful and fast web applications.

Grain is a framework that prioritizes TypeScript. You don't need a `lang="ts"` attribute on your `<script>` tags.

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
| `get` | `() => T` | no parameters; a bare expression (`get: count`) is also accepted and wrapped into `() => (count)` |
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
