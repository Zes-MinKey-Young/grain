/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { compile } from '..';

// scope 会给选择器最后一段加类。`:root` / `html` / `body` 自己当最后一段时，
// 规则变成 `:root.grain-xxx`，没有任何元素带那个类 —— 整条规则永不匹配
// （`<style>` 里定义的 CSS 变量会整片失效，实测踩过），所以给一条提示。

const warnings = (style: string) =>
    compile(`<style>${style}</style><p>x</p>`, { filename: 'A.grain' }).warnings;

it('warns about :root in a scoped style', () => {
    const found = warnings(':root { --a: 1px }');

    expect(found.length).toBe(1);
    expect(found[0]!.message).toContain(':root');
    expect(found[0]!.message).toContain(':global(:root)');
});

it('warns about html / body too', () => {
    expect(warnings('body { color: red }').length).toBe(1);
    expect(warnings('html { color: red }').length).toBe(1);
});

it('stays quiet for :global(...)', () => {
    expect(warnings(':global(:root) { --a: 1px }').length).toBe(0);
    expect(warnings(':global(body) { color: red }').length).toBe(0);
});

it('stays quiet when the root selector is not the target compound', () => {
    // 类加在 `.box` 上，`html` 只是祖先 —— 规则照样能匹配
    expect(warnings('html .box { color: red }').length).toBe(0);
});

it('reports the position inside the style block', () => {
    const source = '<style>\n  :root { --a: 1px }\n</style>\n<p>x</p>';
    const found = compile(source, { filename: 'A.grain' }).warnings;

    expect(found.length).toBe(1);
    expect(source.slice(found[0]!.start).startsWith(':root')).toBe(true);
});
