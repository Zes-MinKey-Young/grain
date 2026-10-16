/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';
import { compile } from '..';

/**
 * `$state(new Map(...))` / `$state(new Set(...))` 的响应性。
 *
 * 两处都得对，缺一个就不刷新：
 *
 * 1. 编译期要把 `scores.set(k, v)` 这类方法当成"写了 scores" —— 否则写了它们的顶层
 *    函数 `writes` 是空的，`functionWrappers` 跳过，不生成 `list.setKey(...)`
 * 2. 产物要把容器包上 `reactiveMap` / `reactiveSet` —— 否则它是裸 Map，没有
 *    `subscribe`，`if (typeof x?.subscribe === 'function')` 直接跳过
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

it('map.set does not re-iterate the whole container', async () => {
    // 以前 `set` 发出去的改动是 `[CHANGE_SET]` —— **不带 key/value**，收的人（List.apply）
    // 定位不到是哪一行，只能落到 default："重新取一次再比对"，也就是遍历整个容器。
    // 现在发 `[CHANGE_SET, key, value]`，apply 走 setKey 只动那一行。
    //
    // 数迭代次数来盯住这条：全量必然会 `Array.from(source())`。
    let iterations = 0;

    const original = Map.prototype[Symbol.iterator];

    Map.prototype[Symbol.iterator] = function (this: Map<unknown, unknown>): MapIterator<[unknown, unknown]> {
        iterations += 1;

        return original.call(this) as MapIterator<[unknown, unknown]>;
    };

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
<button id="set" onclick={() => { score('bob', 99); }}>set</button>`);

        expect(rows(target, 'srow')).toEqual(['ada = 1', 'bob = 2', 'cy = 3']);

        const before = iterations;

        click(target, 'set');

        expect(rows(target, 'srow')).toEqual(['ada = 1', 'bob = 99', 'cy = 3']);

        // 精确路径一次都不用迭代整个 Map
        expect(iterations - before).toBe(0);
    } finally {
        Map.prototype[Symbol.iterator] = original;
    }
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

it('the container is wrapped so it has subscribe', () => {
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

    expect(js).toContain('reactiveMap(new Map(');
    expect(js).toContain('reactiveSet(new Set(');

    // 订阅那句也就接得上了
    expect(js).toMatch(/if \(typeof __src\$\d+\?\.subscribe === 'function'\)/);
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
