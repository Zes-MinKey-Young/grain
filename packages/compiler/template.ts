import type { Parser } from './parser.js';
import { scan_binding_item, scan_expression } from './scan.js';
import type {
    Attributes,
    Comment,
    RawAttributeValue,
    RawBindingValue,
    RawElseBlock,
    RawExpression,
    RawForBlock,
    RawIfBlock,
    RawTemplateNode
} from './types.js';
import { decode_entities, is_alpha, is_whitespace, VOID_ELEMENTS } from './utils.js';

const REGEX_TAG_NAME = /[^\s/>=]+/y;
const REGEX_ATTRIBUTE_NAME = /[^\s/>=]+/y;
/** 只由换行符组成的文本段：没有渲染意义，不进 AST */
const REGEX_ONLY_NEWLINES = /^[\n\r]+$/;

/**
 * 读取顶层模板片段，遇到 `<script>` / `<style>` 就停下来交还给 Root 解析。
 */
export function read_fragment(parser: Parser): RawTemplateNode[] {
    const nodes: RawTemplateNode[] = [];

    while (parser.index < parser.length) {
        if (parser.is_block('script') || parser.is_block('style')) break;
        if (is_closing_tag(parser)) parser.error('Unexpected closing tag');

        nodes.push(...read_nodes(parser, true));
    }

    return nodes;
}

/** 是否是 `</tag>` 形式的闭合标签（`</ div>` 这种不是） */
function is_closing_tag(parser: Parser): boolean {
    return parser.match('</') && is_alpha(parser.source[parser.index + 2]);
}

/** 是否是标签、注释或闭合标签的起点 */
function is_tag_start(source: string, index: number): boolean {
    return (
        source[index] === '<' &&
        (is_alpha(source[index + 1]) ||
            source.startsWith('<!--', index) ||
            (source[index + 1] === '/' && is_alpha(source[index + 2])))
    );
}

/** `index` 处是否是 `keyword` 且后面跟着空白（避免把 `{ifx}` 当成 if 块） */
function is_keyword_at(source: string, index: number, keyword: string): boolean {
    return source.startsWith(keyword, index) && is_whitespace(source[index + keyword.length]);
}

/** `{` 后面直接跟 `if` / `for`（不管有没有 `#`） */
function is_block_keyword(source: string, index: number): boolean {
    return is_keyword_at(source, index, 'if') || is_keyword_at(source, index, 'for');
}

/**
 * `index` 处的 `{` 是否是块标记：`{#if ...}`、`{#for ...}`、`{:else}`、`{/if}`
 */
function is_block_mark(source: string, index: number): boolean {
    if (source[index] !== '{') return false;

    const next = source[index + 1];
    if (next === ':' || next === '/') return true;
    if (next !== '#') return false;

    return is_keyword_at(source, index + 2, 'if') || is_keyword_at(source, index + 2, 'for');
}

/**
 * 循环头 `item of list` 在哪儿断开。
 *
 * 按 `of` 这个单词切，而且必须在括号 / 方括号 / 花括号 / 字符串外面
 * —— `for [a, b] of pairs`、`for x of obj[key]` 都靠这个切对。
 */
export function split_for_header(
    raw: string
): { binding: string; iterable: string } | null {
    let depth = 0;
    let quote: string | null = null;

    for (let i = 0; i < raw.length; i += 1) {
        const char = raw[i];

        if (quote) {
            if (char === '\\') i += 1;
            else if (char === quote) quote = null;

            continue;
        }

        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }

        if (char === '(' || char === '[' || char === '{') depth += 1;
        else if (char === ')' || char === ']' || char === '}') depth -= 1;
        else if (depth === 0 && char === 'o' && raw.startsWith('of', i)) {
            const before = raw[i - 1];
            const after = raw[i + 2];

            if (!before_match(before) && !before_match(after)) {
                return { binding: raw.slice(0, i).trim(), iterable: raw.slice(i + 2).trim() };
            }
        }
    }

    return null;
}

/** 标识符字符：`of` 两边得是空白之类的，才说明它是关键字而不是名字的一部分 */
function before_match(char: string | undefined): boolean {
    return char !== undefined && /[\w$]/.test(char);
}

