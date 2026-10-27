/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { parse } from '..';

// 游离的 `{/xxx}` / `{:else}` 以前会让解析器原地打转：`readNodes` 把这类标记
// 交还给调用方，而元素 / 分支 / 顶层的循环都没人消费它，于是 index 永远不动。
// 现在三个循环都有"一步没走就报错"的兜底。

const cases = ['<div>{/snippet}</div>', '<div>{:else}</div>', '<div></span></div>', '{/if}'];

for (const source of cases) {
    it(`throws instead of hanging on \`${source}\``, () => {
        expect(() => parse(source)).toThrow();
    });
}

it('still parses a normally closed element', () => {
    expect(parse('<div><span>hi</span></div>').template.children).toHaveLength(1);
});
