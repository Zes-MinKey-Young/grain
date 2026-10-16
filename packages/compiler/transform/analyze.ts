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
    /**
     * 派生局部变量的有效期（`[from, to)`）—— 只有派生才有。
     *
     * 过了 `to` 写它就不再刷根变量了（借用已经结束）。语言服务拿它判断某个位置
     * 还该不该画响应式下划线。
     */
    aliveFrom?: number;
    /** `Infinity` 表示活到函数末尾 */
    aliveTo?: number;
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

/**
 * 借用规则给出的一条提示（不是错误：产物照样能跑，只是那一下不会刷新）。
 */
export interface BorrowWarning {
    start: number;
    end: number;
    message: string;
}

/**
 * 一个派生局部变量的有效期：`[from, to)`。
 *
 * - `from`：声明语句结束处 —— 之前它还不存在
 * - `to`：让它失效的那条语句的起点。`Infinity` 表示活到函数末尾
 *
 * `to` 之前写它是有响应性的（等于写根上那条路径），之后就不是了。
 */
export interface BorrowWindow {
    from: number;
    to: number;
    /** 从哪个根变量派生出来的 */
    root: string;
}

export interface ScriptAnalysis {
    states: Map<string, StateInfo>;
    functions: Map<string, FunctionInfo>;
    warnings: BorrowWarning[];
}

/**
 * 这条语句写的是哪个名字（路径的第一段）。不是写操作就 null。
 *
 * 三种写：赋值、自增自减、容器方法（`arr.push(x)` / `map.set(k, v)`）。
 */
function writtenName(node: TSESTree.Node): string | null {
    const target =
        node.type === 'AssignmentExpression'
            ? node.left
            : node.type === 'UpdateExpression'
              ? node.argument
              : node.type === 'CallExpression' &&
                  node.callee.type === 'MemberExpression' &&
                  node.callee.property.type === 'Identifier' &&
                  MUTATION_METHODS.has(node.callee.property.name)
                ? node.callee.object
                : null;

    return target ? baseNameOf(target) : null;
}

/** 路径的第一段（`minkey.name` -> `minkey`）；不是标识符打头的就 null */
function baseNameOf(node: TSESTree.Node): string | null {
    let base: TSESTree.Node = node;

    while (base.type === 'MemberExpression') base = base.object;

    return base.type === 'Identifier' ? base.name : null;
}

/**
 * 逃逸出去的根变量：`other = arr` —— 把根交给了**另一个响应式变量**。
 *
 * 之后改 `other` 等于改 `arr`，而那一侧编译期看不见（它可能在别的组件里），
 * 所以 `arr` 的借用也得失效。
 *
 * 只看简单形式：左边是响应式变量、右边直接是响应式变量的标识符。`other.foo = arr`
 * 那种不处理 —— 保守的收益很小，误判的代价更大。
 */
function escapedRoots(node: TSESTree.Node, states: Map<string, StateInfo>): string[] {
    if (node.type !== 'AssignmentExpression') return [];
    if (node.left.type !== 'Identifier' || !states.has(node.left.name)) return [];
    if (node.right.type !== 'Identifier' || !states.has(node.right.name)) return [];

    return [node.right.name];
}

