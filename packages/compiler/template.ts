import type { Parser } from './parser.js';
import { scan_expression } from './scan.js';
import type {
    Attributes,
    Comment,
    RawAttributeValue,
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
        if (is_closing_tag(parser)) parser.error('意外的闭合标签');

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

/**
 * `index` 处的 `{` 是否是块标记：`{if ...}`、`{for ...}`、`{:else}`、`{/if}`
 */
function is_block_mark(source: string, index: number): boolean {
    if (source[index] !== '{') return false;

    const next = source[index + 1];
    if (next === ':' || next === '/') return true;

    return is_keyword_at(source, index + 1, 'if') || is_keyword_at(source, index + 1, 'for');
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
        if (!top_level) parser.error('`<script>` 和 `<style>` 只能出现在组件顶层');
        // top_level 时 read_fragment 已经 break，不会走到这里
        return [];
    }

    if (parser.match('{')) {
        if (is_keyword_at(parser.source, parser.index + 1, 'if')) return [read_if_block(parser)];
        if (is_keyword_at(parser.source, parser.index + 1, 'for')) return [read_for_block(parser)];
        // 分支 / 结束标记应由对应的块读取器消费，出现在这里说明没有可配对的块
        if (parser.match('{:') || parser.match('{/')) parser.error('没有可以闭合的块');

        return [read_expression(parser)];
    }

    return [read_element(parser)];
}

// ---------------------------------------------------------------- 逻辑块

/** `{if ...}` ... `{:else if ...}` / `{:else}` ... `{/if}` */
function read_if_block(parser: Parser): RawIfBlock {
    const start = parser.index;

    parser.eat('{if', true);
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

/** `{for (... of ...)}` ... `{:else}` ... `{/for}` */
function read_for_block(parser: Parser): RawForBlock {
    const start = parser.index;

    parser.eat('{for', true);

    // 循环头从 `for` 本身开始整段保留，它天然就是一条 for-of 语句的写法，
    // 第二阶段直接交给 TS 解析即可，字符偏移也不用做任何修正
    const content_start = start + 1;
    const { contentEnd, end } = scan_expression(parser.source, parser.index, parser.locate);
    const raw = parser.source.slice(content_start, contentEnd);

    if (!/^for\b/.test(raw)) {
        parser.error('`{for ...}` 里必须是 `for (... of ...)` 形式的循环头', start, end);
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

    if (!parser.eat('else')) parser.error('期望 `else`', start);
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

    if (!parser.eat('{/')) parser.error(`期望 \`{/${name}}\``, start);
    parser.allow_whitespace();
    if (!parser.eat(name)) parser.error(`期望 \`{/${name}}\``, start);
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
 * 从当前位置读到配对的 `}` 并消费掉，产出一个表达式节点。
 * 块的 `{if ...}` / `{:else if ...}` 也用它读条件。
 */
function read_tag_expression(parser: Parser, open_start: number): RawExpression {
    const content_start = parser.index;
    const { contentEnd, end } = scan_expression(parser.source, content_start, parser.locate);

    if (contentEnd === content_start) parser.error('表达式为空', open_start, end);

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
    if (!name) parser.error('期望标签名');

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
        if (!closing) parser.error('期望标签名');
        parser.allow_whitespace();
        parser.eat('>', true);

        if (closing.toLowerCase() !== name.toLowerCase()) {
            parser.error(`闭合标签 \`</${closing}>\` 与 \`<${name}>\` 不匹配`, start, parser.index);
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

    parser.error('元素未闭合');
}

/** 读取一段文本，其中的 `{ ... }` 会被切成表达式节点；遇到块标记则停下 */
function read_text_nodes(parser: Parser): RawTemplateNode[] {
    const source = parser.source;
    const nodes: RawTemplateNode[] = [];

    let start = parser.index;
    let i = start;

    while (i < source.length && !is_tag_start(source, i)) {
        if (source[i] === '{') {
            if (is_block_mark(source, i)) break;

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

        if (parser.index >= parser.length) parser.error('属性列表未结束');

        const char = parser.source[parser.index];
        if (char === '>') return attributes;
        if (char === '/' && parser.source[parser.index + 1] === '>') return attributes;

        const name = parser.read(REGEX_ATTRIBUTE_NAME);
        if (!name) parser.error('期望属性名');
        if (name in attributes) parser.error(`重复的属性 \`${name}\``);

        parser.allow_whitespace();

        let value: RawAttributeValue | true = true;

        if (parser.eat('=')) {
            parser.allow_whitespace();
            value = read_value(parser) as RawAttributeValue;
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
        if (end === -1) parser.error('属性值未闭合', start);

        parser.index = end + 1;
        return decode_entities(parser.source.slice(start, end));
    }

    const start = parser.index;
    let i = start;

    while (i < parser.source.length && !is_whitespace(parser.source[i]) && parser.source[i] !== '>') {
        i += 1;
    }

    if (i === start) parser.error('期望属性值');

    parser.index = i;
    return decode_entities(parser.source.slice(start, i));
}

function read_attribute_value(parser: Parser): RawAttributeValue {
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
    const chunks: Array<string | RawExpression> = [];

    let start = parser.index;
    let i = start;

    while (i < source.length && !is_end(source, i)) {
        if (source[i] === '{') {
            if (i > start) chunks.push(decode_entities(source.slice(start, i)));

            parser.index = i;
            chunks.push(read_expression(parser));

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
    if (end === -1) parser.error('注释未闭合', start);

    parser.index = end + 3;

    return { type: 'comment', content: source.slice(content_start, end), start, end: parser.index };
}