/** 读取一批节点：连续的文本 / 表达式，或者一个元素 / 逻辑块 */
function read_nodes(parser: Parser, top_level: boolean): RawTemplateNode[] {
    let previous = -1;
    let nodes = read_text_nodes(parser);

    // 纯换行的文本段会被丢掉，读完位置已经往前走了却什么都没收着——
    // 接着往后读，直到收到真节点，或者撞上标签 / 块标记（那时位置不会再动）
    while (nodes.length === 0 && parser.index !== previous) {
        previous = parser.index;
        if (parser.index >= parser.length) return [];

        // 丢掉纯换行之后可能正好停在 `</div>` / `{:else}` / `{/if}` 上。
        // 这些不是 read_nodes 该管的，交还给 read_children / read_branch_children 的循环
        if (!top_level && (is_closing_tag(parser) || parser.match('{:') || parser.match('{/')))
            return [];

        nodes = read_text_nodes(parser);
    }

    if (nodes.length > 0) return nodes;

    if (parser.index >= parser.length) return [];

    if (parser.match('<!--')) return [read_comment(parser)];

    if (parser.is_block('script') || parser.is_block('style')) {
        if (!top_level) parser.error('`<script>` and `<style>` are only allowed at the top level of a component');
        // top_level 时 read_fragment 已经 break，不会走到这里
        return [];
    }

    if (parser.match('{')) {
        if (parser.match('{#')) {
            if (is_keyword_at(parser.source, parser.index + 2, 'if')) return [read_if_block(parser)];
            if (is_keyword_at(parser.source, parser.index + 2, 'for')) return [read_for_block(parser)];
        }

        // 少了 `#`：别当成表达式去解析，那样报出来的错看不懂
        for (const keyword of ['if', 'for'] as const) {
            if (!is_keyword_at(parser.source, parser.index + 1, keyword)) continue;

            parser.error(`Block tags need a \`#\`: write \`{#${keyword} ...}\``);
        }
        // 分支 / 结束标记应由对应的块读取器消费，出现在这里说明没有可配对的块
        if (parser.match('{:') || parser.match('{/')) parser.error('There is no block to close');

        return [read_brace(parser)];
    }

    return [read_element(parser)];
}

// ---------------------------------------------------------------- 逻辑块

/** `{#if ...}` ... `{:else if ...}` / `{:else}` ... `{/if}` */
function read_if_block(parser: Parser): RawIfBlock {
    const start = parser.index;

    parser.eat('{#if', true);
    parser.allow_whitespace();
    const test = read_tag_expression(parser, start);

    const children = read_branch_children(parser);
    const alternates: RawElseBlock[] = [];

    while (parser.match('{:')) {
        alternates.push(read_else(parser));
    }

    expect_close(parser, 'if');

    return { type: 'IfBlock', test, children, alternates, start, end: parser.index };
}

/** `{#for item of list}` ... `{:else}` ... `{/for}` */
function read_for_block(parser: Parser): RawForBlock {
    const start = parser.index;

    parser.eat('{#for', true);
    parser.allow_whitespace();

    // 循环头只收 `循环变量 of 可迭代对象`：不写圆括号，
    // 变量可以是 `item`、解构 `[a, b]` / `{x}`，也可以带 `const` / `let`。
    // 第二阶段拼成 `for (...)` 交给 TS，`for (` 写在原本是空白的位置上，
    // 所以字符偏移一个都不用改
    const content_start = parser.index;
    const { contentEnd, end } = scan_expression(parser.source, parser.index, parser.locate);
    const raw = parser.source.slice(content_start, contentEnd);
    const parts = split_for_header(raw);

    if (!parts || parts.binding === '' || parts.iterable === '') {
        parser.error(
            '`{#for ...}` must be `binding of iterable`, for example `{#for item of list}`',
            start,
            end
        );
    }

    parser.index = end;

    const children = read_branch_children(parser);
    const fallback = parser.match('{:') ? read_else(parser) : null;

    expect_close(parser, 'for');

    return {
        type: 'ForBlock',
        raw,
        contentStart: content_start,
        contentEnd,
        children,
        fallback,
        start,
        end: parser.index
    };
}

/** `{:else}` 或 `{:else if ...}` */
function read_else(parser: Parser): RawElseBlock {
    const start = parser.index;

    parser.eat('{:', true);
    parser.allow_whitespace();

    if (!parser.eat('else')) parser.error('Expected `else`', start);
    parser.allow_whitespace();

    let test: RawExpression | null = null;

    if (is_keyword_at(parser.source, parser.index, 'if')) {
        parser.eat('if', true);
        parser.allow_whitespace();
        test = read_tag_expression(parser, start);
    } else {
        parser.eat('}', true);
    }

    const children = read_branch_children(parser);

    return { type: 'ElseBlock', test, children, start, end: parser.index };
}

