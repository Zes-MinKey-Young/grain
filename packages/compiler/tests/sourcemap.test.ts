/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { compile } from '..';

// 没有 map 的时候，DevTools 里打开 `.grain` 看到的是"编译后的代码"，行号也全错。
// 现在按行对齐产出一份 sourcemap：来自源码的行映射回去，生成的行留空。

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 只解我们产的那种：每行最多一段 `[列, 源序号, 源码行, 源码列]` */
function decode(mappings: string): Array<number | null> {
    const result: Array<number | null> = [];

    let sourceLine = 0;

    for (const group of mappings.split(';')) {
        if (!group) {
            result.push(null);

            continue;
        }

        const fields = decodeVlq(group.split(',')[0]!);

        sourceLine += fields[2] ?? 0;
        result.push(sourceLine);
    }

    return result;
}

function decodeVlq(segment: string): number[] {
    const values: number[] = [];

    let rest = 0;
    let shift = 0;

    for (const char of segment) {
        const digit = BASE64.indexOf(char);
        if (digit === -1) break;

        rest += (digit & 0b11111) << shift;

        if (digit & 0b100000) {
            shift += 5;

            continue;
        }

        values.push(rest & 1 ? -(rest >>> 1) : rest >>> 1);
        rest = 0;
        shift = 0;
    }

    return values;
}

const source = `<script>
    let count = $state(0);

    function bump() {
        count += 1;
    }
</script>

<button onclick={bump}>{count}</button>
`;

it('points back at the .grain file', () => {
    const result = compile(source, { filename: 'A.grain' });
    const map = result.map!;

    expect(map.version).toBe(3);
    expect(map.sources).toEqual(['A.grain']);
    expect(map.sourcesContent).toEqual([source]);
});

it('maps a script line to its original line', () => {
    const result = compile(source, { filename: 'A.grain' });
    const lines = result.js.split('\n');
    const original = source.split('\n');

    const mapped = decode(result.map!.mappings);

    expect(mapped.length).toBe(lines.length);

    const generatedIndex = lines.findIndex((line) => line.includes('count += 1'));
    const sourceIndex = original.findIndex((line) => line.includes('count += 1'));

    expect(generatedIndex).toBeGreaterThan(-1);
    expect(mapped[generatedIndex]).toBe(sourceIndex);
});

it('carries the last known line onto generated code', () => {
    const result = compile(source, { filename: 'A.grain' });
    const lines = result.js.split('\n');
    const mapped = decode(result.map!.mappings);

    // 模板生成的建树代码源码里没有对应行，沿用上一处已知源码行
    const generatedIndex = lines.findIndex((line) => line.includes('creEle('));

    expect(generatedIndex).toBeGreaterThan(-1);
    expect(typeof mapped[generatedIndex]).toBe('number');
});

it('covers every generated line', () => {
    const result = compile(source, { filename: 'A.grain' });
    const mapped = decode(result.map!.mappings);

    // 一行都不空着：空映射会让 DevTools 退回显示编译后的模块
    expect(mapped.every((line) => typeof line === 'number')).toBe(true);
});

it('handles a component without a script', () => {
    const result = compile(`<p>hello</p>`, { filename: 'B.grain' });

    expect(result.map).not.toBe(null);
    expect(result.map!.mappings.split(';').length).toBe(result.js.split('\n').length);
});
