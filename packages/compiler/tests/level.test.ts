/// <reference types="bun" />
import { beforeAll, it, expect } from "bun:test";
import { Window } from "happy-dom";
import type { Document } from "happy-dom";
import { join } from "node:path";
import { compile } from "..";

// `$state(x, level)`：第二个参数是响应式级别。
//
// 0 = 只追踪这个变量被重赋值；1 = 同时追踪它内部的变化。数组 / Map / Set 默认 1，
// 其他（包括对象）默认 0。

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

const mount = async (source: string): Promise<Element> => {
    const js = compile(source, { filename: "App.grain", runtimeModule: runtimePath }).js;
    const file = join(import.meta.dir, ".tmp-" + Math.random().toString(36).slice(2) + ".ts");

    await Bun.write(file, js);

    const module = await import(file);
    const target = document.createElement("div");

    document.body.appendChild(target);
    module.default(target);

    return target;
};

const text = (target: Element) => (target.querySelector("span") as HTMLElement).textContent;

it("objects default to level 0: changing inside does not refresh", async () => {
    const target = await mount(`<script>
        let obj = $state({ a: 1 });

        function changeInside() {
            obj.a = 2;
        }

        function replace() {
            obj = { a: 3 };
        }
    </script>
    <span>{obj.a}</span>
    <button onclick={changeInside}>inside</button>
    <button onclick={replace}>replace</button>`);

    expect(text(target)).toBe("1");

    target.querySelectorAll("button")[0].click();

    // 级别 0：改内部不算写它
    expect(text(target)).toBe("1");

    target.querySelectorAll("button")[1].click();

    // 整个换掉才算
    expect(text(target)).toBe("3");
});

it("level 1: changing inside does refresh", async () => {
    const target = await mount(`<script>
        let obj = $state({ a: 1 }, 1);

        function changeInside() {
            obj.a = 2;
        }
    </script>
    <span>{obj.a}</span>
    <button onclick={changeInside}>inside</button>`);

    expect(text(target)).toBe("1");

    target.querySelector("button")!.click();

    expect(text(target)).toBe("2");
});

it("a local taken out of a reactive array keeps its reactivity", async () => {
    const target = await mount(`<script>
        let arr = $state([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);

        function modify() {
            const second = arr[1];
            second.name = 'B';
        }
    </script>
    {#for item of arr}
        <span>{item.name}</span>
    {/for}
    <button onclick={modify}>modify</button>`);

    const rows = () => [...target.querySelectorAll("span")].map((node) => node.textContent);

    expect(rows()).toEqual(["a", "b"]);

    target.querySelector("button")!.click();

    // `second` 是从 `arr` 里取出来的：写它就算写 `arr`
    expect(rows()).toEqual(["a", "B"]);
});

it("a local loses its reactivity when the root is also touched", async () => {
    // 静态约束：同一个函数里既持有派生局部变量、又直接动根变量，就不给它响应性 ——
    // 否则重新排列 / 删除之后，写那个局部变量会去刷新一个跟它无关的数组
    const target = await mount(`<script>
        let arr = $state([{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]);

        function dropAndModify() {
            const third = arr[2];
            arr = [arr[0], arr[1]];
            third.name = 'C';
        }
    </script>
    {#for item of arr}
        <span>{item.name}</span>
    {/for}
    <button onclick={dropAndModify}>go</button>`);

    const rows = () => [...target.querySelectorAll("span")].map((node) => node.textContent);

    expect(rows()).toEqual(["a", "b", "c"]);

    target.querySelector("button")!.click();

    // 数组本身变了（少了第三项），但写 third 不算写 arr —— 不会多刷一次
    expect(rows()).toEqual(["a", "b"]);
});

it("a second borrow of the same root kills the first", async () => {
    // 借用规则：对同一个根，后一次取出让前一次失效 —— 无论后续有没有改
    const target = await mount(`<script>
        let arr = $state([{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]);

        function modify() {
            const first = arr[0];
            const third = arr[2];
            first.name = 'A';
        }
    </script>
    {#for item of arr}
        <span>{item.name}</span>
    {/for}
    <button onclick={modify}>modify</button>`);

    const rows = () => [...target.querySelectorAll("span")].map((node) => node.textContent);

    expect(rows()).toEqual(["a", "b", "c"]);

    target.querySelector("button")!.click();

    // `third` 是最后一次取出，活着；`first` 在取 third 的时候就失效了 —— 写它不算写 arr
    expect(rows()).toEqual(["a", "b", "c"]);

    // 但写还活着的那个仍然刷新
    const other = target.querySelectorAll("button")[0];

    void other;
});

it("the last borrow survives", async () => {
    const target = await mount(`<script>
        let arr = $state([{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]);

        function modify() {
            const first = arr[0];
            const third = arr[2];
            third.name = 'C';
        }
    </script>
    {#for item of arr}
        <span>{item.name}</span>
    {/for}
    <button onclick={modify}>modify</button>`);

    const rows = () => [...target.querySelectorAll("span")].map((node) => node.textContent);

    expect(rows()).toEqual(["a", "b", "c"]);

    target.querySelector("button")!.click();

    // 最后一次取出的那个还活着
    expect(rows()).toEqual(["a", "b", "C"]);
});

it("a local taken out of a level-0 variable is not reactive", async () => {
    // 根不追踪内部时，从它取出来的局部变量也不该有响应性
    const target = await mount(`<script>
        let obj = $state({ a: 1 });

        function modify() {
            const inner = obj;
            inner.a = 2;
        }
    </script>
    <span>{obj.a}</span>
    <button onclick={modify}>modify</button>`);

    expect(text(target)).toBe("1");

    target.querySelector("button")!.click();

    expect(text(target)).toBe("1");
});
