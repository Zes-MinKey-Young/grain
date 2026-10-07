import type { TSESTree } from '@typescript-eslint/typescript-estree';

// 这个包标了 `__esModule` 却没有 default 导出，所以只能具名导入：
// 默认导入在 CJS 下拿到的是 undefined（扩展就是 CJS 编译的）
import { simpleTraverse } from '@typescript-eslint/typescript-estree';

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
 * `get`：跟 `set` 一个语义——**提供一个函数**，不是提供一个值。
 *
 * 想绑一个变量直接用简略形式（`bind:value={count}`），那个才是"值"的写法。
 * 这里要么写 `() => ...`（无参数），要么给一个现成的函数。
 */
function check_get(get: Expression): void {
    const node = get.content;

    if (!is_function_like(node)) {
        // 不是函数字面量，那就得是个能当 getter 使的东西（`get: read_count`）
        if (is_callable(node)) return;

        fail(get, '`get` must be a function with no parameters — write `get: () => ...`');
    }

    if (node.params.length !== 0) {
        fail(get, '`get` takes no parameters — write `get: () => ...`');
    }
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

    fail(
        set,
        `\`set\` must take exactly one parameter (the new value) — write \`set: (value) => ...\`; got ${node.params.length}`
    );
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
            fail(
                listen,
                '`listen` must take exactly one parameter (the update callback) — write `listen: (update) => ...`'
            );
        }

        return;
    }

    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'listen') {
        fail(listen, '`listen` must be either `(update) => ...` or `listen(eventBus, "eventName")`');
    }

    const args = node.arguments;

    if (args.some((argument) => argument.type === 'SpreadElement')) {
        fail(listen, '`listen(...)` does not support spread arguments');
    }

    if (args.length < 2 || args.length > 3) {
        fail(
        listen,
        '`listen(...)` takes two or three arguments: `listen(eventBus, "eventName")` — the predicate is optional'
    );
    }

    const event = args[1];

    if (event.type !== 'Literal' || typeof event.value !== 'string') {
        fail(
        listen,
        'The second argument of `listen` must be a string literal with the event name, e.g. `listen(bus, "tick")`'
    );
    }

    const guard = args[2];

    if (guard && !is_callable(guard)) {
        fail(
        listen,
        'The third argument of `listen` is a predicate and must be a function: `listen(bus, "tick", (ev) => ...)`'
    );
    }
}

/**
 * 没有 `get`（也没有值形式的表达式）时，值只能由 listener 提供：
 * 它得调 `update(新值)`，运行时把新值存下来当 getter 的结果。
 *
 * 所以两种写法要挡住：
 * - 压根没写 `listen` —— 这个绑定没有任何值来源
 * - `listen(bus, "tick")` 简写 —— 展开后是 `update()`，拿不到新值
 */
function check_listen_supplies_value(binding: BindingValue): void {
    const listen = binding.listen;

    if (!listen) {
        const at = binding.set ?? binding.expression;

        if (at) fail(at, '`get` is required unless you also write `listen` — the listener is the only source of the value');

        return;
    }

    const node = listen.content;

    if (!is_function_like(node)) {
        fail(
            listen,
            'Without `get`, `listen` must be written by hand — `listen(eventBus, "eventName")` expands to `update()` and cannot supply the new value. Write `listen: (update) => ...` and call `update(newValue)`'
        );
    }

    const param = node.params[0];
    const name = param?.type === 'Identifier' ? param.name : null;

    if (!name) return;

    let supplied = false;
    let passed = false;

    simpleTraverse(node.body as unknown as TSESTree.Node, {
        enter: (child, parent) => {
            if (child.type !== 'Identifier' || child.name !== name) return;

            const call = parent as TSESTree.CallExpression | undefined;

            // `update(newValue)` —— 直接给出值
            if (call?.type === 'CallExpression' && call.callee === child) {
                if (call.arguments.length > 0) supplied = true;

                return;
            }

            // `something.subscribe(update)` —— 把 update 交出去，对方会带值调它
            passed = true;
        }
    });

    if (!supplied && !passed) {
        fail(
            listen,
            `\`get\` is missing, so the value must come from the listener: call \`${name}(newValue)\`, not \`${name}()\``
        );
    }
}

function check_binding(binding: BindingValue): void {
    if (binding.get) check_get(binding.get);
    if (binding.set) check_set(binding.set);
    if (binding.listen) check_listen(binding.listen);

    if (!binding.get && !binding.expression) check_listen_supplies_value(binding);
}

/**
 * `bind:this`：不硬性限定写法。
 *
 * 写标识符（且不是函数）时变量由它声明；其余一律当"挂上时调用"的表达式。
 * 到底能不能用交给编辑器里的 TS 验（可调用性 / 参数类型 / 能不能赋值），
 * 这里只挡一眼就看得出是错的写法——字面量。
 */
function check_this(item: Expression): void {
    const node = item.content;

    if (node.type !== 'Literal' && node.type !== 'TemplateLiteral') return;

    fail(
        item,
        '`bind:this` takes either a variable name (which it declares) or something callable that receives the element'
    );
}

function is_binding(value: string | Expression | BindingValue): value is BindingValue {
    return typeof value === 'object' && value !== null && !('type' in value);
}

function check_value(key: string, value: AttributeValue | true): void {
    if (value === true || typeof value === 'string') return;

    if (Array.isArray(value)) return;

    if (is_binding(value)) {
        // `bind:this` 不是读写对，单独按"变量 or 回调"查
        if (key === 'bind:this') {
            if (value.expression) check_this(value.expression);

            return;
        }

        check_binding(value);
    }
}

/**
 * 解析完之后检查一遍 `bind:value={ ... }`：三个函数各是什么形状。
 *
 * 放在解析之后而不是解析之中，是因为要看 TS 解析出来的 AST（参数个数之类）。
 */
export function check_bindings(root: Root): void {
    const visit = (nodes: TemplateNode[]): void => {
        for (const node of nodes) {
            // 模板插值里的绑定值（`{ get: ..., listen: ... }`）——没有 type 字段的那个
            if (!('type' in node)) {
                check_binding(node);

                continue;
            }

            switch (node.type) {
                case 'element':
                    for (const [key, value] of Object.entries(node.attributes)) check_value(key, value);
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
