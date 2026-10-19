# 逐项对照表

标注说明：**✓ 等价** / **↔ 需改写** / **✗ 无对应**

## 文件与脚本

| Svelte | Grain |
|---|---|
| `Foo.svelte` | `Foo.grain`（↔ 改名 + 后缀） |
| `<script>` | `<script>`（✓） |
| `<script context="module">` / `<script module>` | ✗ —— 跨模块状态用 store（`writable`） |
| `<script lang="ts">` | 不需要（Grain 的 `<script>` 本来就是 TS） |
| `<style>` | `<style>`（✓，自动作用域） |
| `<svelte:options>` | ✗ |

## props

```svelte
<!-- Svelte 5 -->
<script>
    let { label, count = 0, children } = $props();
</script>
```

```grain
<script>
    let { label, count = 0, children } = $props<{
        label: string;
        count?: number;
        children?: () => unknown;
    }>();
</script>
```

- ↔ `$props()` 需要显式类型参数（否则解构出来是 `any`）
- Svelte 4 的 `export let label` ↔ 同样改成 `$props<T>()` 解构
- `$bindable()` ✓ 同名同义：`let { count = $bindable(0) } = $props<T>()`

## 响应式状态

| Svelte | Grain | 备注 |
|---|---|---|
| `let n = $state(0)` | `let n = $state(0)` | ✓ 语法相同 |
| `let o = $state({a:1})`；`o.a = 1` | `let o = $state({a:1}, 1)` | ↔ **对象默认 level 0，必须加 1** |
| `let xs = $state([])`；`xs.push(1)` | 相同 | ✓ 数组默认 level 1 |
| `let m = $state(new Map())`；`m.set(k,v)` | 相同 | ✓ `Map`/`Set` 默认 level 1，方法由编译期改写 |
| 深层嵌套对象随便改 | 只到容器一层 | ↔ 更深的改动要重设计（见 `semantics.md`） |
| `$state.raw(x)` | ✗ —— Grain 的 level 0 就是"不追踪内部" |
| `$state.snapshot(x)` | ✗ —— 没有 Proxy，本来就是普通对象 |

## 派生值

| Svelte | Grain |
|---|---|
| `$derived(expr)` | `$node(expr)`（↔ 简写形式）或 `$node({ get: () => expr })` |
| `$derived.by(() => {...})` | `$node({ get: () => {...} })` |
| 写回派生值 | `$node({ get: () => a.get(), set: (v) => a.set(v) })`（Svelte 里派生不可写，Grain 可双向） |

```grain
const doubled = $node(count * 2);
const total   = $node({ get: () => items.reduce((sum, x) => sum + x.price, 0) });
const shown   = $node({ get: () => name.get(), set: (v) => name.set(v) });
```

## 副作用

| Svelte | Grain |
|---|---|
| `$effect(() => {...})` | **✗ 无对应** —— 会被原样留在产物里（运行时 ReferenceError）。必须按用途重写 |
| `$effect.pre(...)` | ✗ |
| `$effect.root(...)` | ✗ |
| `onMount(fn)` | `<script onmount>` |
| `onDestroy(fn)` | ✗ |
| `beforeUpdate` / `afterUpdate` | ✗ |
| `tick()` | ✗ 不需要 —— 写入后刷新是同步的 |
| `$inspect(...)` | ✗ 用 `console.log` |
| `$host()` | ✗ |

`$effect` 的四种改法见 SKILL.md 第 2 步；细节见 `semantics.md`。

## 控制流

| Svelte | Grain |
|---|---|
| `{#if}` `{:else if}` `{:else}` `{/if}` | ✓ 完全相同 |
| `{#each xs as x}` `{/each}` | `{#for x of xs}` `{/for}`（↔，无括号） |
| `{#each xs as x (x.id)}` | `{#for x of xs with key = x.id}` |
| `{#each xs as x, i}` | `{#for [i, x] of xs.entries()}` |
| `{#each xs as { a, b }}` | `{#for { a, b } of xs}`（✓ 解构照常） |
| `{#each ...}{:else}...{/each}` | `{#for ...}{:else}...{/for}` |
| `{#await p}...{:then v}...{:catch e}...{/await}` | ✗ 自己用 `$state` + `onmount` 管 |
| `{#key expr}...{/key}` | ✗ |
| `{@const x = expr}` | ✗ 报错 —— 提到 `<script>` 里（用 `$node`）或内联表达式 |

`{#for}` 的 `{:else}` 在可迭代为空时渲染。

## snippet / slot / 插槽

| Svelte | Grain |
|---|---|
| `<slot />`（子） | `{children}`（子，先从 props 取） |
| `<slot name="x" />` | ✗ 没有具名插槽 —— 用**单独的 prop 传组件** |
| `{#snippet row(x)}...{/snippet}` + `{@render row(1)}` | ✗ 没有带参 snippet —— 把那段 UI 拆成组件，用 props 传参 |
| `children` prop + `{@render children()}` | `{children}`（✓ 去掉 `@render`） |

```grain
<!-- 子 -->
<script>
    let { children } = $props<{ children?: () => unknown }>();
</script>

<div class="card">{children}</div>
```

## 事件

