/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';
import { gridSwitch, iconSwitchButton, playButton } from './fixtures/components.ts';

// 症状驱动：把 kipphi-apparatus 里的结构原样搬进来。
//
// `<div id="footer"><PlayButton/><GridSwitch/><input type="range"/></div>` 渲染成了
// input 在最前、两个组件甩到末尾（进度条跑到按钮左边、次侧栏的下拉框沉到底部）。

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

/** 编译一个组件，写成 `.tmp` 里的模块，返回它的绝对路径（带 `./` 前缀给 import 用） */
const build = async (source: string, name: string): Promise<string> => {
    const js = compile(source, { runtimeModule: runtimePath, filename: `${name}.grain` }).js;

    await Bun.write(tmp(`${name}.ts`), js);

    return `./${name}.ts`;
};

/** 挂载一个页面，返回容器 */
const mount = async (source: string): Promise<Element> => {
    const js = compile(source, { runtimeModule: runtimePath, filename: 'page.grain' }).js;
    const file = tmp(`page-${Math.random().toString(36).slice(2)}.ts`);

    await Bun.write(file, js);

    const module = await import(file);
    const target = document.createElement('div');

    document.body.appendChild(target);
    module.default(target);

    return target;
};

const childNames = (host: Element): string[] => [...host.children].map((node) => node.tagName.toLowerCase());

it('keeps components and elements in template order', async () => {
    await build(iconSwitchButton, 'icon-switch');
    await build(playButton, 'play-button');
    await build(gridSwitch, 'grid-switch');

    const target = await mount(`<script>
    import PlayButton from './play-button.ts';
    import GridSwitch from './grid-switch.ts';
</script>

<div id="footer">
    <PlayButton />
    <GridSwitch />
    <input type="range" />
</div>`);

    const footer = target.querySelector('#footer')!;

    expect(childNames(footer)).toEqual(['div', 'div', 'input']);
});

it('keeps order when the parent sits inside an {#if} branch', async () => {
    await build(iconSwitchButton, 'icon-switch');
    await build(playButton, 'play-button');
    await build(gridSwitch, 'grid-switch');

    // 真实的谱面页就是这样：`<main>` 包在 `{#if loadError}…{:else}…{/if}` 里
    const target = await mount(`<script>
    import PlayButton from './play-button.ts';
    import GridSwitch from './grid-switch.ts';

    let failed = $state(false);
</script>

<div id="root">
    {#if failed}
        <p>error</p>
    {:else}
        <main>
            <div id="footer">
                <PlayButton />
                <GridSwitch />
                <input type="range" />
            </div>
        </main>
    {/if}
</div>`);

    const footer = target.querySelector('#footer')!;

    expect(childNames(footer)).toEqual(['div', 'div', 'input']);
});

it('keeps order inside a {#for} row', async () => {
    await build(iconSwitchButton, 'icon-switch');
    await build(playButton, 'play-button');

    // 判定线列表就是这种形状：`{#if}` 里套 `{#for}`，行里再放组件
    const target = await mount(`<script>
    import PlayButton from './play-button.ts';

    let items = $state([1, 2]);
</script>

<div id="rows">
    {#for item of items}
        <div class="row">
            <PlayButton />
            <span>{item}</span>
        </div>
    {/for}
</div>`);

    const rows = [...target.querySelectorAll('.row')];

    expect(rows.length).toBe(2);

    for (const row of rows) {
        expect(childNames(row)).toEqual(['div', 'span']);
    }
});

it('keeps a component above its following element (secondary sidebar)', async () => {
    await build(iconSwitchButton, 'icon-switch');
    await build(playButton, 'play-button');

    const target = await mount(`<script>
    import PlayButton from './play-button.ts';
</script>

<div id="secondary-sidebar">
    <PlayButton />
    <div class="judgelines-manager">content</div>
</div>`);

    const sidebar = target.querySelector('#secondary-sidebar')!;

    expect(childNames(sidebar)).toEqual(['div', 'div']);
    expect(sidebar.querySelector('.judgelines-manager')!.textContent).toBe('content');
});
