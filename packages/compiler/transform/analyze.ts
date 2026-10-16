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
     * 这个变量是从哪条**路径**上取出来的（`const minkey = arr[2]` → `'arr[2]'`）。
     *
     * 顶层 `$state` 没有这个字段。有的话，写它就等于写那条路径 —— `minkey.name = 'x'`
     * 解析成 `arr[2].name`，只有读它的片段才刷。
     *
     * 下标是动态的（`arr[i]`）时这里是根变量名（`arr`）—— 依赖侧保守处理。
     */
    fromPath?: string;
    /**
     * 取出来时的**下标表达式**（`arr[2]` → `'2'`，`arr[i]` → `'i'`）。
     *
     * `setPath(i, prop)` 要用它定位是哪一行。跟 `fromPath` 分开记：依赖侧希望动态下标
     * 保守（退回整个容器），而精确定位希望能找到具体那一行。
     */
    fromIndex?: string;
}

export type FunctionLike =
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression;

export interface FunctionInfo {
    name: string;
    node: FunctionLike;
    /**
     * 整个声明在源码里的范围 —— 包装时要替换的就是这一段。
     *
     * `function f() {}` 就是 `node.range`；`const f = () => {}` 是**整个声明语句**
     * （含 `const f =` 和分号），因为包装后要写成 `const f = function f() {...}`。
     */
    declaration: [number, number];
    /** 声明关键字：`const` / `let` / `var` / `function`。包装时原样带上 */
    keyword: string;
    /** 这个函数写了哪些 state（含它内部嵌套函数写的） */
    writes: Set<string>;
}

export interface ScriptAnalysis {
    states: Map<string, StateInfo>;
    functions: Map<string, FunctionInfo>;
}

/**
 * 这些方法会原地修改数组 / 对象 / Map / Set，视为对变量的写。
 *
 * 漏了 Map / Set 那几个（`set` / `add` / `delete` / `clear`）的后果：写了它们的顶层
 * 函数 `writes` 是空的，`functionWrappers` 直接跳过 —— 于是 `scores.set(k, v)` 不生成
 * `list.setKey(...)`，`{#for [k, v] of scores}` 那块不刷新。只有被模板**直接**引用的
 * 函数能靠 `handler()` 那条路侥幸 work，包在箭头函数里调的就彻底不刷。
 */
