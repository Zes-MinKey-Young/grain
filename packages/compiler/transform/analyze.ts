// 这个包标了 `__esModule` 却没有 default 导出，所以只能具名导入：
// 默认导入在 CJS 下拿到的是 undefined（扩展就是 CJS 编译的）
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
    /** 变量名自己的位置（`let x = ...` 里的 `x`）—— 派生局部变量也记 */
    nameRange: [number, number];
    /**
     * 响应式级别。
     *
     * `0`：只追踪这个变量本身被重赋值。
     * `1`：同时追踪它内部的变化（数组 / `Map` / `Set` 的默认值）。
     *
     * 原始值只能是 `0` —— 它们没有"内部"可言。
     */
    level: number;
    /**
     * 这个变量是从哪个响应式变量里取出来的（`const minkey = arr[2]` → `'arr'`）。
     *
     * 顶层 `$state` 没有这个字段。有的话，写它就等于写根上那个 —— 依赖是挂在
     * 根上的，不认这条线就漏刷新。
     */
    from?: string;
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
function baseNames(node: TSESTree.Node): string[] {
    switch (node.type) {
        case 'Identifier':
            return [node.name];

        case 'MemberExpression':
            return baseNames(node.object);

        case 'ObjectPattern':
            return node.properties.flatMap((property) =>
                property.type === 'RestElement' ? baseNames(property.argument) : baseNames(property.value)
            );

        case 'ArrayPattern':
            return node.elements.flatMap((element) => (element ? baseNames(element) : []));

        case 'RestElement':
            return baseNames(node.argument);

        case 'AssignmentPattern':
            return baseNames(node.left);

        default:
            return [];
    }
}

/**
 * 收集一段代码写过的变量名。
 *
 * `shallow` 里是级别 0 的 `$state` 变量：改它们**内部**不算写（`obj.a = 1`），
 * 只有把它们整个换掉才算（`obj = { ... }`）。
 */
export function collectWrites(node: TSESTree.Node, shallow?: Set<string>): Set<string> {
    const names = new Set<string>();

    simpleTraverse(node, {
        enter(child) {
            switch (child.type) {
                case 'AssignmentExpression':
                case 'UpdateExpression': {
                    const target =
                        child.type === 'AssignmentExpression' ? child.left : child.argument;

                    // 级别 0 的变量，改内部不算写它
                    if (
                        shallow?.size &&
                        target.type === 'MemberExpression' &&
                        target.object.type === 'Identifier' &&
                        shallow.has(target.object.name)
                    ) {
                        break;
                    }

                    for (const name of baseNames(target)) names.add(name);
                    break;
                }

                case 'CallExpression': {
                    const callee = child.callee;
                    if (
                        callee.type === 'MemberExpression' &&
                        callee.property.type === 'Identifier' &&
                        MUTATION_METHODS.has(callee.property.name)
                    ) {
                        for (const name of baseNames(callee.object)) names.add(name);
                    }
                    break;
                }
            }
        }
    });

    return names;
}

/** 收集一段代码读过的变量名（属性名不算） */
export function collectReads(node: TSESTree.Node): Set<string> {
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

/**
 * 这一个节点写了哪些 `$state` 根变量。
 *
 * 用来实现借用规则：写了根变量，之前从它取出来的局部变量就失效。
 */
function writtenRoots(node: TSESTree.Node): string[] {
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
        const target = node.type === 'AssignmentExpression' ? node.left : node.argument;

        return rootOf(target) ? [rootOf(target)!] : [];
    }

    if (node.type === 'CallExpression') {
        const callee = node.callee;

        if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
            if (MUTATION_METHODS.has(callee.property.name)) {
                const root = rootOf(callee.object);

                return root ? [root] : [];
            }
        }
    }

    return [];
}

/**
 * 声明语句里变量名的位置。
 *
 * `const minkey = arr[2]` 的 range 覆盖整句，名字要单独找 —— 在 `=` 前面那段里捞。
 */
function findNameRange(range: [number, number], name: string, source: string): [number, number] {
    const at = source.indexOf(name, range[0]);

    return at >= 0 && at < range[1] ? [at, at + name.length] : range;
}

/** `a.b.c` / `a[0].b` 这种路径最左边那个标识符 */
function rootOf(node: TSESTree.Node): string | null {
    let current: TSESTree.Node = node;

    while (current.type === 'MemberExpression') current = current.object;

    return current.type === 'Identifier' ? current.name : null;
}

/** `$state(...)` 这个调用 */
function isState(node: TSESTree.Node | null | undefined): node is TSESTree.CallExpression {
    return (
        !!node &&
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === '$state'
    );
}

/**
 * 不写第二个参数时，哪些初始值默认"追踪内部"。
 *
 * 数组、`Map`、`Set` 默认 `1` —— 它们是容器，内部变化就是它们的内容；其他（对象、
 * 类实例、函数）默认 `0`，要追踪内部得显式写出来。
 */
