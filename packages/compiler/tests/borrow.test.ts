/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';
import { compile } from '..';

/**
 * 借用规则（照 Rust 的精神）—— 一个根变量同时只能有一个"活跃的借用"：
 *
 * - 后一次取出让前一次失效（`const minkey = arr[2]; const qaqFei = arr[0]`）
 * - 写根变量（`arr = [...]` / `arr.sort()`）让之前的全部失效
 * - 根变量逃逸（`other = arr`）也让它失效
 *
 * 关键是**位置敏感**：失效发生在让它失效的那条语句**之后** —— 在那之前那些引用
 * 仍然是响应式的。这也正是它区别于"一刀切"的地方。
 *
 * 派生还必须是 `const`（`let` / `var` 的给一条提示，不当派生）。
 */

const runtimePath = join(import.meta.dir, '..', '..', 'runtime', 'index.ts');

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
    const js = compile(source, { filename: 'App.grain', runtimeModule: runtimePath }).js;
    const file = join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '.tmp',
        `borrow-${Math.random().toString(36).slice(2)}.ts`
    );

    await Bun.write(file, js);

    const module = (await import(file)) as { default: (target: Element) => void };
    const target = document.createElement('div');

    document.body.appendChild(target);
    module.default(target);

    return target;
};

const messages = (source: string): string[] =>
    compile(source, { filename: 'App.grain' }).warnings.map((warning) => warning.message);

it('writing a derived local after the root was reassigned is flagged', () => {
    const found = messages(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }], 2);

    function drop() {
        const second = arr[1];

        arr = [arr[0]];
        second.name = 'B';
    }
</script>`);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('`second` is no longer reactive');
});

it('a second borrow of the same root flags the first', () => {
    const found = messages(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }], 2);

    function f() {
        const first = arr[0];
        const second = arr[1];

        first.name = 'A';
    }
</script>`);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('`first` is no longer reactive');
});

it('a root escaping into another reactive variable flags the borrow', () => {
    const found = messages(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }], 2);
    let other = $state([], 2);

    function f() {
        const second = arr[1];

        other = arr;
        second.name = 'B';
    }
</script>`);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('`second` is no longer reactive');
});

it('a derived local must be const', () => {
    const found = messages(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }], 2);

    function f() {
        let second = arr[1];

        second.name = 'B';
    }
</script>`);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('is not `const`');
});

it('nothing is flagged while the borrow is still alive', () => {
    expect(
        messages(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }], 2);

    function f() {
        const second = arr[1];

        second.name = 'B';
    }
</script>`)
    ).toEqual([]);
});

// ---------------------------------------------------------------------------
// 根变量修改的**位置**四种：之前 / 中间 / 之后 / 不修改。
//
// 借用是从"取出那句"开始的，所以根在那之前动过不影响；根在取出与写入之间动过，
// 借用就断了 —— 那次写入不再刷根变量。
// ---------------------------------------------------------------------------

const ROWS = `{#for item of arr}
    <span>{item.name}</span>
{/for}
<button onclick={f}>go</button>`;

const names = (target: Element): string[] =>
    [...target.querySelectorAll('span')].map((node) => node.textContent);

it('a borrowed local is one level down', () => {
    // level 是**借几次的预算**，借一次减一：`$state(arr, 2)` 里
    // `const mine = arr[0]` 的 mine 是 level 1。
    //
    // 这条测的是**声明能成立**（不是 warning）；递减的实际效果 —— `mine[0]` 不再
    // 算借用 —— 在产物上看不出来：`mine[0]` 是第二层，本来就不指向 for 的任何一项，
    // 认不认都不会生成 setPath。递减的价值是**不去生成那个错的调用**。
    expect(
        messages(`<script>
    let arr = $state([[{ name: 'a' }], [{ name: 'b' }]], 2);

    function f() {
        const mine = arr[0];

        mine.push({ name: 'c' });
    }
</script>
{#for row of arr}
    <span>{row[0].name}</span>
{/for}
<button onclick={f}>go</button>`)
    ).toEqual([]);
});

it('level 1 does not allow taking an item out', async () => {
    // 默认 level 1：只做"整块追踪内部"—— 容器里变了就重跑整段。
    // 把一项取出来写它**不算**写容器，所以不会有响应性。
    // 想这么用得显式写 `$state(arr, 2)`
    const source = `<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);

    function f() {
        const second = arr[1];

        second.name = 'B';
    }
</script>
${ROWS}`;

    const target = await mount(source);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    // 一点没动
    expect(names(target)).toEqual(['a', 'b', 'c']);

    const js = compile(source, { filename: 'App.grain' }).js;

    // 没有精确调用（`setPath`），也没有针对 `second` 的借用跟踪
    expect(js).not.toMatch(/setPath/);
});

it('④ the root untouched: the borrowed write refreshes', async () => {
    const target = await mount(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 2);

    function f() {
        const second = arr[1];

        second.name = 'B';
    }
</script>
${ROWS}`);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    expect(names(target)).toEqual(['a', 'B', 'c']);
});

