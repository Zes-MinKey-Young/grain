/// <reference types="bun" />
import { it, expect } from 'bun:test';
import { compile } from '..';

// 刷新调用只改 DOM，**画到屏幕上还得等当前这个任务跑完**。
// 所以 async 函数里挂起之前，得先把已经改过的状态刷出去 —— 不然用户看到的就是
// "卡住 → 最后跳到 100%"（录制进度条就是这么坏的）。

const FLUSH = /if \(status !== __prev\$\d+\) \{[\s\S]*?\}\s*__prev\$\d+ = status;/g;

it('每个 await 之前都刷一次', () => {
    const js = compile(`<script>
    let status = $state('idle');

    async function load() {
        status = 'loading';
        await Promise.resolve();
        status = 'working';
        await Promise.resolve();
        status = 'done';
    }
</script>
<p>{status}</p><button onclick={() => void load()}>go</button>`, { filename: 'App.grain' }).js;

    // 两次挂起各一次 + 末尾一次
    expect(js.match(FLUSH) ?? []).toHaveLength(3);

    // 刷新的位置必须在 await **之前**，挂起之后才刷就晚了
    expect(js).toMatch(/\}\s*__prev\$\d+ = status;\s*await Promise\.resolve\(\);/);
});

it('没有 await 的函数只在末尾刷一次', () => {
    const js = compile(`<script>
    let status = $state('idle');

    function load() {
        status = 'loading';
        status = 'done';
    }
</script>
<p>{status}</p><button onclick={load}>go</button>`, { filename: 'App.grain' }).js;

    expect(js.match(FLUSH) ?? []).toHaveLength(1);
});

it('嵌套函数里的 await 不算在这一层', () => {
    const js = compile(`<script>
    let status = $state('idle');

    async function outer() {
        status = 'outer';
        await Promise.resolve();
        // 这个回调自己的 await 由它自己的包装负责
        Promise.resolve().then(async () => {
            status = 'inner';
            await Promise.resolve();
        });
    }
</script>
<p>{status}</p><button onclick={() => void outer()}>go</button>`, { filename: 'App.grain' }).js;

    // 外层：await 前一次 + 末尾一次。
    // 内层那个 async 回调不算 —— 它是外层函数体里的嵌套函数，跟着外层的守卫走
    // （顶层的匿名回调才会被单独包装，见 callback-and-async.test.ts）
    expect(js.match(FLUSH) ?? []).toHaveLength(2);
});
