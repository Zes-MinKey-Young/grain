/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';

// 症状：store 改了，`PopupOption`（`bind:currentOption={$store(...)}`）跟着变，
// 但同一个 store 派生出来的 `$node` 驱动的 `{#if}` **不换分支** ——
// 谱面页点事件：下拉框显示变成"事件"了，次侧栏内容还是判定线列表。

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

it('an {#if} driven by a $node over a store switches when the store changes', async () => {
    const target = await mount(`<script>
    import { writable } from '${runtimePath.replace(/\\/g, '/')}';

    const mode = writable(0);

    // 谱面页里就是这样读 store 的
    const modeValue = $node({
        get: () => mode.get(),
        listen: (update) => mode.subscribe(update)
    });

    function pick() {
        mode.set(1);
    }
</script>

<button class="pick" onclick={pick}>pick</button>
{#if modeValue === 0}
    <div class="zero">zero</div>
{:else}
    <div class="one">one</div>
{/if}`);

    expect(target.querySelector('.zero')).not.toBeNull();

    click(target.querySelector('.pick')!);

    expect(target.querySelector('.one')).not.toBeNull();
    expect(target.querySelector('.zero')).toBeNull();
});