/** 读取分支内容，遇到 `{:...}` 或 `{/...}` 就停下（由块读取器消费） */
function read_branch_children(parser: Parser): RawTemplateNode[] {
    const children: RawTemplateNode[] = [];

    while (parser.index < parser.length) {
        if (parser.match('{:') || parser.match('{/')) break;

        children.push(...read_nodes(parser, false));
    }

    return children;
}

/** 消费 `{/name}` */
function expect_close(parser: Parser, name: string): void {
    const start = parser.index;

    if (!parser.eat('{/')) parser.error(`Expected \`{/${name}}\``, start);
    parser.allow_whitespace();
    if (!parser.eat(name)) parser.error(`Expected \`{/${name}}\``, start);
    parser.allow_whitespace();
    parser.eat('}', true);
}

// ---------------------------------------------------------------- 表达式

/** 读取 `{ ... }`，结束位置由词法扫描器确定（字符串、模板、对象字面量都安全） */
function read_expression(parser: Parser): RawExpression {
    const start = parser.index;
    parser.eat('{', true);

    return read_tag_expression(parser, start);
}

/**
 * 模板里的 `{ ... }`：可能是绑定值，也可能是普通表达式。
 *
 * 绑定值（`get:` / `set:` / `listen:` / `active`）不只是 `bind:` 的专利——
 * 单向属性和模板插值也认这套，它们只取 `get` + `listen`，不往回写。
 */
function read_brace(parser: Parser): RawExpression | RawBindingValue {
    const after = parser.index + 1;
    const { contentEnd } = scan_expression(parser.source, after, parser.locate);
    const text = parser.source.slice(after, contentEnd);

    if (REGEX_BINDING_KEY.test(text) || REGEX_BINDING_FLAG.test(text) || REGEX_LISTEN_CALL.test(text)) {
        return read_binding_value(parser);
    }

    return read_expression(parser);
}

/**
 * 从当前位置读到配对的 `}` 并消费掉，产出一个表达式节点。
 * 块的 `{if ...}` / `{:else if ...}` 也用它读条件。
 */
function read_tag_expression(parser: Parser, open_start: number): RawExpression {
    const content_start = parser.index;
    const { contentEnd, end } = scan_expression(parser.source, content_start, parser.locate);

    if (contentEnd === content_start) parser.error('Empty expression', open_start, end);

    const raw = parser.source.slice(content_start, contentEnd);
    parser.index = end;

    return {
        type: 'expression',
        raw,
        contentStart: content_start,
        contentEnd,
        start: open_start,
        end
    };
}

// ---------------------------------------------------------------- 元素

function read_element(parser: Parser): RawTemplateNode {
    const start = parser.index;
    parser.eat('<', true);

    const name = parser.read(REGEX_TAG_NAME);
    if (!name) parser.error('Expected a tag name');

    const attributes = read_attributes(parser);
    parser.allow_whitespace();

    const self_closing = parser.eat('/');
    parser.eat('>', true);

    const is_void = VOID_ELEMENTS.has(name.toLowerCase());

    let children: RawTemplateNode[] = [];

    if (!is_void && !self_closing) {
        children = read_children(parser);

        parser.eat('</', true);
        const closing = parser.read(REGEX_TAG_NAME);
        if (!closing) parser.error('Expected a tag name');
        parser.allow_whitespace();
        parser.eat('>', true);

        if (closing.toLowerCase() !== name.toLowerCase()) {
            parser.error(`Closing tag \`</${closing}>\` does not match \`<${name}>\``, start, parser.index);
        }
    }

    return { type: 'element', name, attributes, children, start, end: parser.index };
}

/** 读取元素子节点，遇到 `</` 就返回（闭合标签由调用方消费） */
function read_children(parser: Parser): RawTemplateNode[] {
    const children: RawTemplateNode[] = [];

    while (parser.index < parser.length) {
        if (is_closing_tag(parser)) return children;
        children.push(...read_nodes(parser, false));
    }

    parser.error('Unclosed element');
}

