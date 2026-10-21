/// <reference types="bun" />
import { it, expect } from 'bun:test';
import { compile } from '..';

// 之前所有属性都被渲染成模板字符串：`disabled={!ready}` 编出来是
// `() => `${!ready}``，也就是字符串 "false" —— 真值。
// 运行时 applyProp 只在拿到 `false` 时才 removeAttribute，于是按钮永远 disabled。

it('a single-expression attribute keeps the raw value', () => {
    const js = compile(`<script>
    let ready = $state(false);
</script>
<input type="file" disabled={!ready} />
<button disabled={!ready || false}>go</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/"disabled": \(\) => \(!ready\)/);
    expect(js).toMatch(/"disabled": \(\) => \(!ready \|\| false\)/);
    // 不能出现字符串化的版本
    expect(js).not.toMatch(/"disabled": \(\) => `\$\{/);
});

it('mixed text still becomes a template string', () => {
    const js = compile(`<script>
    let n = $state(0);
</script>
<p title="count: {n}">x</p>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/"title": \(\) => `count: \$\{n\}`/);
});
