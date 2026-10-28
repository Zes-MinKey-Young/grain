/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';
import { emptyBranch } from './fixtures/components.ts';

// `{#if}` 曾经是"无条件建、只控制插不插入"：分支里的子组件在 create 时就被实例化，
// 于是 `operationList` 还没赋值 / `selectedNote` 还是 null 的组件提前跑了初始化，
// 一路崩。现在分支内容收进各自的 render，条件成立才建。

const source = `<script>
    let show = $state(false);
</script>

<div>
    {#if show}
        <Foo target={1} />
    {:else}
        <Bar />
    {/if}
</div>
`;

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

const build = async (component: string, name: string): Promise<string> => {
    const js = compile(component, { runtimeModule: runtimePath, filename: `${name}.grain` }).js;

    await Bun.write(tmp(`${name}.ts`), js);

    return `./${name}.ts`;
};

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

const click = (node: Element) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

it('builds branch content inside the branch render, not at create', () => {
    const js = compile(source, { filename: 'A.grain' }).js;

    const branch = js.indexOf('__ifBranch$');
    const foo = js.indexOf('Foo.create');
    const bar = js.indexOf('Bar.create');

    expect(branch).toBeGreaterThan(-1);
    expect(foo).toBeGreaterThan(branch);
    expect(bar).toBeGreaterThan(branch);
});

it('caches the branch so toggling does not rebuild the nodes', () => {
    const js = compile(source, { filename: 'A.grain' }).js;

    // `cache[i] ??= render()`：同一分支只建一次
    expect(js).toContain('??=');
    expect(js).toContain('nodes: Array.from');
});

// 首页那个形状：数据是挂载后才异步取回来的，条件从 false 变 true ——
// 分支必须跟着换（以前只渲染了 `{:else}`，列表永远不出现，顺带 `#charts` 的
// overflow 容器也没有，页面就滚不动了）。
it('switches to the other branch when the condition becomes true later', async () => {
    await build(emptyBranch, 'empty-branch');

    const target = await mount(`<script>
    import EmptyBranch from './empty-branch.ts';

    let items = $state([]);
</script>

<script onmount>
    void (async () => {
        items = ['a', 'b'];
    })();
</script>

<div id="host">
    {#if items.length > 0}
        <EmptyBranch items={items} />
    {:else}
        <span class="empty">nothing</span>
    {/if}
</div>`);

    const host = target.querySelector('#host')!;
    const names = () => [...host.querySelectorAll('.item')].map((node) => node.textContent!.trim());

    expect(names()).toEqual(['a', 'b']);
    expect(host.querySelector('.empty')).toBeNull();
});

// 首页的真实形状：then 分支是 `<ul>{#for}</ul>`（元素会被"单独发射"到 host），
// else 分支是一段**插值文本**。切过去之后 else 那段必须消失 ——
// 现在页面上列表出来了、旧的"还没有谱面"还留在 DOM 里。
it('removes the else branch when switching to a list branch', async () => {
    const target = await mount(`<script>
    let items = $state([]);
</script>

<script onmount>
    void (async () => {
        items = ['a', 'b'];
    })();
</script>

<div id="host">
    {#if items.length > 0}
        <ul id="charts">
            {#for item of items}
                <li class="item">{item}</li>
            {/for}
        </ul>
    {:else}
        {'还没有谱面'}
    {/if}
</div>`);

    const host = target.querySelector('#host')!;

    expect(host.querySelectorAll('.item').length).toBe(2);
    expect(host.textContent!.includes('还没有谱面')).toBe(false);
});

// 首页 `#content` 的完整形状：前面两个 `<p>`（会被"单独发射"成占位），
// 然后才是 if 块。这类"占位 + 动态片段"混排时下标/锚点最容易错。
it('replaces the else branch when the if-block follows placeholder children', async () => {
    const target = await mount(`<script>
    let items = $state([]);
</script>

<script onmount>
    void (async () => {
        items = ['a', 'b'];
    })();
</script>

<div id="host">
    <p>first</p>
    <p>second</p>
    {#if items.length > 0}
        <ul id="charts">
            {#for item of items}
                <li class="item">{item}</li>
            {/for}
        </ul>
    {:else}
        {'还没有谱面'}
    {/if}
</div>`);

    const host = target.querySelector('#host')!;

    expect([...host.children].map((node) => node.tagName)).toEqual(['P', 'P', 'UL']);
    expect(host.textContent!.includes('还没有谱面')).toBe(false);
});

it('switches back to the else branch', async () => {
    await build(emptyBranch, 'empty-branch');

    const target = await mount(`<script>
    import EmptyBranch from './empty-branch.ts';

    let items = $state(['a']);
</script>

<div id="host">
    <span class="clear" role="button" onclick={() => (items = [])}>clear</span>
    {#if items.length > 0}
        <EmptyBranch items={items} />
    {:else}
        <span class="empty">nothing</span>
    {/if}
</div>`);

    const host = target.querySelector('#host')!;

    expect(host.querySelectorAll('.item').length).toBe(1);

    click(host.querySelector('.clear')!);

    expect(host.querySelectorAll('.item').length).toBe(0);
    expect(host.querySelector('.empty')!.textContent!.trim()).toBe('nothing');
});
