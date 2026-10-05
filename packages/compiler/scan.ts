import { ParseError } from './errors.js';
import type { Locator } from './utils.js';

/**
 * SFC 本体解析阶段用的内容扫描器。
 *
 * 这一阶段还不解析 TS / CSS，只做**基本的词法分析**，用来确定内容在哪结束。
 * 目的很明确：字符串、模板字符串、注释、正则里出现的结束标记不能被当成结束，例如：
 *
 * ```html
 * <script>
 *   const html = '</script>';            // 字符串
 *   const tag = `</script >`;            // 模板字符串
 *   // </script>                          // 行注释
 *   /* </script> *\/                      // 块注释
 *   const re = /<\/script\s*>/;          // 正则
 * </script>
 * <p>{`${a}` + '}'}</p>                  // 表达式里的花括号、字符串、嵌套模板
 * ```
 *
 * 只保证"找到正确的结束位置"，不保证内容本身语法正确 —— 语法错误交给第二阶段
 * 的 typescript-estree / css-tree 去报。
 */

export interface ScanResult {
    /** 内容结束偏移，即结束标记的起始位置（`</script` 的 `<`，或表达式的 `}`） */
    contentEnd: number;
    /** 结束标记结束后的偏移 */
    end: number;
}

/** 普通代码；`expr` 表示需要配对花括号（`${ ... }` 或 `{ ... }`），`braces` / `parens` 是已嵌套的层数 */
interface CodeFrame {
    kind: 'code';
    expr: boolean;
    braces: number;
    parens: number;
}

type Frame =
    | CodeFrame
    /** 字符串 */
    | { kind: 'string'; quote: '"' | "'" }
    /** 模板字符串 */
    | { kind: 'template' };

/**
 * 判断当前位置是否是结束标记；返回结束标记之后的位置，不是则返回 -1。
 * `depth` 是当前上下文栈的深度，1 表示还在最外层。
 */
type StopFn = (source: string, index: number, frame: CodeFrame, depth: number) => number;

function is_whitespace(char: string | undefined): boolean {
    return (
        char === ' ' ||
        char === '\t' ||
        char === '\n' ||
        char === '\r' ||
        char === '\f' ||
        char === '\v' ||
        char === '\u00a0'
    );
}

function is_identifier_part(char: string | null | undefined): boolean {
    if (char == null) return false;

    return (
        (char >= 'a' && char <= 'z') ||
        (char >= 'A' && char <= 'Z') ||
        (char >= '0' && char <= '9') ||
        char === '_' ||
        char === '$'
    );
}

/** 跳过行注释（JS 里 `//` 与 Annex B 的 `<!--` 都到行尾为止） */
function skip_line(source: string, index: number): number {
    const newline = source.indexOf('\n', index);
    return newline === -1 ? source.length : newline + 1;
}

function skip_block_comment(source: string, index: number): number {
    const end = source.indexOf('*/', index + 2);
    return end === -1 ? source.length : end + 2;
}

/** 跳过正则字面量；没找到结尾就退化成"一个除号"，避免吞掉后面的内容 */
function skip_regex(source: string, index: number): number {
    let in_class = false;
    let i = index + 1;

    while (i < source.length) {
        const char = source[i];

        if (char === '\\') {
            i += 2;
            continue;
        }

        // 正则不能跨行，遇换行说明这个 `/` 其实不是正则起点
        if (char === '\n' || char === '\r') return index + 1;

        if (in_class) {
            if (char === ']') in_class = false;
        } else if (char === '[') {
            in_class = true;
        } else if (char === '/') {
            i += 1;
            while (i < source.length && is_identifier_part(source[i])) i += 1;
            return i;
        }

        i += 1;
    }

    return index + 1;
}

/**
 * 判断 `/` 是正则起点还是除号：看前一个有语义的字符。
 * 标识符、数字、`)`、`]`、`}` 之后是除号，其余（运算符、`,`、`(`、`[`、`{` 等）之后是正则。
 * `'value'` 是"刚读完一个字面量/字符串/模板"的哨兵。
 */
