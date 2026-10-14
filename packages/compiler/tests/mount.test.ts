/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';
import { compile } from '..';

// 挂载：建树完成 = 挂载完成。内容直接建在目标位置，不在 fragment 里中转。
//
// 以前子组件的 onmount 是在父元素还在 fragment 里时就调的（buildChildren 里），
// 所以 onmount 看到的自己"不在文档里"。子组件改成延迟到插入点确定时才建。

const runtimePath = join(import.meta.dir, '..', '..', 'runtime', 'index.ts');

let document: Document;

beforeAll(() => {
    const window = new Window();

    document = window.document as unknown as Document;

    const globals = globalThis as unknown as Record<string, unknown>;

    globals.document = document;
    globals.Node = window.Node;
    globals.window = window;
});

/**
 * 编译并写成模块。`name` 就是文件名（父组件 import 用的是同一个名字，所以两边得一致）。
 */
const build = async (source: string, name: string): Promise<{ default: (target: Element) => unknown }> => {
    const js = compile(source, { filename: name, runtimeModule: runtimePath }).js;
    const file = join(import.meta.dir, '..', '..', '..', '.tmp', name);

    await Bun.write(file, js);

    return (await import(file)) as { default: (target: Element) => unknown };
};

it('mount leaves the content in the target', async () => {
    const module = await build(`<script>
    let count = $state(0);
</script>
<div><span>{count}</span></div>`, 'simple.ts');

    const target = document.createElement('div');

    module.default(target);

    // 旧行为：内容还在 fragment 里，要等调用方再 append 一次
    expect(target.querySelector('span')).not.toBeNull();
    expect(target.childNodes.length).toBe(1);
});

it('a child component mounts inside the document', async () => {
    const childName = `Child-${Math.random().toString(36).slice(2)}.ts`;
    const parentName = `Parent-${Math.random().toString(36).slice(2)}.ts`;

    await build(`<script>
    let seen = $state('not set');
</script>
<i>{seen}</i>

<script onmount>
    seen = document.body.contains(document.querySelector('i')) ? 'in document' : 'NOT in document';
</script>`, childName);

    const parent = await build(`<script>
    import Child from './${childName}';
</script>
<Child />`, parentName);

    const target = document.createElement('div');

    document.body.appendChild(target);

    parent.default(target);

    // 子组件的 onmount 跑的时候，自己已经在文档里了
    expect(target.querySelector('i')?.textContent).toBe('in document');
});

it('a child component nested two levels deep mounts inside the document', async () => {
    const childName = `DeepChild-${Math.random().toString(36).slice(2)}.ts`;
    const parentName = `DeepParent-${Math.random().toString(36).slice(2)}.ts`;

    await build(`<script>
    let seen = $state('not set');
</script>
<i>{seen}</i>

<script onmount>
    seen = document.body.contains(document.querySelector('i')) ? 'in document' : 'NOT in document';
</script>`, childName);

    // 埋两层：中间那两层普通元素现在也带插入点了，所以子组件建好时就在文档里
    const parent = await build(`<script>
    import Child from './${childName}';
</script>
<main><section><Child /></section></main>`, parentName);

    const target = document.createElement('div');

    document.body.appendChild(target);

    parent.default(target);

    expect(target.querySelector('i')?.textContent).toBe('in document');
});

it('nested elements are created with an insert position, not inside children', () => {
    // 父只收文本和插值；嵌套元素单独建，带 `{ parent, index }`
    const js = compile(`<script>
    let count = $state(0);
</script>
<main>text <span>{count}</span> more</main>`, { filename: 'App.grain' }).js;

    // main 的 children 里只有两个文本 —— span 不在里面
    expect(js).toMatch(/creEle\("main", \{[^}]*\}, \["text ", " more"\]/);

    // span 带着插入位置：插在 main 的第 1 个内容节点（" more"）前面
    expect(js).toMatch(/creEle\("span", \{\}, \[[^\]]*\], \{ parent: update\$\d+, index: 1 \}\)/);
});
