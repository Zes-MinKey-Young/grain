/// <reference types="bun" />
import { it, expect } from 'bun:test';

// `vscode` 替身由 packages/vscode/package.json 的 file: 依赖提供（tests/fake-vscode）
import { analyze } from '../src/analysis.js';

/**
 * `bind:this` 的规矩：
 *
 * - 绑的变量在**元素事件监听器**里能用
 * - 模板里别的地方（箭头函数、`bind:` 的 get/set）也要用，就往 `<script>` 里写
 *   `let box: HTMLXxxElement;` —— 编译器复用那个声明只赋值，扩展也不该再报错
 */

const SOURCE = `<script>
    let box: HTMLInputElement;
    let count = $state(0);

    function onFocus() {
        box.focus();
        count += 1;
    }
</script>
<input bind:this={box} />
<button onclick={onFocus}>focus</button>
`;

it('a variable declared in <script> is not reported as used before assignment', () => {
    // 虚拟文件里 `bind:this={box}` 被铺成 `(box);`（读取），而 script 里那句
    // `let box: HTMLInputElement;` 没有初始化器 —— TS 的 definite assignment 是
    // 流敏感的，会报 "used before being assigned"。修法是在 script 之后插一句初始化。
    const problems = analyze(SOURCE, 'App.grain').semantic();

    expect(problems).toEqual([]);
});

it('the variable keeps its element type', () => {
    const analysis = analyze(SOURCE, 'App.grain');

    // `bind:this={box}` 里那个 box：是变量，不是要绑的函数
    const at = SOURCE.indexOf('bind:this={box}') + 'bind:this={'.length;
    const info = analysis.quickInfo(at);

    expect(info?.text.replace(/\s+/g, ' ')).toBe('let box: HTMLInputElement');
});

it('reading it through the element resolves the members', () => {
    const analysis = analyze(SOURCE, 'App.grain');

    // box.focus() 里的 focus：类型推对了才看得见这个方法（HTMLInputElement 继承来的）
    const at = SOURCE.indexOf('box.focus()') + 'box.'.length;
    const info = analysis.quickInfo(at);

    expect(info?.text).toContain('focus');
});

it('a bind:this that declares its own variable still works', () => {
    // script 里没声明：由 bind:this 自己声明，只能用在 onmount 里
    const source = `<div bind:this={box}></div>

<script onmount>
    box.focus();
</script>
`;

    expect(analyze(source, 'App.grain').semantic()).toEqual([]);
});

it('using a self-declared variable outside onmount is reported', () => {
    const source = `<script>
    function peek() {
        return box;
    }
</script>
<div bind:this={box}></div>
<button onclick={peek}>peek</button>`;

    const problems = analyze(source, 'App.grain').semantic();

    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('can only be used inside');
});
