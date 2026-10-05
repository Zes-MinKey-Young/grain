import { simpleTraverse } from '@typescript-eslint/typescript-estree';
import type { TSESTree } from '@typescript-eslint/typescript-estree';


import type { TSProgram } from '../types.js';

/** `let count = $state(0)` 里的 `count` */
export interface StateInfo {
    name: string;
    /** `$state(...)` 里初始值表达式的源码 */
    init: string;
    /** 整个 `$state(...)` 调用在 SFC 里的 range */
    range: [number, number];
}

export type FunctionLike =
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression;

export interface FunctionInfo {
    name: string;
    node: FunctionLike;
    /** 这个函数写了哪些 state（含它内部嵌套函数写的） */
    writes: Set<string>;
}

export interface ScriptAnalysis {
    states: Map<string, StateInfo>;
    functions: Map<string, FunctionInfo>;
}

/** 这些方法会原地修改数组 / 对象，视为对变量的写 */
const MUTATION_METHODS = new Set([
    'copyWithin',
    'fill',
    'pop',
    'push',
    'reverse',
    'shift',
    'sort',
    'splice',
    'unshift'
]);

function slice(source: string, range: [number, number]): string {
    return source.slice(range[0], range[1]);
}

/** 赋值目标的最底层变量名：`a` -> a，`a.b.c` -> a，`[x, y] = ...` -> x, y */
function base_names(node: TSESTree.Node): string[] {
    switch (node.type) {
        case 'Identifier':
            return [node.name];

        case 'MemberExpression':
            return base_names(node.object);

        case 'ObjectPattern':
            return node.properties.flatMap((property) =>
                property.type === 'RestElement' ? base_names(property.argument) : base_names(property.value)
            );

        case 'ArrayPattern':
            return node.elements.flatMap((element) => (element ? base_names(element) : []));

        case 'RestElement':
            return base_names(node.argument);

        case 'AssignmentPattern':
            return base_names(node.left);

        default:
            return [];
    }
}

/** 收集一段代码写过的变量名 */
export function collect_writes(node: TSESTree.Node): Set<string> {
    const names = new Set<string>();

    simpleTraverse(node, {
        enter(child) {
            switch (child.type) {
                case 'AssignmentExpression':
                    for (const name of base_names(child.left)) names.add(name);
                    break;

                case 'UpdateExpression':
                    for (const name of base_names(child.argument)) names.add(name);
                    break;

                case 'CallExpression': {
                    const callee = child.callee;
                    if (
                        callee.type === 'MemberExpression' &&
                        callee.property.type === 'Identifier' &&
                        MUTATION_METHODS.has(callee.property.name)
                    ) {
                        for (const name of base_names(callee.object)) names.add(name);
                    }
                    break;
                }
            }
        }
    });

    return names;
}

/** 收集一段代码读过的变量名（属性名不算） */
export function collect_reads(node: TSESTree.Node): Set<string> {
    const names = new Set<string>();

    simpleTraverse(node, {
        enter(child, parent) {
            if (child.type !== 'Identifier') return;

            // `obj.count` 的 count、`{ count: 1 }` 的 key 都不是变量引用
            if (parent?.type === 'MemberExpression' && parent.property === child && !parent.computed) return;
            if (parent?.type === 'Property' && parent.key === child && !parent.computed) return;

            names.add(child.name);
        }
    });

    return names;
}

/** 扫描 `<script>` 顶层：找出 `$state` 变量和顶层函数 */
export function analyze_script(program: TSProgram, source: string): ScriptAnalysis {
    const states = new Map<string, StateInfo>();
    const functions = new Map<string, FunctionInfo>();

    for (const statement of program.body) {
        if (statement.type === 'VariableDeclaration') {
            for (const declarator of statement.declarations) {
                const init = declarator.init;
                if (!init || declarator.id.type !== 'Identifier') continue;

                if (
                    init.type === 'CallExpression' &&
                    init.callee.type === 'Identifier' &&
                    init.callee.name === '$state'
                ) {
                    const argument = init.arguments[0];

                    states.set(declarator.id.name, {
                        name: declarator.id.name,
                        init: argument ? slice(source, argument.range) : 'undefined',
                        range: init.range
                    });
                } else if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
                    functions.set(declarator.id.name, {
                        name: declarator.id.name,
                        node: init,
                        writes: collect_writes(init)
                    });
                }
            }
        } else if (statement.type === 'FunctionDeclaration' && statement.id) {
            functions.set(statement.id.name, {
                name: statement.id.name,
                node: statement,
                writes: collect_writes(statement)
            });
        }
    }

    return { states, functions };
}

export function intersects(a: Set<string>, b: Set<string>): boolean {
    for (const value of a) if (b.has(value)) return true;
    return false;
}