/** 这个 state 是 Map 吗 —— 看初始值源码的形状（`new Map(...)`） */
function isMapState(state: StateInfo): boolean {
    return /^new\s+Map\s*\(/.test(state.init.trim());
}

/**
 * 这个初始化表达式是从响应式容器里**取出一项**吗。
 *
 * 两种形式：
 *
 * - `arr[2]` / `arr.prop` —— 数组、普通对象
 * - `map.get('b')` —— Map。它的项不是属性，只能走 `get`。key 原样记下，正好喂给
 *   `setPath(key, prop)` —— 那个签名本来就是 `(key, prop)`
 *
 * @returns `null` 表示这不是取出，按普通变量处理
 */
function takeoutOf(
    init: TSESTree.Node,
    states: Map<string, StateInfo>,
    source: string
): { root: string; path: string; index?: string; map: boolean; bracket: boolean } | null {
    // `arr[2]` / `arr.prop`
    if (init.type === 'MemberExpression') {
        const root = rootOf(init);
        const state = root ? states.get(root) : undefined;

        // 根得是"追踪内部"的那一级，否则它内部变化本来就不追踪
        if (!root || !state || state.level < 1) return null;

        const cell = init as TSESTree.MemberExpression;

        return {
            root,
            path: pathOf(init) ?? root,
            // 下标表达式原样记下：动态的（`arr[i]`）也能定位到那一行
            index: cell.computed ? slice(source, cell.property.range) : undefined,
            map: isMapState(state),
            bracket: cell.computed
        };
    }

    // `map.get('b')`
    if (init.type === 'CallExpression') {
        const callee = init.callee;

        if (
            callee.type !== 'MemberExpression' ||
            callee.property.type !== 'Identifier' ||
            callee.property.name !== 'get' ||
            callee.object.type !== 'Identifier'
        ) {
            return null;
        }

        const root = callee.object.name;
        const state = states.get(root);

        // 只对 Map 认 —— 数组没有 `get`，写了就是用户自己的错，别去猜
        if (!state || state.level < 1 || !isMapState(state)) return null;

        const key = init.arguments[0];

        return {
            root,
            // 路径退化成根：Map 的项没有"路径"可言，靠 key 定位
            path: root,
            index: key ? slice(source, key.range) : undefined,
            map: true,
            bracket: false
        };
    }

    return null;
}

/**
 * 借用规则：算出每个派生局部变量的**有效期**，并挑出越界的写入。
 *
 * 照 Rust 的精神 —— 一个根变量同时只能有一个活跃的借用：
 *
 * - 后一次取出让前一次失效（`const minkey = arr[2]; const qaqFei = arr[0]`）
 * - 写根变量（`arr = [...]` / `arr.sort()`）让之前的全部失效
 * - 根变量逃逸（`other = arr`）也让它失效
 *
 * 跟以前不同的是**位置敏感**：失效发生在让它失效的那条语句**之后**，在那之前
 * 那些引用仍然是响应式的。所以这里记的是区间，不是一个布尔。
 */
function analyzeBorrows(
    node: FunctionLike,
    states: Map<string, StateInfo>,
    source: string
): {
    windows: Map<string, BorrowWindow>;
    warnings: BorrowWarning[];
    /** 派生成功的局部变量，交给调用方登记进 `states` */
    derived: DerivedLocal[];
} {
    const windows = new Map<string, BorrowWindow>();
    const warnings: BorrowWarning[] = [];
    const derived: DerivedLocal[] = [];

    /** 根 -> 它当前活着的那个派生名 */
    const alive = new Map<string, string>();

    /** 写入点。有效期是边扫边回填的，所以先记下、最后再判越界 */
    const writes: Array<{ name: string; at: number; start: number; end: number }> = [];

    const kill = (root: string, at: number): void => {
        const name = alive.get(root);

        if (name === undefined) return;

        const window = windows.get(name);

        if (window) window.to = at;

        alive.delete(root);
    };

    simpleTraverse(node, {
        enter(child) {
            // 取出：`const x = arr[i]` / `const x = arr.prop` / `const x = map.get('b')`
            if (child.type === 'VariableDeclaration') {
                for (const declarator of child.declarations) {
                    const init = declarator.init;

                    if (!init || declarator.id.type !== 'Identifier') continue;

                    const taken = takeoutOf(init, states, source);

                    if (!taken) continue;

                    // Map 的项不是属性（`scores['b']` 会被当成 `scores.b`，产物读到一个
                    // undefined）—— 明确说一声，别生成坏东西
                    if (taken.map && taken.bracket) {
                        warnings.push({
                            start: init.range[0],
                            end: init.range[1],
                            message:
                                `\`${taken.root}\` is a Map — its entries are not properties. ` +
                                `Use \`${taken.root}.get(key)\` instead of the bracket form`
                        });

                        continue;
                    }

                    // 同一个根上之前那个，到这条语句为止
                    kill(taken.root, child.range[0]);

                    if (child.kind !== 'const') {
                        warnings.push({
                            start: declarator.id.range[0],
                            end: declarator.id.range[1],
                            message:
                                `\`${declarator.id.name}\` takes a value out of \`${taken.root}\` ` +
                                `but is not \`const\` — use \`const ${declarator.id.name}\` if the changes should stick`
                        });

                        // 不算派生，也就别占着"活跃借用"的位置
                        continue;
                    }

                    alive.set(taken.root, declarator.id.name);
                    windows.set(declarator.id.name, {
                        from: child.range[1],
                        to: Infinity,
                        root: taken.root
                    });
                    derived.push({
                        name: declarator.id.name,
                        root: taken.root,
                        path: taken.path,
                        index: taken.index,
                        init: slice(source, init.range),
                        range: declarator.range
                    });
                }

                return;
            }

            // 会移动 / 删除已有项的操作，以及根变量逃逸 —— 之前取出的全部失效。
            //
            // 这里刻意**不是**"写了根变量就失效"：`arr.push(x)` 也写根，但它只追加，
            // 已有项的位置和引用都不变，之前取出的 `arr[2]` 还指着同一项。
            // 判死了会错杀 `const minkey = arr[2]; arr.push(...); minkey.language = ...`
            // 这种写法（level 示例就是）
            const disrupted = disruptsBorrow(child);

            if (disrupted && states.has(disrupted)) kill(disrupted, child.range[0]);
            for (const root of escapedRoots(child, states)) kill(root, child.range[0]);

            const name = writtenName(child);

            if (name !== null) {
                writes.push({ name, at: child.range[0], start: child.range[0], end: child.range[1] });
            }
        }
    });

    // 越界写：过了有效期还写它 —— 那一下不会刷新，说一声
    for (const write of writes) {
        const window = windows.get(write.name);

        if (!window || write.at < window.to) continue;

        warnings.push({
            start: write.start,
            end: write.end,
            message:
                `\`${write.name}\` is no longer reactive here — it was borrowed from \`${window.root}\`, ` +
                'and that root was reassigned (or borrowed again) in between'
        });
    }

    return { windows, warnings, derived };
}

/** `analyzeBorrows` 认出来的一个派生局部变量 */
interface DerivedLocal {
    name: string;
    root: string;
    path: string;
    index?: string;
    init: string;
    range: [number, number];
}

/**
 * 这些方法会原地修改数组 / 对象 / Map / Set，视为对变量的写。
 *
 * 漏了 Map / Set 那几个（`set` / `add` / `delete` / `clear`）的后果：写了它们的顶层
 * 函数 `writes` 是空的，`functionWrappers` 直接跳过 —— 于是 `scores.set(k, v)` 不生成
 * `list.setKey(...)`，`{#for [k, v] of scores}` 那块不刷新。只有被模板**直接**引用的
 * 函数能靠 `handler()` 那条路侥幸 work，包在箭头函数里调的就彻底不刷。
 */
export const MUTATION_METHODS = new Set([
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

/**
 * 这些方法会**移动 / 删除已有**的项 —— 之前从容器里取出来的引用就可能指错地方了，
 * 借用得失效。
 *
 * 刻意不含 `push` / `set` / `add` / `delete`：
 *
 * - `push` 只追加，已有项的位置和引用都不变 —— `arr.push(x)` 之后 `arr[2]` 还是
 *   原来那一项（level 示例正是这个用法：取出 `minkey` 再 push，接着改 `minkey`）
 * - `map.set(k, v)` / `set.add(v)` 只动那一项；`delete` 删掉的那一项已经被
 *   `removeKey` 处理，别的项没动
 *
 * 保守该"一律失效"，但那会把上面这些正常用法也判死，而它们在语义上确实安全。
 */
const DISPLACING_METHODS = new Set([
    'clear',
    'copyWithin',
    'fill',
    'pop',
    'reverse',
    'shift',
    'sort',
    'splice',
    'unshift'
]);

/**
 * 这类操作会让借用失效吗 —— 用于借用规则，不是用来记"写了什么"。
 *
 * 跟 `MUTATION_METHODS` 两回事：后者是"这个调用动了容器"（用来决定要不要刷新），
 * 这个是"这个操作让之前取出的引用靠不住了"。
 */
export function disruptsBorrow(node: TSESTree.Node): string | null {
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
        const target = node.type === 'AssignmentExpression' ? node.left : node.argument;

        // 整体重赋值（`arr = [...]`）会换掉整个容器；`arr[1] = ...` 不会
        return target.type === 'Identifier' ? target.name : null;
    }

    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = node.callee.property;

        if (method.type !== 'Identifier' || !DISPLACING_METHODS.has(method.name)) return null;

        let base: TSESTree.Node = node.callee.object;

        while (base.type === 'MemberExpression') base = base.object;

        return base.type === 'Identifier' ? base.name : null;
    }

    return null;
}

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
    aliases?: Map<string, string>,
    /**
     * 派生局部变量的有效期。给了的话，**过了有效期**写它就不算数 ——
     * 那时候它已经不指向根上的那条路径了，刷新一个跟它无关的数组没有意义
     *（`analyzeBorrows` 算出来的）。
     */
    windows?: Map<string, BorrowWindow>
): Set<string> {
    const paths = new Set<string>();

    /** 这个位置上的 `name` 还算响应式吗 */
    const live = (name: string, at: number): boolean => {
        const window = windows?.get(name);

        if (!window) return true;

        return at >= window.from && at < window.to;
    };

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
                        // 过了有效期的派生：它已经不指向根上那条路径了
                        const base = baseNameOf(one);

                        if (base !== null && !live(base, child.range[0])) continue;

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
                        const base = baseNameOf(callee.object);

                        if (base !== null && !live(base, child.range[0])) break;

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

    /** 先只把函数挑出来 —— 借用分析要跑在算 `writes` 之前（它给出有效期） */
    const fnNodes: Array<{
        name: string;
        node: FunctionLike;
        declaration: [number, number];
        keyword: string;
    }> = [];

    for (const statement of program.body) {
        if (statement.type === 'VariableDeclaration') {
            for (const declarator of statement.declarations) {
                const init = declarator.init;

                if (!init || declarator.id.type !== 'Identifier') continue;
                if (isState(init)) continue;

                if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
                    fnNodes.push({
                        name: declarator.id.name,
                        node: init,
                        // 换掉整个声明语句（`const f = () => {...};`），
                        // 包装后才写得出 `const f = function f(...) {...}`
                        declaration: statement.range,
                        keyword: statement.kind
                    });
                }
            }
        } else if (statement.type === 'FunctionDeclaration' && statement.id) {
            fnNodes.push({
                name: statement.id.name,
                node: statement,
                declaration: statement.range,
                keyword: 'function'
            });
        }
    }

    // 借用规则：每个派生局部变量的有效期 + 越界写的提示。
    //
    // 必须在算 `writes` 之前跑 —— `collectWrites` 要用有效期过滤掉"失效之后那些
    // 写入"，否则会为一条早就跟根变量无关的路径生成刷新。
    const windows = new Map<string, BorrowWindow>();
    const warnings: BorrowWarning[] = [];
    const derived: DerivedLocal[] = [];

    for (const item of fnNodes) {
        const result = analyzeBorrows(item.node, states, source);

        for (const [name, window] of result.windows) windows.set(name, window);

        warnings.push(...result.warnings);
        derived.push(...result.derived);
    }

    for (const item of fnNodes) {
        functions.set(item.name, {
            ...item,
            writes: collectWrites(item.node, shallow, undefined, windows)
        });
    }

    // 第三遍：把派生局部变量登记进 `states`（`const minkey = arr[2]`）。
    //
    // 它继承根变量的响应性 —— 写它就等于写根上那条路径。记的是**路径**而不是根名：
    // `minkey.name = 'x'` 要解析成 `arr[2].name`，才能只刷真正读它的那些片段。
    //
    // **不管是否最终失效都登记**：失效是位置敏感的，在失效点之前它仍然响应式。
    // "失效之后"那部分由 `collectWrites` 按有效期过滤（越界的写入不进 `writes`，
    // 也就不会有刷新），提示收在 `warnings` 里。
    for (const item of derived) {
        if (states.has(item.name)) continue;

        const window = windows.get(item.name);

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
            fromIndex: item.index,
            // 有效期：语言服务按它判断"这个位置还响应式吗"
            aliveFrom: window?.from,
            aliveTo: window?.to
        });
    }

    return { states, functions, warnings };
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