function is_regex_start(previous: string | null): boolean {
    if (previous === null) return true;
    if (previous === 'value') return false;
    if (is_identifier_part(previous)) return false;
    return previous !== ')' && previous !== ']' && previous !== '}';
}

/** 匹配 `</name >`，返回 `>` 之后的位置，不匹配返回 -1 */
function match_closing_tag(source: string, index: number, name: string): number {
    if (!source.startsWith('</' + name, index)) return -1;

    let i = index + name.length + 2;
    while (i < source.length && is_whitespace(source[i])) i += 1;

    return source[i] === '>' ? i + 1 : -1;
}

interface ScanCodeOptions {
    locate?: Locator;
    /** 栈底是否处于需要配对花括号的表达式上下文 */
    expr?: boolean;
    /** 找不到结束标记时的报错信息 */
    message: string;
}

function unclosed(message: string, start: number, end: number, locate?: Locator): never {
    const at = locate ? ` (${locate(start).line}:${locate(start).column})` : '';
    throw new ParseError(`${message} 未闭合${at}`, start, end);
}

/**
 * 按 JS / TS 词法扫描代码，直到 `stop` 认出结束标记。
 *
 * 遇到字符串、模板字符串（含嵌套的 `${ ... }`）、注释、正则都会整段跳过，
 * 所以这些里面的结束标记不会被误判。
 */
function scan_code(
    source: string,
    start: number,
    stop: StopFn,
    options: ScanCodeOptions
): ScanResult {
    const stack: Frame[] = [{ kind: 'code', expr: options.expr ?? false, braces: 0, parens: 0 }];
    let previous: string | null = null;
    let i = start;

    while (i < source.length) {
        const frame = stack[stack.length - 1];
        const char = source[i];

        if (frame.kind === 'code') {
            const end = stop(source, i, frame, stack.length);
            if (end !== -1) return { contentEnd: i, end };
        }

        if (frame.kind === 'string') {
            if (char === '\\') {
                i += 2;
                continue;
            }

            if (char === frame.quote) {
                stack.pop();
                previous = 'value';
            } else if (char === '\n') {
                // 未闭合的字符串：JS 里不允许跨行，这里退出字符串态继续找结束标记，
                // 真正的语法错误由 TS 解析器报出
                stack.pop();
            }

            i += 1;
            continue;
        }

        if (frame.kind === 'template') {
            if (char === '\\') {
                i += 2;
                continue;
            }

            if (char === '`') {
                stack.pop();
                previous = 'value';
                i += 1;
                continue;
            }

            // `${` 里是普通代码，可能嵌套 `{}` 甚至再嵌套模板字符串
            if (char === '$' && source[i + 1] === '{') {
                stack.push({ kind: 'code', expr: true, braces: 0, parens: 0 });
                previous = null;
                i += 2;
                continue;
            }

            i += 1;
            continue;
        }

        // ---- 代码上下文 ----

        if (char === '/' && source[i + 1] === '/') {
            i = skip_line(source, i);
            continue;
        }

        if (char === '/' && source[i + 1] === '*') {
            i = skip_block_comment(source, i);
            continue;
        }

        // Annex B：`<!--` 在脚本里是行注释
        if (char === '<' && source.startsWith('!--', i + 1)) {
            i = skip_line(source, i);
            continue;
        }

        if (char === '"' || char === "'") {
            stack.push({ kind: 'string', quote: char });
            previous = 'value';
            i += 1;
            continue;
        }

        if (char === '`') {
            stack.push({ kind: 'template' });
            previous = 'value';
            i += 1;
            continue;
        }

        if (char === '/' && is_regex_start(previous)) {
            i = skip_regex(source, i);
            previous = 'value';
            continue;
        }

        // `a++ / 2` 是除法，`++a /re/` 是正则
        if ((char === '+' && source[i + 1] === '+') || (char === '-' && source[i + 1] === '-')) {
            previous = previous === 'value' || is_identifier_part(previous) ? 'value' : char;
            i += 2;
            continue;
        }

        if (frame.expr) {
            if (char === '{') {
                frame.braces += 1;
            } else if (char === '}') {
                if (frame.braces === 0 && stack.length > 1) {
                    stack.pop();
                    previous = 'value';
                    i += 1;
                    continue;
                }
                frame.braces -= 1;
            }
        }

        // 圆括号也要记：`listen(bus, "do", guard)` 里的逗号不是项分隔
        if (char === '(') frame.parens += 1;
        else if (char === ')') frame.parens -= 1;

        if (!is_whitespace(char)) previous = char;
        i += 1;
    }

    unclosed(options.message, start, source.length, options.locate);
}

