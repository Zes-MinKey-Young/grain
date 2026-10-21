/// <reference types="bun" />
import { it, expect } from 'bun:test';
import { compile } from '..';

// 容器方法的参数会被提取成 `const __value$N = ...`。当这个调用本身就是某条语句的
// 单语句体（`if (x) arr.push(y)`）时，声明会被塞进那个没有花括号的体里，
// 产出「Lexical declaration cannot appear in a single-statement context」的语法错误。

it('a mutation inside a single-statement if gets braces', () => {
    const js = compile(`<script>
    let logs: string[] = $state([]);

    function push(message: string) {
        logs.push(\`\${message} 1\`);

        if (logs.length > 200) logs.splice(0, logs.length - 200);
    }
</script>
{#for line of logs}
    <p>{line}</p>
{/for}
<button onclick={() => push('x')}>go</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/if \(logs\.length > 200\) \{\s*const __value\$\d+ = logs\.length - 200;\s*logs\.splice\(0, __value\$\d+\);/);
    // 不能把声明留在单语句体里
    expect(js).not.toMatch(/if \(logs\.length > 200\)\s*\n\s*const /);
});

it('a mutation inside a loop body gets braces too', () => {
    const js = compile(`<script>
    let items: string[] = $state([]);

    function fill(n: number, tag: string) {
        for (let i = 0; i < n; i++) items.push(tag + i);
    }
</script>
{#for item of items}
    <p>{item}</p>
{/for}
<button onclick={() => fill(3, 'x')}>go</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/for \(let i = 0; i < n; i\+\+\) \{\s*const __value\$\d+ = tag \+ i;\s*items\.push\(__value\$\d+\);/);
    expect(js).not.toMatch(/for \(let i = 0; i < n; i\+\+\)\s*\n\s*const /);
});

it('a mutation after else gets braces', () => {
    const js = compile(`<script>
    let items: string[] = $state([]);

    function trim(keep: boolean) {
        if (keep) return;
        else items.splice(0, items.length - 1);
    }
</script>
{#for item of items}
    <p>{item}</p>
{/for}
<button onclick={() => trim(false)}>go</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/else \{\s*const __value\$\d+ = items\.length - 1;\s*items\.splice\(0, __value\$\d+\);/);
});

it('a normal statement still inlines the declaration', () => {
    const js = compile(`<script>
    let items: string[] = $state([]);

    function add(a: number, b: number) {
        items.push(a + b);
    }
</script>
{#for item of items}
    <p>{item}</p>
{/for}
<button onclick={() => add(1, 2)}>go</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/const __value\$\d+ = a \+ b;\s*items\.push\(__value\$\d+\);/);
    expect(js).not.toMatch(/\{ const __value\$\d+ = a \+ b;\s*items\.push/);
});
