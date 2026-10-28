/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';

// 症状：点事件 → 次侧栏"闪一下"到事件面板又弹回判定线列表，点第二回才正常。
//
// 怀疑是 `PopupOption` 建树时那句"校准"：
//   if (!options.some((o) => same(o, currentOption))) currentOption = options[0];
//
// 用 `bind:currentOption={$store(activeSecondarySidebar)}` 传进来时，这个绑定**没有
// getter**，`toBinding` 先给的是 fallback（''），真正的值要等 `listen` 送过来。
// 校准跑在送值之前的话，`currentOption` 是 '' → 判定"不在选项里" → 写回
// options[0]（判定线）→ store 被改回 LINES。

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

/** 带"校准"那句的最小版 PopupOption */
const picker = `<script>
    let { options = [], currentOption = $bindable('') } = $props<{
        options: any[];
        currentOption?: any;
    }>();

    if (!options.some((option) => option === currentOption)) currentOption = options[0];
</script>

<div class="picker">{currentOption}</div>
`;

it('does not clobber the store when calibrating a $store binding', async () => {
    await build(picker, 'picker');

    const target = await mount(`<script>
    import Picker from './picker.ts';
    import { writable } from '${runtimePath.replace(/\\/g, '/')}';

    const mode = writable(2);
</script>

<Picker options={[0, 1, 2]} bind:currentOption={$store(mode)} />
<span class="mirror">{mode.get()}</span>`);

    // store 里是 2（合法选项）：挂载不该把它改成 0
    expect(target.querySelector('.mirror')!.textContent).toBe('2');
    expect(target.querySelector('.picker')!.textContent).toBe('2');
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
