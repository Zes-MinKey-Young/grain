/// <reference types="bun" />
import { it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

import { analyze } from '../src/analysis.js';

/**
 * KNOWN ISSUE (kept as a note, not a test):
 *
 * When `<script onmount>` declares a local with the same name as a loop variable
 * (Player does: `{#for [idx, song] of songs.entries()}` + onmount has
 * `const song = songs[i]`), that `const song` lands at the top level of the
 * virtual file and collides with the `declare let song: any;` we append at the
 * end. TS then reports "Block-scoped variable 'song' used before its
 * declaration." (`declare let` has a TDZ and the template uses come first.)
 *
 * The emitted code is fine - onmount lives in `create()`, the loop variable in
 * `render()`, they never meet. It is purely an artifact of how the virtual file
 * is laid out.
 *
 * Tried `declare var` (no TDZ): does not fix it, the complaints come from the
 * two references inside onmount itself.
 */

it('a loop variable is not shadowed by a same-named local in a function', () => {
    // `collectAll` collects every level, so a `let song` inside some function made
    // the compiler think the loop variable was already declared - and it never
    // appended `declare let song`, leaving `{song.name}` unresolved
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
    // The assignment happens at runtime (`"this": ($el) => { canvas = $el; }`),
    // so the virtual file cannot show it
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

it('a multi-line handler is separated from the next expression', () => {
    // Without a semicolon after `(...)`, JS reads two adjacent expressions as a
    // CALL: `(() => {...})\n(song.name)` -> "calling that arrow with one argument",
    // which TS reports as "Expected 0 arguments, but got 1." - and the squiggle
    // lands on the *second* expression, so it looks like `{song.name}` is broken.
    // ASI does not save us: a newline is not a trigger, and `)` followed by `(`
    // is legal call syntax.
    const source = `<script>
    let rows = $state([{ id: 7 }]);
    let current = $state(0);
</script>
{#for [i, row] of rows.entries()}
    <div
        class="songitem {current === i ? 'on' : ''}"
        onclick={() => {
            current = i;
        }}
    >
        {row.id}
    </div>
{/for}`;

    expect(analyze(source, 'App.grain').semantic()).toEqual([]);
});

it('a multi-line handler is followed by a semicolon in the virtual file', () => {
    const source = `<script>
    let rows = $state([{ id: 7 }]);
    let current = $state(0);
</script>
{#for [i, row] of rows.entries()}
    <div
        onclick={() => {
            current = i;
        }}
    >
        {row.id}
    </div>
{/for}`;

    const virtual = analyze(source, 'App.grain').virtualText();

    // the arrow function closes with `});` - the semicolon is what keeps the next
    // line from being read as an argument list
    expect(virtual).toContain('});');
});

it('borrow warnings come through the language service too', () => {
    // 跟编译器返回的是同一份：派生过了有效期还在写、非 const 派生
    const source = `<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }]);

    function drop() {
        const second = arr[1];

        arr = [arr[0]];
        second.name = 'B';
    }
</script>
<p>{arr[0].name}</p>`;

    const found = analyze(source, 'App.grain').semantic();
    const borrow = found.filter((problem) => problem.message.includes('no longer reactive'));

    expect(borrow).toHaveLength(1);
    // 位置对着最后那句 `second.name = 'B'`
    expect(source.slice(borrow[0].start, borrow[0].end)).toContain("second.name = 'B'");
});

it('a non-const borrow is flagged by the language service', () => {
    const source = `<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }]);

    function f() {
        let second = arr[1];

        second.name = 'B';
    }
</script>
<p>{arr[0].name}</p>`;

    const found = analyze(source, 'App.grain').semantic();

    expect(found.map((problem) => problem.message).join(' ')).toContain('is not `const`');
});

it('the player app (when this repo sits next to it) has no diagnostics', () => {
    const file = 'D:/zes/VSCode/Player/frontend/src/App.grain';

    if (!existsSync(file)) return;

    const problems = analyze(readFileSync(file, 'utf8'), 'App.grain').semantic();

    expect(problems.map((problem) => problem.message)).toEqual([]);
});
