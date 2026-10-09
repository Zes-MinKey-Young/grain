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
