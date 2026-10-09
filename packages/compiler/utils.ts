/**
 * 不需要闭合标签的元素。
 *
 * Elements that must not have a closing tag — `<br>`, `<img>`, `<input>`, and so on.
 */
export const VOID_ELEMENTS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr'
]);

/** 按名字记的字符实体（`&amp;` 之类）。 Character entities we decode by name. */
const ENTITIES: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: '\u00a0',
    quot: '"'
};

/**
 * 这个字符是空白吗？
 *
 * Is this character whitespace? `&nbsp;` (U+00A0) counts as well — it shows up in
 * templates about as often as a literal space.
 *
 * @param char 待判断的字符；越界读取时是 `undefined`
 * @returns 是空白就 true
 */
export function isWhitespace(char: string | undefined): boolean {
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

/**
 * 这个字符是字母吗？
 *
 * Is this character an ASCII letter? Used when scanning identifiers and tag names.
 *
 * @param char 待判断的字符；可能为 null / undefined
 * @returns 是 a-z 或 A-Z 就 true
 */
export function isAlpha(char: string | null | undefined): boolean {
    if (char == null) return false;

    return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
}

/** 绝对偏移 -> 行列（都从 1 开始）。 Maps a source offset to a 1-based line / column. */
export type Locator = (offset: number) => { line: number; column: number };

/**
 * 从 typescript-estree 抛的错里取出源码区间。
 *
 * typescript-estree 抛的是 `TSError`，带 `location.start.offset / end.offset`。因为解析
 * 时前面补的是等长空白，这些 offset 就是整个 SFC 里的绝对偏移，可以直接用。拿不到就
 * 退回调用方给的兜底区间。
 *
 * Pull the source range out of a `TSError`. Offsets are absolute within the whole SFC
 * (the expression is parsed with an equal-length whitespace prefix), so they can be
 * used as-is. Falls back to the caller's range when the error carries no location.
 *
 * @param error typescript-estree 抛出的错误
 * @param fallback 拿不到位置时用这个区间
 * @returns `[start, end]`，保证 end 至少比 start 大 1
 */
export function errorRange(error: unknown, fallback: [number, number]): [number, number] {
    const location = (error as { location?: { start?: { offset?: number }; end?: { offset?: number } } } | null)
        ?.location;

    const start = location?.start?.offset;
    const end = location?.end?.offset;

    if (typeof start === 'number' && typeof end === 'number') {
        return [start, Math.max(end, start + 1)];
    }

    return fallback;
}

/**
 * 造一个 offset -> 行列的换算器，用于错误信息。
 *
 * Build a locator for error messages. Line starts are collected once, then each lookup
 * is a binary search — cheap enough to call on every diagnostic.
 *
 * @param source SFC 源码
 * @returns 传入 offset，得到 1-based 的 `{ line, column }`
 */
export function createLocator(source: string): Locator {
    const lineStarts = [0];

    for (let i = 0; i < source.length; i += 1) {
        if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }

    return (offset: number) => {
        let low = 0;
        let high = lineStarts.length - 1;

        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (lineStarts[mid] <= offset) low = mid;
            else high = mid - 1;
        }

        return { line: low + 1, column: offset - lineStarts[low] + 1 };
    };
}

const REGEX_ENTITY = /&(#[0-9a-fA-FxX]+|[a-zA-Z]+);/g;

/**
 * 解码文本节点里的 HTML 实体。
 *
 * Decode HTML entities in a text node. Numeric ones (`&#65;`, `&#x41;`) and the few
 * named ones we know; anything else is left alone.
 *
 * @param raw 原文
 * @returns 解码后的文本
 */
export function decodeEntities(raw: string): string {
    if (!raw.includes('&')) return raw;

    return raw.replace(REGEX_ENTITY, (match, body: string) => {
        if (body.charCodeAt(0) === 35 /* # */) {
            const hex = body[1] === 'x' || body[1] === 'X';
            const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
            return Number.isNaN(code) ? match : String.fromCodePoint(code);
        }

        return ENTITIES[body] ?? match;
    });
}
