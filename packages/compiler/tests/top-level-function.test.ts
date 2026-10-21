/// <reference types="bun" />
import { it, expect } from 'bun:test';
import { compile } from '..';

// 顶层函数写了 state，就得生成刷新调用。以前只认 `function f() {}`，
// `const f = () => {}` 被漏掉 —— Player 的 App.grain 就是这么坏的：
// `const onAudioEnded = () => { currentSongIndex++; ... }` 里没有任何刷新。

it('a top-level arrow function that writes state gets the refresh calls', () => {
    const js = compile(`<script>
    let index = $state(0);
    let songs = $state(['a', 'b']);

    const onEnded = () => {
        index++;
        if (index >= songs.length) index = 0;
    };
</script>
<audio onended={onEnded}></audio>
<p>{index}</p>
{#for song of songs}
    <span>{song}</span>
{/for}`, { filename: 'App.grain' }).js;

    // 函数被包装过（有"改之前的值"守卫）
    expect(js).toMatch(/function onEnded\(\)/);
    expect(js).toMatch(/(?:const|let) __prev\$\d+ = index;/);

    // 末尾追加了刷新调用
    expect(js).toMatch(/if \(index !== __prev\$\d+\) \{[\s\S]*update\$\d+\?\.\(\d+\)/);
});

it('a function expression assigned to a const works too', () => {
    const js = compile(`<script>
    let count = $state(0);

    const bump = function () {
        count += 1;
    };
</script>
<button onclick={bump}>{count}</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/function bump\(\)/);
    expect(js).toMatch(/update\$\d+\?\.\(\d+\)/);
});

it('a function declaration still works', () => {
    const js = compile(`<script>
    let count = $state(0);

    function bump() {
        count += 1;
    }
</script>
<button onclick={bump}>{count}</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/function bump\(\)/);
    expect(js).toMatch(/update\$\d+\?\.\(\d+\)/);
});

it('an arrow function that writes nothing is left alone', () => {
    const js = compile(`<script>
    let count = $state(0);

    const peek = () => count;
</script>
<button onclick={peek}>{count}</button>`, { filename: 'App.grain' }).js;

    // 只读不写：不包装（包装了反而多一层调用）
    expect(js).not.toMatch(/function peek\(\)/);
});
