// 这个包标了 `__esModule` 却没有 default 导出，所以只能具名导入：
// 默认导入在 CJS 下拿到的是 undefined（扩展就是 CJS 编译的）
import { parse as parse_ts } from '@typescript-eslint/typescript-estree';
import type { TSESTreeOptions } from '@typescript-eslint/typescript-estree';

import { ParseError } from '../errors.js';
import type { RawScript, Script, TSProgram } from '../types.js';
import { error_range } from '../utils.js';

export const TS_OPTIONS = {
    comment: true,
    jsx: false,
    loc: true,
    range: true,
    sourceType: 'module'
} as const satisfies TSESTreeOptions;

/**
 * 第二阶段：把 `<script>` 的原文交给 typescript-estree 解析。
 *
 * `masked` 是等长的"空白版"源码（除换行外全是空格），拿它做前缀，
 * AST 里的位置就是整个 SFC 的绝对偏移，不需要在后续阶段再换算。
 */
export function parse_script(block: RawScript, masked: string): Script {
    const code = masked.slice(0, block.contentStart) + block.raw;

    let content: TSProgram;

    try {
        content = parse_ts(code, TS_OPTIONS);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const tag = block.context === 'module' ? '<script module>' : '<script>';
        // 只勾出错的那一段，不是整个 script
        const [start, end] = error_range(error, [block.contentStart, block.contentEnd]);

        throw new ParseError(`Failed to parse ${tag}: ${message}`, start, end);
    }

    return { ...block, content };
}
