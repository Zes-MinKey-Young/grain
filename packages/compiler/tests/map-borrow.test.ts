/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';
import { compile } from '..';

/**
 * 借用规则四种位置的 **Map 版**（数组版在 borrow.test.ts）。
 *
 * Map 的项不是属性，取出走 `get`：

 *     const second = scores.get('b');      <- 借用从这里开始
 *     second.name = 'B';                   <- 写它
 *
 * key 原样记下，正好喂给 `setPath(key, prop)` —— 那个签名本来就是 `(key, prop)`。
 *
 * 能打断借用的操作跟数组一样：整体重赋值、`clear()`。而 `set` / `delete` **不打断**
 * —— 它们只动那一项（跟 `push` 只追加一个道理）。
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
        `map-borrow-${Math.random().toString(36).slice(2)}.ts`
    );

    await Bun.write(file, js);

    const module = (await import(file)) as { default: (target: Element) => void };
    const target = document.createElement('div');

    document.body.appendChild(target);
    module.default(target);

    return target;
};

const ROWS = `{#for [name, value] of scores with key = name}
    <span>{value.name}</span>
{/for}
<button onclick={f}>go</button>`;

const THREE = `let scores = $state(new Map([
        ['a', { name: 'a' }],
        ['b', { name: 'b' }],
        ['c', { name: 'c' }]
    ]), 2);`;

const names = (target: Element): string[] =>
    [...target.querySelectorAll('span')].map((node) => node.textContent);

const messages = (source: string): string[] =>
    compile(source, { filename: 'App.grain' }).warnings.map((warning) => warning.message);

it('④ the root untouched: the borrowed write refreshes', async () => {
    const target = await mount(`<script>
    ${THREE}

    function f() {
        const second = scores.get('b');

        second.name = 'B';
    }
</script>
${ROWS}`);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    expect(names(target)).toEqual(['a', 'B', 'c']);
});

it('① the root reassigned before the borrow: still refreshes', async () => {
    // 根先整个换掉，再取出 —— 借用从取出那句才开始，不受影响
    const target = await mount(`<script>
    ${THREE}

    function f() {
        scores = new Map([['a', { name: 'x' }], ['b', { name: 'y' }]]);
        const second = scores.get('b');

        second.name = 'B';
    }
</script>
${ROWS}`);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    expect(names(target)).toEqual(['x', 'B']);
});

it('② the root cleared in between: no refresh, and it is flagged', async () => {
    // 取出 -> `clear()` 打断借用 -> 再写。那次写入不再刷根变量
    const source = `<script>
    ${THREE}

    function f() {
        const second = scores.get('b');

        scores.clear();
        second.name = 'B';
    }
</script>
${ROWS}`;

    const target = await mount(source);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    // 清空生效
    expect(names(target)).toEqual([]);

    // 越界写 —— 有提示
    expect(messages(source).join(' ')).toContain('`second` is no longer reactive');

    // 也不该有精确的 setPath
    const js = compile(source, { filename: 'App.grain' }).js;

    expect(js).not.toMatch(/setPath\('b', "name"\)/);
});

it('③ the root cleared after the write: the write already happened', async () => {
    // 取出 -> 写入（借用还活着 -> 刷新）-> 再清空
    const source = `<script>
    ${THREE}

    function f() {
        const second = scores.get('b');

        second.name = 'B';
        scores.clear();
    }
</script>
${ROWS}`;

    const target = await mount(source);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    expect(names(target)).toEqual([]);

    // 写入排在清空之前，借用那时还活着 —— 不提示，且有精确的 setPath
    expect(messages(source)).toEqual([]);
    expect(compile(source, { filename: 'App.grain' }).js).toMatch(/setPath\('b', "name"\)/);
});

it('map.set / delete do NOT break the borrow (only clear does)', async () => {
    // 跟上一条对照：`set` / `delete` 只动那一项，别的项引用不变，借用不该断
    const source = `<script>
    ${THREE}

    function f() {
        const second = scores.get('b');

        scores.set('d', { name: 'd' });
        second.name = 'B';
    }
</script>
${ROWS}`;

    const target = await mount(source);

    target.querySelector('button')!.click();

    expect(names(target)).toEqual(['a', 'B', 'c', 'd']);
    expect(messages(source)).toEqual([]);
});

it('a Map entry is not a property — the bracket form is flagged', () => {
    // 以前会把 `scores['b']` 当成对象属性，生成 `scores.b`（Map 没有那个属性）
    // —— 产物读到一个 undefined，点击时抛 TypeError 被浏览器吞掉，DOM 静默不更新
    const source = `<script>
    ${THREE}

    function f() {
        const second = scores['b'];

        second.name = 'B';
    }
</script>
${ROWS}`;

    const found = messages(source).join(' ');

    expect(found).toContain('is a Map');
    expect(found).toContain('.get(key)');

    // 关键：不能再生成那个错的属性访问
    const js = compile(source, { filename: 'App.grain' }).js;

    expect(js).not.toMatch(/scores\.b\.name/);
});

it('writing through map.get(k) directly refreshes too', async () => {
    // 不经过一个 `const` 取出：`scores.get('b').name = 'B'`。
    //
    // 以前这条不刷新 —— `pathOf` 不认 `CallExpression`，那次写入进不了 `writes`；
    // `cellOf` 也不认这种 left，精确的 setPath 生成不出来。两条路都断了，于是
    // 改了数据、DOM 一动不动，也不报错
    const source = `<script>
    ${THREE}

    function f() {
        scores.get('b').name = 'B';
    }
</script>
${ROWS}`;

    const target = await mount(source);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    expect(names(target)).toEqual(['a', 'B', 'c']);
    expect(compile(source, { filename: 'App.grain' }).js).toMatch(/setPath\('b', "name"\)/);
});

it('a dynamic key works the same way', async () => {
    // key 是个变量 —— 照样定位到那一项
    const source = `<script>
    ${THREE}

    function f() {
        const which = 'c';

        scores.get(which).name = 'C';
    }
</script>
${ROWS}`;

    const target = await mount(source);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    target.querySelector('button')!.click();

    expect(names(target)).toEqual(['a', 'b', 'C']);
});

it('an array still uses the bracket form without complaint', () => {
    // 只对 Map 认 `get` —— 数组的下标写法照旧，别误报
    expect(
        messages(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }], 2);

    function f() {
        const second = arr[1];

        second.name = 'B';
    }
</script>
{#for item of arr}
    <span>{item.name}</span>
{/for}
<button onclick={f}>go</button>`)
    ).toEqual([]);
});
