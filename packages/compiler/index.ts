export { Parser, parse, parse_root, type ParseOptions } from './parser.js';
export { ParseError } from './errors.js';
export { scan_script, scan_expression, scan_style, type ScanResult } from './scan.js';
export { check_bindings } from './check.js';
export { parse_expression, parse_expressions, parse_for_of } from './read/expression.js';
export { parse_script } from './read/script.js';
export { parse_style } from './read/style.js';
export {
    compile,
    compile_root,
    generate,
    create_scope_id,
    is_global,
    scope_stylesheet,
    analyze_script,
    collect_reads,
    collect_writes,
    type CompileOptions,
    type CompileResult,
    type ScriptAnalysis,
    type StateInfo,
    type FunctionInfo
} from './transform/index.js';
export * from './types.js';
