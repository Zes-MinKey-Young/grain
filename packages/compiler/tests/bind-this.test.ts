/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';
import { compile } from '..';

// `bind:this` 的规矩：
//
// - 绑的变量在**元素事件监听器**里能用
// - 模板里别的地方（箭头函数、`bind:` 的 get/set）也要用的话，往 `<script>` 里写
//   `let box: HTMLXxxElement;` —— 编译器复用那个声明，只负责赋值

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

const mount = async (source: string): Promise<Element> => {
    const js = compile(source, { runtimeModule: runtimePath }).js;
    // 写到仓库根的 .tmp：留在 tests 目录里会被 tsc 编进 vite-plugin 的 dist
    const file = join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '.tmp',
        `bind-this-${Math.random().toString(36).slice(2)}.ts`
    );

    await Bun.write(file, js);

    const module = await import(file);
    const target = document.createElement('div');

    // 不移除：happy-dom 的 focus() 只对在文档里的元素生效，而这个用例要验的
    // 正是"监听器里用 bind:this 的变量把焦点调过去"
    document.body.appendChild(target);
    module.default(target);

    return target;
};

it('the variable is usable inside an element event listener', async () => {
    // 不查闭包里的变量（拿不到），看它**造成的结果**：监听器把 focus 调到 box 上，
    // 于是 document.activeElement 变成了那个 input
    const target = await mount(`<script>
    let box: HTMLInputElement;

    function onFocus() {
        box.focus();
    }
</script>
<input bind:this={box} />
<button onclick={onFocus}>focus</button>`);

    const input = target.querySelector('input') as HTMLInputElement;

    // 挂载之后变量已经有值了（不是只有 onmount 里才有）
    expect(input.tagName).toBe('INPUT');

    target.querySelector('button')!.click();

    // 监听器里直接用它，没有 undefined —— 焦点被调过去了
    expect(document.activeElement).toBe(input);
});

it('reuses the declaration from <script> instead of making its own', () => {
    const js = compile(`<script>
    let box: HTMLDivElement;
</script>
<div bind:this={box}></div>`, { filename: 'App.grain' }).js;

    // 只有一处 let box —— script 里那句；bind:this 不再另起一个
    expect(js.match(/let box;/g)).toHaveLength(1);

    // 赋值交给建树时跑的 "this"
    expect(js).toMatch(/"this": \(\$el\) => \{ box = \$el; \}/);
});

it('still declares it itself when <script> has none', () => {
    const js = compile(`<div bind:this={box}></div>`, { filename: 'App.grain' }).js;

    // 不声明就没法赋值
    expect(js).toMatch(/let box;/);
});

it('a callback receives the element instead', () => {
    const js = compile(`<script>
    let seen = '';
    function grab(el) { seen = el.tagName; }
</script>
<div bind:this={grab}></div>`, { filename: 'App.grain' }).js;

    // 标识符指向 script 里的函数：当回调用，不声明变量
    expect(js).not.toMatch(/let grab/);
    expect(js).toMatch(/"this": grab/);
});
