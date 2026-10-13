/**
 * cheatsheet 用的示例代码。
 *
 * 放在 `.ts` 里而不是直接写在模板里：模板里的 `<script>` 会被 grain 自己的解析器
 * 当成真的块（它只看模板文本，不解析 script 内部）。这些字符串从 `App.grain` 引用，
 * 模板上就只剩 `{code}` 了。
 */

export interface Sample {
    title: string;
    code: string;
    note?: string;
}

export const samples: Sample[] = [
    {
        title: '1 · 一个组件',
        code: `<script>
    let count = $state(0);
<\/script>

<button onclick={() => count += 1}>{count}</button>

<style>
    button { padding: 4px 8px; }
<\/style>`,
        note: '`<script>` 放状态、模板里写元素、`<style>` 是 scoped 的。'
    },
    {
        title: '2 · $state 和它的级别',
        code: `let n    = $state(0);            // 级别 0：只追踪自己被重赋值
let list = $state([1, 2]);       // 容器默认级别 1：内部变化也追踪
let obj  = $state({ a: 1 }, 1);  // 对象默认 0，要追踪内部得写出来

const third = list[2];
third.name = 'x';                // 只刷那一行里读了这个属性的片段`,
        note: '依赖是**路径**级的：改 `list[1]` 不会刷读 `list[0]` 的地方。从容器里取出来的局部变量按它那条路径定位，也一样精确。'
    },
    {
        title: '3 · 模板插值',
        code: `<p>{count} / {count * 2} / {count > 3 ? 'big' : 'small'}</p>
<input bind:value={name} />`,
        note: '`{ ... }` 里是一句 TS 表达式。'
    },
    {
        title: '4 · bind: 双向',
        code: `<MyInput bind:value={count} />

<MyInput bind:value={{
    get: () => count,
    set: (value) => count = value
}} />`,
        note: '属性那边用 `$bindable()` 声明才能绑。'
    },
    {
        title: '5 · $props / $bindable',
        code: `let { label, count = $bindable(0) } = $props<{
    label: string;
    count?: number;
}>();`
    },
    {
        title: '6 · {#if}',
        code: `{#if count > 3}
    <p>big</p>
{:else if count > 0}
    <p>small</p>
{:else}
    <p>none</p>
{/if}`
    },
    {
        title: '7 · {#for}',
        code: `{#for item of items with key = item.id}
    <p>{item.name}</p>
{:else}
    <p>empty</p>
{/for}

{#for [i, item] of items.entries() with key = i}
    <p>{i}: {item}</p>
{/for}`,
        note: '不写 key 就按位置复用；写了 key 就按身份，重排时搬节点而不是重写内容。'
    },
    {
        title: '8 · $node 派生值',
        code: `const doubled = $node({ get: () => count * 2 });
const tripled = $node(count * 3);
const shown   = $node({
    get: () => name.get(),
    set: (v) => name.set(v)
});`,
        note: '有 `set` 就是双向，没有就是单向（写入单向是编译错误）。纯编译期：产物里不会留下那个对象。'
    },
    {
        title: '9 · 响应式容器',
        code: `let list = $state([{ id: 1 }]);

list.push({ id: 2 });   // 只建新的那一行
list[1] = { id: 9 };    // 只换那一项
[list[0], list[1]] = [list[1], list[0]];   // 一次批量改两个位置`,
        note: '编译期认得出这些写法，生成精确调用；认不出的（`sort` / `filter`）退回整块比对。'
    },
    {
        title: '10 · Store（跨模块的状态）',
        code: `// counter.grain.ts
export const counter = writable(0);

// 用
{$read(counter)}
<input bind:value={$store(counter)} />`,
        note: '`writable` 来自 runtime；`$read` 单向、`$store` 双向。'
    },
    {
        title: '11 · bind:this',
        code: `let box;

<div bind:this={box}></div>`,
        note: '拿到元素本身；在 `<script onmount>` 里才保证已经赋上值。'
    },
    {
        title: '12 · <script onmount>',
        code: `<script onmount>
    greeting = 'after mount';
<\/script>`,
        note: 'DOM 已经就位的时候跑。在这里写 `$state` 也会触发刷新。'
    },
    {
        title: '13 · 宏',
        code: `<script macro>
    // 编译期函数，参数拿到的是源码文本
    function twice(x) { return \`(\${x}) * 2\`; }
<\/script>

<p>{twice(count)}</p>`,
        note: '宏名得 `$` 开头。内置的有 `$store` / `$read`。'
    }
];
