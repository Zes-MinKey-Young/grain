/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';
import { judgeLineRow } from './fixtures/components.ts';

// `Nap` 那张谱一进编辑器就把循环保护打满（`__refresh$N` 10ms 内 100 次），
// 判定线列表一个都没渲染出来。这里把 `JudgeLineManager` 的骨架搬进来复现：
// 自递归 + `{#if}` 套 `{#for}` + 两个 `$node`（一个返回排序数组、一个返回新对象）。

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
    const js = compile(source, { runtimeModule: runtimePath, filename: `${name}.grain` }).js;

    await Bun.write(tmp(`${name}.ts`), js);

    return `./${name}.ts`;
};

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

it('renders a recursive judge line tree without spinning', async () => {
    // 脚手架：store（真组件里是 `store.ts` 的 `selectedLineNumber`）+ 滚动桩
    await Bun.write(
        tmp('judge-store.ts'),
        `let current = 0;
const listeners = new Set<any>();

export const selected = {
    get: () => current,
    set: (next: number) => {
        if (next === current) return;
        current = next;
        for (const listener of [...listeners]) listener(current);
    },
    subscribe: (listener: any) => {
        listeners.add(listener);
        listener(current);
        return () => listeners.delete(listener);
    }
};`
    );

    await build(judgeLineRow, 'judge-line-row');

    const target = await mount(`<script>
    import JudgeLineRow from './judge-line-row.ts';

    const line = (id: number, children: any[] = []) => ({
        id,
        moveX: id * 0.1,
        children: new Set(children)
    });

    const root = line(0, [line(1, [line(3), line(4)]), line(2, [line(5)])]);
</script>

<JudgeLineRow target={root} />`);

    const rows = [...target.querySelectorAll('.row')];
    const ids = rows.map((row) => row.querySelector('.id')!.textContent!.trim());

    // 一棵 6 个节点的树：0 → 1 → (3, 4)、2 → 5
    expect(ids.sort()).toEqual(['0', '1', '2', '3', '4', '5']);
    expect(target.querySelectorAll('.row').length).toBe(6);
});