function defaultLevel(value: TSESTree.Expression | undefined): number {
    if (!value) return 0;

    if (value.type === 'ArrayExpression') return 1;

    if (value.type === 'NewExpression') {
        const name = value.callee.type === 'Identifier' ? value.callee.name : '';

        return name === 'Map' || name === 'Set' ? 1 : 0;
    }

    return 0;
}

/** `$state(x, level)` 的 level —— 第二个参数，只认数字字面量 */
function levelOf(call: TSESTree.CallExpression): number {
    const given = call.arguments[1];

    // `...args` 展开的说不清，按默认来
    if (given && given.type === 'Literal' && typeof given.value === 'number') return given.value;

    const first = call.arguments[0];

    return defaultLevel(first && first.type !== 'SpreadElement' ? first : undefined);
}

/** 扫描 `<script>` 顶层：找出 `$state` 变量和顶层函数 */
export function analyzeScript(program: TSProgram, source: string): ScriptAnalysis {
    const states = new Map<string, StateInfo>();
    const functions = new Map<string, FunctionInfo>();

    // 第一遍：$state 变量。级别要先定下来 —— 第二遍收集写入时要用它判断
    // "改内部算不算写这个变量"
    for (const statement of program.body) {
        if (statement.type !== 'VariableDeclaration') continue;

        for (const declarator of statement.declarations) {
            const init = declarator.init;

            if (!isState(init) || declarator.id.type !== 'Identifier') continue;

            const argument = init.arguments[0];

            states.set(declarator.id.name, {
                name: declarator.id.name,
                init: argument ? slice(source, argument.range) : 'undefined',
                range: init.range,
                nameRange: declarator.id.range,
                level: levelOf(init)
            });
        }
    }

    // 级别 0 的那些：改它们内部不算写（它们只追踪自己被重赋值）
    const shallow = new Set(
        [...states.values()].filter((state) => state.level === 0).map((state) => state.name)
    );

    for (const statement of program.body) {
        if (statement.type === 'VariableDeclaration') {
            for (const declarator of statement.declarations) {
                const init = declarator.init;

                if (!init || declarator.id.type !== 'Identifier') continue;
                if (isState(init)) continue;

                if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
                    functions.set(declarator.id.name, {
                        name: declarator.id.name,
                        node: init,
                        writes: collectWrites(init, shallow)
                    });
                }
            }
        } else if (statement.type === 'FunctionDeclaration' && statement.id) {
            functions.set(statement.id.name, {
                name: statement.id.name,
                node: statement,
                writes: collectWrites(statement, shallow)
            });
        }
    }

    // 第三遍：从响应式变量里取出来的局部变量（`const minkey = arr[2]`）。
    //
    // 它继承根变量的响应性 —— 之后写它就等于写根上那个。
    //
    // 借用规则（照 Rust 的精神）：对同一个根变量，**后一次取出让前一次的全部失效**；
    // 写根变量也让之前取出的全部失效。原因是重新排列或者删除之后，先前取出的那个局部
    // 变量可能已经指向一个不在数组里的东西，再写它就会去刷新一个跟它无关的数组 ——
    // 而到底是哪一种情况，编译期判断不了，所以用这条静态规则一刀切。
    for (const info of functions.values()) {
        /** 根变量 -> 它当前还"活着"的那个派生名 */
        const alive = new Map<string, string>();

        /** 这个函数里派生成功的局部变量（最后统一登记进 states） */
        const borrowed: Array<{ name: string; root: string; init: string; range: [number, number] }> = [];

        /** 让某个根上当前活着的派生失效 */
        const kill = (root: string): void => {
            alive.delete(root);
        };

        simpleTraverse(info.node, {
            enter(child) {
                // 取出：`const x = arr[i]` / `const x = arr.prop`
                if (child.type === 'VariableDeclarator' && child.id.type === 'Identifier' && child.init) {
                    if (child.init.type === 'MemberExpression') {
                        const root = rootOf(child.init);
                        const state = root ? states.get(root) : undefined;

                        // 根得是"追踪内部"的那一级，否则它内部变化本来就不追踪
                        if (state && state.level >= 1) {
                            // 同一个根上之前取过的那些，到这儿就失效了
                            kill(root!);

                            alive.set(root!, child.id.name);
                            borrowed.push({
                                name: child.id.name,
                                root: root!,
                                init: slice(source, child.init.range),
                                range: child.range
                            });
                        }
                    }

                    return;
                }

                // 写根变量：之前取出的全部失效
                for (const root of writtenRoots(child)) kill(root);
            }
        });

        for (const item of borrowed) {
            // 只有最后还活着的那些才真的有响应性
            if (alive.get(item.root) !== item.name) continue;
            if (states.has(item.name)) continue;

            states.set(item.name, {
                name: item.name,
                init: item.init,
                range: item.range,
                // 名字在声明语句里的位置：`const minkey = arr[2]` 的 minkey
                nameRange: findNameRange(item.range, item.name, source),
                level: states.get(item.root)!.level,
                from: item.root
            });
        }
    }

    return { states, functions };
}

export function intersects(a: Set<string>, b: Set<string>): boolean {
    for (const value of a) if (b.has(value)) return true;
    return false;
}
