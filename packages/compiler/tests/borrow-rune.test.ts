/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';
import { compile } from '..';

/**
 * `$borrow(level)` —— 参数的借用声明。
 *
 * ```ts
 * function rename(item = $borrow(2)) {
 *     item.title = 'done';      // 调用点是 `rename(items[2])`，这一下要刷那一行
 * }
 * ```
 *
 * 函数体不知道自己被哪条路径调用，所以由**调用点**把刷新接进来：
 *
 *     rename(items[2], (p) => __list?.setPath(2, p))
 *
 * 函数体这边只报"写了哪条路径"（`__borrow?.('title')`）。
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

const js = (source: string): string => compile(source, { filename: 'App.grain' }).js;

const messages = (source: string): string[] =>
    compile(source, { filename: 'App.grain' }).warnings.map((warning) => warning.message);

const mount = async (source: string): Promise<Element> => {
    const compiled = compile(source, { filename: 'App.grain', runtimeModule: runtimePath }).js;
    const file = join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '.tmp',
        `borrow-rune-${Math.random().toString(36).slice(2)}.ts`
    );

    await Bun.write(file, compiled);

    const module = (await import(file)) as { default: (target: Element) => void };
    const target = document.createElement('div');

    document.body.appendChild(target);
    module.default(target);

    return target;
};

const names = (target: Element): string[] =>
    [...target.querySelectorAll('span')].map((node) => node.textContent);

// ---------------------------------------------------------------- 函数侧

it('$borrow is stripped and a hidden reporter is added', () => {
    const out = js(`<script>
    function rename(item = $borrow(2)) {
        item.title = 'done';
    }
</script>
<p>x</p>`);

    // 默认值不该出现在产物里（`$borrow` 运行时不存在）
    expect(out).not.toContain('$borrow');
    // 参数只留名字 + 隐藏的报告函数
    expect(out).toContain('function rename(item, __borrow)');
});

it('nested paths are reported as dotted paths', () => {
    const out = js(`<script>
    function rename(item = $borrow(2)) {
        item.title = 'done';
        item.meta.author = 'me';
    }
</script>
<p>x</p>`);

    expect(out).toContain(`__borrow?.("title")`);
    expect(out).toContain(`__borrow?.("meta.author")`);
});

it('writing the param itself is not reported', () => {
    // `item = {...}` 是改局部变量，跟根上那条路径没关系
    const out = js(`<script>
    function reset(item = $borrow(2)) {
        item = { title: 'x' };
    }
</script>
<p>x</p>`);

    expect(out).not.toContain('__borrow?.(');
});

it('a plain default value is left alone', () => {
    // 只有 `$borrow(...)` 才特殊处理，普通默认值原样保留
    const out = js(`<script>
    function greet(name = 'world') {
        return name;
    }
</script>
<p>{greet()}</p>`);

    expect(out).toContain("function greet(name = 'world')");
});

// ---------------------------------------------------------------- 调用点

it('the call site wires a refresh function in', () => {
    const out = js(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }], 2);

    function rename(item = $borrow(2)) {
        item.name = 'X';
    }
</script>
{#for row of arr}
    <span>{row.name}</span>
{/for}
<button onclick={() => { rename(arr[1]); }}>go</button>`);

    // `rename(arr[1])` -> 多一个"路径 -> 刷新"的回调
    expect(out).toMatch(/rename\(arr\[1\], \(p\) => __list\$\d+\?\.setPath\(1, p\)\)/);
});

it('a write through a borrowed param refreshes exactly that row', async () => {
    const target = await mount(`<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 2);

    function rename(item = $borrow(2)) {
        item.name = 'X';
    }
</script>
{#for row of arr}
    <span>{row.name}</span>
{/for}
<button id="go" onclick={() => { rename(arr[1]); }}>go</button>`);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    (target.querySelector('#go') as HTMLElement).click();

    expect(names(target)).toEqual(['a', 'X', 'c']);
});

it('a Map key also works as the argument', async () => {
    // 项得是对象，改属性才有意义（数字没法「改内部」）
    const target = await mount(`<script>
    let scores = $state(new Map([['ada', { n: 1 }], ['bob', { n: 2 }]]), 2);

    function bump(entry = $borrow(2)) {
        entry.n = 99;
    }
</script>
{#for [name, value] of scores}
    <span>{name} = {value.n}</span>
{/for}
<button id="go" onclick={() => { bump(scores.get('bob')); }}>go</button>`);

    expect(names(target)).toEqual(['ada = 1', 'bob = 2']);

    (target.querySelector('#go') as HTMLElement).click();

    expect(names(target)).toEqual(['ada = 1', 'bob = 99']);
});

it('a nested write refreshes the fragment that reads it', async () => {
    // `__borrow('meta.author')` -> `setPath(1, 'meta.author')` -> 行的 `updatePath`
    // 得认得点分路径（以前只登记第一段 `meta`，多段的匹配不上）
    const target = await mount(`<script>
    let arr = $state(
        [{ meta: { author: 'a' } }, { meta: { author: 'b' } }, { meta: { author: 'c' } }],
        2
    );

    function rename(item = $borrow(2)) {
        item.meta.author = 'Z';
    }
</script>
{#for row of arr}
    <span>{row.meta.author}</span>
{/for}
<button id="go" onclick={() => { rename(arr[1]); }}>go</button>`);

    expect(names(target)).toEqual(['a', 'b', 'c']);

    (target.querySelector('#go') as HTMLElement).click();

    expect(names(target)).toEqual(['a', 'Z', 'c']);
});

it('a level that is too low is flagged', () => {
    // `$borrow(2)` 要求实参至少 level 2，而这里 `arr` 是默认的 1
    const found = messages(`<script>
    let arr = $state([{ name: 'a' }]);

    function rename(item = $borrow(2)) {
        item.name = 'X';
    }
</script>
{#for row of arr}
    <span>{row.name}</span>
{/for}
<button onclick={() => { rename(arr[0]); }}>go</button>`);

    expect(found.join(' ')).toContain('requires level 2');
});

it('an argument that is not a reactive path is flagged', () => {
    const found = messages(`<script>
    function rename(item = $borrow(2)) {
        item.name = 'X';
    }
</script>
<button onclick={() => { rename({ name: 'a' }); }}>go</button>`);

    expect(found.join(' ')).toContain('pass a reactive path');
});
