/// <reference types="bun" />
import { beforeAll, it, expect } from "bun:test";
import { Window } from "happy-dom";
import type { Document } from "happy-dom";
import { join } from "node:path";
import { compile } from "..";

// Tests that need to check what the code actually does at runtime live here too —
// happy-dom supplies the DOM, so there is no hand-written mock to maintain.

const runtimePath = join(import.meta.dir, "..", "..", "runtime", "index.ts");

let document: Document;

beforeAll(() => {
    const window = new Window();

    document = window.document as unknown as Document;

    const globals = globalThis as unknown as Record<string, unknown>;

    globals.document = document;
    globals.Node = window.Node;
    globals.window = window;
});

/** 编译 -> 写成一个临时模块 -> 挂上去，返回它的容器 */
const mount = async (source: string): Promise<Element> => {
    const js = compile(source, { runtimeModule: runtimePath }).js;
    // 写到仓库根的 .tmp：留在 tests 目录里会被 tsc 编进 vite-plugin 的 dist
    const file = join(import.meta.dir, "..", "..", "..", ".tmp", `runtime-${Math.random().toString(36).slice(2)}.ts`);

    await Bun.write(file, js);

    const module = await import(file);
    const target = document.createElement("div");

    document.body.appendChild(target);
    module.default(target);

    return target;
};

it("only re-renders the row that changed", async () => {
    const target = await mount(`<script>
        let a = $state([1, 2]);

        function bump() {
            a[0] = 9;
        }
    </script>
    {#for it of a}
        <div>{it}</div>
    {/for}
    <button onclick={bump}>bump</button>`);

    const rows = () => [...target.querySelectorAll("div")].map((node) => node.textContent);

    expect(rows()).toEqual(["1", "2"]);

    const second = target.querySelectorAll("div")[1];

    // 用元素自己的 click()，别用全局 Event —— 那个不是 happy-dom 的
    target.querySelector("button")!.click();

    expect(rows()).toEqual(["9", "2"]);

    // 只有 a[0] 变了，所以第二行还是原来那个节点
    expect(target.querySelectorAll("div")[1]).toBe(second);
});

it("swaps rows in place", async () => {
    // `[a[0], a[1]] = [a[1], a[0]]` 是**同时**写入两个位置 —— 拆成两个 setAt 的话第一个会
    // 把第二个要读的值覆盖掉，顺序也就换不过来
    const target = await mount(`<script>
        let a = $state([1, 2]);

        function flip() {
            [a[0], a[1]] = [a[1], a[0]];
        }
    </script>
    {#for it of a}
        <div>{it}</div>
    {/for}
    <button onclick={flip}>flip</button>`);

    const rows = () => [...target.querySelectorAll("div")].map((node) => node.textContent);

    expect(rows()).toEqual(["1", "2"]);

    const [first, second] = [...target.querySelectorAll("div")];

    target.querySelector("button")!.click();

    expect(rows()).toEqual(["2", "1"]);

    // 没写 key 就是按位置复用：内容换了，节点还是原来那两个（没被重建）
    expect([...target.querySelectorAll("div")]).toEqual(expect.arrayContaining([first, second]));
});

it("swaps keyed rows in the DOM", async () => {
    // 有 key 时，交换应该是**搬节点**：原来第一个那个 div 得跑到第二个位置去，
    // 不能只是把里面的文字换掉
    const target = await mount(`<script>
        let a = $state([{ id: 1 }, { id: 2 }]);

        function flip() {
            [a[0], a[1]] = [a[1], a[0]];
        }
    </script>
    {#for item of a with key = item.id}
        <div>{item.id}</div>
    {/for}
    <button onclick={flip}>flip</button>`);

    const rows = () => [...target.querySelectorAll("div")].map((node) => node.textContent);
    const [first, second] = [...target.querySelectorAll("div")];

    expect(rows()).toEqual(["1", "2"]);

    target.querySelector("button")!.click();

    expect(rows()).toEqual(["2", "1"]);

    // 节点真的换了位置（还是那两个，没重建）
    const after = [...target.querySelectorAll("div")];

    expect(after[0]).toBe(second);
    expect(after[1]).toBe(first);
});

