
**Grain** 是一个类 Svelte 前端模板，让你能够构建小而强大且快速的 Web 应用

Grain 框架优先考虑 TypeScript，你不需要在 `<script>` 标签上添加 `lang="ts"` 属性。

# 快速开始

## 创建一个项目

```sh
npx @graints/create-grain my-app
# 或者克隆此仓库并连接本地包
pnpm create-grain my-app

cd my-app
pnpm install
pnpm dev
```

模板：`basic`（默认，
`App.grain` + 子组件，涵盖 `$state`、`{#if}` / `{#for}`、`bind:value`、`bind:this` 与 `<script onmount>`、`$props` / `$bindable` 和组件 `<style>`）和 `minimal`（一个文件）。使用 `--template minimal` 则只有一个。

## 产物

```
index.html          具有一个空的 #app
src/main.ts         将根组件挂载至 #app
src/App.grain       根组件
src/Counter.grain   子组件（只有基本模板）
vite.config.mts     Vite 配置
tsconfig.json       内含 types: ["@graints/runtime"]
```

可用命令：`pnpm dev` / `pnpm build` / `pnpm preview` / `pnpm typecheck`。

最小可用组件

```grain
<script>
  let count = $state(0);
</script>

<button onclick={() => count++}>
  clicked {count} times
</button>
```

## 编辑器

安装 **`grain-ts.grain-vscode`** 扩展 (初始化项目后的 `.vscode/extensions.json` 会推荐它)， 用于 `.grain` 文件内的语法高亮、诊断、补全、跳转定义和组件属性提示。

## 类型

`$state`、 `$props`、 `$bindable` 及 `*.grain` 模块类型来自运行时包
(`@graints/runtime`), 由 `tsconfig.json` 通过 `"types": ["@graints/runtime"]` 引用 —
无需拷贝类型定义文件到你的项目中。扩展也会给编辑器语言服务注入相同的代码。

## 路径别名

`paths` 在 `tsconfig.json` 中配置，以便在编辑器和构建时使用别名。

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

- **编辑器**: `paths` 被递给语言服务，别名指向的文件按需加载，即便它从未被打开——这使得有别名也能使用跳转定义、补全和组件属性提示。
- **构建**: Vite 能处理 `resolve.tsconfigPaths`，但不能处理 `.grain` 这样的陌生扩展名，因此插件需要自己解算。

`paths` 在启动时加载，修改 `tsconfig.json` 后需要重启。

# Grain 的响应式原理
Grain 把重活放在编译期。它通过编译期分析依赖并生成对应的响应式代码来编译响应式变量。例如以下代码：
```grain
<script>
  let count = $state(0);
  const increment = () => count++;
</script>

<button onclick={increment}>
  count is {count}
</button>
```
应当编译为：
```js
import { creEle } from "grain";
let count = 0;
const increment = () => {
  count++;
  update$0(1);
}
const update$0 = creEle('button', { onclick: increment_$1 }, ["count is", () => count]);
```
这里 `update$0(1)` 告诉 Grain 在 `increment` 调用后重新求值 `() => count`。没有 Svelte 那种 `$.get` 函数。依赖在编译期被追踪。

# if 和 for 块

块标签总是带 `#`, 并以 `{/if}` 或 `{/for}` 关闭:

```grain
{#if count > 0}
    <p>{count} clicks</p>
{:else if count === 0}
    <p>click something</p>
{:else}
    <p>how did we get here</p>
{/if}
```

条件是普通 TypeScript 表达式，和其他表达式一样检查和补全。`{:else if ...}` 和 `{:else}` 都是可选的。

## for

循环头部是 `binding of iterable` — 像 ES6 的 `for (const item of items)` 但 **没有圆括号**:

```grain
<ul>
    {#for item of items}
        <li>{item}</li>
    {:else}
        <li>nothing here yet</li>
    {/for}
</ul>
```

`{:else}` 块在可迭代对象为空时显示。绑定的表达式也可以是解构，前面的 `const` / `let` 是可选的。