/** 读取一段文本，其中的 `{ ... }` 会被切成表达式节点；遇到块标记则停下 */
function read_text_nodes(parser: Parser): RawTemplateNode[] {
    const source = parser.source;
    const nodes: RawTemplateNode[] = [];

    let start = parser.index;
    let i = start;

    while (i < source.length && !is_tag_start(source, i)) {
        if (source[i] === '{') {
            // 少了 `#` 的 `{if ...}` / `{for ...}` 也停下：
            // 交给 read_nodes 报"要带 #"，比当成表达式解析出来的错好懂
            if (is_block_mark(source, i) || is_block_keyword(source, i + 1)) break;

            push_text(nodes, source, start, i);

            parser.index = i;
            nodes.push(read_expression(parser));

            start = parser.index;
            i = start;
            continue;
        }

        i += 1;
    }

    push_text(nodes, source, start, i);
    parser.index = i;

    return nodes;
}

/**
 * 收一段文本。纯换行的直接丢掉——产物里就不会出现一堆 `"\n    "` 了。
 *
 * 带空格 / 制表符的仍然保留：inline 元素之间的空白是有渲染意义的。
 */
function push_text(nodes: RawTemplateNode[], source: string, start: number, end: number): void {
    if (start >= end) return;

    const raw = source.slice(start, end);
    if (REGEX_ONLY_NEWLINES.test(raw)) return;

    nodes.push({ type: 'text', raw, content: decode_entities(raw), start, end });
}

// ---------------------------------------------------------------- 属性

