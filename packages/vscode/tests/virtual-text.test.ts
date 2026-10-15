/// <reference types="bun" />
import { it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

import { analyze } from '../src/analysis.js';

/**
 * 虚拟文件的位置必须跟源码**一一对应** —— 语义高亮、hover、诊断的位置都靠它。
 *
 * 只能就地替换（等长），不能往中间插东西。插过 `bind:this` 的初始化语句，结果
 * 后面全部后移、语义高亮整体错位（`</script>` 上出现了 JS 的着色）。
 */

it('tags outside the scripts are blank in the virtual file', () => {
    const source = readFileSync('D:/zes/VSCode/Player/frontend/src/App.grain', 'utf8');
    const virtual = analyze(source, 'App.grain').virtualText();

    for (const tag of ['</script>', '<style>']) {
        let at = source.indexOf(tag);

        while (at !== -1) {
            // 源码里是标签，虚拟文件里应该还是同样长度的空白
            expect(virtual.slice(at, at + tag.length).trim()).toBe('');
            expect(virtual.slice(0, at).length).toBe(at);

            at = source.indexOf(tag, at + 1);
        }
    }
});

it('the script bodies are copied in place', () => {
    const source = `<script>
    let count = $state(0);
</script>
<p>{count}</p>`;

    const virtual = analyze(source, 'App.grain').virtualText();

    // script 内容原样落在同样的偏移上
    const body = 'let count = $state(0);';
    const at = source.indexOf(body);

    expect(virtual.slice(at, at + body.length)).toBe(body);

    // 后面的模板区域仍然是空白（`{count}` 会被单独铺进来，标签本身不铺）
    const tag = source.indexOf('</script>');

    expect(virtual.slice(tag, tag + '</script>'.length).trim()).toBe('');
});

it('a derived local that lost its reactivity is not underlined', () => {
    // 借用失效（同一个函数里动了根变量）之后它就不再是响应式的了 —— 别画下划线
    const source = `<script>
    let arr = $state([{ name: 'a' }, { name: 'b' }]);

    function drop() {
        const second = arr[1];

        arr = [arr[0]];
        second.name = 'B';
    }
</script>
<p>{arr[0].name}</p>`;

    const marked = analyze(source, 'App.grain')
        .stateReferences()
        .map((r) => source.slice(r.start, r.end));

    expect(marked).not.toContain('second');
    expect(marked).toContain('arr');
});