```grain
{#for [key, value] of entries}   <li>{key}: {value}</li>  {/for}
{#for { name } of people}        <li>{name}</li>          {/for}
{#for const item of items}       <li>{item}</li>          {/for}
```

## 注意

- 没有 `#` 的块报错: ``Block tags need a `#`: write `{#if ...}`.``.
- 循环变量仅存在于块内 — 编辑器定义它、在那进行类型推算和补全，跳转定义跳到循环头部。
- 块能自由嵌套并可含有元素、组件、表达式和其他块。
- 迭代一个 `$state` 数组能在数组变化时重渲染块的部分 (`push`, `splice`, …)。

# bind
`bind:` 用于双向绑定，可以把一个响应式变量绑到具有 `$bindable` 属性的子组件或者某些原生元素（比如 `<input>`）。
```grain
<script>
  let count = $state(0);
</script>

<MyInput bind:value={count} />
```

你也可以用 `{getter, setter}` 语法。`getter` 应该包含响应式变量。
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

你也可以添加监听器，见下。

## 带额外监听器
你可能需要和一个非响应式但带有强大事件总线的系统交互。传统地，你可以跟踪变量本身的变化，但无法看到其属性的变化。但有了监听器语法，你就可以利用这个事件总线。
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

监听器只在 `<input>` 挂载时运行一次。在这个场景中，`operationList` 的事件和变量 `target` 的变化都能触发 `get: () => target.value` 的重新求值。

`listen` 子句可以简写为 `listen(operationList, "do", (ev) => ev instanceof NodeValueChangeOperation && ev.target === target)`。Grain 会把它展开成长形式，即 `listen(事件总线, 事件名称, 保卫谓词)`。如果事件总线对象没有 `addEventListener` 方法，Grain 会尝试寻找 `on` 方法代替。

保卫谓词也是可选的。`listen(operationList, "do")` 表示谓词恒真，也就是每次都调用 `update()`。所以最短的形式是只有事件总线和事件名：
```grain
<input bind:value={ get: () => stamp, set: (value) => stamp = value, listen(bus, "tick") } />
```

拥有同一个事件总线和事件名称的监听器会被合并成一个 `addEventListener` 调用。当保卫谓词是 `&&` 链时，共享的条件会被提升到一个 `if` 语句中：
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

只有缩写形式才能合并。手写的 `listen: (update) => ...` 会被原样传递，因为编译器无法看到它订阅了什么。

## bind: get / set / listen 语法形式
`bind:value={ ... }` 是 Grain 语法，不是 TypeScript，所以这三个函数是编译期检查的。

| 键 | 所需形式 | 备注 |
| --- | --- | --- |
| `get` | `() => T` | 无参数 — `get` 提供 **getter**, 不是一个值，所以 `get: count` 意味着 “`count` 是 getter”. 可调用表达式 (`get: read_count`) 也是接受的。如果只是想绑定素的变量，使用短语法 `bind:value={count}` |
| `set` | `(value) => void` | 有且仅有一个参数，即新值，也接受可调用表达式 (`set: do_set`) |
| `listen` | `(update) => void` or `listen(bus, "name")` | `listen(bus, "name", guard)` — `guard` 可选，必须是函数，事件名必须是字符串字面量。 |

## bind 的 active 选项
`active` 用于绑定非响应式变量到响应式变量。它告诉编译器 getter 需要在 setter 调用后重新求值。
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

### 没有第二条数据流
用 `active` 绑上的普通变量不是响应式状态。这个绑定加上 `active` 是它**唯一**的数据流 —— `active` 重新读 getter 并把值写回那个元素，别的都没有。在模板其它地方读同一个变量，它变了也不会更新：
```grain
<script>
  let draft = '';
</script>

<input bind:value={ get: () => draft, set: (value) => draft = value, active } />
<span>draft: {draft}</span>   <!-- 永远不变；编译期无从得知 -->
```
想让模板其余部分跟着变，就用 `$state`。

## listen-only 绑定

`get` 可以省略，前提是 `bind:` 带 `listen`，这时候监听语句成为唯一的值来源，并且 `update` 回调要多接收一个参数：

