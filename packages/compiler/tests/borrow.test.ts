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
    let arr = $state([{ name: 'a' }, { name: 'b' }]);

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
    let arr = $state([{ name: 'a' }, { name: 'b' }]);

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
    let arr = $state([{ name: 'a' }, { name: 'b' }]);
    let other = $state([]);

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
    let arr = $state([{ name: 'a' }, { name: 'b' }]);

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
    let arr = $state([{ name: 'a' }, { name: 'b' }]);

    function f() {
        const second = arr[1];

        second.name = 'B';
    }
</script>`)
    ).toEqual([]);
});

it('a write before the root is touched still refreshes', async () => {
    // 位置敏感的核心：失效点之前写它，照样刷新
    const target = await mount(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }]);

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
    let arr = $state([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);

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
