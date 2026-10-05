/** 不需要闭合标签的元素 */
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

const ENTITIES: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: '\u00a0',
    quot: '"'
};

export function is_whitespace(char: string | undefined): boolean {
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

export function is_alpha(char: string | null | undefined): boolean {
    if (char == null) return false;

    return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
}

export type Locator = (offset: number) => { line: number; column: number };

/**
 * typescript-estree 抛的是 `TSError`，带 `location.start.offset / end.offset`。
 * 因为解析时前面补的是等长空白，这些 offset 就是整个 SFC 里的绝对偏移，可以直接用。
 * 拿不到就退回调用方给的兜底区间。
 */
export function error_range(error: unknown, fallback: [number, number]): [number, number] {
    const location = (error as { location?: { start?: { offset?: number }; end?: { offset?: number } } } | null)
        ?.location;

    const start = location?.start?.offset;
    const end = location?.end?.offset;

    if (typeof start === 'number' && typeof end === 'number') {
        return [start, Math.max(end, start + 1)];
    }

    return fallback;
}

/** offset -> line / column（1-based），用于错误信息 */
export function create_locator(source: string): Locator {
    const line_starts = [0];

    for (let i = 0; i < source.length; i += 1) {
        if (source.charCodeAt(i) === 10) line_starts.push(i + 1);
    }

    return (offset: number) => {
        let low = 0;
        let high = line_starts.length - 1;

        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (line_starts[mid] <= offset) low = mid;
            else high = mid - 1;
        }

        return { line: low + 1, column: offset - line_starts[low] + 1 };
    };
}

const REGEX_ENTITY = /&(#[0-9a-fA-FxX]+|[a-zA-Z]+);/g;

/** 解码文本节点里的 HTML 实体 */
export function decode_entities(raw: string): string {
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
