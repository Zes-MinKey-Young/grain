import { type StyleSheet as StyleSheetNode, parse as parse_css } from 'css-tree';
import type { CssDiagnostic, RawStyle, Stylesheet } from '../types.js';
import type { Locator } from '../utils.js';

/**
 * 第二阶段：把 `<style>` 的原文交给 css-tree 解析。
 *
 * 通过 `offset` / `line` / `column` 让 CSS AST 的位置对齐整个 SFC 的绝对偏移。
 * css-tree 是容错解析器，语法问题不抛错，而是记录到 `diagnostics` 里，
 * 由后续阶段决定是报警还是报错。
 */
export function parse_style(block: RawStyle, locate: Locator): Stylesheet {
    const diagnostics: CssDiagnostic[] = [];
    const { line, column } = locate(block.contentStart);

    const content = parse_css(block.raw, {
        positions: true,
        offset: block.contentStart,
        line,
        column,
        parseAtrulePrelude: true,
        parseRulePrelude: true,
        parseValue: true,
        parseCustomProperty: true,
        onParseError: (error) => {
            const start = block.contentStart + error.offset;
            const location = locate(start);

            diagnostics.push({
                message: error.message,
                formattedMessage: error.formattedMessage,
                start,
                end: start,
                line: location.line,
                column: location.column
            });
        }
    }) as StyleSheetNode;

    return { ...block, content, diagnostics };
}
