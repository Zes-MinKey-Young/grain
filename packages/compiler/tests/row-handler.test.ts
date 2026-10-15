/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';
import { compile } from '..';

/**
 * `{#for}` 里的事件监听器：必须定义在 `render$X` 内部。
 *
 * 定义在顶层的话访问不到循环变量（`{#for item of items}` 里 onclick 用 `item`），
 * 运行时 ReferenceError —— 而监听器里的异常被浏览器吞掉，表现就是"点了没反应"。
 */

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
    const js = compile(source, { filename: 'App.grain', runtimeModule: runtimePath }).js;
    const file = join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '.tmp',
        `row-handler-${Math.random().toString(36).slice(2)}.ts`
    );

    await Bun.write(file, js);

    const module = (await import(file)) as { default: (target: Element) => void };
    const target = document.createElement('div');

    document.body.appendChild(target);
    module.default(target);

    return target;
};

it('a handler inside a for block sees the loop variable', async () => {
    const target = await mount(`<script>
    let items = $state(['a', 'b', 'c']);
    let picked = $state('');
</script>
{#for item of items}
    <button onclick={() => { picked = item; }}>{item}</button>
{/for}
<p>{picked}</p>`);

    const picked = () => target.querySelector('p')?.textContent;

    expect(picked()).toBe('');

    const buttons = [...target.querySelectorAll('button')] as Element[];

    buttons[2]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    // 监听器里读到了那一行的 item —— 定义在顶层的话这里是空的（ReferenceError 被吞）
    expect(picked()).toBe('c');
});

it('a destructured loop variable works too', async () => {
    const target = await mount(`<script>
    let rows = $state([{ id: 7, name: 'x' }]);
    let chosen = $state(0);
</script>
{#for [i, row] of rows.entries()}
    <button onclick={() => { chosen = row.id; }}>{i}</button>
{/for}
<p>{chosen}</p>`);

    target.querySelector('button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(target.querySelector('p')?.textContent).toBe('7');
});

it('the handler is defined inside render, before it is used', () => {
    const js = compile(`<script>
    let items = $state([1, 2]);
    let picked = $state(0);
</script>
{#for item of items}
    <button onclick={() => { picked = item; }}>{item}</button>
{/for}`, { filename: 'App.grain' }).js;

    // 定义落在 `render$N` 内部
    const render = js.slice(js.indexOf('const render$'));

    expect(render).toMatch(/const __handler\$\d+ = /);
    // 而且要在引用它的 `creEle` 之前（`const` 有 TDZ）
    expect(render.indexOf('const __handler$')).toBeLessThan(render.indexOf('creEle("button"'));
});

it('a handler outside a for block still goes to the top level', () => {
    const js = compile(`<script>
    let picked = $state(0);
</script>
<button onclick={() => { picked = 1; }}>go</button>
<p>{picked}</p>`, { filename: 'App.grain' }).js;

    // 不涉及循环变量：定义在 create() 里就够了，不用塞进 render
    expect(js).toMatch(/const __handler\$\d+ = /);
    expect(js).not.toMatch(/const render\$/);
});
