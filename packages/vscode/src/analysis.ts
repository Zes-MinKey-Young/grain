import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

/** `$props<{...}>()` 里的一个属性 */
export interface ComponentProp {
    name: string;
    /** 类型源码，如 `string` / `() => unknown` */
    type: string;
    optional: boolean;
    /** 子组件里用 `$bindable()` 声明过，可以双向绑定 */
    bindable: boolean;
}

/** 模板里的一个元素。属性没有位置信息，靠重新扫描标签头部得到 */
export interface ElementInfo {
    name: string;
    /** `<` 的位置 */
    start: number;
    /** 标签名结束的位置 */
    name_end: number;
    /** 元素结束的位置 */
    end: number;
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
    /** 找出覆盖某个偏移的元素（模板里） */
    element_at(offset: number): ElementInfo | null;
    /** 导入的某个组件接受哪些属性（来自它自己的 `$props<...>()`） */
    component_props(name: string): ComponentProp[];
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
                        if (typeof chunk === 'string') continue;

                        // 绑定值（`bind:value={ ... }`）不是表达式；
                        // 但里面 get / set / listen / 变量这些是 TS 解析出来的，照样要诊断
                        if (!('type' in chunk)) {
                            for (const item of [chunk.expression, chunk.get, chunk.set, chunk.listen]) {
                                if (item) expressions.push(item);
                            }

                            continue;
                        }

                        expressions.push(chunk);
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

/** 类型字面量的最小结构（够用就行，不把整个 TSESTree 拉进来） */
interface TypeLiteralLike {
    type: string;
    members?: Array<{
        type: string;
        optional?: boolean;
        key?: { type: string; name?: string };
        typeAnnotation?: { typeAnnotation?: { range?: [number, number] } };
    }>;
}

/** 从 `{ label: string; count?: number }` 这样的类型字面量读出属性 */
function members_of(node: TypeLiteralLike, source: string): ComponentProp[] {
    if (node.type !== 'TSTypeLiteral' || !node.members) return [];

    const props: ComponentProp[] = [];

    for (const member of node.members) {
        if (member.type !== 'TSPropertySignature') continue;
        if (member.key?.type !== 'Identifier' || !member.key.name) continue;

        const range = member.typeAnnotation?.typeAnnotation?.range;

        props.push({
            name: member.key.name,
            optional: member.optional === true,
            type: range ? source.slice(range[0], range[1]) : 'unknown',
            bindable: false
        });
    }

    return props;
}

/** 组件的 `$props<{...}>()` 接受哪些属性 */
function props_of(script: Script | null, source: string): ComponentProp[] {
    if (!script) return [];

    for (const statement of script.content.body) {
        if (statement.type !== 'VariableDeclaration') continue;

        for (const declarator of statement.declarations) {
            const init = declarator.init;

            if (init?.type !== 'CallExpression') continue;
            if (init.callee.type !== 'Identifier' || init.callee.name !== '$props') continue;

            // 泛型参数：新版 estree 放 typeArguments，旧版放 typeParameters
            const call = init as unknown as {
                typeArguments?: { params: TypeLiteralLike[] };
                typeParameters?: { params: TypeLiteralLike[] };
            };
            const argument = (call.typeArguments ?? call.typeParameters)?.params[0];
            const props = argument ? members_of(argument, source) : [];

            // 哪些属性是双向绑定的，看解构里有没有 `$bindable(...)`
            const bound = bindable_names(declarator.id);

            for (const prop of props) prop.bindable = bound.has(prop.name);

            return props;
        }
    }

    return [];
}

/** 解构模式里写了 `$bindable(...)` 的项：`{ count = $bindable(0) }` */
function bindable_names(id: unknown): Set<string> {
    const names = new Set<string>();

    const pattern = id as {
        type?: string;
        properties?: Array<{
            type?: string;
            value?: {
                type?: string;
                left?: { type?: string; name?: string };
                right?: { type?: string; callee?: { type?: string; name?: string } };
            };
        }>;
    };

    if (pattern.type !== 'ObjectPattern' || !pattern.properties) return names;

    for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        if (property.value?.type !== 'AssignmentPattern') continue;
        if (property.value.right?.type !== 'CallExpression') continue;
        if (property.value.right.callee?.name !== '$bindable') continue;

        const target = property.value.left;
        if (target?.type !== 'Identifier' || !target.name) continue;

        names.add(target.name);
    }

    return names;
}

/** 解析过的组件：路径 -> 属性。文件保存时失效 */
const component_cache = new Map<string, ComponentProp[]>();

export function forget_component(path: string): void {
    component_cache.delete(path);
}

function component_props_at(path: string): ComponentProp[] {
    const cached = component_cache.get(path);
    if (cached) return cached;

    let props: ComponentProp[] = [];

    try {
        const source = readFileSync(path, 'utf8');

        props = props_of(parse(source, { filename: path }).script, source);
    } catch {
        props = [];
    }

    component_cache.set(path, props);

    return props;
}

/** script 里 `import Foo from './Foo.grain'` 全收集起来 */
function imported_components(script: Script | null, filename: string): Map<string, ComponentProp[]> {
    const components = new Map<string, ComponentProp[]>();
    if (!script) return components;

    for (const statement of script.content.body) {
        if (statement.type !== 'ImportDeclaration') continue;

        const specifier = statement.source.value;
        if (typeof specifier !== 'string' || !specifier.endsWith('.grain')) continue;

        const binding = statement.specifiers.find((item) => item.type === 'ImportDefaultSpecifier') as
            | { local?: { name?: string } }
            | undefined;

        if (!binding?.local?.name) continue;

        components.set(binding.local.name, component_props_at(resolve(dirname(filename), specifier)));
    }

    return components;
}

function element_at(nodes: TemplateNode[], offset: number): ElementInfo | null {
    for (const node of nodes) {
        const children: TemplateNode[] =
            node.type === 'element' || node.type === 'IfBlock' || node.type === 'ForBlock'
                ? [
                      ...node.children,
                      ...(node.type === 'IfBlock' ? node.alternates.flatMap((item) => item.children) : []),
                      ...(node.type === 'ForBlock' && node.fallback ? node.fallback.children : [])
                  ]
                : [];

        if (node.type === 'element' && offset >= node.start && offset <= node.end) {
            return {
                name: node.name,
                start: node.start,
                name_end: node.start + 1 + node.name.length,
                end: node.end
            };
        }

        const nested = element_at(children, offset);
        if (nested) return nested;
    }

    return null;
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
    const components = imported_components(root?.script ?? null, filename);

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

        element_at(offset: number): ElementInfo | null {
            return root ? element_at(root.template.children, offset) : null;
        },

        component_props(name: string): ComponentProp[] {
            return components.get(name) ?? [];
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


