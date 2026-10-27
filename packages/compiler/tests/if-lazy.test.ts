/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { compile } from '..';

// `{#if}` 曾经是"无条件建、只控制插不插入"：分支里的子组件在 create 时就被实例化，
// 于是 `operationList` 还没赋值 / `selectedNote` 还是 null 的组件提前跑了初始化，
// 一路崩。现在分支内容收进各自的 render，条件成立才建。

const source = `<script>
    let show = $state(false);
</script>

<div>
    {#if show}
        <Foo target={1} />
    {:else}
        <Bar />
    {/if}
</div>
`;

it('builds branch content inside the branch render, not at create', () => {
    const js = compile(source, { filename: 'A.grain' }).js;

    const branch = js.indexOf('__ifBranch$');
    const foo = js.indexOf('Foo.create');
    const bar = js.indexOf('Bar.create');

    expect(branch).toBeGreaterThan(-1);
    expect(foo).toBeGreaterThan(branch);
    expect(bar).toBeGreaterThan(branch);
});

it('caches the branch so toggling does not rebuild the nodes', () => {
    const js = compile(source, { filename: 'A.grain' }).js;

    // `cache[i] ??= render()`：同一分支只建一次
    expect(js).toContain('??=');
    expect(js).toContain('nodes: Array.from');
});