const MUTATION_METHODS = new Set([
    'add',
    'clear',
    'copyWithin',
    'delete',
    'fill',
    'pop',
    'push',
    'reverse',
    'set',
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
 * 把一个引用表达式转成**路径**：`arr` / `arr[2]` / `arr[2].name`。
 *
 * 下标或键是动态的（`arr[i]`、`obj[k]`）时退化成根变量 —— 那种情况静态看不出改的是
 * 哪一格，只能按整个容器算。
 *
 * `aliases` 是派生局部变量（`const minkey = arr[2]` 里的 `minkey`）：它的路径就是
 * 右边那条，于是 `minkey.name` 会解析成 `arr[2].name`。
 */
export function pathOf(
    node: TSESTree.Node,
    aliases?: Map<string, string>
): string | null {
    if (node.type === 'Identifier') {
        return aliases?.get(node.name) ?? node.name;
    }

    if (node.type !== 'MemberExpression') return null;

    const base = pathOf(node.object, aliases);

    if (!base) return null;

    // `a.b`：静态属性名
    if (!node.computed) {
        if (node.property.type !== 'Identifier') return null;

        return `${base}.${node.property.name}`;
    }

    // `a[2]`：字面量下标
    if (node.property.type === 'Literal' && typeof node.property.value === 'number') {
        return `${base}[${node.property.value}]`;
    }

    if (node.property.type === 'Literal' && typeof node.property.value === 'string') {
        return `${base}.${node.property.value}`;
    }

    // 动态下标：说不清是哪一格，按整个容器算
    return base;
}

/** 路径按 `.` / `[` 切开，用来做前缀比较 */
function segmentsOf(path: string): string[] {
    return path.replace(/\[(\d+)\]/g, '.$1').split('.');
}

/**
 * 这两条路径有关系吗（一个是另一个的前缀）？
 *
 * 写了 `arr[2].name` 该刷：读 `arr[2].name` 的、读 `arr[2]` 的（整个对象换了）、读 `arr`
 * 的（容器内部变了）。但不该刷读 `arr[0].name` 的 —— 那是另一项。
 */
export function touches(write: string, read: string): boolean {
    if (write === read) return true;

    const a = segmentsOf(write);
    const b = segmentsOf(read);
    const shared = Math.min(a.length, b.length);

    for (let i = 0; i < shared; i += 1) {
        if (a[i] !== b[i]) return false;
    }

    return true;
}

/**
 * 收集一段代码读过的**路径**（属性名本身不算 —— `obj.count` 的 count 不是变量）。
 */
export function collectReads(node: TSESTree.Node, aliases?: Map<string, string>): Set<string> {
    const paths = new Set<string>();

    simpleTraverse(node, {
        enter(child, parent) {
            if (child.type !== 'Identifier') return;

            // `obj.count` 的 count、`{ count: 1 }` 的 key 都不是变量引用
            if (parent?.type === 'MemberExpression' && parent.property === child && !parent.computed) return;
            if (parent?.type === 'Property' && parent.key === child && !parent.computed) return;

            // 属性名由 pathOf 收，这里只收裸标识符（或派生变量的根）
            if (parent?.type === 'MemberExpression' && parent.object === child) return;

            const path = pathOf(child, aliases);

            if (path) paths.add(path);
        }
    });

    // `arr[2].name`： Identifier 只给了 `arr`，整条链要另外收
    simpleTraverse(node, {
        enter(child) {
            if (child.type !== 'MemberExpression') return;

            const path = pathOf(child, aliases);

            if (path) paths.add(path);
        }
    });

    return paths;
}

/**
 * 收集一段代码写过的**路径**。
 *
 * `shallow` 里是级别 0 的 `$state` 变量：改它们**内部**不算写（`obj.a = 1`），
 * 只有把它们整个换掉才算（`obj = { ... }`）。
 */
export function collectWrites(
    node: TSESTree.Node,
    shallow?: Set<string>,
    aliases?: Map<string, string>
): Set<string> {
    const paths = new Set<string>();

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

                    // 解构赋值（`[a[0], a[1]] = [x, y]`）：每一项各自是一条路径
                    const targets =
                        target.type === 'ArrayPattern'
                            ? target.elements.filter((element) => element !== null)
                            : [target];

                    for (const one of targets) {
                        const path = pathOf(one, aliases);

                        if (path) paths.add(path);
                    }
                    break;
                }

                case 'CallExpression': {
                    const callee = child.callee;
                    if (
                        callee.type === 'MemberExpression' &&
                        callee.property.type === 'Identifier' &&
                        MUTATION_METHODS.has(callee.property.name)
                    ) {
                        // 容器方法（`arr.push(...)`）改的是整个容器
                        const path = pathOf(callee.object, aliases);

                        if (path) paths.add(path);
                    }
                    break;
                }
            }
        }
    });

    return paths;
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
                // 名字那一段：`let typed: Foo = $state(...)` 的 `id.range` 连类型注解
                // 一起包了（`typed: Foo`），拿它做下划线会多画一截
                nameRange: findNameRange(declarator.id.range, declarator.id.name, source),
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
                        // 换掉整个声明语句（`const f = () => {...};`），
                        // 包装后才写得出 `const f = function f(...) {...}`
                        declaration: statement.range,
                        keyword: statement.kind,
                        writes: collectWrites(init, shallow)
                    });
                }
            }
        } else if (statement.type === 'FunctionDeclaration' && statement.id) {
            functions.set(statement.id.name, {
                name: statement.id.name,
                node: statement,
                declaration: statement.range,
                keyword: 'function',
                writes: collectWrites(statement, shallow)
            });
        }
    }

    // 第三遍：从响应式变量里取出来的局部变量（`const minkey = arr[2]`）。
    //
    // 它继承根变量的响应性 —— 之后写它就等于写根上那一条路径。记的是**路径**而不是
    // 根名：`minkey.name = 'x'` 要解析成 `arr[2].name`，才能只刷真正读它的那些片段。
    //
    // 借用规则（照 Rust 的精神）：对同一个根变量，**后一次取出让前一次的全部失效**；
    // 写根变量也让之前取出的全部失效。原因是重新排列或者删除之后，先前取出的那个局部
    // 变量可能已经指向一个不在数组里的东西，再写它就会去刷新一个跟它无关的数组 ——
    // 而到底是哪一种情况，编译期判断不了，所以用这条静态规则一刀切。
    for (const info of functions.values()) {
        /** 根变量 -> 它当前还"活着"的那个派生名 */
        const alive = new Map<string, string>();

        /** 这个函数里派生成功的局部变量（最后统一登记进 states） */
        const borrowed: Array<{
            name: string;
            root: string;
            path: string;
            index?: string;
            init: string;
            range: [number, number];
        }> = [];

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
                            const path = pathOf(child.init) ?? root!;
                            const cell = child.init as TSESTree.MemberExpression;

                            // 同一个根上之前取过的那些，到这儿就失效了
                            kill(root!);

                            alive.set(root!, child.id.name);
                            borrowed.push({
                                name: child.id.name,
                                root: root!,
                                path,
                                // 下标表达式原样记下：动态的（`arr[i]`）也能定位到那一行
                                index: cell.computed ? slice(source, cell.property.range) : undefined,
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
                // 它对应的路径：`minkey` -> `arr[2]`
                fromPath: item.path,
                // 下标表达式：动态的（`arr[i]`）也记下，`setPath` 要靠它定位
                fromIndex: item.index
            });
        }
    }

    return { states, functions };
}

/**
 * 这两组路径有交集吗？
 *
 * 用 `touches`（前缀匹配）而不是集合相交：写了 `arr[2].name` 该刷读 `arr[2].name` 的、
 * 读 `arr[2]` 的、读 `arr` 的，但不该刷读 `arr[0].name` 的 —— 那是另一项。
 */
export function intersects(reads: Set<string>, writes: Set<string>): boolean {
    for (const write of writes) {
        for (const read of reads) {
            if (touches(write, read)) return true;
        }
    }

    return false;
}