```grain
<input bind:value={ set: (v) => save(v), listen: (update) => bus.on('tick', () => update(next())) } />
```

`update(newValue)` 重新定义值。`update()` 不带参数只刷新，值保持不变。

无 `get` 绑定的编译期规则：

| 例子 | 结果 |
| --- | --- |
| 也没有 `listen` | 报错：没人给值 |
| `listen(bus, "tick")` 短形式 | 报错：它展开为 `update()`，不能给值。应当手写完整形式。 |
| listener 从没调用 `update(value)` | 报错：值永远无法改变 |

## 宏

`<script macro>` 定义编译期运行的函数。一个宏返回需要插入的代码——一个字符串或者字符串数组（空格连接），需要跨行书写时尤为实用：

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

它返回的东西会按这个地方原本该有的语法重新解析，所以上面 `$field('name')` 展开成的就是  `bind:value={ get: () => name, set: (v) => name = v }`.

这些 **不是** 词法意义上的标记/词元（Token）——每一块都是任意代码，编译器会把它整个交给那个位置的解析器。返回一个普通字符串（`'get: () => name, set: (v) => name = v'`）和上面数组一样。

### 命名

宏命名类似符文 — `$` 开头 — 不能遮蔽原有符文，因为它们在不同阶段处理：

| | runes (`$state`, `$props`, `$bindable`) | macros |
| --- | --- | --- |
| when | 语言的一部分，由编译器自身处理 | 首先运行，仅在编译时有效 |
| what they do | `$state` 变成读写对，`$props()` 成为 props 参数 | 展开为其他语法 |
| where | `<script>` | `bind:`、属性值、`<script>` |

So `function $state()` in a macro script is an error, and so is a macro named `field`.

### 宏可以使用的位置

- **`bind:`** — 作为绑定值读取
- **属性值** — 作为属性值读取；没有 `{` 或引号的结果被视为一个表达式（`onclick` 上的 `() => count++` 变为处理器）
- **在 `<script>` 内** — 展开为表达式

不在模板 `{ ... }` 插值中：宏在运行时不存在，所以在那里使用会是编译错误，而不是稍后的 `ReferenceError`。

### 在 `<script macro>` 中导入

宏可以导入，但只能导入 **相对路径** —— `node_modules` 中的包在构建时不一定可加载 —— 并且本地名称必须使用 `$` 重命名：

```grain
<script macro>
    import { flip as $flip } from './macros';   // ok
    import { flip } from './macros';            // error: local name needs the `$`
    import { flip as $flip } from 'lodash';     // error: not a relative path
</script>
```

命名空间导入同样被拒绝，理由相同。`<script macro>` 依然不能 `export` —— 它不会进入产物。

### 参数

参数在编译期求值：字面量（`'name'`、`3`、`true`）拿到的是值，其它一律拿到**源码文本**。返回值必须是字符串，或字符串数组。

## Store：跨模块的状态

`$state` 是编译时的 —— 编译器只能追踪它可见的依赖，两个导入相同模块的组件对彼此是不可见的。因此共享状态需要一点运行时：来自运行时包的 `writable`.

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

`$store` 是一个 **内置宏** —— 不需要 `<script macro>`，也不需要导入。它展开为：

```js
{ listen: (update) => counter.subscribe(update), set: (v) => counter.set(v) }
```

`subscribe` 会立即回调当前值，这就是没有 `get` 的原因：监听器提供值（见 *listen-only bindings*）。每次 `set` 都会通知所有订阅者，因此任意数量的组件可以保持同步，无论是哪个方向变化的。

- `set` 返回写入的值；写入相同的值不会通知任何人
- `subscribe` 返回一个取消订阅函数 —— 如果需要分离，请保留它
- `$store` 是保留字：你不能定义名为该名称的宏

### 显示 Store 的值

模板中的 `{counter.get()}` 在运行时像其他普通代码一样被求值，但**没有任何东西会重新运行它**：刷新是在编译时连接的，仅适用于 `$state`，而 store 通过 `subscribe` 宣布变化。所以它只渲染一次，然后永远不会再变动。

`$read` 是 `$store` 的只读对应物 —— 它只发出 `listen` 部分：

