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
