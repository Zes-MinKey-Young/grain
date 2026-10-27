/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { compile } from '..';

// `<script>` 里的顶层 `await` 以前会被原样放进同步的 `create()`，产物直接是语法错误。
// 现在 `create` 声明成 async，返回 Promise，并打上 `create.async = true`。

it('declares create as async when the script awaits at the top level', () => {
    const js = compile(
        `<script>
    const data = await load();
    let name = $state(data.name);
</script>
<p>{name}</p>`,
        { filename: 'A.grain' }
    ).js;

    expect(js).toContain('export async function create(props = {}, children = null, __at) {');
    expect(js).toContain('const data = await load();');
    expect(js).toContain('create.async = true;');
});

it('leaves a sync component alone', () => {
    const js = compile(
        `<script>
    let name = $state('a');
</script>
<p>{name}</p>`,
        { filename: 'A.grain' }
    ).js;

    expect(js).not.toContain('(async () => {');
    expect(js).not.toContain('create.async');
});

it('ignores await inside a function body', () => {
    const js = compile(
        `<script>
    let name = $state('a');
    async function load() { return await fetch('/x'); }
</script>
<p>{name}</p>`,
        { filename: 'A.grain' }
    ).js;

    expect(js).not.toContain('create.async');
});

it('keeps the module script at module scope even with await', () => {
    const js = compile(
        `<script module>
    const shared = await load();
</script>
<script>
    let name = $state('a');
</script>
<p>{name}</p>`,
        { filename: 'A.grain' }
    ).js;

    // 模块级本来就是 ES module 顶层，await 天然合法，不需要再包一层
    expect(js).toContain('const shared = await load();');
    expect(js).not.toContain('create.async');
});