| Svelte | Grain |
|---|---|
| `on:click={fn}`（v4） | `onclick={fn}`（↔ **必须改，否则是死属性**） |
| `onclick={fn}`（v5） | ✓ 相同 |
| `on:click\|preventDefault`（v4 修饰符） | ✗ 在处理器里自己 `e.preventDefault()` |
| `on:click={e => ...}` | `onclick={(e) => ...}` |

## 绑定

| Svelte | Grain |
|---|---|
| `bind:value={x}` | ✓ 相同 |
| `bind:checked={x}` | ✓ 解析通过（通用属性绑定）；有疑问就用 `{ get, set }` 显式写 |
| `bind:group={x}` | ✗ 语义未实现 —— 手写 `{ get: () => x === 'a', set: (on) => { if (on) x = 'a'; } }` |
| `bind:this={el}` | ✓ 相同（**但该变量只能在 `<script onmount>` 里用**） |
| `bind:this={fn}`（回调形式） | ✓ 相同 |
| 组件上 `bind:prop` | ✓ 相同（子组件用 `$bindable()`） |

## 指令（全部会变成死属性，不报错）

| Svelte | Grain |
|---|---|
| `class:active={on}` | ✗ 手写 `class={on ? 'active' : ''}`（或 `class="a {on ? 'b' : ''}"`） |
| `class:active`（简写） | ✗ 同上 |
| `style:color={c}` | ✗ 手写 `style="color: {c}"` |
| `use:action` | ✗ 在 `<script onmount>` 里对元素调用（先用 `bind:this` 拿到） |
| `transition:fade` / `in:` / `out:` | ✗ 无动画系统 |
| `animate:flip` | ✗（且会**报错**：循环头解析失败） |

## 动画

`transition:` / `in:` / `out:` / `animate:` 全都 ✗。产物里只会多一个 `"transition:fade": true` 之类的死属性（`animate:` 更糟，直接报错）。要动效只能自己用 CSS 过渡 + 在合适时机切 class。

## `<svelte:xxx>`

| Svelte | Grain |
|---|---|
| `<svelte:window on:resize>` | ✗ 在 `<script onmount>` 里 `window.addEventListener` |
| `<svelte:body>` | ✗ 同上 |
| `<svelte:document>` | ✗ 同上 |
| `<svelte:head><title>` | ✗ 在 `<script onmount>` 里 `document.title = ...` |
| `<svelte:element this={tag}>` | ✗ 用条件分支（`{#if tag === 'a'}` …）分别渲染 |
| `<svelte:component this={C}>` | ✗ 用条件分支 |
| `<svelte:boundary>` | ✗ |
| `<svelte:options>` | ✗ |

注意：这些**都能通过编译**，会生成同名未知元素 —— 必须 grep 掉。

## store

```ts
import { writable } from 'svelte/store';   →   import { writable } from '@graints/runtime';
```

| Svelte | Grain |
|---|---|
| 模板里 `{$count}`（自动订阅） | `{$read(count)}`（只读） |
| `bind:value={$count}` | `bind:value={$store(count)}` |
| 脚本里 `count.set(1)` | ✓ 相同 |
| `count.update(fn)` | ✓ 有就照用（没有的话 `count.set(fn(count.get()))`） |
| `get(count)` | `count.get()` |
| `derived(a, fn)` | `$node({ get: () => ..., listen: (update) => a.subscribe(update) })` |
| `readable` | ✓ 运行时同样导出（按需确认） |
| 自定义 store（`subscribe` 返回取消函数） | ✓ 兼容：`subscribe(cb)` 立刻回调和返回 unsubscribe 是 Grain 的约定 |

**最容易错**：`{count.get()}` 在模板里只求值一次、永不更新 —— 必须 `$read`。

## 上下文 / 跨组件共享

| Svelte | Grain |
|---|---|
| `setContext` / `getContext` | ✗ 用 store 代替 |
| `createEventDispatcher` / `$on`（v4） | ✗ 用 props 回调 / store |

## SvelteKit

| SvelteKit | Grain |
|---|---|
| `src/routes/+page.svelte` | `src/routes/+page.grain`（同名同义） |
| `src/routes/about/+page.svelte` | `src/routes/about/+page.grain` |
| `src/routes/posts/[slug]/+page.svelte` | `src/routes/posts/[slug]/+page.grain` |
| `+page.ts` 的 `load()` | ✗ 在组件 `onmount` 里自己取数 |
| 页面里读 `page.params` | ✗ 从 `route`（响应式 store）取，不走 props |
| `$app/stores` 的 `page` | ✗ 自己用 `location` / `route` |
| `+layout.svelte` | ✗ 没有 `+layout.grain` —— 手写 shell 组件 |
| `+error.svelte` | ✗ |
| SSR / 预渲染 | ✗ Grain 是纯客户端挂载 |
| `+page.ts` 的 `load()` | ✗ 在组件 `onmount` 里自己取数 |
| `$app/stores` 的 `page` | ✗ 自己用 `location` / 路由 API |
| `+layout.svelte` | ✗ 手写 shell 组件 |
| `+error.svelte` | ✗ |
| SSR / 预渲染 | ✗ Grain 是纯客户端挂载 |

## 挂载入口

```ts
// main.ts（模板给的就是这个）
import App from './App.grain';

App(document.getElementById('app')!);
```

Svelte 的 `new App({ target })` ↔ 改成函数调用。
