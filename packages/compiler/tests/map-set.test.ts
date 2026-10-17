/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';
import { compile } from '..';
import { CHANGE_CLEAR, CHANGE_DELETE, CHANGE_SET, reactiveMap } from '../../runtime/index.ts';

/**
 * `$state(new Map(...))` / `$state(new Set(...))` 的响应性。
 *
 * **`$state` 不改变容器的类型** —— Map 就是 Map，不该被包成 Proxy。所以改动靠
 * 编译期追踪容器方法，两处都得对，缺一个就不刷新：
 *
 * 1. `scores.set(k, v)` 这类方法要算作"写了 scores" —— 否则写了它们的顶层函数
 *    `writes` 是空的，`functionWrappers` 跳过，不生成 `list.setKey(...)`
 * 2. 生成出来的调用要带上定位信息（key），for 块里靠"值 -> 那一项"的映射
 *    直接落到那一行，而不是遍历整个列表
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
        `map-set-${Math.random().toString(36).slice(2)}.ts`
    );

    await Bun.write(file, js);

    const module = (await import(file)) as { default: (target: Element) => void };
    const target = document.createElement('div');

    document.body.appendChild(target);
    module.default(target);

    return target;
};

const click = (target: Element, id: string): void => {
    target.querySelector(`#${id}`)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};

const rows = (target: Element, cls: string): string[] =>
    [...target.querySelectorAll(`.${cls}`)].map((el) => el.textContent);

it('map.set / delete / clear refresh the list', async () => {
    const target = await mount(`<script>
    let scores = $state(new Map([['ada', 1]]));

    function score(name, value) {
        scores.set(name, value);
    }

    function unscore(name) {
        scores.delete(name);
    }

    function reset() {
        scores.clear();
    }
</script>
{#for [name, value] of scores with key = name}
    <p class="srow">{name} = {value}</p>
{/for}
<button id="set" onclick={() => { score('bob', 20); }}>set</button>
<button id="del" onclick={() => { unscore('ada'); }}>del</button>
<button id="clear" onclick={reset}>clear</button>`);

    expect(rows(target, 'srow')).toEqual(['ada = 1']);

    click(target, 'set');
    expect(rows(target, 'srow')).toEqual(['ada = 1', 'bob = 20']);

    click(target, 'del');
    expect(rows(target, 'srow')).toEqual(['bob = 20']);

    click(target, 'clear');
    expect(rows(target, 'srow')).toEqual([]);
});

it('reactiveMap reports the key so a subscriber can stay precise', () => {
    // `reactiveMap` 是给**手写代码**用的公开 API（编译器生成的产物不再用它 ——
    // `$state` 不改容器的类型）。
    //
    // 它发出去的改动必须带 key/value：以前是 `[CHANGE_SET]`（光有种类），收的人定位
    // 不到是哪一行，只能"重新取一次再比对"（遍历整个容器）。
    const map = reactiveMap(new Map([['ada', 1]]));
    const seen: unknown[] = [];

    map.subscribe((change) => seen.push(change));

    map.set('bob', 2);
    map.delete('ada');
    map.clear();

    expect(seen).toEqual([
        [CHANGE_SET, 'bob', 2],
        [CHANGE_DELETE, 'ada'],
        [CHANGE_CLEAR]
    ]);
});

it('set.add / delete refresh the list', async () => {
    const target = await mount(`<script>
    let picked = $state(new Set(['red']));

    function pick(color) {
        picked.add(color);
    }

    function unpick(color) {
        picked.delete(color);
    }
</script>
{#for color of picked with key = color}
    <p class="prow">{color}</p>
{/for}
<button id="add" onclick={() => { pick('blue'); }}>add</button>
<button id="del" onclick={() => { unpick('red'); }}>del</button>`);

    expect(rows(target, 'prow')).toEqual(['red']);

    click(target, 'add');
    expect(rows(target, 'prow')).toEqual(['red', 'blue']);

    click(target, 'del');
    expect(rows(target, 'prow')).toEqual(['blue']);
});

it('$state does not change the container type', () => {
    // `$state` 只是编译期的标记，不该把 Map 包成 Proxy —— 类型得原样保留
    // （`scores instanceof Map` 之类的判断不能被破坏）。
    //
    // 改动靠**编译期**追踪容器方法：`scores.set(k, v)` 那类调用换成列表自己的
    // `setKey` / `removeKey` / `clear`（见下一条）
    const js = compile(`<script>
    let scores = $state(new Map([['ada', 1]]));
    let picked = $state(new Set(['red']));
</script>
{#for [name, value] of scores with key = name}
    <p>{name}</p>
{/for}
{#for color of picked with key = color}
    <p>{color}</p>
{/for}`, { filename: 'App.grain' }).js;

    expect(js).toContain('let scores = new Map(');
    expect(js).toContain('let picked = new Set(');
    expect(js).not.toContain('reactiveMap');
    expect(js).not.toContain('reactiveSet');
});

it('container methods are turned into precise list calls at compile time', () => {
    const js = compile(`<script>
    let scores = $state(new Map([['ada', 1]]));

    function setIt() {
        scores.set('bob', 20);
    }

    function delIt() {
        scores.delete('ada');
    }

    function clearIt() {
        scores.clear();
    }
</script>
{#for [name, value] of scores with key = name}
    <p>{name}</p>
{/for}`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/__list\$\d+\?\.setKey\('bob', 20\)/);
    expect(js).toMatch(/__list\$\d+\?\.removeKey\('ada'\)/);
    expect(js).toMatch(/__list\$\d+\?\.clear\(\)/);
});

it('setKey locates the row through the key map, not by scanning', async () => {
    // `setKey` 以前是 `entries.findIndex(entry => entry.key === key)` —— 线性扫。
    // 现在 for 块里维护着 key -> 那一项的映射，一次 `get` 就够
    let scans = 0;

    const original = Array.prototype.findIndex;

    Array.prototype.findIndex = function (
        this: unknown[],
        ...args: [unknown, ...unknown[]]
    ): number {
        scans += 1;

        return (original as (...rest: unknown[]) => number).apply(this, args);
    } as never;

    try {
        const target = await mount(`<script>
    let scores = $state(new Map([['ada', 1], ['bob', 2], ['cy', 3]]));

    function score(name, value) {
        scores.set(name, value);
    }
</script>
{#for [name, value] of scores with key = name}
    <p class="srow">{name} = {value}</p>
{/for}
<button id="set" onclick={() => { score('cy', 33); }}>set</button>`);

        const before = scans;

        click(target, 'set');

        expect(rows(target, 'srow')).toEqual(['ada = 1', 'bob = 2', 'cy = 33']);
        expect(scans - before).toBe(0);
    } finally {
        Array.prototype.findIndex = original;
    }
});

it('a two-item destructuring for picks its key automatically', async () => {
    // `{#for [key, value] of map}` 本来就是 Map 的写法，第一项天然是键 ——
    // 不写 `with key` 也该认。漏认的话 `setKey` / `removeKey` 一条都生成不出来
    const target = await mount(`<script>
    let scores = $state(new Map([['ada', 1], ['bob', 2]]));

    function score(name, value) {
        scores.set(name, value);
    }

    function drop(name) {
        scores.delete(name);
    }
</script>
{#for [name, value] of scores}
    <p class="srow">{name} = {value}</p>
{/for}
<button id="set" onclick={() => { score('bob', 99); }}>set</button>
<button id="del" onclick={() => { drop('ada'); }}>del</button>`);

    expect(rows(target, 'srow')).toEqual(['ada = 1', 'bob = 2']);

    click(target, 'set');
    expect(rows(target, 'srow')).toEqual(['ada = 1', 'bob = 99']);

    click(target, 'del');
    expect(rows(target, 'srow')).toEqual(['bob = 99']);
});

it('the auto key is also used for locating the row', () => {
    // 键认出来了才会登记成 keyed —— `setKey` 只对 keyed 的列表生成
    const js = compile(`<script>
    let scores = $state(new Map([['ada', 1]]));

    function score(name, value) {
        scores.set(name, value);
    }
</script>
{#for [name, value] of scores}
    <p>{name}</p>
{/for}`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/key: \(\[name, value\]\) => \(name\)/);
    expect(js).toMatch(/\.setKey\(name, value\)/);
});

it('a plain array is not wrapped (precise calls already cover it)', () => {
    // 数组的 push / splice 编译期就换成了 list.push(...)，再包 reactiveArray 会刷两遍
    const js = compile(`<script>
    let items = $state([1, 2]);
</script>
{#for item of items}
    <p>{item}</p>
{/for}`, { filename: 'App.grain' }).js;

    expect(js).toContain('let items = [1, 2];');
    expect(js).not.toContain('reactiveArray');
});

it('a function calling a container method gets the precise call', () => {
    // 被箭头函数间接调用（不是模板直接引用）的函数也得包装上
    const js = compile(`<script>
    let scores = $state(new Map([['ada', 1]]));

    function score(name, value) {
        scores.set(name, value);
    }
</script>
{#for [name, value] of scores with key = name}
    <p>{name}</p>
{/for}
<button onclick={() => { score('bob', 20); }}>set</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/const score = function score\(name, value\) \{/);
    expect(js).toMatch(/scores\.set\(name, value\);\s*__list\$\d+\?\.setKey\(name, value\)/);
});
