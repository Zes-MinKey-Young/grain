/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { parse } from '..';

// `<Foo x={1}/>` 里 `/` 曾被当作未加引号的属性值的一部分，
// 于是 readElement 看不到自闭合，`<Foo>` 被当成容器，报"闭合标签不匹配"。

it('accepts a self-closing element right after an expression attribute', () => {
    const root = parse('<div><Foo x={1}/><span>s</span></div>');

    const div = root.template.children[0] as { children: Array<{ name: string }> };

    expect(div.children.map((child) => child.name)).toEqual(['Foo', 'span']);
});

it('still treats a slash inside a quoted value as text', () => {
    const root = parse('<div><Foo x="a/"/></div>');
    const div = root.template.children[0] as { children: Array<{ attributes: Record<string, unknown> }> };

    expect(div.children[0].attributes.x).toBe('a/');
});
