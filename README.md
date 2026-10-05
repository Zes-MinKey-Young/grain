
**Grain** is a Svelte-like Frontend Template Engine, allowing you to build tiny yet powerful and fast web applications. Grain is a framework that:
- Prioritizes TypeScript. You don't need a `lang="ts"` attribute on your `<script>` tags.
- Does most work during compile time. Grain compiles reactive variable through analyzing dependencies during compile time and generating the reactive code there. For example, the following code:
```html
<script lang="ts">
  let count = $state(0);
  const increment = () => count++;
</script>

<button onclick={increment}>
  count is {count}
</button>
```
Should be compiled to:
```js
import { creEle } from "grain";
let count = 0;
const increment = () => {count++;}
const increment_$1 = () => {
    count++;
    update$0(1);
}
const update$0 = creEle('button', { onclick: increment_$1 }, ["count is", () => count]);
```
Here `update(1)` tells `() => count` to re-evaluate after `increment` is called. No functions like `$.get` is presented. Dependencies are tracked during compile time.
- Provides a way to interop with non-reactive code. In Svelte, when using functions for `bind:value`, the getter is not automatically called after the setter. Its invocation relies on the setter modifying a reactive variable. In Grain, you can use `bindactive:value` to tell Grain you are not operating a reactive variable, and it will actively run the getter after setter was called. For example, you operate `localStorage` using a `ToggleButton` component, you can use `bindactive:value` to tell Grain that the getter should be called after the setter was called.
