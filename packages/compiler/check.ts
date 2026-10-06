import type { TSESTree } from '@typescript-eslint/typescript-estree';

import { ParseError } from './errors.js';
import type { AttributeValue, BindingValue, Expression, Root, TemplateNode } from './types.js';

type FunctionLike = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

function is_function_like(node: TSESTree.Node): node is FunctionLike {
    return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}

/** 引用一个现成的函数也算谓词：`listen(bus, "tick", is_tick)` */
function is_callable(node: TSESTree.Node): boolean {
    return is_function_like(node) || node.type === 'Identifier' || node.type === 'MemberExpression';
}

function fail(item: Expression, message: string): never {
    throw new ParseError(message, item.contentStart, item.contentEnd);
}

/**
 * `get`：`() => ...`（无参数）。
 *
 * 也可以直接写一个表达式（`get: count`）—— 产物里包成 `() => (count)`，
 * 依赖照样能算出来，所以只拦"写了参数"这种明显不对的写法。
 */
function check_get(get: Expression): void {
    const node = get.content;

    if (!is_function_like(node) || node.params.length === 0) return;

    fail(get, '`get` 不接受参数，写成 `get: () => ...`');
}

/**
 * `set`：`(value) => ...`（正好一个参数，就是新值）。
 *
 * 不是函数时当成一个可调用的 setter（`set: do_set`），产物里展开成 `do_set($value)`。
 */
function check_set(set: Expression): void {
    const node = set.content;

    if (!is_function_like(node)) return;

    if (node.params.length === 1) return;

    fail(set, `\`set\` 必须正好一个参数（新值），写成 \`set: (value) => ...\`；现在有 ${node.params.length} 个`);
}

/**
 * `listen`：两种写法。
 *
 * - `(update) => { ... }` —— 正好一个参数，运行时把 `update` 传进来
 * - `listen(事件总线, "事件名")` —— 展开成挂事件监听；**谓词可省**，
 *   省了就是恒真（事件来了就 update）；要过滤就加第三个参数
 */
function check_listen(listen: Expression): void {
    const node = listen.content;

    if (is_function_like(node)) {
        if (node.params.length !== 1) {
            fail(listen, '`listen` 必须正好一个参数（update 回调），写成 `listen: (update) => ...`');
        }

        return;
    }

    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'listen') {
        fail(listen, '`listen` 要么是 `(update) => ...`，要么是 `listen(事件总线, "事件名")`');
    }

    const args = node.arguments;

    if (args.some((argument) => argument.type === 'SpreadElement')) {
        fail(listen, '`listen(...)` 不支持展开参数');
    }

    if (args.length < 2 || args.length > 3) {
        fail(listen, '`listen(...)` 要两个或三个参数：`listen(事件总线, "事件名")`，谓词可省');
    }

    const event = args[1];

    if (event.type !== 'Literal' || typeof event.value !== 'string') {
        fail(listen, '`listen` 的第二个参数必须是事件名的字符串字面量，比如 `listen(bus, "tick")`');
    }

    const guard = args[2];

    if (guard && !is_callable(guard)) {
        fail(listen, '`listen` 的第三个参数是谓词，得是个函数：`listen(bus, "tick", (ev) => ...)`');
    }
}

function check_binding(binding: BindingValue): void {
    if (binding.get) check_get(binding.get);
    if (binding.set) check_set(binding.set);
    if (binding.listen) check_listen(binding.listen);
}

function is_binding(value: string | Expression | BindingValue): value is BindingValue {
    return typeof value === 'object' && value !== null && !('type' in value);
}

function check_value(value: AttributeValue | true): void {
    if (value === true || typeof value === 'string') return;

    if (Array.isArray(value)) return;
    if (is_binding(value)) check_binding(value);
}

/**
 * 解析完之后检查一遍 `bind:value={ ... }`：三个函数各是什么形状。
 *
 * 放在解析之后而不是解析之中，是因为要看 TS 解析出来的 AST（参数个数之类）。
 */
export function check_bindings(root: Root): void {
    const visit = (nodes: TemplateNode[]): void => {
        for (const node of nodes) {
            switch (node.type) {
                case 'element':
                    for (const value of Object.values(node.attributes)) check_value(value);
                    visit(node.children);
                    break;

                case 'IfBlock':
                    visit(node.children);
                    for (const alternate of node.alternates) visit(alternate.children);
                    break;

                case 'ForBlock':
                    visit(node.children);
                    if (node.fallback) visit(node.fallback.children);
                    break;
            }
        }
    };

    visit(root.template.children);
}