```grain
<p>value is {$read(counter)}</p>
<span title={$read(counter)}></span>
```

这是可行的，因为 `listen:` 并非专用于 `bind:` —— **普通属性**或**模板插值**也可以写成绑定值的形式。此时它是单向的：值被推送到元素上，没有数据回流。长形式的效果相同：

```grain
<span title={ get: () => counter.get(), listen: (update) => counter.subscribe(update) }></span>
```

给了 `get`，值就由它来；不给，值就来自监听器（`subscribe` 会立刻用当前值回调一次）。绑定值不能和文本混在一起 —— 它得是整个值。

## $node：`<script>` 中的派生值

`$node` 声明一个派生值。它的参数是一个 **绑定值（binding value）** —— 语法与属性或模板插值相同，尽管它看起来像是一个 TypeScript 对象：

```grain
<script>
    let count = $state(0);

    const doubled = $node({ get: () => count * 2 });                         // 单向
    const tripled = $node(count * 3);                                        // 简写形式，单向
    const shown   = $node({ get: () => name.get(), set: (v) => name.set(v) }); // 双向
    const pushed  = $node({ listen: (update) => name.subscribe(update) });     // 值来自监听器
</script>
```

- **`set` 决定方向。** 如果包含它，对变量赋值（如 `shown = x`）会经过 setter；如果不包含它，对变量赋值会导致编译错误 —— 单向即单向。
- **`get` 是可选的。** 如果缺失它，值将来自 `listen`（`subscribe` 会立即回调当前值），这与单向属性完全相同。缺少 `get` 或 `listen` 本身都不是错误。
- **`active` 必须写成 `active: true`**，以保持参数为有效的 TypeScript。
- **仅编译期生效。** 没有对象会保留到输出中 —— 只有一对 getter/setter 以及一个重新计算该变量并刷新所有读取它的代码的函数。

`listen` 扮演两个不同的角色，取决于是否同时存在 `get`：

- **带有 `get`** —— 它仅 *触发* 重新计算。当源是 store 时这正是你需要的：编译器无法看到该依赖，如果没有它，什么都不会刷新。
- **没有 `get`** —— 它就是 *来源*。它传递给 `update(newValue)` 的内容将成为值，与单向属性相同。

```grain
// listen triggers; get supplies the value
const upper = $node({ get: () => name.get().toUpperCase(), listen: (update) => name.subscribe(update) });

// listen is the source; there is no get
const pushed = $node({ listen: (update) => name.subscribe(update) });
```

## 响应式循环

循环在两个时机之一被拦下，取决于编译器能不能看见它。

**编译期。** `$node` 互相读对方时，重算链闭合成环、永远停不下来 —— 这静态就能看出来，所以直接编译失败：

```grain
const x = $node({ get: () => y + 1 });
const y = $node({ get: () => x + 1 });
```

```
Reactive loop: x -> y -> x — each one reads the next, so recomputing never settles
```

自己读自己（`const a = $node({ get: () => a + 1 })`）是同一件事的单行写法。

**仅 dev。** 只在运行时才成立的环（store 通知、条件分支）静态看不见。所以 dev 下编译器会给每个刷新函数埋一个计数器：10ms 内跑满 100 次就抛，并且指名是哪个函数：

```
`__refresh$3` ran 100 times within 10ms — this is almost always a reactive loop
```

生产构建不带计数器，那里的循环会以栈溢出的形式暴露出来。

## Keyed 循环

`{#for ...}` 会复用已经建好的 DOM：更新时比对列表，只建新增的那些。不写 key 就按**位置**匹配 —— 够应付追加、末尾删除和原地改值：

```grain
{#for item of items}
    <p>{item.name}</p>
{:else}
    <p>这里空空如也</p>
{/for}
```

加上 `with key = ...` 就按**身份**匹配。这样换顺序是移动已有的行而不是重写它们，在中间插入也只影响它后面的部分：

```grain
{#for item of items with key = item.id}
    <p>{item.name}</p>
{/for}
```

`entries()` 也行，`Map` 和 `Set` 也行：

