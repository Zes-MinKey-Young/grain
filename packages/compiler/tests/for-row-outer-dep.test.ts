/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';

// 症状：`PopupOption` 弹窗里点了某一项，触发按钮上的文字会变，但弹窗里的
// 高亮（`i === currentIndex`）永远停在第一次渲染那一格。
//
// 行的高亮读的是**循环外的**响应式变量（`currentIndex` / `picked`），而 `{#for}`
// 的行只在"源数组变了"时重渲染 —— 外层变量变了不会传播到行。

const runtimePath = join(import.meta.dir, '..', '..', 'runtime', 'index.ts');
const tmp = (...parts: string[]) => join(import.meta.dir, '..', '..', '..', '.tmp', ...parts);

let document: Document;

beforeAll(() => {
    const window = new Window();

    document = window.document as unknown as Document;

    const globals = globalThis as unknown as Record<string, unknown>;

    globals.document = document;
    globals.Node = window.Node;
    globals.window = window;
});

const mount = async (page: string): Promise<Element> => {
    const js = compile(page, { runtimeModule: runtimePath, filename: 'page.grain' }).js;
    const file = tmp(`page-${Math.random().toString(36).slice(2)}.ts`);

    await Bun.write(file, js);

    const module = await import(file);
    const target = document.createElement('div');

    document.body.appendChild(target);
    module.default(target);

    return target;
};

const click = (node: Element) =>
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// 弹窗是 `{#if}` 里的：分支内容建在 branch fragment 上，外层刷新能不能传到行？
it('re-renders rows inside an {#if} branch when the outer value changes', async () => {
    const target = await mount(`<script>
    let options = ['a', 'b', 'c'];
    let picked = $state('a');
    let open = $state(true);

    const currentIndex = $node({ get: () => options.findIndex((option) => option === picked) });
</script>

<button class="toggle" onclick={() => (open = !open)}>toggle</button>
<div id="list">
    {#if open}
        {#for [index, option] of options.entries()}
            <span class="item {index === currentIndex ? 'selected' : ''}" onclick={() => (picked = option)}>{option}</span>
        {/for}
    {/if}
</div>`);

    const list = target.querySelector('#list')!;
    const selectedIndex = () =>
        [...list.querySelectorAll('.item')].findIndex((node) => node.classList.contains('selected'));

    expect(selectedIndex()).toBe(0);

    click(list.querySelectorAll('.item')[1]!);

    expect(selectedIndex()).toBe(1);
});

// `PopupOption` 的真实写法：下标是 `$node` 派生的，源是 `entries()` 迭代器
it('re-renders rows when the outer $node they read changes', async () => {
    const target = await mount(`<script>
    let options = ['a', 'b', 'c'];
    let picked = $state('a');

    const currentIndex = $node({ get: () => options.findIndex((option) => option === picked) });

    function pick(option: string) {
        picked = option;
    }
</script>

<div id="list">
    {#for [index, option] of options.entries()}
        <span class="item {index === currentIndex ? 'selected' : ''}" onclick={() => pick(option)}>{option}</span>
    {/for}
</div>`);

    const list = target.querySelector('#list')!;
    const selectedIndex = () =>
        [...list.querySelectorAll('.item')].findIndex((node) => node.classList.contains('selected'));

    expect(selectedIndex()).toBe(0);

    click(list.querySelectorAll('.item')[1]!);

    expect(selectedIndex()).toBe(1);
});

it('re-renders {#for} rows when an outer reactive value they read changes', async () => {
    const target = await mount(`<script>
    let picked = $state(0);
    let items = $state(['a', 'b', 'c']);
</script>

<div id="list">
    {#for [index, item] of items.entries()}
        <span class="item {index === picked ? 'selected' : ''}" onclick={() => (picked = index)}>{item}</span>
    {/for}
</div>`);

    const list = target.querySelector('#list')!;
    const selectedIndex = () =>
        [...list.querySelectorAll('.item')].findIndex((node) => node.classList.contains('selected'));

    expect(selectedIndex()).toBe(0);

    click(list.querySelectorAll('.item')[1]!);

    expect(selectedIndex()).toBe(1);
});
