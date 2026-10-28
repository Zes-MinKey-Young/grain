/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';

// 直接把 kipphi-apparatus 的**首页原文**编译进来，只把 `#/...` 的导入换成桩。
//
// 症状：谱面数据回来后列表出现了，但 `{:else}` 那句"还没有谱面"仍留在 DOM 里。
// 自己手写的近似模板复现不出来，所以这里用原文。

const APP = 'D:/zes/VSCode/kipphi-apparatus/src/routes/+page.grain';
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

const stub = async (name: string, code: string): Promise<string> => {
    const file = tmp(`${name}.ts`);

    await Bun.write(file, code);

    return `./${name}.ts`;
};

it('removes the "no charts" branch once the charts arrive', async () => {
    await stub('home-i18n', `export const _ = (key) => key === 'chartIndex.noCharts' ? 'NOTHING-HERE' : key;`);
    await stub(
        'home-bg',
        `export async function queryCharts() {
            return [
                { identifier: 'a', title: 'A', type: 'KPA2', image: null, chartPath: '', illustration: '', lastModified: 0 },
                { identifier: 'b', title: 'B', type: 'KPA2', image: null, chartPath: '', illustration: '', lastModified: 0 }
            ];
        }`
    );

    const navigator = await stub(
        'home-navigator',
        `import { component, creFragment } from '${runtimePath.replace(/\\/g, '/')}';
export function create(props = {}, children = null, __at) {
    return component(creFragment([], __at), create, props, children);
}
export default function mount() {}
mount.create = create;`
    );

    const imageLoader = await stub(
        'home-image',
        `import { component, creFragment } from '${runtimePath.replace(/\\/g, '/')}';
export function create(props = {}, children = null, __at) {
    return component(creFragment([], __at), create, props, children);
}
export default function mount() {}
mount.create = create;`
    );

    const source = (await Bun.file(APP).text())
        .replace(/from "#\/i18n"/g, `from './home-i18n.ts'`)
        .replace(/from "#\/background"/g, `from './home-bg.ts'`)
        .replace(/from "#\/components\/Navigator.grain"/g, `from '${navigator}'`)
        .replace(/from "#\/components\/ImageLoader.grain"/g, `from '${imageLoader}'`);

    const js = compile(source, { runtimeModule: runtimePath, filename: 'home.grain' }).js;
    const file = tmp(`home-${Math.random().toString(36).slice(2)}.ts`);

    await Bun.write(file, js);

    const module = await import(file);
    const target = document.createElement('div');

    document.body.appendChild(target);
    module.default(target);

    // onmount 里的 `queryCharts()` 是异步的，等它落地
    await new Promise((resolve) => setTimeout(resolve, 30));

    const content = target.querySelector('#content')!;

    expect(target.querySelectorAll('.chart').length).toBe(2);
    expect(content.textContent!.includes('NOTHING-HERE')).toBe(false);
});
