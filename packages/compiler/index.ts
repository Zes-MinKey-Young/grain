export { Parser, parse, parseRoot, type ParseOptions } from './parser.js';
export { ParseError } from './errors.js';
export { scanScript, scanExpression, scanStyle, type ScanResult } from './scan.js';
export { checkBindings } from './check.js';
export { nearestTsconfig, readPaths, resolveAlias } from './tsconfig.js';
export type { PathAlias, PathConfig } from './tsconfig.js';
export { splitForHeader } from './template.js';
export { parseExpression, parseExpressions, parseForOf } from './read/expression.js';
export { parseScript } from './read/script.js';
export { MacroScope, expandMacros, type MacroReparse } from './macro.js';
export { parseStyle } from './read/style.js';
export {
    compile,
    compileRoot,
    generate,
    createScopeId,
    isGlobal,
    scopeStylesheet,
    analyzeScript,
    collectReads,
    collectWrites,
    type CompileOptions,
    type CompileResult,
    type ScriptAnalysis,
    type StateInfo,
    type FunctionInfo
} from './transform/index.js';
export * from './types.js';
