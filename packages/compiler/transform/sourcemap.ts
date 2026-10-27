/**
 * 行级 sourcemap。
 *
 * 四遍，优先级从高到低：
 *
 * 1. **语句锚点**：codegen 每 push 一条语句都记下它对应的模板节点在源码里的偏移，
 *    所以逐条对齐就行 —— 模板代码因此落在真正的那一行上。
 *
 * 2. **标签锚点**：兜底用的启发式：`creEle("div" …)` / `Foo.create(…)` 的名字来自
 *    模板，按顺序去源码里找下一个 `<div` / `<Foo`。锚点漏掉的语句靠它补。
 *
 * 3. **整行对齐**：`<script>` 的正文是从源码整段切下来的（改动都在行内），
 *    剩下的行去源码里按顺序找同一行文本，对上就映射回那一行。
 *
 * 4. **向前补齐**：还剩下的（纯生成的胶水代码）沿用上一处已知来源 —— 不留空，
 *    空映射会让 DevTools 退回显示编译后的模块。
 */

export interface SourceMap {
    version: 3;
    file: string;
    sources: string[];
    sourcesContent: string[];
    names: string[];
    /** VLQ 编码的映射串 */
    mappings: string;
}

/** 一条生成的语句 + 它对应的源码偏移 */
export interface Anchor {
    text: string;
    offset: number;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 太短的行（`}`、`);`、`return`）太容易撞，对齐时跳过 */
const MIN_LENGTH = 6;

/** 往后看多少行。够跳过生成出来的整段（`{#for}`、`{#if}` 之类） */
const LOOKAHEAD = 80;

/** `creEle("div", …)` 的元素名 / `Foo.create(…)` 的组件名 */
const TAG = /creEle\("([a-zA-Z][\w-]*)|\b([A-Z][\w]*)\.create\(/;

/**
 * @param generated 生成的 JS
 * @param original 组件源码
 * @param filename 组件路径，写进 `sources`
 * @param anchors codegen 逐条记下来的语句
 */
export function createSourceMap(
    generated: string,
    original: string,
    filename: string,
    anchors: Anchor[] = []
): SourceMap {
    const generatedLines = generated.split('\n');
    const originalLines = original.split('\n').map((line) => line.trim());
    const lineStarts = collectLineStarts(original);

    /** 产物行（0 基）-> 源码行（0 基） */
    const origins: Array<number | null> = new Array(generatedLines.length).fill(null);

    // ---- 1. 语句锚点 ----
    let anchorCursor = 0;

    for (const anchor of anchors) {
        const first = anchor.text.split('\n')[0].trim();
        if (first.length < MIN_LENGTH) continue;

        const height = anchor.text.split('\n').length;
        const found = findFrom(generatedLines, first, anchorCursor);

        if (found === -1) continue;

        const line = lineAt(lineStarts, anchor.offset);

        for (let index = found; index < Math.min(generatedLines.length, found + height); index += 1) {
            if (origins[index] === null) origins[index] = line;
        }

        anchorCursor = found + height;
    }

    // ---- 2. 标签锚点 ----
    // 只在模板区找：`<script>` 里也可能出现 `<div` 这类文本
    const templateStart = Math.max(original.lastIndexOf('</script>'), original.lastIndexOf('</style>')) + 1;

    let tagCursor = templateStart;

    for (let index = 0; index < generatedLines.length; index += 1) {
        if (origins[index] !== null) continue;

        const tag = TAG.exec(generatedLines[index]);
        if (!tag) continue;

        // `creEle("div"` 拿第 1 组；`Foo.create(` 拿第 2 组
        const name = tag[1] ?? tag[2];
        if (!name) continue;

        const needle = `<${name}`;
        const found = original.indexOf(needle, tagCursor);

        if (found === -1) continue;

        origins[index] = lineAt(lineStarts, found);
        tagCursor = found + needle.length;
    }

    // ---- 2. 整行对齐 ----
    let sourceCursor = 0;

    for (let index = 0; index < generatedLines.length; index += 1) {
        if (origins[index] !== null) continue;

        const text = generatedLines[index].trim();
        if (text.length < MIN_LENGTH) continue;

        const found = findFrom(originalLines, text, sourceCursor);
        if (found === -1) continue;

        origins[index] = found;
        sourceCursor = found + 1;
    }

    // ---- 3. 向前补齐 ----
    let last = origins.find((line) => line !== null) ?? 0;

    for (let index = 0; index < origins.length; index += 1) {
        const origin = origins[index];

        if (origin === null) origins[index] = last;
        else last = origin;
    }

    return {
        version: 3,
        file: filename,
        sources: [filename],
        sourcesContent: [original],
        names: [],
        mappings: encodeMappings(origins)
    };
}

function collectLineStarts(source: string): number[] {
    const starts = [0];

    for (let index = 0; index < source.length; index += 1) {
        if (source.charCodeAt(index) === 10) starts.push(index + 1);
    }

    return starts;
}

/** 源码偏移 -> 0 基行号 */
function lineAt(lineStarts: number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low < high) {
        const mid = (low + high + 1) >> 1;

        if (lineStarts[mid] <= offset) low = mid;
        else high = mid - 1;
    }

    return low;
}

/** 从 `from` 开始往后找一行相同的（比较前都 trim 过） */
function findFrom(lines: string[], text: string, from: number): number {
    const end = Math.min(lines.length, from + LOOKAHEAD);

    for (let index = from; index < end; index += 1) {
        if (lines[index].trim() === text) return index;
    }

    return -1;
}

/**
 * 每行一段 `[生成列, 源序号, 源码行, 源码列]`，列固定 0。
 *
 * 只有"源码行"这个字段会变，所以每段是 `A` + `A` + VLQ(行差) + `A`。
 */
function encodeMappings(origins: Array<number | null>): string {
    const lines: string[] = [];

    let previous = 0;

    for (const origin of origins) {
        if (origin === null) {
            lines.push('');

            continue;
        }

        lines.push(`AA${encodeVlq(origin - previous)}A`);
        previous = origin;
    }

    return lines.join(';');
}

/** Base64 VLQ */
function encodeVlq(value: number): string {
    let rest = value < 0 ? (-value << 1) | 1 : value << 1;
    let out = '';

    do {
        let digit = rest & 0b11111;
        rest >>>= 5;

        if (rest > 0) digit |= 0b100000;

        out += BASE64[digit];
    } while (rest > 0);

    return out;
}
