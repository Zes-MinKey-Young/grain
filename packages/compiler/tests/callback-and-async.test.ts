/// <reference types="bun" />
import { it, expect } from 'bun:test';
import { compile } from '..';

// 两个曾经漏掉的形状：
//
// 1. `async function f() { ... }` 包装时会被重建成普通函数，`async` 丢了，
//    函数体里的 `await` 于是变成语法错误（rolldown 直接报 PARSE_ERROR）
// 2. 顶层语句里**内联**的回调（`.then(x => { status = ... })`）没有被分析，
//    写入改得到值、但没有刷新调用，UI 永远停在初始值

it('an async top-level function keeps its async keyword', () => {
    const js = compile(`<script>
    let status = $state('idle');

    async function load() {
        const value = await Promise.resolve('done');
        status = value;
    }
</script>
<p>{status}</p>
<button onclick={load}>go</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/const load = async function load\(/);
    // 包装照旧生效：先存旧值，末尾比对后刷新
    expect(js).toMatch(/(?:const|let) __prev\$\d+ = status;/);
    expect(js).toMatch(/if \(status !== __prev\$\d+\) \{[\s\S]*update\$\d+\?\.\(\d+\)/);
});

it('an async arrow keeps async too', () => {
    const js = compile(`<script>
    let n = $state(0);

    const bump = async () => {
        n = await Promise.resolve(n + 1);
    };
</script>
<p>{n}</p><button onclick={bump}>go</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/async function bump\(/);
});

it('writes inside an inline callback get the refresh calls', () => {
    const js = compile(`<script>
    let status = $state('idle');

    Promise.resolve('done').then(value => {
        status = value;
    });
</script>
<p>{status}</p>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/\.then\(\(?value\)? => \{/);
    expect(js).toMatch(/(?:const|let) __prev\$\d+ = status;/);
    expect(js).toMatch(/if \(status !== __prev\$\d+\) \{[\s\S]*update\$\d+\?\.\(\d+\)/);
});

it('a callback inside a named function gets its own guard', () => {
    const js = compile(`<script>
    let n = $state(0);

    function start() {
        Promise.resolve(1).then(value => {
            n = value;
        });
    }
</script>
<p>{n}</p><button onclick={start}>go</button>`, { filename: 'App.grain' }).js;

    // 两份快照：外层函数一份，回调自己一份。
    //
    // 光靠外层那份不够 —— `.then(...)` 的回调在**外层返回之后**才跑，外层比旧值时
    // `n` 还没变，那次刷新就白等（OptionBox 点开不显示就是这个）。两份都在的话，
    // 回调跑完自己那份会刷新；外层那份提前刷一次只是多余，不影响正确性。
    expect(js.match(/let __prev\$\d+ = n;/g) ?? []).toHaveLength(2);
});

it('a callback that writes nothing is left alone', () => {
    const js = compile(`<script>
    let n = $state(0);

    function start() {
        n++;
    }

    Promise.resolve(1).then(value => {
        console.log(value);
    });
</script>
<p>{n}</p><button onclick={start}>go</button>`, { filename: 'App.grain' }).js;

    expect(js).toMatch(/\.then\(\(?value\)? => \{\s*console\.log\(value\);\s*\}\)/);
});
