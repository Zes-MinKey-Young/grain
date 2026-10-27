/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { compile } from '..';

// `<script module>` 以前是原样发射的：里面的 `$state(...)` / `$node(...)` 会活到产物里，
// 运行时直接 ReferenceError。现在它走 moduleScript()，按"没有组件实例"的语义落地。

it('expands $state to a plain module-level variable', () => {
    const js = compile(
        `<script module>
    let shared = $state(0);
</script>
<p>hi</p>`,
        { filename: 'A.grain' }
    ).js;

    expect(js).toContain('let shared = 0;');
    expect(js).not.toContain('$state');
});

it('turns a module-level $node into a self-subscribing variable', () => {
    const js = compile(
        `<script module>
    const current = $node({ get: () => source.get(), listen: (update) => source.subscribe(update) });
</script>
<p>{current}</p>`,
        { filename: 'A.grain' }
    ).js;

    // 读写对留在模块顶层
    expect(js).toMatch(/const __node\$\d+ = \{ get: \(\) => source\.get\(\), listen: \(update\) => source\.subscribe\(update\) \};/);
    // 变量 + 自订阅（模块级没有片段可刷，所以只重新取值）
    expect(js).toMatch(/let current = __node\$\d+\.get\(\);/);
    expect(js).toMatch(/__node\$\d+\.listen\?\.\(\(value\) => \{ current = __node\$\d+\.get\(\); \}\);/);
    expect(js).not.toContain('$node');
});

it('rejects $props inside <script module>', () => {
    expect(() =>
        compile(
            `<script module>
    const { name } = $props();
</script>
<p>hi</p>`,
            { filename: 'A.grain' }
        )
    ).toThrow(/nothing to bind to in <script module>/);
});

it('keeps exports and imports of the module script at module scope', () => {
    const js = compile(
        `<script module>
    import { Op } from 'kipphi';

    export function helper() {
        return 1;
    }
</script>
<p>hi</p>`,
        { filename: 'A.grain' }
    ).js;

    expect(js).toContain(`import { Op } from 'kipphi';`);
    expect(js).toContain('export function helper()');
});