```grain
{#for [i, x] of items.entries() with key = i}
    <p>{i}: {x}</p>
{/for}
```

普通对象不追踪 —— 只认数组、`Map` 和 `Set`。

### 精确更新

编译器看得见这次写入时，会直接调列表自己的方法，而不是重新比对一遍：

```grain
function add() {
    items.push(next);      // -> list.push(next)，已有的行不动
}
```

生效条件是 `of` 后面直接跟着那个容器变量，而且方法是 `push` / `pop` / `shift` / `unshift` / `splice` 之一。其余（`sort`、`reverse`、`list.filter(...)`）没有"受影响的行"可言，会退回整块比对。

### 编译器看不见那次写入时

如果容器被改的地方编译器追踪不到（传给了回调、在组件外被改），用响应式容器 —— 它自己会通知改动：

```grain
import { reactive_array } from '@graints/runtime';

const items = reactive_array([{ id: 1, name: 'a' }]);

function add() {
    items.push({ id: 2, name: 'b' });   // 上面的 `for` 会自动更新
}
```

`reactive_map` 和 `reactive_set` 同理。两点注意：

- 它们只通知**结构性**改动（`push`、`shift`、`splice`、`set`、`delete`、`clear`）。改某个元素内部（`items[0].name = 'x'`）是看不见的，这种改法需要调一下 `items.touch()`

## bind:this
`bind:this` 给你的是元素本身，而不是它的某个属性。

### 当变量用
写个裸名字，`bind:this` **会替你把这个变量声明出来** —— `<script>` 里什么都不用加：

```grain
<input bind:this={box} />

<script onmount>
  box.focus();
  box.placeholder = 'set in onmount';
</script>
```
变量在组件实例创建时创建，元素建好时赋值。

### 当回调用
写个函数（或任何可调用的表达式），就**不会声明变量** —— 元素一建好就拿它去调这个函数：

```grain
<script>
  function grab(el: HTMLElement) {
    el.setAttribute('data-grabbed', 'yes');
  }
</script>

<p bind:this={grab}>grab(el) 在这个 &lt;p&gt; 建好时执行</p>
```
内联箭头也一样：`bind:this={(el) => el.focus()}`。

用哪种只看一条规则：**不是函数的标识符**就是变量形式，其余全是回调形式。`bind:this={grab}`、`bind:this={handlers.grab}`、`bind:this={makeHandler()}`、`bind:this={(el) => el.focus()}` 都是回调。

别的都不写死 —— 回调到底收不收元素、变量装不装得下，交给编辑器里的 TypeScript 检查：

```grain
<script>
  let s = $state('a');
</script>
<p bind:this={s}>...</p>   <!-- Type 'HTMLParagraphElement' is not assignable to type 'string' -->
```

只有明显的胡写才在编译期拦下：

```grain
<p bind:this={123}>...</p>   <!-- error -->
```

## <script onmount>
`<script onmount>` 在组件的元素挂载之后立刻运行 —— 那时每个 `bind:this` 变量都已经赋好值，所以要直接碰 DOM 就写在这里：

```grain
<script>
  let count = $state(0);
</script>

<script onmount>
  // 只有这个块能看见 `box`
  box.focus();
</script>

<input bind:this={box} />
```

规则：
- **只有 `<script onmount>` 能访问 `bind:this` 变量。** 在别处用是编译期错误：`` `box` is declared by `bind:this` and can only be used inside `<script onmount>` ``
- 每个组件实例跑一次 —— 根组件是追加进目标之后，子组件是父组件挂上它的时候
- `$state(...)` 和 `$props()` 在里头照常能用，跟 `<script>` 里一样
- 它不是事件处理器：在这里写 `$state` 不会安排刷新。要摆弄 DOM 就放这儿，要做响应式的工作就放回 `<script>`

`bind:this` 变量带的是对应的 DOM 接口类型（`<input>` 是 `HTMLInputElement`，`<div>` 是 `HTMLDivElement`……），所以 `box.value` 和 `box.focus()` 都有类型检查和补全。认不出来的标签退回 `HTMLElement`。
