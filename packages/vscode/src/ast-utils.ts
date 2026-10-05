/**
 * 纯 AST 工具，不碰编译器——这样 providers 可以放心 import 它，
 * 不会把 typescript-estree（连带整个 TypeScript）拖进扩展激活阶段。
 */

/** 通用 AST 遍历 */
export function walk(node: unknown, visit: (node: any) => void): void {
    if (!node || typeof node !== 'object') return;

    visit(node);

    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key === 'range' || key === 'parent') continue;

        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item === 'object' && 'type' in item) walk(item, visit);
            }
        } else if (value && typeof value === 'object' && 'type' in value) {
            walk(value, visit);
        }
    }
}

/** 标签头部的一个属性名，带位置 */
export interface AttributeName {
    name: string;
    start: number;
    end: number;
}

function skip_quoted(source: string, from: number, to: number): number {
    const quote = source[from];
    let i = from + 1;

    while (i < to) {
        if (source[i] === '\\') {
            i += 2;
            continue;
        }

        if (source[i] === quote) return i + 1;

        i += 1;
    }

    return to;
}

function skip_braced(source: string, from: number, to: number): number {
    let depth = 0;
    let i = from;

    while (i < to) {
        const char = source[i];

        if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) return i + 1;
        } else if (char === '"' || char === "'") {
            i = skip_quoted(source, i, to);
            continue;
        }

        i += 1;
    }

    return to;
}

/**
 * 扫描元素头部的属性名：`<Foo a=1 b="x {y}">` 里的 `a` / `b`。
 *
 * 属性没有位置信息，只能回头扫源码。引号和 `{ ... }` 里的东西都跳过去，
 * 不会把它们当成属性名。
 */
export function attributes_in(source: string, from: number, to: number): AttributeName[] {
    const found: AttributeName[] = [];

    let i = from;

    while (i < to) {
        const char = source[i];

        if (char === '"' || char === "'") {
            i = skip_quoted(source, i, to);
            continue;
        }

        if (char === '{') {
            i = skip_braced(source, i, to);
            continue;
        }

        if (char === '>' || (char === '/' && source[i + 1] === '>')) break;

        if (/[\w:.-]/.test(char)) {
            const start = i;
            while (i < to && /[\w:.-]/.test(source[i])) i += 1;

            found.push({ name: source.slice(start, i), start, end: i });
            continue;
        }

        i += 1;
    }

    return found;
}

/** 一段 AST 里光标下的标识符（最里层那个） */
export function identifier_at(node: unknown, offset: number): string | null {
    let found: string | null = null;
    let best = Number.MAX_SAFE_INTEGER;

    walk(node, (current) => {
        if (current.type !== 'Identifier' || !current.range) return;

        const [start, end] = current.range;
        if (offset < start || offset > end) return;

        // 取范围最小的那个（最里层）
        if (end - start < best) {
            best = end - start;
            found = current.name;
        }
    });

    return found;
}