/** 绑定值里的键：`get:` / `set:` / `listen:`，以及简写的 `active` */
const REGEX_BINDING_KEY = /^\s*(get|set|listen|active)\s*:/;
const REGEX_BINDING_FLAG = /^\s*(active)\s*$/;
/** 不带键名的 listen 简写：`listen(eventBus, eventName, guard)` */
const REGEX_LISTEN_CALL = /^\s*listen\s*\(/;

/** 一段文本是不是绑定值语法（不带花括号） */
export const REGEX_BINDING_VALUE =
    /^\s*(get|set|listen|active)\s*:|^\s*active\s*$|^\s*listen\s*\(/;

/** 裁剪出绑定值里一项的内容（去掉两端空白），做成一个待解析的片段 */
function slice_item(source: string, start: number, end: number): RawExpression {
    let from = start;
    let to = end;

    while (from < to && is_whitespace(source[from])) from += 1;
    while (to > from && is_whitespace(source[to - 1])) to -= 1;

    return {
        type: 'expression',
        raw: source.slice(from, to),
        contentStart: from,
        contentEnd: to,
        start: from,
        end: to
    };
}

/**
 * `bind:` 的绑定值：`{count}`、`{count, active}`、`{ get: ..., set: ..., active }`。
 *
 * 自己按顶层逗号断开、认键名，不交给 TS 去猜 —— 这是 grain 的语法，
 * 只有里面那些具体的值（getter、setter、表达式）才归 TS 管。
 */
export function read_binding_value(parser: Parser): RawBindingValue {
    const source = parser.source;
    const start = parser.index;

    parser.eat('{', true);

    const binding: RawBindingValue = {
        start,
        end: start,
        expression: null,
        get: null,
        set: null,
        listen: null,
        active: false
    };

    while (true) {
        parser.allow_whitespace();

        const item_start = parser.index;
        const { contentEnd, end } = scan_binding_item(source, item_start, parser.locate);

        // contentEnd 就是这一项内容的结束位置（逗号或 `}` 之前）
        const text = source.slice(item_start, contentEnd);
        const closing = source[contentEnd] === '}';
        const item_end = contentEnd;

        const key = REGEX_BINDING_KEY.exec(text);
        const flag = key ? null : REGEX_BINDING_FLAG.exec(text);
        const call = key || flag ? null : REGEX_LISTEN_CALL.exec(text);

        if (flag) {
            binding.active = true;
        } else if (call) {
            // `listen(bus, "do", guard)`：连键名都不用写，整项就是 listen 的值
            binding.listen = slice_item(source, item_start, item_end);
        } else if (key) {
            const name = key[1] as 'get' | 'set' | 'listen' | 'active';
            // 值从冒号之后开始
            let from = item_start + key[0].length;
            let to = item_end;

            while (from < to && is_whitespace(source[from])) from += 1;
            while (to > from && is_whitespace(source[to - 1])) to -= 1;

            if (name === 'active') {
                binding.active = source.slice(from, to) !== 'false';
            } else {
                binding[name] = {
                    type: 'expression',
                    raw: source.slice(from, to),
                    contentStart: from,
                    contentEnd: to,
                    start: from,
                    end: to
                };
            }
        } else {
            // 没有键名：这就是变量形式（`{count}`），整项当表达式
            binding.expression = slice_item(source, item_start, item_end);
        }

        parser.index = end;

        if (closing) {
            binding.end = end;
            return binding;
        }
    }
}

/**
 * `<script>` / `<style>` 的属性：值就是普通字符串，不解析表达式。
 */
export function read_block_attributes(parser: Parser): Attributes {
    return read_attributes(parser, read_plain_value) as Attributes;
}

/** 元素属性：值可以是文本、表达式或它们的混合 */
export function read_attributes(
    parser: Parser,
    read_value: (parser: Parser) => RawAttributeValue = read_attribute_value
): Record<string, RawAttributeValue | true> {
    const attributes: Record<string, RawAttributeValue | true> = {};

    while (true) {
        parser.allow_whitespace();

        if (parser.index >= parser.length) parser.error('Unterminated attribute list');

        const char = parser.source[parser.index];
        if (char === '>') return attributes;
        if (char === '/' && parser.source[parser.index + 1] === '>') return attributes;

        const name = parser.read(REGEX_ATTRIBUTE_NAME);
        if (!name) parser.error('Expected an attribute name');
        if (name in attributes) parser.error(`Duplicate attribute \`${name}\``);

        parser.allow_whitespace();

        let value: RawAttributeValue | true = true;

        if (parser.eat('=')) {
            parser.allow_whitespace();

            // `bind:` 的值是 grain 自己的语法，走专门的解析器
            value = (name.startsWith('bind:') ? read_binding_value(parser) : read_value(parser)) as RawAttributeValue;
        }

        attributes[name] = value;
    }
}

function read_plain_value(parser: Parser): string {
    const quote = parser.source[parser.index];

    if (quote === '"' || quote === "'") {
        parser.index += 1;
        const start = parser.index;
        const end = parser.source.indexOf(quote, start);
        if (end === -1) parser.error('Unterminated attribute value', start);

        parser.index = end + 1;
        return decode_entities(parser.source.slice(start, end));
    }

    const start = parser.index;
    let i = start;

    while (i < parser.source.length && !is_whitespace(parser.source[i]) && parser.source[i] !== '>') {
        i += 1;
    }

    if (i === start) parser.error('Expected an attribute value');

    parser.index = i;
    return decode_entities(parser.source.slice(start, i));
}

export function read_attribute_value(parser: Parser): RawAttributeValue {
    const quote = parser.source[parser.index];

    if (quote === '"' || quote === "'") {
        parser.index += 1;
        const value = read_chunks(parser, (source, index) => source[index] === quote);
        parser.eat(quote, true);
        return value;
    }

    return read_chunks(parser, (source, index) => is_whitespace(source[index]) || source[index] === '>');
}

/**
 * 读取一段"文本 + 表达式"的混合内容，直到 `is_end` 为止。
 * 只有一段时直接返回它，多段时返回数组。
 */
function read_chunks(
    parser: Parser,
    is_end: (source: string, index: number) => boolean
): RawAttributeValue {
    const source = parser.source;
    const chunks: Array<string | RawExpression | RawBindingValue> = [];

    let start = parser.index;
    let i = start;

    while (i < source.length && !is_end(source, i)) {
        if (source[i] === '{') {
            if (i > start) chunks.push(decode_entities(source.slice(start, i)));

            parser.index = i;
            chunks.push(read_brace(parser));

            start = parser.index;
            i = start;
            continue;
        }

        i += 1;
    }

    if (i > start) chunks.push(decode_entities(source.slice(start, i)));
    parser.index = i;

    if (chunks.length === 0) return '';
    if (chunks.length === 1) return chunks[0];

    return chunks;
}

function read_comment(parser: Parser): Comment {
    const source = parser.source;
    const start = parser.index;
    parser.eat('<!--', true);

    const content_start = parser.index;
    const end = source.indexOf('-->', content_start);
    if (end === -1) parser.error('Unterminated comment', start);

    parser.index = end + 3;

    return { type: 'comment', content: source.slice(content_start, end), start, end: parser.index };
}
