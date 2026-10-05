import { type TSESTreeOptions, parse as parse_ts } from '@typescript-eslint/typescript-estree';
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

        throw new ParseError(`${tag} 解析失败：${message}`, start, end);
    }

    return { ...block, content };
}
