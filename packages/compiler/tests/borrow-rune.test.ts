/// <reference types="bun" />
import { it, expect } from 'bun:test';
import { compile } from '..';

/**
 * `$borrow(level)` —— 参数的借用声明。
 *
 * ```ts
 * function rename(item = $borrow(2)) {
 *     item.title = 'done';      // 调用点是 `rename(items[2])`，这一下要刷那一行
 * }
 * ```
 *
 * 函数体不知道自己被哪条路径调用，所以由**调用点**把刷新接进来：函数多一个隐藏参数
 * `__borrow(path)`，函数体写 `item.a.b = v` 就报 `'a.b'`。
 *
 * 这一组只管**函数侧**的产物（剥掉默认值、加隐藏参数、报路径）。调用点那一半还没做。
 */
const js = (source: string): string => compile(source, { filename: 'App.grain' }).js;

it('$borrow is stripped and a hidden reporter is added', () => {
    const out = js(`<script>
    function rename(item = $borrow(2)) {
        item.title = 'done';
    }
</script>
<p>x</p>`);

    // 默认值不该出现在产物里（`$borrow` 运行时不存在）
    expect(out).not.toContain('$borrow');
    // 参数只留名字 + 隐藏的报告函数
    expect(out).toContain('function rename(item, __borrow)');
});

it('nested paths are reported as dotted paths', () => {
    const out = js(`<script>
    function rename(item = $borrow(2)) {
        item.title = 'done';
        item.meta.author = 'me';
    }
</script>
<p>x</p>`);

    expect(out).toContain(`__borrow?.("title")`);
    expect(out).toContain(`__borrow?.("meta.author")`);
});

it('the reporter is optional so it is safe before a call site wires it up', () => {
    // 调用点还没生成刷新函数时，`__borrow` 是 undefined —— 用 `?.` 调用才不会炸
    const out = js(`<script>
    function rename(item = $borrow(2)) {
        item.title = 'done';
    }
</script>
<p>x</p>`);

    expect(out).toContain('__borrow?.(');
});

it('a function with a borrow param is wrapped even without reactive writes', () => {
    // 它自己不写响应式变量（只写参数），别的地方会因此跳过包装 —— 那就没有
    // `__borrow` 可用了
    const out = js(`<script>
    function rename(item = $borrow(2)) {
        item.title = 'done';
    }
</script>
<p>x</p>`);

    expect(out).toContain('__borrow');
});

it('a plain default value is left alone', () => {
    // 只有 `$borrow(...)` 才特殊处理，普通默认值原样保留
    const out = js(`<script>
    function greet(name = 'world') {
        return name;
    }
</script>
<p>{greet()}</p>`);

    expect(out).toContain("function greet(name = 'world')");
});

it('writing the param itself is not reported', () => {
    // `item = {...}` 是改局部变量，跟根上那条路径没关系
    const out = js(`<script>
    function reset(item = $borrow(2)) {
        item = { title: 'x' };
    }
</script>
<p>x</p>`);

    expect(out).not.toContain('__borrow?.(');
});