it('① the root reassigned before the borrow: still refreshes', async () => {
    // 根先整个换成 [x, y]，再取出第二项 —— 借用从取出那句才开始，不受之前影响
    const target = await mount(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 2);

    function f() {
        arr = [{ name: 'x' }, { name: 'y' }];
        const second = arr[1];

        second.name = 'B';
    }
</script>
${ROWS}`);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    expect(names(target)).toEqual(['x', 'B']);
});

it('② the root displaced in between: no refresh, and it is flagged', async () => {
    // 取出 -> 根被改（借用断）-> 再写。那次写入不再刷根变量。
    //
    // 这里用 `splice` 而不是整体重赋值：splice 走精确调用（不整块比对），所以 DOM
    // 上真能看出差别。整体重赋值会整块比对，那一次写入的结果会被顺带刷出来 ——
    // 对象确实被改了，只是没人通知 DOM
    const target = await mount(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 2);

    function f() {
        const second = arr[1];

        arr.splice(0, 1);
        second.name = 'B';
    }
</script>
${ROWS}`);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    // 第一项删掉了；第二项显示的是**旧值** —— 那次写入没通知 DOM。
    // （借用还活着的话这里会是 ['B', 'c']）
    expect(names(target)).toEqual(['b', 'c']);

    const js = compile(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 2);

    function f() {
        const second = arr[1];

        arr.splice(0, 1);
        second.name = 'B';
    }
</script>
${ROWS}`, { filename: 'App.grain' }).js;

    // 失效了就不该有精确的 setPath
    expect(js).not.toMatch(/setPath\(1, "name"\)/);
});

it('③ the root reassigned after the write: the write already happened', async () => {
    // 取出 -> 写入（借用还活着，刷新）-> 根再换掉。写入排在之前，照样算数
    const target = await mount(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 2);

    function f() {
        const second = arr[1];

        second.name = 'B';
        arr = [arr[2], arr[1], arr[0]];
    }
</script>
${ROWS}`);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    // 重排 + 那次写入（b 已经在重排前变成 B 了）
    expect(names(target)).toEqual(['c', 'B', 'a']);
});

it('a write before the root is touched still refreshes', async () => {
    // 位置敏感的核心：失效点之前写它，照样刷新
    const target = await mount(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }], 2);

    function f() {
        const second = arr[1];

        second.name = 'B';
    }
</script>
{#for item of arr}
    <span>{item.name}</span>
{/for}
<button onclick={f}>go</button>`);

    const rows = () => [...target.querySelectorAll('span')].map((node) => node.textContent);

    expect(rows()).toEqual(['a', 'b']);

    target.querySelector('button')!.click();

    // 第 2 项的名字改了 -> 那一行刷
    expect(rows()).toEqual(['a', 'B']);
});

it('a write after the root is touched does not refresh', async () => {
    const target = await mount(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 2);

    function f() {
        const third = arr[2];

        arr = [arr[0], arr[1]];
        third.name = 'C';
    }
</script>
{#for item of arr}
    <span>{item.name}</span>
{/for}
<button onclick={f}>go</button>`);

    const rows = () => [...target.querySelectorAll('span')].map((node) => node.textContent);

    expect(rows()).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    // 数组短了一项；`third.name` 那一下不算写 arr，不会把 'C' 带出来
    expect(rows()).toEqual(['a', 'b']);
});
