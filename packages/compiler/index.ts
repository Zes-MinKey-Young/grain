export { Parser, parse, parseRoot, type ParseOptions } from './parser.ts';
export { ParseError } from './errors.ts';
export { scanScript, scanExpression, scanStyle, type ScanResult } from './scan.ts';
export { checkBindings } from './check.ts';
export { nearestTsconfig, readPaths, resolveAlias } from './tsconfig.ts';
export type { PathAlias, PathConfig } from './tsconfig.ts';
export { splitForHeader } from './template.ts';
export { parseExpression, parseExpressions, parseForOf } from './read/expression.ts';
export { parseScript } from './read/script.ts';
export { MacroScope, expandMacros, type MacroReparse } from './macro.ts';
export { parseStyle } from './read/style.ts';
export {
    compile,
    compileRoot,
    generate,
    createScopeId,
    isGlobal,
    scopeStylesheet,
    analyzeScript,
    borrowCallErrors,
    collectReads,
    collectWrites,
    type CompileOptions,
    type CompileResult,
    type ScriptAnalysis,
    type StateInfo,
    type FunctionInfo
} from './transform/index.ts';
export * from './types.ts';
