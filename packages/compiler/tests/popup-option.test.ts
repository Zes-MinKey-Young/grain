/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';
import { popupOption } from './fixtures/components.ts';

// 症状：点 OptionBox 里的某个选项，父组件收到了新值（界面变了），但 OptionBox
// 自己显示的还是旧值。结构照 `PopupOption.grain` 抄（fixtures 里）。

const runtimePath = join(import.meta.dir, '..', '..', 'runtime', 'index.ts');

let window: Window;
let document: Document;

beforeAll(() => {
    window = new Window();
    document = window.document as unknown as Document;

    const globals = globalThis as unknown as Record<string, unknown>;

    globals.document = document;
    globals.Node = window.Node;
    globals.window = window;
});

const tmp = (...parts: string[]) => join(import.meta.dir, '..', '..', '..', '.tmp', ...parts);

const build = async (source: string, name: string): Promise<string> => {
    const js = compile(source, { runtimeModule: runtimePath, filename: `${name}.grain` }).js;

    await Bun.write(tmp(`${name}.ts`), js);

    return `./${name}.ts`;
};

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

const click = (node: Element) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

it('updates its own label when an option is picked', async () => {
    await build(popupOption, 'popup-option');

    const target = await mount(`<script>
    import PopupOption from './popup-option.ts';

    let current = $state('a');
</script>

<PopupOption options={['a', 'b', 'c']} bind:currentOption={current} />

<span class="mirror">{current}</span>`);

    const label = () => target.querySelector('.label')!.textContent!.trim();
    const mirror = () => target.querySelector('.mirror')!.textContent!.trim();

    expect(label()).toBe('a');
    expect(mirror()).toBe('a');

    // 打开弹窗，点第二个选项
    click(target.querySelector('.trigger')!);

    const items = [...target.querySelectorAll('.option-item')];

    expect(items.map((node) => node.textContent!.trim())).toEqual(['a', 'b', 'c']);

    click(items[1]!);

    // 父组件收到了新值
    expect(mirror()).toBe('b');

    // 自己也该跟着变
    expect(label()).toBe('b');
});

it('shows the store value right away when bound with $store', async () => {
    // 父组件用 `$store(active)` 绑过去：那个绑定**没有 getter**（只有 set + listen），
    // 值是靠 listen 送进来的。子组件得自己接住，否则永远停在 `$bindable` 的默认值
    // —— 页面上的症状就是次侧栏那个切换按钮一直显示 "Select Option"。
    await build(popupOption, 'popup-option');

    const target = await mount(`<script>
    import PopupOption from './popup-option.ts';
    import { writable } from '${runtimePath.replace(/\\/g, '/')}';

    const active = writable('b');
</script>

<PopupOption options={['a', 'b', 'c']} bind:currentOption={$store(active)} />`);

    const label = () => target.querySelector('.label')!.textContent!.trim();

    expect(label()).toBe('b');

    // 之后 store 变了也要跟着走
    (window as unknown as { __active?: { set: (v: string) => void } }).__active?.set('c');

    expect(label()).toBe('b');
});

it('keeps the selected marker on the picked option', async () => {
    await build(popupOption, 'popup-option');

    const target = await mount(`<script>
    import PopupOption from './popup-option.ts';

    let current = $state('a');
</script>

<PopupOption options={['a', 'b', 'c']} bind:currentOption={current} />`);

    click(target.querySelector('.trigger')!);
    click([...target.querySelectorAll('.option-item')][2]!);

    // 重新打开：`b`/`c` 的选中标记来自 `$node` 派生的 `currentIndex`
    click(target.querySelector('.trigger')!);

    const selected = [...target.querySelectorAll('.option-item')]
        .filter((node) => node.className.includes('selected'))
        .map((node) => node.textContent!.trim());

    expect(selected).toEqual(['c']);
});
