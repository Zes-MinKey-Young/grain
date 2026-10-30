/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';

// `bind:` 绑在 `{#if}` 分支里的子组件上时，父组件改值之后子组件要能收到。
//
// 之前 `ifBlock` 生成分支内容时 owner 传的是 null，`component()` 里
// `deps.size === 0 || !owner` 直接 return —— 子组件的 props 更新器压根不生成。

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

it('updates a bound child that lives inside an {#if} branch', async () => {
    await build(
        `<script>
    let { value = $bindable('a') } = $props<{ value?: string }>();
</script>

<span class="child">{value}</span>`,
        'bound-child'
    );

    const target = await mount(`<script>
    import BoundChild from './bound-child.ts';

    let value = $state('a');
    let open = $state(true);

    function change() {
        value = 'b';
    }
</script>

<button class="change" onclick={change}>change</button>
{#if open}
    <BoundChild bind:value={value} />
{/if}
<span class="mirror">{value}</span>`);

    const child = () => target.querySelector('.child')!.textContent!.trim();

    expect(child()).toBe('a');

    target.querySelector<HTMLElement>('.change')!.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true })
    );

    expect(target.querySelector('.mirror')!.textContent!.trim()).toBe('b');
    expect(child()).toBe('b');
});
