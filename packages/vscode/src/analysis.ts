import { compile, parse, ParseError } from '../../compiler/index.js';
import type { Expression, Root, Script, TemplateNode } from '../../compiler/index.js';
import {
    build_virtual,
    typescript_service,
    virtual_name,
    type QuickInfo,
    type SemanticProblem
} from './typescript.js';
import { walk } from './ast-utils.js';

export interface Declaration {
    name: string;
    /** 声明在源文本里的区间 */
    start: number;
    end: number;
    /** 声明源码，悬停时显示 */
    detail: string;
    kind: 'variable' | 'function';
}

export interface Analysis {
    root: Root | null;
    error: ParseError | null;
    /** script（含 module）顶层的声明，补全用 */
    declarations: Map<string, Declaration>;
    /** 所有层级的声明（含函数内部），script 里 hover / 跳转用 */
    all: Map<string, Declaration>;
    /** 找出覆盖某个偏移的模板表达式 */
    expression_at(offset: number): Expression | null;
    /** 找出覆盖某个偏移的 script（模板之外、script 内容之内） */
    script_at(offset: number): Script | null;
    /** TypeScript 语言服务给的悬停信息（带类型），只在 script 区域里有效 */
    quick_info(offset: number): QuickInfo | null;
    /** TypeScript 的语义诊断（类型错误、未定义变量等） */
    semantic(): SemanticProblem[];
    /** 后台预热 TS 语言服务（加载它比较重，别放在第一次 hover 时才做） */
    warmup(): void;
    /** 编译产物（命令用） */
    compiled(): { js: string; css: string } | null;
    /** 文档关闭时把虚拟文件从语言服务里摘掉 */
    dispose(): void;
}

function collect_declarations(source: string, script: Script | null): Map<string, Declaration> {
    const declarations = new Map<string, Declaration>();
    if (!script) return declarations;

    for (const statement of script.content.body) {
        // `export const title = ...` 外面包了一层 ExportNamedDeclaration
        const target = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (!target) continue;

        if (target.type === 'VariableDeclaration') {
            for (const declarator of target.declarations) {
                if (declarator.id.type !== 'Identifier') continue;

                const [start, end] = target.range;

                declarations.set(declarator.id.name, {
                    name: declarator.id.name,
                    start,
                    end,
                    detail: source.slice(start, end),
                    kind: 'variable'
                });
            }
        } else if (target.type === 'FunctionDeclaration' && target.id) {
            const [start, end] = target.range;

            declarations.set(target.id.name, {
                name: target.id.name,
                start,
                end,
                detail: source.slice(start, end),
                kind: 'function'
            });
        }
    }

    return declarations;
}

/** 递归收集所有层级的声明，同名时保留最靠前的那个 */
function collect_all(source: string, script: Script | null): Map<string, Declaration> {
    const declarations = new Map<string, Declaration>();
    if (!script) return declarations;

    const add = (name: string, start: number, end: number, kind: Declaration['kind']) => {
        if (!declarations.has(name)) {
            declarations.set(name, { name, start, end, detail: source.slice(start, end), kind });
        }
    };

    walk(script.content, (node) => {
        if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.range) {
            const [start, end] = node.range;
            const init = node.init;

            add(
                node.id.name,
                start,
                end,
                init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression'
                    ? 'function'
                    : 'variable'
            );
        } else if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier' && node.range) {
            const [start, end] = node.range;
            add(node.id.name, start, end, 'function');
        }
    });

    return declarations;
}

function collect_expressions(nodes: TemplateNode[]): Expression[] {
    const expressions: Expression[] = [];

    const visit = (node: TemplateNode): void => {
        switch (node.type) {
            case 'expression':
                expressions.push(node);
                break;

            case 'element':
                for (const value of Object.values(node.attributes)) {
                    if (value === true || typeof value === 'string') continue;

                    for (const chunk of Array.isArray(value) ? value : [value]) {
                        if (typeof chunk !== 'string') expressions.push(chunk);
                    }
                }
                node.children.forEach(visit);
                break;

            case 'IfBlock':
                expressions.push(node.test);
                for (const alternate of node.alternates) {
                    if (alternate.test) expressions.push(alternate.test);
                    alternate.children.forEach(visit);
                }
                node.children.forEach(visit);
                break;

            case 'ForBlock':
                node.fallback?.children.forEach(visit);
                node.children.forEach(visit);
                break;
        }
    };

    nodes.forEach(visit);

    return expressions;
}

export function analyze(source: string, filename: string): Analysis {
    let root: Root | null = null;
    let error: ParseError | null = null;

    try {
        root = parse(source, { filename });
    } catch (caught) {
        error = caught instanceof ParseError ? caught : new ParseError(String(caught), 0, 0);
    }

    const declarations = new Map<string, Declaration>();
    const all = new Map<string, Declaration>();

    for (const script of [root?.module, root?.script]) {
        for (const [name, declaration] of collect_declarations(source, script ?? null)) {
            declarations.set(name, declaration);
        }

        for (const [name, declaration] of collect_all(source, script ?? null)) {
            all.set(name, declaration);
        }
    }

    const expressions = root ? collect_expressions(root.template.children) : [];

    // 把 script 铺到虚拟 .ts 文件里交给 TS 语言服务
    // 注意用 `!=`：解析失败时 root 为 null，root?.script 是 undefined，用 !== 会漏过去
    const scripts = [root?.module, root?.script].filter((script): script is Script => script != null);
    const virtual = virtual_name(filename);

    typescript_service.update(virtual, build_virtual(source, scripts, filename));

    return {
        root,
        error,
        declarations,
        all,

        expression_at(offset: number): Expression | null {
            return (
                expressions.find(
                    (expression) => offset >= expression.contentStart && offset <= expression.contentEnd
                ) ?? null
            );
        },

        script_at(offset: number): Script | null {
            for (const script of [root?.script, root?.module]) {
                if (script && offset >= script.contentStart && offset <= script.contentEnd) return script;
            }

            return null;
        },

        // 虚拟文件与原文件 offset 一一对应，直接把光标偏移传进去就行
        quick_info(offset: number): QuickInfo | null {
            return scripts.some((script) => offset >= script.contentStart && offset <= script.contentEnd)
                ? typescript_service.quick_info(virtual, offset)
                : null;
        },

        semantic(): SemanticProblem[] {
            return typescript_service.semantic_problems(virtual);
        },

        warmup(): void {
            typescript_service.warmup();
        },

        compiled(): { js: string; css: string } | null {
            try {
                return compile(source, { filename, runtimeModule: 'grain' });
            } catch {
                return null;
            }
        },

        dispose(): void {
            typescript_service.remove(virtual);
        }
    };
}


