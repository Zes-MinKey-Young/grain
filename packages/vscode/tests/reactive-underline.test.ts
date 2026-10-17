/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { analyze } from '../src/analysis.js';

/**
 * 响应式变量的下划线（`stateReferences`）—— 画在哪、不画在哪。
 *
 * 这个结果直接喂给 `paintReactive` 的 `setDecorations`，位置错了会在编辑器里
 * 画到别的字上。
 */

/** 这些位置上的文本，按顺序 */
function marked(source: string): string[] {
    return analyze(source, 'App.grain')
        .stateReferences()
        .map((r) => source.slice(r.start, r.end));
}

it('a plain $state variable', () => {
    const source = `<script>
    let count = $state(0);
</script>
<p>{count}</p>`;

    // 声明处 + 模板里的引用
    expect(marked(source)).toEqual(['count', 'count']);
});

it('a type annotation is not part of the underline', () => {
    // oxc 的 `id.range` 连类型注解一起包（`typed: Foo`），装饰会多画一截
    for (const declaration of [
        'let a: Foo = $state({ x: 1 });',
        'let a: number[] = $state([1], 2);',
        'let a: string | null = $state(null);',
        'let a: number = $state<number>(0);'
    ]) {
        const source = `<script>
    interface Foo { x: number }
    ${declaration}
</script>
<p>{a}</p>`;

        expect(marked(source)).toEqual(['a', 'a']);
    }
});

it('a $state with a type argument still gets underlined', () => {
    const source = `<script>
    let a = $state<number>(0);
</script>
<p>{a}</p>`;

    expect(marked(source)).toEqual(['a', 'a']);
});

it('an inner binding that shadows the name is not underlined', () => {
    // 函数参数 / 块里的 let 是另一个变量，跟响应式那个没关系
    const cases = [
        'function show(count) {\n        return count;\n    }',
        'const show = (count) => count;',
        'for (let count = 0; count < 3; count++) {}',
        'function outer() {\n        const count = 5;\n\n        return count;\n    }'
    ];

    for (const body of cases) {
        const source = `<script>
    let count = $state(0);

    ${body}
</script>
<p>{count}</p>`;

        expect(marked(source)).toEqual(['count', 'count']);
    }
});

it('a derived local is underlined as well', () => {
    const source = `<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }], 2);

    function pick() {
        const second = arr[1];

        second.name = 'B';
    }
</script>
<p>{arr[0].name}</p>`;

    const found = marked(source);

    expect(found).toContain('second');
    expect(found).toContain('arr');
});

it('a property name is not underlined', () => {
    const source = `<script>
    let count = $state({ total: 1 });
</script>
<p>{count.total}</p>`;

    // `count` 两次；`total` 是属性名，不算
    expect(marked(source)).toEqual(['count', 'count']);
});

it('text inside a string is not underlined', () => {
    // 模板表达式区域以前是拿正则扫的，于是 `onclick={() => console.log("audio time to: " + x)}`
    // 里那句话中的 `time` 也被当成响应式变量的引用画了下划线。
    // 现在优先走 AST —— 字符串字面量和模板字符串的文本部分都不产出 Identifier
    const source = `<script>
    let time = $state('');
    let value = $state(0);
</script>
<button onclick={() => { console.log("Setting audio time to: " + value); }}>go</button>
<span>{time}</span>`;

    // 字符串文本里的 `time` 不算；`value` 是声明 + onclick 里读取，两处都算
    expect(marked(source)).toEqual(['time', 'value', 'value', 'time']);
});

it('a template literal inside a handler is not scanned as text', () => {
    const source = `<script>
    let time = $state('');
    let audio: HTMLAudioElement;
    let progress: HTMLElement;
    let progressVal = $state(0);
</script>
<progress value={progressVal} onclick={(e) => {
    const ratio = (e.clientX - 0) / 1;

    audio.currentTime = audio.duration * ratio;
    console.log(\`Setting audio time to: \${audio.currentTime} (ratio: \${ratio * 100}%)\`);
}}></progress>
<span>{time}</span>`;

    const found = marked(source);

    // `time` 两次（声明 + 插值）、`progressVal` 两次；模板串里的 `time`、
    // `audio.currentTime` 的属性名、`ratio`、`audio.duration` 都不算
    expect(found).toEqual(['time', 'progressVal', 'progressVal', 'time']);
});

it('the offset is not doubled for template expressions', () => {
    // 表达式节点的 range 就是源码绝对偏移，再加一次 contentStart 会飞出文件末尾
    // （表现是插值那个位置 slice 出来是空串，装饰画到空气上）
    const source = `<script>
    let count = $state(0);
</script>
<p>{count}</p>`;

    const found = analyze(source, 'App.grain').stateReferences();

    for (const reference of found) {
        expect(source.slice(reference.start, reference.end)).toBe('count');
    }
});
