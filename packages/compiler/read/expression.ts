// 这个包标了 `__esModule` 却没有 default 导出，所以只能具名导入：
// 默认导入在 CJS 下拿到的是 undefined（扩展就是 CJS 编译的）
import { parse as parse_ts } from '@typescript-eslint/typescript-estree';

import { ParseError } from '../errors.js';
import type {
    BindingValue,
    Expression,
    ForBlock,
    RawAttributeValue,
    RawBindingValue,
    RawExpression,
    RawForBlock,
    RawTemplateNode,
    Template,
    TSExpression,
    TSForOf,
    TSProgram
} from '../types.js';
import { TS_OPTIONS } from './script.js';
import { error_range } from '../utils.js';

/**
 * 把一个 `{ ... }` 表达式交给 typescript-estree 解析。
 *
 * 和 `<script>` 一样用 `masked` 前缀对齐位置，解析出来的是 ESTree 的
 * Expression 节点（Identifier / CallExpression / BinaryExpression ...）。
 */
export function parse_expression(node: RawExpression, masked: string): TSExpression {
    // 把源码里那个 `{` 换成 `(`、末尾补 `)`，内容就一定是"表达式"而不是语句或块。
    // 只改了花括号本身，所以表达式内部每个字符的偏移一点没变，位置仍然对齐整个 SFC。
    const code = masked.slice(0, node.contentStart - 1) + '(' + node.raw + ')';

    let program: TSProgram;

    try {
        program = parse_ts(code, TS_OPTIONS);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const [start, end] = error_range(error, [node.contentStart, node.contentEnd]);

        throw new ParseError(`Failed to parse expression \`{${node.raw}}\`: ${message}`, start, end);
    }

    const statement = program.body[0];

    if (program.body.length !== 1 || !statement || statement.type !== 'ExpressionStatement') {
        throw new ParseError(
            `\`{${node.raw}}\` must contain exactly one expression`,
            node.contentStart,
            node.contentEnd
        );
    }

    return statement.expression;
}

/** 绑定值没有 `type` 字段，表达式有 */
function is_binding(value: RawAttributeValue): value is RawBindingValue {
    return typeof value === 'object' && value !== null && !('type' in value);
}

/**
 * 解析绑定值里的一项（`get` / `set` / `listen` / 变量）。
 *
 * 这些片段不裹在 `{ ... }` 里，所以能直接按源码解析，偏移一个字符都不动。
 * 只有对象字面量（以 `{` 开头）得包一层括号，否则会被当成块语句。
 */
export function parse_snippet(node: RawExpression, masked: string, label: string): TSExpression {
    const raw = node.raw;
    const wrap = raw.trimStart().startsWith('{');
    const code = masked.slice(0, node.contentStart) + (wrap ? `(${raw})` : raw);

    let program: TSProgram;

    try {
        program = parse_ts(code, TS_OPTIONS);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const [start, end] = error_range(error, [node.contentStart, node.contentEnd]);

        throw new ParseError(`Failed to parse ${label} \`${raw}\`: ${message}`, start, end);
    }

    const statement = program.body[0];

    if (program.body.length !== 1 || !statement || statement.type !== 'ExpressionStatement') {
        throw new ParseError(`${label} \`${raw}\` must be an expression`, node.contentStart, node.contentEnd);
    }

    return statement.expression;
}

/**
 * 把 `{#for item of list}` 的循环头交给 TS 解析。
 *
 * 循环头不带圆括号，所以拼一条完整的 for-of 语句：`for (` 写在 contentStart **前面**
 * 那段空白上，`)` 写在 contentEnd 上，`;` 写在后面第一个空白处。
 * 这样循环变量和可迭代对象的偏移一个字符都不动，拿到的 `left` / `right` 直接对齐整个 SFC。
 */
export function parse_for_of(node: RawForBlock, masked: string): TSForOf {
    const prefix = 'for (';
    const from = node.contentStart - prefix.length;

    if (from < 0 || masked.slice(from, node.contentStart) !== ' '.repeat(prefix.length)) {
        throw new ParseError(
            `No room for \`for (\` before the loop head \`{${node.raw}}\` — leave a space after \`{#for\``,
            node.contentStart,
            node.contentEnd
        );
    }

    let code = masked.slice(0, from) + prefix + node.raw + ')' + masked.slice(node.contentEnd + 1);

    // 语句体：往后找第一个空白放个 `;`（`)` 和体之间隔着换行也没关系）
    let at = node.contentEnd + 1;
    while (at < code.length && (code[at] === '\n' || code[at] === '\r')) at += 1;

    code = at < code.length ? `${code.slice(0, at)};${code.slice(at + 1)}` : `${code};`;

    let program: TSProgram;

    try {
        program = parse_ts(code, TS_OPTIONS);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const [start, end] = error_range(error, [node.contentStart, node.contentEnd]);

        throw new ParseError(`Failed to parse the loop head \`${node.raw}\`: ${message}`, start, end);
    }

    const statement = program.body[0];

    if (program.body.length !== 1 || !statement || statement.type !== 'ForOfStatement') {
        throw new ParseError(
            `\`{${node.raw}}\` must be \`binding of iterable\``,
            node.contentStart,
            node.contentEnd
        );
    }

    return statement;
}

/**
 * 第二阶段：遍历模板，把里面所有表达式（含属性值、逻辑块的）解析成 TS AST。
 *
 * 原地填充 `content`，所以第一阶段和第二阶段共用同一棵树。
 */
export function parse_expressions(template: Template<RawTemplateNode>, masked: string): void {
    function visit_chunk(chunk: string | RawExpression): void {
        if (typeof chunk === 'string') return;
        (chunk as Expression).content = parse_expression(chunk, masked);
    }

    function visit_value(value: RawAttributeValue | true): void {
        if (value === true || typeof value === 'string') return;

        if (Array.isArray(value)) {
            for (const chunk of value) visit_chunk(chunk);
            return;
        }

        // 绑定值：`{ get, set, listen, active }`，各项分别解析
        if (is_binding(value)) {
            const binding = value as RawBindingValue;

            for (const key of ['expression', 'get', 'set', 'listen'] as const) {
                const item = binding[key];
                if (item) (item as Expression).content = parse_snippet(item, masked, `the ${key} of bind`);
            }

            return;
        }

        visit_chunk(value as RawExpression);
    }

    function visit(nodes: RawTemplateNode[]): void {
        for (const node of nodes) {
            switch (node.type) {
                case 'expression':
                    (node as Expression).content = parse_expression(node, masked);
                    break;

                case 'element':
                    for (const value of Object.values(node.attributes)) visit_value(value);
                    visit(node.children);
                    break;

                case 'IfBlock':
                    (node.test as Expression).content = parse_expression(node.test, masked);
                    visit(node.children);
                    for (const alternate of node.alternates) {
                        if (alternate.test) {
                            (alternate.test as Expression).content = parse_expression(alternate.test, masked);
                        }
                        visit(alternate.children);
                    }
                    break;

                case 'ForBlock':
                    (node as ForBlock).content = parse_for_of(node, masked);
                    visit(node.children);
                    if (node.fallback) visit(node.fallback.children);
                    break;
            }
        }
    }

    visit(template.children);
}
