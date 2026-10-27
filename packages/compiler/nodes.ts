// 解析走 babel（能在浏览器里跑），类型仍从 typescript-estree 拿 —— 类型是编译期的，
// 打包时会擦掉
import { parse as parseTs, simpleTraverse } from './ast.js';
import type { TSESTree } from './ast.js';

import { ParseError } from './errors.js';
import type { MacroReparse } from './macro.js';
import type { MacroReplacement, NodeDecl, RawBindingValue, Root, Script } from './types.js';
import { applyEdits } from './utils.js';

/**
 * 找出 `<script>` 里的 `$node(...)`：一个派生节点。
 *
 * 参数按**绑定值**的语法读（跟属性 / 模板插值那套一样，不是 TS 对象字面量）：
 *
 * - 有 `set` 就是双向，没有就是单向（写入单向的是编译错误）
 * - `get` 可以缺——缺了就由 `listen` 提供值（`subscribe` 会立刻回调当前值）
 * - `active` 得写成 `active: true`，这样参数才是一句合法的 TS
 *
 * 纯编译期：产物里不会留下这个对象，只有一对 getter/setter 和重算函数。
 *
 * @example 只读（派生）
 * ```grain
 * let count = $state(0);
 * const doubled = $node({ get: () => count * 2 });
 * ```
 *
 * @example 纯表达式，等价于上面
 * ```grain
 * const tripled = $node(count * 3);
 * ```
 *
 * @example 双向
 * ```grain
 * const shown = $node({ get: () => name.get(), set: (v) => name.set(v) });
 *
 * function rename() {
 *     shown = 'bob';      // 走 setter
 * }
 * ```
 *
 * @example 值由 listen 推（源是 store 时常用）
 * ```grain
 * const pushed = $node({ listen: (update) => name.subscribe(update) });
 * ```
 *
 * @example 派生 + 订阅，源是 store
 * ```grain
 * const upper = $node({
 *     get: () => name.get().toUpperCase(),
 *     listen: (update) => name.subscribe(update),
 *     active: true
 * });
 * ```
 *
 * @example 花括号可以省掉：参数里出现"成员"（`get:` / `set:` / `listen:`）时，
 * 整串参数就当作绑定值读；`$read(...)` / `$store(...)` 展开出来正好是成员
 * ```grain
 * const pushed = $node($read(name));          // 等价于 { listen: (update) => name.subscribe(update) }
 * const bound = $node($store(name));          // 等价于 { get: ..., set: ... }
 * ```
 *
 * @param root 解析好的组件（宏展开之后）
 * @param source SFC 源码，用来取各段的原文
 * @param reparse 绑定值的重新解析（由 parser 注入）
 * @returns 每个 `$node` 声明一条；没有就返回空数组
 */
export function findNodes(root: Root, source: string, reparse: MacroReparse): NodeDecl[] {
    const found: NodeDecl[] = [];

    for (const block of [root.script, root.module]) {
        if (!block) continue;

        for (const statement of block.content.body) {
            if (statement.type === 'VariableDeclaration') {
                for (const item of statement.declarations) {
                    const init = item.init;

                    if (item.id.type !== 'Identifier' || !init) continue;
                    if (init.type !== 'CallExpression') continue;
                    if (init.callee.type !== 'Identifier' || init.callee.name !== '$node') continue;

                    found.push(readNode(item.id.name, init, statement, source, reparse, root.replacements));
                }
            }

            // 单独一句 `$node(...)` 没意义
            if (statement.type === 'ExpressionStatement') {
                simpleTraverse(statement.expression, {
                    enter: (node) => {
                        if (isNodeCall(node)) {
                            throw new ParseError(
                                '`$node` only makes sense as a declaration, for example `const doubled = $node({ get: () => count * 2 })`',
                                node.range[0],
                                node.range[1]
                            );
                        }
                    }
                });
            }
        }
    }

    return found;
}

function isNodeCall(node: TSESTree.Node): boolean {
    return (
        node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === '$node'
    );
}

function readNode(
    name: string,
    call: TSESTree.CallExpression,
    statement: TSESTree.Node,
    source: string,
    reparse: MacroReparse,
    replacements: MacroReplacement[]
): NodeDecl {
    if (call.arguments.length !== 1) {
        throw new ParseError(
            '`$node` takes exactly one argument — a binding value (braces optional) or an expression',
            call.range[0],
            call.range[1]
        );
    }

    const [argument] = call.arguments;

    if (argument.type === 'SpreadElement') {
        throw new ParseError('`$node` does not take spread arguments', call.range[0], call.range[1]);
    }

    const object = argument.type === 'ObjectExpression';

    // 取参数原文：写成 `{ ... }` 的去掉最外层花括号，其余原样。
    // 这里必须把宏展开也套上 —— `$node($read(name))` 里 `$read(...)` 展开出来就是
    // `listen: (update) => name.subscribe(update)`，正好是绑定值的一个成员，
    // 所以花括号可以省掉（TS 那边它只是一句普通的调用，语法上是合法的）。
    //
    // 区间取参数的，不取 `$node(` 之后的：`$node<T>(...)` 里 callee 结束于 `$node`，
    // 从那儿切会把 `<T>` 也切进来。
    const from = object ? argument.range[0] + 1 : argument.range[0];
    const to = object ? argument.range[1] - 1 : argument.range[1];

    const inner = applyEdits(
        source.slice(from, to),
        replacements.filter((item) => item.start >= from && item.end <= to),
        from
    );

    let binding: RawBindingValue;

    try {
        binding = reparse.binding(inner, undefined);
    } catch (error) {
        throw new ParseError(
            `Could not read \`$node\`'s binding value: ${error instanceof Error ? error.message : String(error)}`,
            argument.range[0],
            argument.range[1]
        );
    }

    const expression = binding.expression;
    const get = binding.get ?? expression;
    const set = binding.set;
    const listen = binding.listen;

    if (!get && !listen) {
        throw new ParseError(
            '`$node` needs a `get`, or a `listen` to supply the value',
            argument.range[0],
            argument.range[1]
        );
    }

    // 注意用项的 `raw`（重新读出来的那段文本），不是它的偏移——
    // 那些偏移是相对传给 reparse 的文本的，拿来切源码会错位
    const sourceOf = (item: typeof get): string | null => (item ? item.raw : null);

    return {
        name,
        statement: [statement.range[0], statement.range[1]],
        // 变量形式（`{count}`）补成 getter；`get:` / `listen:` 写什么就是什么
        get: get === expression && expression ? `() => (${sourceOf(expression)})` : sourceOf(get),
        set: sourceOf(set),
        listen: sourceOf(listen),
        active: binding.active
    };
}

/** 一段表达式源码 -> AST（用来算它读了哪些变量） */
export function parseInline(code: string): TSESTree.Expression {
    const program = parseTs(`(${code})`, { loc: true, range: true });
    const first = program.body[0];

    if (!first || first.type !== 'ExpressionStatement') {
        throw new Error(`not an expression: ${code}`);
    }

    return first.expression;
}

/** 声明语句所在的块（用来判断该往哪儿放生成的代码） */
export function blockOf(block: Script, statement: [number, number]): boolean {
    return statement[0] >= block.contentStart && statement[1] <= block.contentEnd;
}
