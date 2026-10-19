# Grain 语法参考

## 一个 `.grain` 文件

```grain
<script>
    // TypeScript，原样进产物
    let count = $state(0);

    const bump = () => count++;
</script>

<button onclick={bump}>
    clicked {count} times
</button>

<style>
    button { margin-top: 0.5rem; }
</style>
```

三段都可省略。`<script>` 可以出现多个（`<script>`、`<script onmount>`、`<script macro>`，后者见 `ecosystem.md`）。

## 模板基础

- 插值：`{表达式}` —— 任意 TS 表达式
- 属性：`class={name}` / `onclick={fn}` / `disabled` 裸写
- 事件是**原生属性名**：`onclick` / `oninput` / `onkeydown`，不是 `on:click`
- HTML 注释 `<!-- -->` 与 `{/* */}` 均可

## 块：`{#if}`

```grain
{#if count > 0}
    <p>{count} clicks</p>
{:else if count === 0}
    <p>click something</p>
{:else}
    <p>how did we get here</p>
{/if}
```

条件是普通 TS 表达式，类型检查与补全照常。`{:else if}` / `{:else}` 都可省。

块标签**必须带 `#`**，忘了会报 ``Block tags need a `#`: write `{#if ...}`.``

## 块：`{#for}`

循环头是 `绑定 of 可迭代`，**没有括号**（不像 `for (const x of xs)`）：

```grain
<ul>
    {#for item of items}
        <li>{item}</li>
    {:else}
        <li>nothing here yet</li>
    {/for}
</ul>
```

`{:else}` 在可迭代为空时渲染。

绑定的四种写法（前面 `const` / `let` 可省）：

```grain
{#for item of items}          <li>{item}</li>       {/for}
{#for [key, value] of entries} <li>{key}</li>       {/for}
{#for { name } of people}      <li>{name}</li>      {/for}
{#for const item of items}     <li>{item}</li>      {/for}
```

循环变量只存在于块内（编辑器会为它建声明，所以有类型、可跳转）。

### key

```grain
{#for item of items with key = item.id}
    <p>{item.name}</p>
{/for}
```

- 写 `with key`：按**身份**匹配，换顺序只移动已有行、不重写
- 不写：按**位置**匹配，够用于追加、末尾删除、原地改值
- **两项解构自动认第一项当 key** —— `{#for [k, v] of map}` 和 `{#for [i, x] of xs.entries()}` 都不用再手写 `with key = k`

遍历 `$state` 数组 / `Map` / `Set` 时，容器变化会驱动块更新（`push` / `splice` / `set` / `delete` / `clear` … 都有对应的精确刷新）。

## `bind:` 双向绑定

### 绑到变量

```grain
<input bind:value={text} />
```

### 绑到子组件的 `$bindable`

```grain
<!-- 父 -->
<Child bind:count={total} />
```

```grain
<!-- 子 -->
<script>
    let { label, count = $bindable(0), children } = $props<{
        label: string;
        count?: number;
        children?: () => unknown;
    }>();
</script>
```

### 自定义 get / set / listen

```grain
<input bind:value={ get: () => stamp, set: (value) => stamp = Number(value), listen(bus, 'tick') } />
```

- `get`：读
- `set`：写回
- `listen`：外部源变化时通知重算。两种形态
  - `listen(源, '事件名')` —— 简写，等价于监听该源的该事件
  - `listen: (update) => source.subscribe(update)` —— 完整形态
- `active: true` —— 每次写入后也重跑 getter。必须写成 `active: true`（这样参数整体仍是合法 TS）

### 只监听、不写回（单向）

```grain
<input bind:value={ listen: (update) => name.subscribe(update) } />
```

`listen` 把 `update(newValue)` 交上来的值当作当前值，跟单向属性一样。

### `bind:this`

```grain
<input bind:this={box} />        <!-- 变量：元素挂上时赋值 -->
<p bind:this={grab}>…</p>        <!-- 函数：挂上时以元素为参数调用 -->
```

`bind:this` 声明的变量**只在 `<script onmount>` 里可用**，别处用会编译报错。

## `<script onmount>`

挂载后执行的普通代码，**内联进 `create()`**，跟 `<script>` 同一作用域（互相可见），不是回调：

```grain
<script onmount>
    box.focus();          // 此时元素已在文档里
    createRouter({ routes, target }).start();
</script>
```

## 组件

```grain
<script>
    import Child from './Child.grain';
    let name = $state('world');
</script>

<Child label={name} bind:count={total}>
    <em>插槽里也能读到 {name}</em>
</Child>
```

- 导入 `.grain` 文件即得组件
- props 由子组件 `$props<T>()` 声明，父组件按属性传
- 子组件内容通过 `children` 传入并渲染 `{children}`
- 子组件内部：`let { ... } = $props<Props>()`；带默认值用 `$bindable(默认值)`

## `<style>`

自动作用域（产物会加类名），选择器写法照常：

```grain
<style>
    .child { padding: 0.5rem; }
    .child b { color: green; }
    [data-grabbed] { color: #0a6; }
</style>
```

## 路由

`src/routes/` 目录即路由，编译期由插件扫成表。页面文件叫 `+page.grain`（跟 SvelteKit 一个路子）：

```
src/routes/+page.grain                 ->  /
src/routes/about/+page.grain           ->  /about
src/routes/posts/[id]/+page.grain      ->  /posts/:id
src/routes/posts/[...all]/+page.grain  ->  兜底（排序压到最后）
```

```grain
<script>
    import routes from "grain:routes";
    import { createRouter } from "@graints/runtime";
</script>

<nav>
    <a href="/">home</a>
    <a href="/about">about</a>
</nav>

<main id="outlet"></main>

<script onmount>
    const outlet = document.getElementById("outlet");

    createRouter({ routes, target: outlet }).start();
</script>
```

`grain:routes` 是虚拟模块（不是文件），只在 `import` 里出现；页面组件懒加载。

### 读当前路由与参数

`route` 是模块级响应式 store（`path` / `pattern` / `params`）。**params 不走 `$props`** ——
路由器只调 `page(target)`，不传 props：

```grain
<script>
    import { route } from "@graints/runtime";

    const here = $node({
        get: () => route.get(),
        listen: (update) => route.subscribe(update)
    });
</script>

<h1>Post {here.params.id ?? '?'}</h1>
```

模板里只读地用它：`{$read(route)}`。

### 跳转

`start()` 之后所有站内 `<a>` 都在 `document` 上被拦截；代码里用 `navigate(to, { replace })`
（它驱动最近一个 `start()` 过的路由器）。浏览器前进后退走 `popstate`。

`createRouter({ routes, target, fallback })` 返回 `{ route, navigate, start, stop }`；
`fallback` 是都没匹配上时挂的页面，`stop()` 撤监听并调掉已挂页面的 dispose。

**没有** SSR / 预渲染，也**没有** `+layout.grain`（外壳自己写组件）。只有 `+page.grain`
算路由，目录里可以放共用的子组件。

## 项目结构

```
index.html          has #app
src/main.ts         mounts the root component into #app
src/App.grain       root component
vite.config.mts     the grain vite plugin
tsconfig.json       types: ["@graints/runtime"]
```

`pnpm dev` / `pnpm build` / `pnpm preview` / `pnpm typecheck`。

`main.ts` 挂载：

```ts
import App from './App.grain';

App(document.getElementById('app')!);
```

## 编辑器

装 `grain-ts.grain-vscode` 扩展：高亮、诊断、补全、跳转、组件 prop 提示。悬停给的是**类型**（模板里也有效，包括 `{#for}` 里循环变量的类型）。
