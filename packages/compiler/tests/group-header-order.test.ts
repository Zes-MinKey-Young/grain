/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';

// 症状：切到分组布局时，组的 header（`.group-header`）跑到了行**下面**。
//
// `JudgeLineGroup` 的根是这个形状：
//   [ <div class="group-header">…</div>,  {#if !folded}{#for line}{<JudgeLineManager/>}{/for}{/if} ]
// 头是**元素**（单独发射、按 index 挂），行是 `{#if}` + `{#for}`（fragment）。

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

const build = async (source: string, name: string): Promise<string> => {
    await Bun.write(
        tmp(`${name}.ts`),
        compile(source, { runtimeModule: runtimePath, filename: `${name}.grain` }).js
    );

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

it('keeps the group header above its rows', async () => {
    await build(
        `<script>
    import Row from './group-row.ts';
    let { lines = ['a', 'b'] } = $props<{ lines?: string[] }>();
    let folded = $state(false);
</script>

<div class="group-header">header</div>
{#if !folded}
    {#for line of lines with key = line}
        <Row label={line} />
    {/for}
{/if}`,
        'group'
    );

    await build(
        `<script>
    let { label = '' } = $props<{ label?: string }>();
</script>

<div class="row">{label}</div>`,
        'group-row'
    );

    const target = await mount(`<script>
    import Group from './group.ts';
</script>

<div id="host"><Group /></div>`);

    const host = target.querySelector('#host')!;
    const kids = [...host.children].map((node) => node.className);

    expect(kids[0]).toBe('group-header');
    expect(kids.slice(1)).toEqual(['row', 'row']);
});