it("swaps when two loops share the array", async () => {
    // 两个 for 都拿 a 当源（`a` 和 `a.entries()`）—— 两个列表都要更新，而且
    // `entries()` 那边的项是 `[i, value]` 拼出来的，不能拿裸值去 update
    const target = await mount(`<script>
        let a = $state([{ id: 1 }, { id: 2 }]);

        function flip() {
            [a[0], a[1]] = [a[1], a[0]];
        }
    </script>
    {#for item of a with key = item.id}
        <div>{item.id}</div>
    {/for}
    {#for [i, item] of a.entries() with key = i}
        <span>{i}:{item.id}</span>
    {/for}
    <button onclick={flip}>flip</button>`);

    const divs = () => [...target.querySelectorAll("div")].map((node) => node.textContent);
    const spans = () => [...target.querySelectorAll("span")].map((node) => node.textContent);

    expect(divs()).toEqual(["1", "2"]);
    expect(spans()).toEqual(["0:1", "1:2"]);

    const [first] = [...target.querySelectorAll("div")];
    const [span0, span1] = [...target.querySelectorAll("span")];

    target.querySelector("button")!.click();

    // 两个循环都换过来了
    expect(divs()).toEqual(["2", "1"]);
    expect(spans()).toEqual(["0:2", "1:1"]);

    // keyed 的那个是真的搬了节点
    expect([...target.querySelectorAll("div")].indexOf(first as never)).toBe(1);

    // entries 那个也跟着**值**走（不是留在原地改内容），所以节点同样搬了位；
    // 还是原来那两个，没被重建
    const after = [...target.querySelectorAll("span")];

    expect(after[0]).toBe(span1);
    expect(after[1]).toBe(span0);
    expect(after.length).toBe(2);
});

it("entries loop: a swap only re-runs the index", async () => {
    // `{#for [i, item] of a.entries()}` 的项是 `[下标, 值]`。就地交换时行应该跟着
    // **值**走，只有下标那一块重跑 —— 行里的 `{Math.random()}` 不该被重算
    const target = await mount(`<script>
        let a = $state([{ id: 1 }, { id: 2 }]);

        function flip() {
            [a[0], a[1]] = [a[1], a[0]];
        }
    </script>
    {#for [i, item] of a.entries() with key = i}
        <span>{i}:{item.id} #{Math.random()}</span>
    {/for}
    <button onclick={flip}>flip</button>`);

    const spans = () => [...target.querySelectorAll("span")];
    const texts = () => spans().map((node) => node.textContent!.split("#")[0].trim());
    const randoms = () => spans().map((node) => node.textContent!.split("#")[1]);

    expect(texts()).toEqual(["0:1", "1:2"]);

    const before = randoms();

    target.querySelector("button")!.click();

    // 下标换掉了
    expect(texts()).toEqual(["0:2", "1:1"]);

    // 随机数跟着节点走（没重算），说明只刷了下标那一块
    expect(randoms()).toEqual([before[1], before[0]]);
});

it("keeps existing rows when appending", async () => {
    const target = await mount(`<script>
        let a = $state([1]);

        function add() {
            a.push(2);
        }
    </script>
    {#for it of a}
        <div>{it}</div>
    {/for}
    <button onclick={add}>add</button>`);

    const first = target.querySelectorAll("div")[0];

    // 用元素自己的 click()，别用全局 Event —— 那个不是 happy-dom 的
    target.querySelector("button")!.click();

    const rows = () => [...target.querySelectorAll("div")].map((node) => node.textContent);

    expect(rows()).toEqual(["1", "2"]);
    expect(target.querySelectorAll("div")[0]).toBe(first);
});
