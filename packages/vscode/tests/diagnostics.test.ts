/// <reference types="bun" />
import { it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

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

it('Player 的 App.grain（如果在本机）应该没有诊断', () => {
    const file = 'D:/zes/VSCode/Player/frontend/src/App.grain';

    if (!existsSync(file)) return;

    const problems = analyze(readFileSync(file, 'utf8'), 'App.grain').semantic();

    expect(problems.map((p) => p.message)).toEqual([]);
});
