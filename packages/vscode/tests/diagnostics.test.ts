/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { analyze } from '../src/analysis.js';

it('a loop variable is not shadowed by a same-named local in a function', () => {
    // `collectAll` 会把函数里的局部声明也收进来，于是 `song` 被认为"已经有了"、
    // 不补 `declare let song` —— 而模板里的 `{song.name}` 就没声明了
    const source = `<script>
    let songs = $state([{ name: 'a' }]);

    function pick() {
        let song = 'local';

        return song;
    }
</script>
{#for [idx, song] of songs}
    <p>{song.name}</p>
{/for}`;

    expect(analyze(source, 'App.grain').semantic()).toEqual([]);
});

it('a loop variable is not shadowed by a local inside <script onmount>', () => {
    const source = `<script>
    let songs = $state([{ name: 'a' }]);
</script>
{#for [idx, song] of songs}
    <p>{song.name}</p>
{/for}

<script onmount>
    for (let i = 0; i < 3; i += 1) {
        let song = 'local';
    }
</script>`;

    expect(analyze(source, 'App.grain').semantic()).toEqual([]);
});

it('a bind:this variable is not reported as used before assignment', () => {
    // 那次赋值是运行时做的（`"this": ($el) => { canvas = $el; }`），虚拟文件里体现不出来
    const source = `<script>
    let canvas;

    function draw() {
        canvas.getContext('2d');
    }
</script>
<canvas bind:this={canvas}></canvas>`;

    expect(analyze(source, 'App.grain').semantic()).toEqual([]);
});

it('a typed bind:this variable works the same way', () => {
    const source = `<script>
    let canvas: HTMLCanvasElement;

    function draw() {
        canvas.getContext('2d');
    }
</script>
<canvas bind:this={canvas}></canvas>`;

    expect(analyze(source, 'App.grain').semantic()).toEqual([]);
});

/**
 * 已知问题（没在测试里，写在这儿提醒）：
 *
 * `<script onmount>` 里声明了跟循环变量**同名**的局部变量时（Player 就是：
 * `{#for [idx, song] of songs.entries()}` + onmount 里 `const song = songs[i]`），
 * 虚拟文件里那个 `const song` 是顶层的，跟补在末尾的 `declare let song: any;` 撞上 ——
 * TS 报 "Block-scoped variable 'song' used before its declaration."（`declare let`
 * 有 TDZ，而模板里的用法在前面）。
 *
 * 产物本身没问题：onmount 的内容在 `create()` 作用域里、循环变量在 `render()` 里，
 * 两者不相干。纯粹是虚拟文件的铺法造成的。
 *
 * 试过 `declare var`（无 TDZ）—— 不解决问题，报错来自 onmount 内部那两个引用。
 */
