import { parse, type ParseOptions } from '../parser.js';
import type { Root } from '../types.ts';
import { generate, type CompileOptions, type CompileResult } from './generate.ts';

export { generate, type CompileOptions, type CompileResult } from './generate.ts';
export { createScopeId, isGlobal, scopeStylesheet } from './style.ts';
export {
    analyzeScript,
    borrowCallErrors,
    collectReads,
    collectWrites,
    intersects,
    type FunctionInfo,
    type FunctionLike,
    type ScriptAnalysis,
    type StateInfo
} from './analyze.ts';

/** SFC 源码 -> 可执行 JS + CSS */
export function compile(source: string, options: CompileOptions & ParseOptions = {}): CompileResult {
    const root = parse(source, options);

    // 宏展开出来的片段登记在 root.expanded，追加到源码末尾——生成阶段按 range 切片才拿得到
    return generate(root, root.expanded ? `${source}\n${root.expanded}` : source, options);
}

/** 已经解析好的 Root -> 可执行 JS + CSS */
export function compileRoot(root: Root, source: string, options: CompileOptions = {}): CompileResult {
    return generate(root, source, options);
}
