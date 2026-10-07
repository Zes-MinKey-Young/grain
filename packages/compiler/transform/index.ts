import { parse, type ParseOptions } from '../parser.js';
import type { Root } from '../types.js';
import { generate, type CompileOptions, type CompileResult } from './generate.js';

export { generate, type CompileOptions, type CompileResult } from './generate.js';
export { create_scope_id, is_global, scope_stylesheet } from './style.js';
export {
    analyze_script,
    collect_reads,
    collect_writes,
    intersects,
    type FunctionInfo,
    type FunctionLike,
    type ScriptAnalysis,
    type StateInfo
} from './analyze.js';

/** SFC 源码 -> 可执行 JS + CSS */
export function compile(source: string, options: CompileOptions & ParseOptions = {}): CompileResult {
    const root = parse(source, options);

    // 宏展开出来的片段登记在 root.expanded，追加到源码末尾——生成阶段按 range 切片才拿得到
    return generate(root, root.expanded ? `${source}\n${root.expanded}` : source, options);
}

/** 已经解析好的 Root -> 可执行 JS + CSS */
export function compile_root(root: Root, source: string, options: CompileOptions = {}): CompileResult {
    return generate(root, source, options);
}
