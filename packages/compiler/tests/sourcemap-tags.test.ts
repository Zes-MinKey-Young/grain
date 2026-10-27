/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { compile } from '..';

// 模板那部分代码是生成的，源码里没有一模一样的一行。这里靠 tag 名对齐：
// 产物里的 `creEle("button"` 找源码里下一个 `<button`，那一行就是它的来源。

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decode(mappings: string): Array<number | null> {
    const result: Array<number | null> = [];

    let sourceLine = 0;

    for (const group of mappings.split(';')) {
        if (!group) {
            result.push(null);

            continue;
        }

        const segment = group.split(',')[0]!;
        const values: number[] = [];

        let rest = 0;
        let shift = 0;

        for (const char of segment) {
            const digit = BASE64.indexOf(char);
            if (digit === -1) break;

            rest += (digit & 31) << shift;

            if (digit & 32) {
                shift += 5;

                continue;
            }

            values.push(rest & 1 ? -(rest >>> 1) : rest >>> 1);
            rest = 0;
            shift = 0;
        }

        sourceLine += values[2] ?? 0;
        result.push(sourceLine);
    }

    return result;
}

const source = `<script>
    let count = $state(0);
</script>

<div class="box">
    <button onclick={() => count++}>+</button>
    <span>{count}</span>
</div>
`;

it('maps a generated element to its own tag line', () => {
    const result = compile(source, { filename: 'A.grain' });
    const lines = result.js.split('\n');
    const mapped = decode(result.map!.mappings);
    const original = source.split('\n');

    const generatedIndex = lines.findIndex((line) => line.includes('creEle("button"'));
    const buttonLine = original.findIndex((line) => line.trim().startsWith('<button'));

    expect(generatedIndex).toBeGreaterThan(-1);
    expect(buttonLine).toBeGreaterThan(-1);
    expect(mapped[generatedIndex]).toBe(buttonLine);
});

it('keeps template code out of the script lines', () => {
    const result = compile(source, { filename: 'A.grain' });
    const lines = result.js.split('\n');
    const mapped = decode(result.map!.mappings);

    // 建树代码不该被算到 `let count = $state(0)` 那一行上
    const stateLine = source.split('\n').findIndex((line) => line.includes('$state(0)'));

    for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes('creEle(')) continue;

        expect(mapped[index]).not.toBe(stateLine);
    }
});