/**
 * 扫描 `<script>` 内容，返回真正的结束位置。
 *
 * @param start 内容的起始偏移（开始标签 `>` 之后）
 */
export function scan_script(source: string, start: number, locate?: Locator): ScanResult {
    return scan_code(source, start, (source, index) => match_closing_tag(source, index, 'script'), {
        locate,
        message: '`</script>`'
    });
}

/**
 * 扫描 `{ ... }` 表达式内容，返回配对的 `}` 位置。
 *
 * @param start 表达式内容的起始偏移（`{` 之后）
 */
export function scan_expression(source: string, start: number, locate?: Locator): ScanResult {
    return scan_code(
        source,
        start,
        // 只在最外层、且没有未闭合的 `{` 时才认这个 `}`（模板字符串的 `${ ... }` 深度 > 1）
        (source, index, frame, depth) =>
            depth === 1 && frame.braces === 0 && frame.parens === 0 && source[index] === '}'
                ? index + 1
                : -1,
        { locate, expr: true, message: '表达式' }
    );
}

/**
 * 扫描绑定值里的一项：`bind:value={ ... }` 里按**顶层逗号**断开。
 *
 * 括号里的逗号（`listen(bus, "do", guard)`）、字符串里的逗号都不算。
 * 返回这一项之后的位置；遇到 `}` 说明这是最后一项。
 *
 * @param start 这一项的起始偏移
 */
export function scan_binding_item(source: string, start: number, locate?: Locator): ScanResult {
    return scan_code(
        source,
        start,
        (source, index, frame, depth) => {
            if (depth !== 1 || frame.braces !== 0 || frame.parens !== 0) return -1;

            const char = source[index];

            return char === ',' || char === '}' ? index + 1 : -1;
        },
        { locate, expr: true, message: '绑定值' }
    );
}

/** CSS 字符串；CSS 字符串不能跨行，遇到换行就当作没闭合 */
function skip_css_string(source: string, index: number, quote: string): number {
    let i = index + 1;

    while (i < source.length) {
        const char = source[i];

        if (char === '\\') {
            i += 2;
            continue;
        }

        if (char === quote) return i + 1;
        if (char === '\n') return i;

        i += 1;
    }

    return i;
}

/**
 * 扫描 `<style>` 内容。
 *
 * CSS 里同样可能出现 `content: "</style>"` 或注释里的结束标记，
 * 所以这里也做一层最基础的注释 / 字符串识别。
 */
export function scan_style(source: string, start: number, locate?: Locator): ScanResult {
    let i = start;

    while (i < source.length) {
        const char = source[i];

        if (char === '/' && source[i + 1] === '*') {
            i = skip_block_comment(source, i);
            continue;
        }

        if (char === '"' || char === "'") {
            i = skip_css_string(source, i, char);
            continue;
        }

        const closing = char === '<' ? match_closing_tag(source, i, 'style') : -1;
        if (closing !== -1) return { contentEnd: i, end: closing };

        i += 1;
    }

    unclosed('`</style>`', start, source.length, locate);
}
