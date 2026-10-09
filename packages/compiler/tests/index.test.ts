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
        let a = $state([0]);

        function fn1() {
            a[0] = 1;
        }

        function fn() {
            [a[0]] = [1];
        }

        </script>
        {#for it of a}
            <div>{it}</div>
        {/for}
        `);

    // (2) both writes turned into the precise "replace that one row" call,
    // not into a refresh of the whole block
    expect(result.js.match(/set_at\(0, 1\)/g)).toHaveLength(2);

    // nothing refreshes the whole fragment — that would defeat the point
    expect(result.js).not.toMatch(/update\$\d+\?\.\(/);

    // (3) optional call + hoisted declaration, so calling it early is a no-op
    expect(result.js).toMatch(/__list\$\d+\?\.set_at\(0, 1\)/);
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
