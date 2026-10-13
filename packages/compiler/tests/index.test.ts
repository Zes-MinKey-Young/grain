/// <reference types="bun" />
import { it, expect } from "bun:test";
import { compile } from "..";

// We use Bun for testing because it is fast and easy to use.
//
// The conditions below are what the generated code has to look like. They are written
// as plain assertions on the output, since the exact numbering (`update$0`, `__list$6`)
// shifts whenever the compiler changes — match on shape, not on a fixed name.

it("should update the template locally", () => {
    // 1. Reactive code is generated anywhere the reactive variable is modified —
    //    a normal function, a destructuring assignment, an arrow-function, it makes
    //    no difference.
    // 2. Only one row of the #for is updated, because only a[0] changed.
    // 3. The update is called with ?.() so it stays safe before the updater exists.
    const result = compile(`<script>
        let a = $state([0, 114]);

        function fn1() {
            a[0] = 1;
        }

        function fn() {
            [a[0]] = [1];
        }

        function fn2() {
            [a[0], a[1]] = [a[1], a[0]]
        }

        </script>
        {#for it of a}
            <div>{it}</div>
        {/for}
        `);

    // (2) both writes turned into the precise "replace that one row" call,
    // not into a refresh of the whole block
    expect(result.js.match(/setAt\(0, 1\)/g)).toHaveLength(2);

    // fn2 是**同时**写两个位置的交换：两个 setAt 顺序执行的话，第二个会读到第一个
    // 已经覆盖掉的值。所以它得走批量调用（setRows），两个值也都得在赋值之前求好
    expect(result.js).toMatch(/setRows\(\[\[0, __value\$\d+\], \[1, __value\$\d+\]\]\)/);
    expect(result.js).toMatch(/const __value\$\d+ = a\[0\];\s*\n\s*const __value\$\d+ = a\[1\];/);

    // nothing refreshes the whole fragment — that would defeat the point
    expect(result.js).not.toMatch(/update\$\d+\?\.\(/);

    // (3) optional call + hoisted declaration, so calling it early is a no-op
    expect(result.js).toMatch(/__list\$\d+\?\.setAt\(0, 1\)/);
    expect(result.js).toMatch(/var __list\$\d+ = creList\(/);
    expect(result.js).toMatch(/var update\$\d+ = creFragment\(/);
})

it("should use the same value for update function", () => {
    // Should assign { name: "Jane" } to a local variable first, rather than
    // repeating the expression in the generated code.
    const result = compile(`<script>
        let a = $state([{ name: "John" }]);

        function fn() {
            a.push({ name: "Jane" });
        }

        </script>
        {#for it of a}
            <div>{it.name}</div>
        {/for}
    `);

    // the object literal appears exactly once
    expect(result.js.match(/\{ name: "Jane" \}/g)).toHaveLength(1);

    // and both the original call and the precise one use the same local
    const named = /const (__value\$\d+) = \{ name: "Jane" \};/.exec(result.js);

    expect(named).not.toBeNull();

    const value = named![1];

    expect(result.js).toContain(`a.push(${value});`);

    // `$` 在正则里是行尾锚，变量名里的那个要转义
    expect(result.js).toMatch(new RegExp(`__list\\$\\d+\\?\\.push\\(${value.replace("$", "\\$")}\\);`));
})
