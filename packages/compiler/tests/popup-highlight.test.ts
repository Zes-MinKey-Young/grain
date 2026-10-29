/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';

// 症状：点弹窗里的选项，触发按钮的文字变了，弹窗里的高亮不动。
// 结构照 `PopupOption.grain`：**组件**里 `{#if}` 包 `{#for}`，行读组件作用域的 `$node`。

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

const click = (node: Element) =>
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

it('moves the highlight inside the popup when an option is picked', async () => {
    await build(
        `<script>
    let {
        options = [],
        currentOption = $bindable('')
    } = $props<{ options: any[]; currentOption?: any }>();

    let isPopupVisible = $state(false);

    const currentIndex = $node({ get: () => options.findIndex((option) => option === currentOption) });

    function selectOption(index: number) {
        currentOption = options[index];
        isPopupVisible = false;
    }
</script>

<div class="trigger" role="button" onclick={() => (isPopupVisible = true)}>
    <span class="label">{currentIndex >= 0 ? options[currentIndex] : 'Select Option'}</span>

    {#if isPopupVisible}
        <div class="popup">
            {#for [index, option] of options.entries()}
                <div class="option-item {index === currentIndex ? 'selected' : ''}" onclick={() => selectOption(index)}>{option}</div>
            {/for}
        </div>
    {/if}
</div>`,
        'popup-box'
    );

    const target = await mount(`<script>
    import PopupBox from './popup-box.ts';
    let current = $state('a');
</script>

<PopupBox options={['a', 'b', 'c']} bind:currentOption={current} />
<span class="mirror">{current}</span>`);

    const trigger = target.querySelector('.trigger')!;
    const selected = () =>
        [...target.querySelectorAll('.option-item')].findIndex((node) =>
            node.classList.contains('selected')
        );

    click(trigger);
    expect(selected()).toBe(0);

    click(target.querySelectorAll('.option-item')[2]!);

    // 重新打开弹窗看高亮
    click(trigger);

    expect(target.querySelector('.mirror')!.textContent).toBe('c');
    expect(selected()).toBe(2);
});
