import { Window } from 'happy-dom';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compile } from '../index.ts';

const runtimePath = join(import.meta.dir, '..', '..', 'runtime', 'index.ts');

const window = new Window();
const globals = globalThis as unknown as Record<string, unknown>;

for (const name of ['document', 'Node', 'window', 'MouseEvent']) {
    globals[name] = (window as unknown as Record<string, unknown>)[name];
}

let counter = 0;

/**
 * 编译 + 挂载。
 *
 * 产物写到**系统临时目录**并随即删掉：写进测试目录的话，`bunfig` 的 test root 是
 * `packages`，那些文件会被扫进去（堆积起来之后每次全量测试都要多扫上千个文件），
 * `tsc` 也会去啃它们。
 */
async function mount(source: string): Promise<Element> {
    const result = compile(source, { filename: 'App.grain', runtimeModule: runtimePath });
    const file = join(tmpdir(), `grain-untrack-${(counter += 1)}-${Math.random().toString(36).slice(2)}.ts`);

    await Bun.write(file, result.js);

    const module = (await import(file)) as { default: (target: Element) => void };
    const target = window.document.createElement('div');

    document.body.appendChild(target);
    module.default(target);

    try {
        rmSync(file, { force: true });
    } catch {
        // 删不掉无所谓，它在临时目录里
    }

    return target;
}

const names = (target: Element): string[] =>
    [...target.querySelectorAll('span')].map((node) => node.textContent);

/** 提示 + 错误都算 */
const messages = (source: string): string[] => {
    const result = compile(source, { filename: 'App.grain' });

    return [...result.warnings, ...result.errors].map((problem) => problem.message);
};

const BASE = `<script>
    let count = $state(0);
    let total = $state(10);
</script>
{#if total > 0}
    <span>{$untrack(count) + '/' + total}</span>
{/if}
<button id="count" onclick={() => { count += 1; }}>count</button>
<button id="total" onclick={() => { total += 1; }}>total</button>`;

it('$untrack drops the dependency but keeps the rest', async () => {
    // `count` 被 untrack 了：改它不刷。`total` 照旧
    const target = await mount(BASE);

    expect(names(target)).toEqual(['0/10']);

    (target.querySelector('#count') as HTMLElement).click();
    expect(names(target)).toEqual(['0/10']); // ← 没刷

    (target.querySelector('#total') as HTMLElement).click();
    expect(names(target)).toEqual(['1/11']); // ← 刷了，而且读到的是 count 的新值
});

it('$untrack does not survive into the output', () => {
    const js = compile(BASE, { filename: 'App.grain' }).js;

    expect(js).not.toContain('$untrack');
});

it('it works inside a $node getter', async () => {
    // 注意：`$node` 刷新时会重新赋值这个变量，所以得用 `let`（`const` 会抛）
    const target = await mount(`<script>
    let count = $state(0);
    let items = $state([{ n: 1 }, { n: 2 }]);

    let label = $node({ get: () => \`\${$untrack(count)} of \${items.length}\` });
</script>
<span>{label}</span>
<button id="count" onclick={() => { count += 1; }}>count</button>
<button id="push" onclick={() => { items.push({ n: 3 }); }}>push</button>`);

    expect(names(target)).toEqual(['0 of 2']);

    (target.querySelector('#count') as HTMLElement).click();
    expect(names(target)).toEqual(['0 of 2']);

    (target.querySelector('#push') as HTMLElement).click();
    expect(names(target)).toEqual(['1 of 3']);
});

it('it works inside an {#if} test', () => {
    // 条件里 untrack 的那个不参与重判
    const js = compile(`<script>
    let flag = $state(true);
    let other = $state(1);
</script>
{#if other > 0 && $untrack(flag)}
    <p>yes</p>
{:else}
    <p>no</p>
{/if}
<button onclick={() => { flag = false; }}>flip</button>`, { filename: 'App.grain' }).js;

    expect(js).not.toContain('$untrack');
});

it('it works in an attribute value', () => {
    const js = compile(`<script>
    let count = $state(0);
    let total = $state(1);
</script>
<span title={\`\${$untrack(count)}-\${total}\`}>x</span>`, { filename: 'App.grain' }).js;

    expect(js).not.toContain('$untrack');
});

it('it works inside <script> and a handler body', () => {
    const js = compile(`<script>
    let count = $state(0);
    let plain = 3;

    const shown = $untrack(count) + plain;

    function bump() {
        count += 1;
    }
</script>
<span>{shown}</span>
<button onclick={() => { console.log($untrack(count)); }}>log</button>`, {
        filename: 'App.grain'
    }).js;

    expect(js).not.toContain('$untrack');
});

it('nested $untrack is stripped all the way down', () => {
    const js = compile(`<script>
    let count = $state(0);
</script>
<span>{$untrack($untrack(count))}</span>`, { filename: 'App.grain' }).js;

    expect(js).not.toContain('$untrack');
});

it('parens and strings inside the argument survive', () => {
    // 括号配对 + 字符串感知：`Math.max(1, 2)` 的括号、字符串里的括号都不能数错
    const js = compile(`<script>
    let count = $state(0);
</script>
<span>{$untrack(Math.max(1, 2)) + '(' + count + ')'}</span>`, { filename: 'App.grain' }).js;

    expect(js).not.toContain('$untrack');
    expect(js).toContain('Math.max(1, 2)');
});

it('a template literal inside the argument is handled', () => {
    const js = compile(`<script>
    let count = $state(0);
</script>
<span>{$untrack(\`a\${count}b\`)}</span>`, { filename: 'App.grain' }).js;

    expect(js).not.toContain('$untrack');
});

// --------------------------------------------------------------------------- 警告

it('wrapping nothing reactive is flagged', () => {
    const found = messages(`<script>
    let plain = 3;
</script>
<span>{$untrack(plain + 1)}</span>`);

    expect(found.join(' ')).toContain('wraps nothing reactive');
});

it('wrapping a literal is flagged', () => {
    expect(messages(`<span>{$untrack(1 + 2)}</span>`).join(' ')).toContain('wraps nothing reactive');
});

it('wrapping a $state is not flagged', () => {
    expect(
        messages(`<script>
    let count = $state(0);
</script>
<span>{$untrack(count)}</span>`)
    ).toEqual([]);
});

it('a store read is flagged (it was never a dependency)', () => {
    // store 的读取本来就不产生编译期依赖 —— untrack 它没有意义
    expect(
        messages(`<script>
    import { counter } from './counter';
</script>
<span>{$untrack(counter.get())}</span>`).join(' ')
    ).toContain('wraps nothing reactive');
});

it('the flag points at the call', () => {
    const source = `<script>
    let plain = 3;
</script>
<span>{$untrack(plain)}</span>`;

    const found = compile(source, { filename: 'App.grain' }).warnings;
    const hit = found.find((problem) => problem.message.includes('wraps nothing reactive'));

    expect(source.slice(hit!.start, hit!.end)).toBe('$untrack(plain)');
});

it('the warning also comes out of <script>', () => {
    expect(
        messages(`<script>
    let plain = 3;

    const shown = $untrack(plain);
</script>
<span>{shown}</span>`).join(' ')
    ).toContain('wraps nothing reactive');
});
