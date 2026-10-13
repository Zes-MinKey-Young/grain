/**
 * TS 解析 + 遍历。
 *
 * 之前用 `@typescript-eslint/typescript-estree`（带着一堆 Node 侧依赖，bundle 不进浏览器），
 * 现在换成 `oxc-parser`：Rust 写的解析器，npm 包有**专门的浏览器入口**
 * （`browser: './src-js/wasm.js'`，WASM 版），Node 和浏览器都能跑。
 *
 * 它的 AST 基本就是 estree，只有两处要补：
 *
 * - 位置给的是 `start` / `end` 两个数字，estree 是 `range: [start, end]` —— 编译器到处
 *   都是 `node.range`，所以解析完走一遍补上
 * - 解析错误放在返回值的 `errors` 数组里，不抛异常。按 `range` 排个序，取第一个抛出去
 *
 * 字面量本来就是 `Literal`（带 `value` / `raw`），不用像 babel 那样合并。
 *
 * `@typescript-eslint/typescript-estree` 现在只作为**类型**来源（`TSESTree`）——
 * `import type` 会被擦掉，不进 bundle。
 */
import { parseSync } from 'oxc-parser';

export type { TSESTree } from '@typescript-eslint/typescript-estree';
import type { TSESTree } from '@typescript-eslint/typescript-estree';

/** 随便一个节点：类型由 `TSESTree` 那边管，这里只做运行时的活 */
type AnyNode = Record<string, any>;

/** 不是子节点的字段，遍历时跳过（`parent` 会成环，位置是数字） */
const SKIP_KEYS = new Set([
    'parent',
    'loc',
    'start',
    'end',
    'range',
    'extra',
    'leadingComments',
    'trailingComments',
    'innerComments',
    'comments',
    'tokens',
    'errors',
    'directives'
]);

/**
 * 给每个节点补 `range`。
 *
 * oxc 给的是 `start` / `end`，estree 用 `range: [start, end]` —— 编译器（和它生成的
 * 编辑）全靠 `range` 定位，所以解析完走一遍补上。
 */
function addRanges(node: AnyNode): void {
    if (typeof node.start === 'number' && typeof node.end === 'number' && !node.range) {
        node.range = [node.start, node.end];
    }

    for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue;

        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item === 'object' && typeof item.type === 'string') addRanges(item);
            }
        } else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') {
            addRanges(value as AnyNode);
        }
    }
}

/** oxc 的错误项：带 `message` 和一个 `range`（或 `loc`） */
type OxcError = { message?: string; range?: [number, number]; start?: number };

/**
 * oxc 把错误放在 `errors` 里而不是抛。挑第一个（位置最靠前的）抛出去，并尽量把区间
 * 挂到 error 上 —— `errorRange` 会去读 `location.start.offset`，这里直接用 oxc 的
 * `range` 补成同样形状，调用方就不用改。
 */
function throwErrors(errors: OxcError[] | undefined, fallback: [number, number]): void {
    if (!errors || errors.length === 0) return;

    const sorted = [...errors].sort((a, b) => (a.range?.[0] ?? a.start ?? 0) - (b.range?.[0] ?? b.start ?? 0));
    const first = sorted[0];
    const range = first.range ?? fallback;

    const error = new Error(first.message ?? 'parse error') as Error & {
        location?: { start: { offset: number }; end: { offset: number } };
    };

    error.location = {
        start: { offset: range[0] },
        end: { offset: Math.max(range[1], range[0] + 1) }
    };

    throw error;
}

/**
 * 解析一段 TS。
 *
 * 签名（含选项）刻意跟 `@typescript-eslint/typescript-estree` 的 `parse` 保持一致，
 * 调用点不用改。`fallback` 用来在拿不到错误位置时兜底。
 */
export function parse(
    code: string,
    options?: { comment?: boolean; jsx?: boolean; loc?: boolean; range?: boolean }
): TSESTree.Program {
    // 解析失败时的兜底区间：整个片段。调用点会把它缩到出错的那一段
    const fallback: [number, number] = [0, Math.max(code.length, 1)];

    const result = parseSync('grain.ts', code, { sourceType: 'module' });

    throwErrors(result.errors as OxcError[] | undefined, fallback);

    const program = result.program as AnyNode;

    addRanges(program);

    // estree 的 Program 上有 `comments`；oxc 挂在返回值上
    if (result.comments) program.comments = result.comments;

    void options;

    return program as unknown as TSESTree.Program;
}

/**
 * 深度优先遍历，进 / 出各回调一次。
 *
 * 对应 `@typescript-eslint/typescript-estree` 的 `simpleTraverse`：`visitor.enter` 收到
 * `(node, parent)`。**不**把 parent 写到节点上（免得序列化时成环）。
 */
export function simpleTraverse(
    node: unknown,
    visitor: {
        enter?(node: TSESTree.Node, parent: TSESTree.Node | undefined): void;
        leave?(node: TSESTree.Node, parent: TSESTree.Node | undefined): void;
    }
): void {
    const walk = (current: unknown, parent: AnyNode | undefined): void => {
        if (!current || typeof current !== 'object') return;
        if (typeof (current as AnyNode).type !== 'string') return;

        const any = current as AnyNode;

        visitor.enter?.(any as unknown as TSESTree.Node, parent as unknown as TSESTree.Node | undefined);

        for (const [key, value] of Object.entries(any)) {
            if (SKIP_KEYS.has(key)) continue;

            if (Array.isArray(value)) {
                for (const item of value) walk(item, any);
            } else if (value && typeof value === 'object') {
                walk(value, any);
            }
        }

        visitor.leave?.(any as unknown as TSESTree.Node, parent as unknown as TSESTree.Node | undefined);
    };

    walk(node, undefined);
}
