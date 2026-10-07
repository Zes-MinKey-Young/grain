// 这个包标了 `__esModule` 却没有 default 导出，所以只能具名导入：
// 默认导入在 CJS 下拿到的是 undefined（扩展就是 CJS 编译的）
import { parse as parse_ts, simpleTraverse } from '@typescript-eslint/typescript-estree';
import type { TSESTree } from '@typescript-eslint/typescript-estree';

import { ParseError } from './errors.js';
import type { MacroReparse } from './macro.js';
import type { NodeDecl, RawBindingValue, Root, Script } from './types.js';

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
 * @param root 解析好的组件（宏展开之后）
 * @param source SFC 源码，用来取各段的原文
 * @param reparse 绑定值的重新解析（由 parser 注入）
 * @returns 每个 `$node` 声明一条；没有就返回空数组
 */
export function find_nodes(root: Root, source: string, reparse: MacroReparse): NodeDecl[] {
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

                    found.push(read_node(item.id.name, init, statement, source, reparse));
                }
            }

            // 单独一句 `$node(...)` 没意义
            if (statement.type === 'ExpressionStatement') {
                simpleTraverse(statement.expression, {
                    enter: (node) => {
                        if (is_node_call(node)) {
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

function is_node_call(node: TSESTree.Node): boolean {
    return (
        node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === '$node'
    );
}

function read_node(
    name: string,
    call: TSESTree.CallExpression,
    statement: TSESTree.Node,
    source: string,
    reparse: MacroReparse
): NodeDecl {
    if (call.arguments.length !== 1) {
        throw new ParseError(
            '`$node` takes exactly one argument — a binding value or an expression',
            call.range[0],
            call.range[1]
        );
    }

    const [argument] = call.arguments;

    if (argument.type === 'SpreadElement') {
        throw new ParseError('`$node` does not take spread arguments', call.range[0], call.range[1]);
    }

    // 纯表达式：`$node(count * 2)` —— 等价于 `{ get: () => count * 2 }`
    if (argument.type !== 'ObjectExpression') {
        return {
            name,
            statement: [statement.range[0], statement.range[1]],
            get: `() => (${source.slice(argument.range[0], argument.range[1])})`,
            set: null,
            listen: null,
            active: false
        };
    }

    const raw = source.slice(argument.range[0], argument.range[1]);

    // 去掉最外层的花括号，剩下的交给绑定值解析器读
    const inner = raw.slice(1, -1);

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
    const source_of = (item: typeof get): string | null => (item ? item.raw : null);

    const getter = source_of(get);

    return {
        name,
        statement: [statement.range[0], statement.range[1]],
        // 变量形式（`{count}`）补成 getter；`get:` 写什么就是什么
        get: get === expression && expression ? `() => (${source_of(expression)})` : getter,
        set: source_of(set),
        listen: source_of(listen),
        active: binding.active
    };
}

/** 一段表达式源码 -> AST（用来算它读了哪些变量） */
export function parse_inline(code: string): TSESTree.Expression {
    const program = parse_ts(`(${code})`, { loc: true, range: true });
    const first = program.body[0];

    if (!first || first.type !== 'ExpressionStatement') {
        throw new Error(`not an expression: ${code}`);
    }

    return first.expression;
}

/** 声明语句所在的块（用来判断该往哪儿放生成的代码） */
export function block_of(block: Script, statement: [number, number]): boolean {
    return statement[0] >= block.contentStart && statement[1] <= block.contentEnd;
}
