/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { compile } from '..';

// `$node(...)` 的参数有两种读法：一句表达式，或者"绑定值"（`get:` / `set:` / `listen:`）。
// 后者以前必须写成 `$node({ ... })`。但宏展开出来正好是成员，写成 `$node($read(name))`
// 才是 TS 语法上合法的，所以花括号现在可以省。

it('reads a lone expression as the value form', () => {
    const js = compile(
        `<script>
    let count = $state(0);
    const doubled = $node(count * 2);
</script>
<p>{doubled}</p>`,
        { filename: 'A.grain' }
    ).js;

    expect(js).toContain('get: () => (count * 2)');
});

it('reads an object literal as the binding form', () => {
    const js = compile(
        `<script>
    let count = $state(0);
    const doubled = $node({ get: () => count * 2 });
</script>
<p>{doubled}</p>`,
        { filename: 'A.grain' }
    ).js;

    expect(js).toContain('get: () => count * 2');
});

it('accepts a macro without braces', () => {
    const js = compile(
        `<script>
    const pushed = $node($read(name));
</script>
<p>{pushed}</p>`,
        { filename: 'A.grain' }
    ).js;

    // 宏已经展开，产物里不该再有 `$read`
    expect(js).not.toContain('$read');
    expect(js).toContain('subscribe');
});

it('accepts a macro without braces in <script module>', () => {
    const js = compile(
        `<script module>
    const pushed = $node($read(name));
</script>
<p>{pushed}</p>`,
        { filename: 'A.grain' }
    ).js;

    expect(js).not.toContain('$read');
    expect(js).toMatch(/const __node\$\d+ = \{ listen: /);
    expect(js).toMatch(/__node\$\d+\.listen\?\.\(\(value\) => \{ pushed = value; \}\);/);
});

it('finds the argument even when the call has type arguments', () => {
    const js = compile(
        `<script>
    const pushed = $node<string | null>($read(name));
</script>
<p>{pushed}</p>`,
        { filename: 'A.grain' }
    ).js;

    // 从参数区间切，别从 `$node` 之后切 —— 否则 `<string | null>` 会混进绑定值里
    expect(js).not.toContain('$read');
    expect(js).not.toContain('string | null>(');
    expect(js).toContain('subscribe');
});

it('still rejects `$node` with more than one argument', () => {
    expect(() =>
        compile(
            `<script>
    const a = $node(get: () => 1, listen: () => {});
</script>
<p>{a}</p>`,
            { filename: 'A.grain' }
        )
    ).toThrow();
});
