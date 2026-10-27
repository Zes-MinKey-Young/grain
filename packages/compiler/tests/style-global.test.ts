/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { compile } from '..';

const css = (style: string) => compile(`<style>${style}</style><p>x</p>`, { filename: 'A.grain' }).css;

// `:global(...)`：这一段不参与 scope，选择器原样保留（`:global` 本身要脱掉）。
// 其它情况照旧在"目标元素"那一段加 scope 类。

it('scopes a plain selector', () => {
    expect(css('.a { color: red }')).toMatch(/\.a\.grain-[a-z0-9]+\s*\{\s*color:red/);
});

it('drops :global and keeps the selector unscoped', () => {
    const out = css(':global(.a) { color: red }');

    expect(out).not.toContain(':global');
    expect(out).toMatch(/\.a\s*\{\s*color:red/);
});

it('still scopes the trailing compound', () => {
    const out = css(':global(.a) .b { color: red }');

    expect(out).not.toContain(':global');
    expect(out).toMatch(/\.a \.b\.grain-[a-z0-9]+/);
});

it('leaves the target alone when the compound is global', () => {
    const out = css('.a :global(.b) { color: red }');

    expect(out).not.toContain(':global');
    expect(out).toMatch(/\.a \.b\s*\{\s*color:red/);
});

it('unwraps a compound that mixes scoped and global parts', () => {
    const out = css('.a:global(.b) { color: red }');

    expect(out).not.toContain(':global');
    // 混在一起时整体还是要 scope（`.a` 是本组件的）
    expect(out).toMatch(/\.a(\.grain-[a-z0-9]+)?\.b(\.grain-[a-z0-9]+)?\s*\{/);
    expect(out).toMatch(/grain-/);
});

it('handles a global selector with combinators inside', () => {
    const out = css(':global(.a .b) { color: red }');

    expect(out).not.toContain(':global');
    expect(out).toMatch(/\.a \.b\s*\{\s*color:red/);
    expect(out).not.toMatch(/\.b\.grain-/);
});
