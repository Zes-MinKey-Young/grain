/// <reference types="bun" />
import { it, expect } from 'bun:test';

import { compile } from '..';

// 组件里同时有 `$bindable` 和 `<script onmount>` 时：
// `script()` 处理 onmount 会重新赋值 `bindables` / `propNames`，而 onmount 里
// 没有 `$props()` —— 于是它们被清空，产物用了 `toBinding` 却没 import
// （页面上是 `ReferenceError: toBinding is not defined`）。

const source = `<script>
    let { value = $bindable(0), other } = $props<{ value?: number; other?: string }>();
</script>

<script onmount>
    value = 1;
</script>

<div>{value}{other}</div>
`;

it('imports toBinding when the component also has an onmount block', () => {
    const js = compile(source, { filename: 'A.grain' }).js;

    expect(js).toContain('toBinding');
    expect(js).toMatch(/import \{[^}]*toBinding[^}]*\} from/);
});

it('still knows the props in setProps', () => {
    const js = compile(source, { filename: 'A.grain' }).js;

    // `other` 是普通 prop：setProps 里要被重新赋值
    expect(js).toMatch(/setProps = \(\$props, \$children\) => \{/);
    expect(js).toContain('$props["other"]');
});
