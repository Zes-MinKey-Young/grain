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
        'let a: number[] = $state([1]);',
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
    let arr = $state([{ name: 'a' }, { name: 'b' }]);

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
