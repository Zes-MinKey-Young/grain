/// <reference types="bun" />
import { it, expect } from 'bun:test';
import { join } from 'node:path';

import { compile } from '..';

// 循环保护按**函数引用**计数（= 实例级），不接受字符串：
// `__refresh$28` 这个名字在每个实例里都一样，按名字计数会把"N 个实例同一帧各跑一次"
// 误判成环（树形判定线一次 sync 就建几十个实例）。

const runtimePath = join(import.meta.dir, '..', '..', 'runtime', 'index.ts').replace(/\\/g, '/');

it('passes the refresh function itself, plus the file for the message', () => {
    const js = compile(`<script>
    let n = $state(0);
    const doubled = $node({ get: () => n * 2 });
</script>
<p>{doubled}</p>`, { filename: 'Foo.grain', dev: true }).js;

    // 第一个参数是函数引用，第二个是文件名
    expect(js).toMatch(/guard\(__refresh\$\d+, "Foo\.grain"\)/);
    // 不能再出现字符串键那种写法
    expect(js).not.toMatch(/guard\("__refresh/);
});

it('counts per function, not per name', async () => {
    const { guard } = await import(runtimePath);

    const a = function __refresh$1() {};
    const b = function __refresh$1() {};

    // 两个"同名"但各自一份的刷新函数，各跑 60 次不该被当成环
    for (let index = 0; index < 60; index += 1) {
        guard(a, 'A.grain');
        guard(b, 'B.grain');
    }

    // 同一个函数连跑 100 次才该抛，并且带上组件名
    let error: Error | null = null;

    try {
        for (let index = 0; index < 100; index += 1) guard(a, 'A.grain');
    } catch (thrown) {
        error = thrown as Error;
    }

    expect(error).not.toBeNull();
    expect(error!.message).toContain('A.grain');
    expect(error!.message).toContain('__refresh$1');
});
