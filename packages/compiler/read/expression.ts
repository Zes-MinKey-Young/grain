import { parse as parse_ts } from '@typescript-eslint/typescript-estree';
import { ParseError } from '../errors.js';
import type {
    Expression,
    ForBlock,
    RawAttributeValue,
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

        throw new ParseError(`表达式 \`{${node.raw}}\` 解析失败：${message}`, start, end);
    }

    const statement = program.body[0];

    if (program.body.length !== 1 || !statement || statement.type !== 'ExpressionStatement') {
        throw new ParseError(`\`{${node.raw}}\` 里必须正好是一个表达式`, node.contentStart, node.contentEnd);
    }

    return statement.expression;
}

/**
 * 把 `{for (... of ...)}` 的循环头交给 TS 解析。
 *
 * 循环头本身就是 `for (... of ...)`，末尾补个 `;` 就是一条完整的 for-of 语句，
 * 同样不改任何字符偏移，拿到的 `left` / `right` 位置直接对齐整个 SFC。
 */
export function parse_for_of(node: RawForBlock, masked: string): TSForOf {
    const code = masked.slice(0, node.contentStart) + node.raw + ';';

    let program: TSProgram;

    try {
        program = parse_ts(code, TS_OPTIONS);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const [start, end] = error_range(error, [node.contentStart, node.contentEnd]);

        throw new ParseError(`\`{${node.raw}}\` 解析失败：${message}`, start, end);
    }

    const statement = program.body[0];

    if (program.body.length !== 1 || !statement || statement.type !== 'ForOfStatement') {
        throw new ParseError(`\`{${node.raw}}\` 里必须是 \`for (... of ...)\``, node.contentStart, node.contentEnd);
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

        visit_chunk(value);
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
