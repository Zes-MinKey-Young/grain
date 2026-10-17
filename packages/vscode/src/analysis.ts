import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
    analyzeScript,
    compile,
    parse,
    parseRoot,
    splitForHeader,
    ParseError
} from '../../compiler/index.js';
import type {
    Expression,
    MacroUse,
    Root,
    RootStage,
    Script,
    TemplateNode,
    TSProgram
} from '../../compiler/index.js';
import { log } from './log.js';
import {
    buildVirtual,
    typescriptService,
    realName,
    virtualName,
    VIRTUAL_EXPORT,
    type CompletionDetail,
    type CompletionEntry,
    type Definition,
    type QuickInfo,
    type SemanticProblem,
    type SemanticSpan,
    type VirtualScript
} from './typescript.js';
import { identifierAt, walk } from './ast-utils.js';

/** 一处引用（偏移相对整个 SFC） */
export interface Reference {
    start: number;
    end: number;
}

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
    nameEnd: number;
    /** 元素结束的位置 */
    end: number;
}

export interface Analysis {
    root: Root | null;
    error: ParseError | null;
    /** 虚拟文件当前的内容；语言服务临时加载别的文件时要它 */
    virtualText(): string;
    /** script（含 module）顶层的声明，补全用 */
    declarations: Map<string, Declaration>;
    /** 所有层级的声明（含函数内部），script 里 hover / 跳转用 */
    all: Map<string, Declaration>;
    /** 找出覆盖某个偏移的模板表达式（要拿它的 TS AST 时才用得到） */
    expressionAt(offset: number): Expression | null;
    /** 找出覆盖某个偏移的 script（模板之外、script 内容之内） */
    scriptAt(offset: number): Script | null;
    /** 光标停在一次宏调用上（bind / 属性 / script 三种位置都算） */
    macroAt(offset: number): MacroUse | null;
    /** 找出覆盖某个偏移的元素（模板里） */
    elementAt(offset: number): ElementInfo | null;
    /** 导入的某个组件接受哪些属性（来自它自己的 `$props<...>()`） */
    componentProps(name: string): ComponentProp[];
    /** 语义高亮用：TS 给的符号分类（类名 / 接口 / 参数 …） */
    classifications(): SemanticSpan[];
    /** script 里的补全（模板里返回空） */
    completions(offset: number): CompletionEntry[];
    /** 补全项的签名和文档 */
    completionDetail(offset: number, name: string): CompletionDetail | null;
    /** TypeScript 语言服务给的悬停信息（带类型），只在 script 区域里有效 */
    quickInfo(offset: number): QuickInfo | null;
    /** TypeScript 的语义诊断（类型错误、未定义变量等） */
    semantic(): SemanticProblem[];
    /** 光标下标识符的全部引用（含声明本身）：script / 模板表达式 / if / for 都算 */
    references(offset: number): Reference[];
    /**
     * 所有 `$state` 变量的引用（含声明本身）。
     *
     * 扩展用它给响应式变量画黄色下划线 —— 一眼能看出哪些变量是响应式的。
     */
    stateReferences(): Reference[];
    /** 光标下的标识符名（script / module / onmount / 模板表达式 都算） */
    nameAt(offset: number): string | null;
    /** 名字对应的 `bind:this`（变量形式才有） */
    thisBindingNamed(name: string | null): ThisBinding | undefined;
    /** 跳转定义：`bind:this` 声明的变量指回模板那一处，其余交给 TS */
    definition(offset: number): Definition[];
    /** 重命名：`bind:this` 声明的变量改成模板里那一处，其余交给 TS */
    rename(offset: number): Reference[];
    /** 后台预热 TS 语言服务（加载它比较重，别放在第一次 hover 时才做） */
    warmup(): void;
    /** 编译产物（命令用） */
    compiled(): { js: string; css: string } | null;
    /** 文档关闭时把虚拟文件从语言服务里摘掉 */
    dispose(): void;
}

function collectDeclarations(source: string, script: Script | null): Map<string, Declaration> {
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

/** `$state` 声明的变量名在源码里的位置（`let x = $state(...)` 里的 `x`） */
function stateNameRanges(program: TSProgram): Array<[number, number]> {
    const found: Array<[number, number]> = [];

    for (const statement of program.body) {
        if (statement.type !== 'VariableDeclaration') continue;

        for (const declarator of statement.declarations) {
            if (declarator.id.type !== 'Identifier') continue;

            const init = declarator.init;

            if (
                init?.type === 'CallExpression' &&
                init.callee.type === 'Identifier' &&
                init.callee.name === '$state'
            ) {
                // 只取名字那一段：`let typed: Foo = $state(...)` 的 `id.range`
                // 连类型注解一起包了（`typed: Foo`），拿它做装饰会多画一截
                const [from] = declarator.id.range;

                found.push([from, from + declarator.id.name.length]);
            }
        }
    }

    return found;
}

/** `at` 之前最近的、不是空白的那个字符（没有就给空串） */
function sourceLastNonSpace(source: string, at: number): string {
    for (let i = at - 1; i >= 0; i -= 1) {
        if (!/\s/.test(source[i])) return source[i];
    }

    return '';
}

/** `at` 之后最近的、不是空白的那个字符 */
function sourceFirstNonSpace(source: string, at: number): string {
    for (let i = at; i < source.length; i += 1) {
        if (!/\s/.test(source[i])) return source[i];
    }

    return '';
}

/** 三种函数节点 */
function isFunction(node: { type?: string } | null | undefined): boolean {
    return (
        node?.type === 'FunctionDeclaration' ||
        node?.type === 'FunctionExpression' ||
        node?.type === 'ArrowFunctionExpression'
    );
}

/** 参数里绑定的名字（`(count)` / `({ a })` / `([x])` / `(n = 1)`） */
function paramNames(params: readonly any[]): string[] {
    const found: string[] = [];

    const walkPattern = (pattern: any): void => {
        if (!pattern || typeof pattern !== 'object') return;

        if (pattern.type === 'Identifier') found.push(pattern.name);
        else if (pattern.type === 'AssignmentPattern') walkPattern(pattern.left);
        else if (pattern.type === 'RestElement') walkPattern(pattern.argument);
        else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties ?? []) walkPattern(p.value ?? p);
        else if (pattern.type === 'ArrayPattern') for (const p of pattern.elements ?? []) walkPattern(p);
    };

    for (const param of params) walkPattern(param);

    return found;
}

/**
 * 哪些区间里的 `name` 是**内层同名绑定**（函数参数、块里的 let/const）。
 *
 * `stateReferencesOf` 只按名字扫（不走 TS —— 虚拟文件的偏移对不上），所以得自己
 * 判断作用域：`let count = $state(0)` 之后写 `function show(count) { return count }`，
 * 那两个 `count` 跟外面的响应式变量没关系，不该画下划线。
 *
 * 用区间而不是 `parent` 链：解析出来的节点上**没有** `parent` 字段（试过，链是空的）。
 *
 * 遮蔽范围取**整个函数 / 整个块** —— 参数和块内声明本身也落在里面，就一起排掉了。
 */
function shadowedRanges(program: TSProgram, names: ReadonlySet<string>): Array<[string, number, number]> {
    const found: Array<[string, number, number]> = [];

    walk(program, (node) => {
        if (!node || typeof node !== 'object') return;

        // 函数：参数遮蔽整个函数（连同参数列表本身）
        if (isFunction(node)) {
            const [from, to] = node.range as [number, number];

            for (const name of paramNames(node.params ?? [])) {
                if (names.has(name)) found.push([name, from, to]);
            }
        }

        // 块 / for：里面声明的同名变量遮蔽到这个节点结束
        if (
            node.type === 'BlockStatement' ||
            node.type === 'ForStatement' ||
            node.type === 'ForOfStatement' ||
            node.type === 'ForInStatement'
        ) {
            const [from, to] = node.range as [number, number];
            const holders =
                node.type === 'BlockStatement' ? (node.body ?? []) : [node.init ?? node.left];

            for (const holder of holders) {
                if (holder?.type !== 'VariableDeclaration') continue;

                for (const declarator of holder.declarations ?? []) {
                    if (declarator.id?.type === 'Identifier' && names.has(declarator.id.name)) {
                        found.push([declarator.id.name, from, to]);
                    }
                }
            }
        }
    });

    return found;
}

/**
 * 借用规则的提示 —— 跟编译器返回的是**同一份**（`analyzeScript` 的 `warnings`）。
 *
 * 两类：派生局部变量过了有效期还在写、以及不是 `const` 声明的派生。产物照跑，
 * 只是那一下不会刷新，所以是提示不是错误。
 */
function borrowProblems(source: string, root: Root | null): SemanticProblem[] {
    const found: SemanticProblem[] = [];

    if (!root) return found;

    for (const block of [root.script, root.module, root.onmount]) {
        if (!block) continue;

        const analysis = analyzeScript(block.content, source);

        // 提示和错误都走 `semantic()` —— 那边一律按 Error 报，所以 `$borrow` 的契约
        // 违反在编辑器里是红线（这正是它跟"借用越界"那种提示的区别）
        for (const problem of [...analysis.warnings, ...analysis.errors]) {
            found.push({ start: problem.start, end: problem.end, message: problem.message });
        }
    }

    return found;
}

/** 引用是不是落在某个遮蔽区间里 */
function isShadowedAt(
    blinded: ReadonlyArray<[string, number, number]>,
    name: string,
    at: number
): boolean {
    return blinded.some(([blind, from, to]) => blind === name && at >= from && at <= to);
}

/** 扫的过程中带着名字，最后才筛（有效期要等所有 script 都扫完才知道） */
type Marked = Reference & { name?: string };

/**
 * 这个引用处的借用是不是已经结束了。
 *
 * 声明本身不算 —— 它总是在区间之前（`from` 是声明语句的结束处），而那是"变量在
 * 这儿"的标注，留着。
 */
function expiredReference(
    reference: Marked,
    windows: ReadonlyMap<string, [number, number]>,
    declarations: ReadonlyMap<string, [number, number]>
): boolean {
    const name = reference.name;

    if (name === undefined) return false;

    const window = windows.get(name);

    if (!window) return false;

    const declared = declarations.get(name);

    if (declared && reference.start >= declared[0] && reference.start <= declared[1]) return false;

    return reference.start < window[0] || reference.start >= window[1];
}

/**
 * 所有 `$state` 变量的引用（含声明本身），位置是**源码**坐标。
 *
 * 自己扫而不问 TS：虚拟文件把 `$state(...)` 换成了裸值，长度跟源码不一样，TS 给的
 * 位置映射回来会错位（实测装饰落到了分号后面）。
 */
function stateReferencesOf(
    source: string,
    scripts: Array<Script | null | undefined>,
    expressions: ExpressionRegion[]
): Reference[] {
    /** 名字 -> 声明位置（`$state` 变量 + 从它们取出来的局部变量） */
    const names = new Map<string, [number, number]>();

    /**
     * 其中哪些是**顶层** `$state` 变量。
     *
     * 只有它们才做"被内层同名绑定遮蔽"的判断：派生局部变量（`const second = arr[1]`）
     * 本身就是写在函数/块里的，拿遮蔽规则去套会把它们自己排掉。
     */
    const topLevel = new Set<string>();

    /**
     * 派生局部变量的借用有效期（`[from, to)`）—— 过了就不再响应式。
     *
     * `const third = arr[2]; arr = [...]; third.name = 'x'` 里最后那个 `third` 就是：
     * 它已经不指向 `arr` 的任何一项了，产物不会为它生成刷新，下划线也不该画。
     */
    const windows = new Map<string, [number, number]>();

    for (const script of scripts) {
        if (!script) continue;

        const analysis = analyzeScript(script.content, source);

        for (const state of analysis.states.values()) {
            if (state.nameRange) names.set(state.name, state.nameRange);
            if (!state.fromPath) topLevel.add(state.name);

            // 派生局部变量的有效期：过了就不再有响应性，不该画下划线
            if (state.aliveTo !== undefined) {
                windows.set(state.name, [state.aliveFrom ?? 0, state.aliveTo]);
            }
        }

        // `$borrow` 接进来的参数也是响应式的 —— 函数体里写它就是在写调用点那条路径
        for (const info of analysis.functions.values()) {
            for (const borrow of info.borrows) {
                const param = info.node.params[borrow.index];

                if (param?.type !== 'AssignmentPattern' || param.left.type !== 'Identifier') continue;

                // 参数名那一段（可能带类型注解，按名字长度裁）
                names.set(borrow.name, [
                    param.left.range[0],
                    param.left.range[0] + borrow.name.length
                ]);
            }
        }
    }

    if (names.size === 0) return [];

    const found: Marked[] = [];

    // script / module / onmount 里：走 TS AST，属性名（`obj.count` 的 count）不算
    for (const script of scripts) {
        if (!script) continue;

        // 先把"内层同名绑定"的区间扫出来，下面按位置排掉（只对顶层 $state 变量）
        const blinded = shadowedRanges(script.content, topLevel);

        // walk 只给节点，没有 parent —— 属性名（`obj.count` 的 count）看前一个字符排掉
        walk(script.content, (node) => {
            if (node?.type !== 'Identifier' || !names.has(node.name)) return;

            const [start, end] = node.range;

            if (isShadowedAt(blinded, node.name, start)) return;
            if (sourceLastNonSpace(source, start) === '.') return;
            // `{ count: 1 }` 里的键：后面紧跟冒号
            if (sourceFirstNonSpace(source, end) === ':') return;

            // oxc 的 Identifier range 会连类型注解一起包（`a: Foo`）—— 只留名字那一段
            found.push({ start, end: start + node.name.length, name: node.name });
        });
    }

    // 模板表达式里：优先走 AST —— 字符串字面量和模板字符串的文本部分不该算引用
    // （`onclick={() => console.log("audio time to: " + x)}` 里的 `time` 是句话，
    //  跟响应式变量没关系）。正则那条留着给解析失败时兜底
    for (const expression of expressions) {
        if (expression.content) {
            // 节点的 range 就是**源码绝对偏移**（跟 script 一样，不用加 contentStart）
            walk(expression.content, (node) => {
                if (node?.type !== 'Identifier' || !names.has(node.name)) return;

                const [start, end] = node.range;

                // 属性名（`audio.currentTime` 的 currentTime）
                if (sourceLastNonSpace(source, start) === '.') return;
                // `{ count: 1 }` 里的键
                if (sourceFirstNonSpace(source, end) === ':') return;

                // oxc 的 Identifier range 会连类型注解一起包（`a: Foo`）—— 只留名字那一段
                found.push({ start, end: start + node.name.length, name: node.name });
            });

            continue;
        }

        for (const name of names.keys()) {
            const pattern = new RegExp(`(^|[^\\w$.])${name}(?![\\w$])`, 'g');

            for (const match of expression.raw.matchAll(pattern)) {
                const at = match.index + match[0].length - name.length;

                found.push({
                    start: expression.contentStart + at,
                    end: expression.contentStart + at + name.length
                });
            }
        }
    }

    const unique = new Map(found.map((reference) => [reference.start, reference]));

    // 借用结束的那部分剔掉：那时候写它不再刷根变量，画下划线会误导
    return [...unique.values()]
        .filter((reference) => !expiredReference(reference, windows, names))
        .sort((a, b) => a.start - b.start)
        .map(({ start, end }) => ({ start, end }));
}

/** 递归收集所有层级的声明，同名时保留最靠前的那个 */
function collectAll(source: string, script: Script | null): Map<string, Declaration> {
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

/**
 * 覆盖这个偏移的那些 `for` 的循环头（**由外到内**），写成真的 TS `for` 语句。
 *
 * 为什么不自己推循环变量的类型：写一句 `for (let item of items) { ... }` 让 TS 推就好
 * —— 数组、`Map`、`Set`、`entries()`、解构绑定（`[i, item]`）它全都认得，自己写类型
 * 推导是在重造轮子，还容易漏。
 *
 * 循环头原文里可能没有 `let` / `const`（`{#for item of items}` 就没写），补一个 `let`。
 */
function loopHeadersAt(nodes: readonly unknown[], source: string, offset: number): string[] {
    const headers: string[] = [];

    const visit = (list: readonly unknown[]): void => {
        for (const node of list) {
            const current = node as Record<string, any>;

            if (current?.type === 'ForBlock') {
                const start = Number(current.start ?? 0);
                const end = Number(current.end ?? 0);

                if (offset >= start && offset <= end && typeof current.raw === 'string') {
                    const parts = splitForHeader(current.raw);
                    const binding = (parts?.binding ?? current.raw.split(/\s+of\s/)[0] ?? '').trim();
                    const range = current.content?.right?.range as [number, number] | undefined;

                    if (binding && range) {
                        const declared = /^(let|const|var)\b/.test(binding) ? binding : `let ${binding}`;

                        headers.push(`for (${declared} of ${source.slice(range[0], range[1])}) {`);
                    }
                }

                // 嵌套的 for 照常进去：内层 hover 时要连外层的变量一起给
                if (Array.isArray(current.children)) visit(current.children);
                if (current.fallback) visit(current.fallback.children ?? []);
            } else if (Array.isArray(current?.children)) {
                visit(current.children);
            }
        }
    };

    visit(nodes);

    return headers;
}

/** 光标下的标识符（`source` 里 offset 处那一个词） */
function wordAt(source: string, offset: number): string | null {
    const pattern = /[A-Za-z_$][\w$]*/g;

    for (const match of source.matchAll(pattern)) {
        const from = match.index ?? 0;

        if (offset >= from && offset <= from + match[0].length) return match[0];
    }

    return null;
}

/**
 * 光标是不是停在某个 `for` 的**绑定变量**上（`{#for item of items}` 里的 `item`）。
 *
 * 循环头不是表达式，`expressionAt` 找它不到，所以单独认一次 —— 悬停时给出
 * 循环变量自己的类型。
 */
function loopBindingAt(nodes: readonly unknown[], source: string, offset: number): string | null {
    let found: string | null = null;

    const visit = (list: readonly unknown[]): void => {
        for (const node of list) {
            const current = node as Record<string, any>;

            if (current?.type === 'ForBlock' && typeof current.raw === 'string') {
                const parts = splitForHeader(current.raw);

                if (parts) {
                    const start = Number(current.contentStart ?? current.start ?? 0);
                    const from = start + current.raw.indexOf(parts.binding);
                    const to = from + parts.binding.length;

                    if (offset >= from && offset <= to) {
                        found = wordAt(source, offset) ?? null;

                        return;
                    }
                }
            }

            if (Array.isArray(current?.children)) visit(current.children);
            if (current?.fallback) visit(current.fallback.children ?? []);

            if (found) return;
        }
    };

    visit(nodes);

    return found;
}

/**
 * `{for (const item of list)}` 里的循环变量。
 *
 * 循环头不铺进虚拟文件（它不是表达式），所以模板里一用 `item` 就"找不到名字"——
 * 补一个声明抵消掉。取的是循环头原文，两个阶段都拿得到。
 */
function collectLoopNames(nodes: readonly unknown[]): string[] {
    const names = new Set<string>();
    const pattern = /[A-Za-z_$][\w$]*/g;
    const keywords = new Set(['const', 'let', 'var']);

    const visit = (node: unknown): void => {
        const current = node as Record<string, unknown>;

        if (current?.type === 'ForBlock' && typeof current.raw === 'string') {
            // 循环头是 `item of list`：只看 `of` 左边那段（可能是 `[a, b]` / `{x}`）
            const header = current.raw;
            const binding = splitForHeader(header)?.binding ?? header.split(/\s+of\s/)[0];

            for (const match of binding.matchAll(pattern)) {
                if (keywords.has(match[0])) continue;

                names.add(match[0]);
            }
        }

        for (const key of ['children', 'fallback'] as const) {
            const next = current?.[key];

            if (Array.isArray(next)) next.forEach(visit);
            else if (next) visit(next);
        }
    };

    nodes.forEach(visit);

    return [...names];
}

/**
 * script 里**顶层**声明的名字。
 *
 * 只用来判断"循环变量要不要补声明"：`collectAll` 会把函数里的局部声明也收进来，
 * 于是 `{#for [i, song] of ...}` 的 `song` 会因为某个函数里恰好有个 `let song`
 * 而被认为"已经有了"、不补 —— 模板那边就报 "Cannot find name 'song'"。
 * 函数内的声明跟模板里的循环变量不是一回事。
 */
function topLevelNames(program: TSProgram | null | undefined): Set<string> {
    const names = new Set<string>();

    for (const statement of (program as unknown as { body?: any[] })?.body ?? []) {
        if (statement.type === 'VariableDeclaration') {
            for (const declarator of statement.declarations ?? []) {
                if (declarator.id?.type === 'Identifier') names.add(declarator.id.name);
            }
        } else if (
            (statement.type === 'FunctionDeclaration' ||
                statement.type === 'ClassDeclaration' ||
                statement.type === 'TSTypeAliasDeclaration' ||
                statement.type === 'TSInterfaceDeclaration') &&
            statement.id?.name
        ) {
            names.add(statement.id.name);
        }
    }

    return names;
}

/** 常见标签 -> DOM 类型，给 `bind:this` 声明的变量用（认不出的退成 HTMLElement） */
const ELEMENT_TYPES: Record<string, string> = {
    a: 'HTMLAnchorElement',
    br: 'HTMLBRElement',
    button: 'HTMLButtonElement',
    canvas: 'HTMLCanvasElement',
    div: 'HTMLDivElement',
    form: 'HTMLFormElement',
    h1: 'HTMLHeadingElement',
    h2: 'HTMLHeadingElement',
    h3: 'HTMLHeadingElement',
    h4: 'HTMLHeadingElement',
    h5: 'HTMLHeadingElement',
    h6: 'HTMLHeadingElement',
    img: 'HTMLImageElement',
    input: 'HTMLInputElement',
    label: 'HTMLLabelElement',
    li: 'HTMLLIElement',
    ol: 'HTMLOListElement',
    option: 'HTMLOptionElement',
    p: 'HTMLParagraphElement',
    pre: 'HTMLPreElement',
    select: 'HTMLSelectElement',
    span: 'HTMLSpanElement',
    table: 'HTMLTableElement',
    textarea: 'HTMLTextAreaElement',
    ul: 'HTMLUListElement',
    video: 'HTMLVideoElement'
};

/**
 * 模板里的一处 `bind:this`。
 *
 * 两种形态：
 * - **变量形式**（`name` 不为 null）：`bind:this={box}` —— box 由它声明，挂上时赋值
 * - **回调形式**（`name` 为 null）：任何表达式，挂上时当函数调用、把元素传进去
 *
 * 到底是哪种，看写的是不是"一个不是函数的标识符"。剩下的交给 TS 判断：
 * 回调形式会在虚拟文件末尾拼一句调用来验类型（见 `thisChecks`）。
 */
interface ThisBinding {
    name: string | null;
    /**
     * 变量是不是由 `bind:this` 声明的。
     * script 里已经声明过同名的（`let box: number` + `bind:this={box}`）就不是——
     * 那种只是赋值，别处照样能用，也别再补一个 `declare let`
     */
    declared: boolean;
    /** 元素类型；变量形式用来声明，回调形式用来验参数 */
    type: string;
    /** 值的原文（回调形式拼检查语句要用） */
    raw: string;
    /** 声明处 / 表达式本身的区间：报错往这儿指 */
    start: number;
    end: number;
}

function collectThisBindings(
    nodes: readonly unknown[],
    /** script / onmount 里声明过的函数：`bind:this={grab}` 是回调形式 */
    functions: Set<string>,
    /** script / module 里已经声明过的名字 */
    declared: Set<string>
): ThisBinding[] {
    const found: ThisBinding[] = [];

    const visit = (node: unknown): void => {
        const current = node as Record<string, unknown>;

        if (current?.type === 'element') {
            for (const [key, value] of Object.entries((current.attributes ?? {}) as Record<string, unknown>)) {
                if (key !== 'bind:this' || typeof value !== 'object' || value === null || 'type' in value) continue;

                const expression = (value as Record<string, unknown>).expression as
                    | {
                          content?: { type?: string; name?: string };
                          contentStart?: number;
                          contentEnd?: number;
                          raw?: string;
                      }
                    | null
                    | undefined;

                if (!expression?.raw) continue;

                const identifier =
                    expression.content?.type === 'Identifier' ? expression.content.name : undefined;
                // 标识符、且它不是个函数 —— 变量形式；其余一律当回调
                const name = identifier && !functions.has(identifier) ? identifier : null;
                const tag = String(current.name ?? '');
                

                found.push({
                    name,
                    declared: name !== null && !declared.has(name),
                    type: ELEMENT_TYPES[tag] ?? `HTMLElementTagNameMap["${tag}"]`,
                    raw: expression.raw,
                    start: expression.contentStart ?? 0,
                    end: expression.contentEnd ?? 0
                });
            }
        }

        for (const next of ['children', 'alternates', 'fallback'] as const) {
            const value = current?.[next];

            if (Array.isArray(value)) value.forEach(visit);
            else if (value) visit(value);
        }
    };

    nodes.forEach(visit);

    return found;
}

/**
 * 用 TS 验绑定项（`get` / `set` / `listen`）的类型。
 *
 * 虚拟文件里它们是按"值"铺的（`(get_的值);`），所以是不是能当函数调用、
 * 参数对不对，TS 看不出来。这里按语义补一句调用去问它：
 * - `get` -> `(expr)();`                  必须无参可调用
 * - `set` -> `(expr)(null as any);`       必须能接一个值
 * - `listen` -> `(expr)(() => {});`       必须能接一个 update 回调
 *
 * 简写形式 `listen(bus, "name")` 不是真的函数调用（`listen` 运行时并不存在），跳过。
 */
function bindingChecks(regions: ExpressionRegion[]): Array<{ code: string; region: ExpressionRegion }> {
    const calls: Record<string, string> = {
        get: '()',
        set: '(null as any)',
        listen: '(() => {})'
    };

    const found: Array<{ code: string; region: ExpressionRegion }> = [];

    for (const region of regions) {
        if (!region.kind || region.kind === 'expression') continue;
        if (region.kind === 'listen' && /^\s*listen\s*\(/.test(region.raw)) continue;

        found.push({ code: `(${region.raw})${calls[region.kind]};`, region });
    }

    return found;
}

/**
 * 用 TS 验 `bind:this` 的类型。
 *
 * 变量形式：`box = null as any as HTMLInputElement;` —— 类型不对（比如 script 里
 * 声明成了 number）就会报错。回调形式：`(grab)(null as any as HTMLElement);` ——
 * 不可调用、参数类型不对都会报错。
 *
 * 这些语句拼在虚拟文件末尾（偏移超出源码），报错位置由 `thisCheckSpans` 挪回模板那一处。
 */
function thisChecks(bindings: ThisBinding[]): string[] {
    return bindings.map((binding) =>
        binding.name
            ? `${binding.name} = null as any as ${binding.type};`
            : `(${binding.raw})(null as any as ${binding.type});`
    );
}

/**
 * 模板里的子组件（`<Child />` / `<Foo.Bar />`）：名字按类型上色。
 *
 * TS 的分类只覆盖 script 和表达式，标签名在它眼里就是普通文本，
 * 所以这里自己给一段 span（开标签和闭标签都给）。
 */
function componentSpansOf(nodes: readonly unknown[], source: string): SemanticSpan[] {
    const spans: SemanticSpan[] = [];

    const visit = (node: unknown): void => {
        const current = node as Record<string, unknown>;

        if (current?.type === 'element' && typeof current.name === 'string') {
            const name = current.name;

            if (/^[A-Z]/.test(name) || name.includes('.')) {
                const start = Number(current.start ?? 0) + 1;

                spans.push({ start, length: name.length, type: 'class', modifiers: [] });

                const closing = source.lastIndexOf(`</${name}>`, Number(current.end ?? source.length));
                if (closing >= 0) {
                    spans.push({ start: closing + 2, length: name.length, type: 'class', modifiers: [] });
                }
            }
        }

        for (const next of ['children', 'alternates', 'fallback'] as const) {
            const value = current?.[next];

            if (Array.isArray(value)) value.forEach(visit);
            else if (value) visit(value);
        }
    };

    nodes.forEach(visit);

    return spans;
}

/**
 * 把 script 原文里的宏调用换成**等长**的占位符（`_macro$0`）。
 *
 * 宏返回的是要插进去的源码，但它在 script 里展开成的是**另一段代码**——照字面检查的话
 * `const flip = $flip('name')` 会被认为 flip 是个数组，后面 `flip()` 就报"不可调用"。
 *
 * 展开出来的代码比调用长得多，塞不回原来的位置（虚拟文件靠等长来对齐偏移），
 * 所以这里只放一个占位符，真正的 `var _macro$0 = <展开结果>` 拼在文件末尾
 * —— 那里想多长都行，`flip` 的类型也就跟着展开结果走了。
 */
function maskMacroCalls(block: Script, macros: Array<{ use: MacroUse; index: number }>): Script {
    let raw = block.raw;

    for (const { use, index } of macros) {
        if (use.start < block.contentStart || use.end > block.contentEnd) continue;

        const from = use.start - block.contentStart;
        const to = use.end - block.contentStart;
        const name = `_macro$${index}`;

        if (to - from < name.length) continue;

        raw = raw.slice(0, from) + name + ' '.repeat(to - from - name.length) + raw.slice(to);
    }

    return { ...block, raw };
}

/** 已经自己写了 `export default` 的就别再补一个 */
function hasDefaultExport(scripts: VirtualScript[]): boolean {
    return scripts.some((script) => /export\s+default\b/.test(script.raw));
}

/** script / 模板里所有函数节点的区间（含参数列表） */
function functionRanges(root: Root | null, expressions: Expression[]): Array<[number, number]> {
    const found: Array<[number, number]> = [];

    const collect = (program: unknown): void => {
        walk(program, (node) => {
            if (isFunction(node)) found.push(node.range as [number, number]);
        });
    };

    for (const script of [root?.script, root?.module, root?.onmount]) if (script) collect(script.content);
    for (const expression of expressions) collect(expression.content);

    return found;
}

/**
 * `bind:this` 自己声明的变量：只在挂载之后才有值，所以在**挂载前就会跑**的地方
 * 引用它是错的。
 *
 * 允许两个地方：
 *
 * - `<script onmount>` 里（那时候已经挂上了）
 * - 任何**函数体**里 —— 事件监听器、回调、定时器……这些基本不会在挂载前触发。
 *   函数定义写在顶层没问题，跑起来的时候元素早就在了
 *
 * TS 那边没法表达这个作用域（变量是编译期才声明的，虚拟文件里只能全局声明），
 * 所以自己扫一遍。
 */
function thisLeaks(
    root: Root | null,
    expressions: Expression[],
    bindings: ThisBinding[]
): SemanticProblem[] {
    const named = bindings.filter((item) => item.declared);

    if (!root || named.length === 0) return [];

    const wanted = new Map(named.map((item) => [item.name as string, item]));
    const onmount = root.onmount;
    const functions = functionRanges(root, expressions);
    const problems: SemanticProblem[] = [];

    const check = (node: any): void => {
        if (node?.type !== 'Identifier' || !node.range) return;

        const item = wanted.get(node.name);
        if (!item) return;

        const [start, end] = node.range;

        // 声明处本身（`bind:this={box}` 里的 box）不算
        if (start >= item.start && start <= item.end) return;

        // onmount 里可以用（那时候已经挂上了）
        if (onmount && start >= onmount.contentStart && start <= onmount.contentEnd) return;

        // 函数体里也可以用：事件监听器之类的不会在挂载前触发
        if (functions.some(([from, to]) => start >= from && start <= to)) return;

        problems.push({
            start,
            end,
            message: `\`${node.name}\` is declared by \`bind:this\` — use it inside a function or \`<script onmount>\`（挂载之后才有值）`
        });
    };

    for (const script of [root.script, root.module]) if (script) walk(script.content, check);
    for (const expression of expressions) walk(expression.content, check);

    return problems;
}

/** `(value) => ...` / `(ev) => ...` 这种参数，类型不在我们手里，不报 */
const REGEX_IMPLICIT_ANY = /implicitly has an 'any' type/;

/**
 * script 里的宏调用换成占位符（`const flip = _macro$0`）之后，
 * 赋值只能拼在文件末尾，TS 会报"用了还没赋值"——那是虚拟文件的拼法带来的，不是用户的错
 */
const REGEX_MACRO_PLACEHOLDER = /Variable '_macro\$\d+' is used before being assigned/;

/**
 * 针对 `bind:this` 变量的、**不成立**的诊断。
 *
 * 那次赋值是运行时做的（`"this": ($el) => { box = $el; }`），虚拟文件里体现不出来。
 * 所以：
 *
 * - `let box: HTMLCanvasElement;` + `bind:this={box}` → TS 说"使用前未赋值"
 * - `let box;` + `bind:this={box}` → TS 说"隐式 any"
 *
 * 两个都不该报 —— 元素建好就赋上了。
 */
const REGEX_THIS_ASSIGNS =
    /Variable '(\w+)' (?:is used before being assigned|implicitly has .*'any')/;

/**
 * 模板里的表达式 / 绑定项：只要区间和原文。
 *
 * 铺虚拟文件、判断光标位置都用这些就够了，所以解析失败（表达式没有 TS AST）
 * 时照样能收 —— 敲到一半的 `obj.` 不至于把高亮和补全全弄丢。
 */
export interface ExpressionRegion {
    contentStart: number;
    contentEnd: number;
    raw: string;
    /** 是绑定值里的哪一项；用来决定拼什么样的类型检查语句 */
    kind?: 'expression' | 'get' | 'set' | 'listen';
}

function collectExpressions(
    nodes: readonly unknown[],
    source: string,
    /**
     * 收 `bind:this` 的表达式吗。
     *
     * 铺虚拟文件时要跳过（它是赋值目标，铺进去变成一次读取）；而 hover / 补全要用，
     * 所以那边照收。
     */
    includeThis = true
): ExpressionRegion[] {
    const expressions: ExpressionRegion[] = [];

    const push = (value: unknown): void => {
        if (value) expressions.push(value as ExpressionRegion);
    };

    const childrenOf = (node: Record<string, unknown>): unknown[] =>
        Array.isArray(node.children) ? (node.children as unknown[]) : [];

    const visit = (node: unknown): void => {
        const current = node as Record<string, unknown>;

        switch (current?.type) {
            case 'expression':
                push(node);
                break;

            case 'element':
                for (const [key, value] of Object.entries((current.attributes ?? {}) as Record<string, unknown>)) {
                    if (value === true || typeof value === 'string') continue;

                    // `bind:this={box}` 不铺：它是个**赋值目标**，铺进虚拟文件就变成一次
                    // 读取（`(box);`）—— 而 `let box: HTMLInputElement;` 没有初始化器，
                    // TS 会报 "used before being assigned"。那个赋值是运行时做的，不该
                    // 在虚拟文件里体现。类型检查由 thisChecks 另外生成
                    if (key === 'bind:this' && !includeThis) continue;

                    for (const chunk of Array.isArray(value) ? value : [value]) {
                        if (typeof chunk === 'string') continue;

                        // 绑定值（`bind:value={ ... }`）不是表达式；
                        // 但里面 get / set / listen / 变量这些照样要铺进虚拟文件
                        if (typeof chunk === 'object' && chunk !== null && !('type' in chunk)) {
                            const binding = chunk as Record<string, unknown>;

                            for (const key of ['expression', 'get', 'set', 'listen'] as const) {
                                const item = binding[key] as Record<string, unknown> | null | undefined;
                                if (!item) continue;

                                expressions.push({
                                    ...(item as unknown as ExpressionRegion),
                                    kind: key
                                });
                            }

                            continue;
                        }

                        push(chunk);
                    }
                }

                childrenOf(current).forEach(visit);
                break;

            case 'IfBlock':
                push(current.test);
                for (const alternate of (current.alternates ?? []) as Array<Record<string, unknown>>) {
                    if (alternate.test) push(alternate.test);
                    childrenOf(alternate).forEach(visit);
                }

                childrenOf(current).forEach(visit);
                break;

            case 'ForBlock': {
                // 循环头本身（`item of history`）不是合法 TS，不铺；
                // 但可迭代对象是个表达式，单独铺进去——这样在它上面跳转引用 / 补全也能用
                const right = (current as { content?: { right?: { range?: [number, number] } } }).content?.right
                    ?.range;

                if (right) {
                    push({
                        contentStart: right[0],
                        contentEnd: right[1],
                        raw: source.slice(right[0], right[1])
                    });
                }

                const fallback = current.fallback as Record<string, unknown> | null | undefined;
                if (fallback) childrenOf(fallback).forEach(visit);

                childrenOf(current).forEach(visit);
                break;
            }
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
function membersOf(node: TypeLiteralLike, source: string): ComponentProp[] {
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
function propsOf(script: Script | null, source: string): ComponentProp[] {
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
            const props = argument ? membersOf(argument, source) : [];

            // 哪些属性是双向绑定的，看解构里有没有 `$bindable(...)`
            const bound = bindableNames(declarator.id);

            for (const prop of props) prop.bindable = bound.has(prop.name);

            return props;
        }
    }

    return [];
}

/** 解构模式里写了 `$bindable(...)` 的项：`{ count = $bindable(0) }` */
function bindableNames(id: unknown): Set<string> {
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
const componentCache = new Map<string, ComponentProp[]>();

export function forgetComponent(path: string): void {
    componentCache.delete(path);
}

function componentPropsAt(path: string): ComponentProp[] {
    const cached = componentCache.get(path);
    if (cached) return cached;

    let props: ComponentProp[] = [];

    try {
        const source = readFileSync(path, 'utf8');

        props = propsOf(parse(source, { filename: path }).script, source);
    } catch {
        props = [];
    }

    componentCache.set(path, props);

    return props;
}

/** script 里 `import Foo from './Foo.grain'` 全收集起来 */
function importedComponents(script: Script | null, filename: string): Map<string, ComponentProp[]> {
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

        // 交给 TS 解析（自己的话拼不出 tsconfig 里 `paths` 映射过的路径）；
        // 解析不到再退回按相对路径猜一次
        const target = typescriptService.resolveModule(specifier, virtualName(filename));

        components.set(
            binding.local.name,
            componentPropsAt(target ? realName(target) : resolve(dirname(filename), specifier))
        );
    }

    return components;
}

function elementAt(nodes: TemplateNode[], offset: number): ElementInfo | null {
    for (const node of nodes) {
        // 单向绑定（模板插值 / 属性值的绑定值）：不是元素，跳过
        if (!('type' in node)) continue;

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
                nameEnd: node.start + 1 + node.name.length,
                end: node.end
            };
        }

        const nested = elementAt(children, offset);
        if (nested) return nested;
    }

    return null;
}

/**
 * 解析失败时的兜底：把 `<script>` 块抠出来。
 *
 * 模板写坏了（比如 `obj.` 敲一半）编译器会抛错，但 script 本身多半是好的。
 * 不抠出来的话虚拟文件里 script 全变空白，语义高亮和补全就整个没了。
 */
function fallbackScripts(source: string): VirtualScript[] {
    const found: VirtualScript[] = [];
    const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/g;

    for (const match of source.matchAll(pattern)) {
        const openEnd = match.index + match[0].indexOf('>') + 1;
        const body = match[2];

        found.push({
            contentStart: openEnd,
            contentEnd: openEnd + body.length,
            raw: body
        });
    }

    return found;
}

export function analyze(source: string, filename: string): Analysis {
    let root: Root | null = null;
    let error: ParseError | null = null;

    try {
        root = parse(source, { filename });
    } catch (caught) {
        error = caught instanceof ParseError ? caught : new ParseError(String(caught), 0, 0);
    }

    // 解析失败（`obj.` 敲一半、标签没闭合…）就退到第一阶段：
    // 结构和区间还在，只是表达式没有 TS AST。铺虚拟文件只要区间和原文，
    // 所以高亮和补全不至于跟着一起没
    let stage: RootStage | null = root;

    if (!stage) {
        try {
            stage = parseRoot(source, { filename });
        } catch {
            stage = null;
        }
    }

    const declarations = new Map<string, Declaration>();
    const all = new Map<string, Declaration>();

    for (const script of [root?.module, root?.script]) {
        for (const [name, declaration] of collectDeclarations(source, script ?? null)) {
            declarations.set(name, declaration);
        }

        for (const [name, declaration] of collectAll(source, script ?? null)) {
            all.set(name, declaration);
        }
    }

    // 两份：铺虚拟文件 / 判断光标位置用区间那份（解析失败时也有）；
    // 模板里 hover 找声明要 TS AST，只有完整解析成功才有
    // 给虚拟文件用：跳过 `bind:this`（它是赋值目标，铺进去会变成读取）
    const regions = stage ? collectExpressions(stage.template.children, source, false) : [];
    const expressions = (root ? collectExpressions(root.template.children, source) : []) as Expression[];
    const components = importedComponents(root?.script ?? null, filename);

    // script / onmount 里声明过的函数：决定 `bind:this={grab}` 是回调还是变量
    const scriptFunctions = new Set<string>();

    for (const script of [root?.script, root?.module, root?.onmount]) {
        if (!script) continue;

        for (const name of analyzeScript(script.content, source).functions.keys()) scriptFunctions.add(name);
    }

    const thisBindings = root
        ? collectThisBindings(root.template.children, scriptFunctions, new Set(all.keys()))
        : [];

    /**
     * `bind:this` 绑的变量名（script 里自己声明过的也算）。
     *
     * 用它过滤掉针对这些变量的"使用前未赋值"/"隐式 any"—— 那次赋值是运行时做的，
     * 虚拟文件里体现不出来。
     */
    const thisNames = new Set(
        thisBindings.map((item) => item.name).filter((name): name is string => name !== null)
    );
    // 模板里子组件的名字要按类型上色
    const componentSpans = stage ? componentSpansOf(stage.template.children, source) : [];

    // 把 script 铺到虚拟 .ts 文件里交给 TS 语言服务
    // 注意用 `!=`：解析失败时 root 为 null，root?.script 是 undefined，用 !== 会漏过去
    // script 里的宏调用要事先换成等长的占位符（见 maskMacroCalls）
    const used = (root?.macros ?? [])
        .filter((use) => use.where === 'script')
        .map((use, index) => ({ use, index }));

    const parsed: VirtualScript[] = [root?.module, root?.script]
        .filter((script): script is Script => script != null)
        .map((script) => maskMacroCalls(script, used));

    // onmount 跟 script 一样铺进虚拟文件
    if (root?.onmount) parsed.push(maskMacroCalls(root.onmount, used));
    // macro 也铺进去：它只在编译期存在，但写宏的时候该有 TS 支持。
    // 里面是宏的**定义**，不用遮
    if (root?.macro) parsed.push(root.macro);
    // 解析失败时第一阶段那两个块只有原文，照样能铺；再不行才用正则抠
    const scripts: VirtualScript[] =
        parsed.length > 0
            ? parsed
            : stage
              ? [stage.module, stage.script].flatMap((script) =>
                    script
                        ? [{ contentStart: script.contentStart, contentEnd: script.contentEnd, raw: script.raw }]
                        : []
                )
              : fallbackScripts(source);
    const virtual = virtualName(filename);

    // 循环变量在虚拟文件里没有声明，补上。
    //
    // 只在 script **顶层**声明过同名时才不补：函数里的局部声明（`function f() { let song }`）
    // 跟模板里的循环变量不是一回事，拿它当"已经有了"会让模板报 "Cannot find name"
    const declaredTopLevel = new Set<string>();

    for (const script of [root?.script, root?.module, root?.onmount]) {
        for (const name of topLevelNames(script?.content)) declaredTopLevel.add(name);
    }

    const loops = stage
        ? collectLoopNames(stage.template.children).filter((name) => !declaredTopLevel.has(name))
        : [];

    // 拼在虚拟文件末尾的东西（偏移超出源码长度）：
    //   - 循环变量 / bind:this 变量的声明，让它们能用
    //   - bind:this 的类型检查语句，让 TS 帮我们验类型
    //   - 兜底的默认导出，让这个虚拟文件一定是模块
    // 类型检查项：拼在虚拟文件末尾，报错位置挪回模板里对应那一处
    const checks: Array<{ code: string; start: number; end: number }> = [
        ...thisBindings.map((binding, index) => ({
            code: thisChecks(thisBindings)[index],
            start: binding.start,
            end: binding.end
        })),
        ...bindingChecks(regions).map((check) => ({
            code: check.code,
            start: check.region.contentStart,
            end: check.region.contentEnd
        })),
        // 宏展开出来的代码：拼在末尾，既给了正确的类型，报错也能映射回那个宏调用
        ...used.map(({ use, index }) => ({
            code: `var _macro$${index} = ${use.text};`,
            start: use.start,
            end: use.end
        }))
    ];

    // 循环变量的占位声明（`any`）。hover 到 `for` 里的表达式时会把它换成带类型的版本，
    // 所以留成单独一段，方便按原文替换
    const loopDeclarations = loops.map((name) => `declare let ${name}: any;`);

    const tailLines: string[] = [
        ...loopDeclarations,
        // `$node` 和内置宏（`$store` / `$read`）的声明在 GRAIN_TYPE_SOURCE 里，全局可见

        // 只补 bind:this **自己声明**的变量；script 里已有的不重复声明
        ...thisBindings
            .filter((item) => item.declared)
            .map((item) => `declare let ${item.name}: ${item.type};`),
        ...checks.map((check) => check.code),
        ...(hasDefaultExport(scripts) ? [] : [VIRTUAL_EXPORT])
    ];

    // 末尾每一段在虚拟文件里的区间：报错要按它挪回模板里对应的位置
    const tailStart = source.length + 1;
    const tailSpans: Array<{ from: number; to: number; start: number; end: number }> = [];
    let cursor = tailStart;

    for (const [index, line] of tailLines.entries()) {
        const to = cursor + line.length + 1;

        // 倒数 `checks.length` 行之前、声明之后那一段就是检查项
        const at = index - (tailLines.length - checks.length - (hasDefaultExport(scripts) ? 0 : 1));
        if (at >= 0 && at < checks.length) {
            tailSpans.push({ from: cursor, to, start: checks[at].start, end: checks[at].end });
        }

        cursor = to;
    }

    // 虚拟文件必须跟源码**等长**（位置一一对应，TS 报的偏移不用换算）。
    // 早先为了消掉 `bind:this` 那句 "used before being assigned"，在 script 后面插过
    // 一句初始化 —— 那会让后面所有内容后移，语义高亮整体错位（`</script>` 上出现
    // JS 的着色）。现在改成不把 `bind:this` 的表达式铺进虚拟文件（见 collectExpressions），
    // 那个报错的前提就没了
    const virtualText = buildVirtual(source, scripts, regions, tailLines.join('\n'));

    typescriptService.update(virtual, virtualText);

    return {
        root,
        error,
        declarations,
        all,

        /** 虚拟文件当前的内容；语言服务要临时加载别的文件时用它 */
        virtualText: () => virtualText,

        expressionAt(offset: number): Expression | null {
            return (
                expressions.find(
                    (expression) => offset >= expression.contentStart && offset <= expression.contentEnd
                ) ?? null
            );
        },

        /** 名字对应的 `bind:this`（变量形式才有） */
        thisBindingNamed(name: string | null): ThisBinding | undefined {
            if (!name) return undefined;

            return thisBindings.find((item) => item.declared && item.name === name);
        },

        /** 光标下的标识符名（script / module / onmount / 模板表达式 都算） */
        nameAt(offset: number): string | null {
            const expression = expressions.find(
                (item) => offset >= item.contentStart && offset <= item.contentEnd
            );

            if (expression) return identifierAt(expression.content, offset);

            for (const script of [root?.script, root?.module, root?.onmount, root?.macro]) {
                if (!script) continue;
                if (offset < script.contentStart || offset > script.contentEnd) continue;

                const name = identifierAt(script.content, offset);
                if (name) return name;
            }

            return null;
        },

        scriptAt(offset: number): Script | null {
            for (const script of [root?.script, root?.module, root?.onmount, root?.macro]) {
                if (script && offset >= script.contentStart && offset <= script.contentEnd) return script;
            }

            return null;
        },

        /** 光标停在一次宏调用上：拿它展开出来的东西（hover 预览用） */
        macroAt(offset: number): MacroUse | null {
            return root?.macros.find((use) => offset >= use.start && offset <= use.end) ?? null;
        },

        elementAt(offset: number): ElementInfo | null {
            return root ? elementAt(root.template.children, offset) : null;
        },

        componentProps(name: string): ComponentProp[] {
            return components.get(name) ?? [];
        },

        classifications(): SemanticSpan[] {
            return [
                ...typescriptService.classifications(virtual, source.length),
                ...componentSpans
            ];
        },

        completions(offset: number): CompletionEntry[] {
            const inScript = scripts.some(
                (script) => offset >= script.contentStart && offset <= script.contentEnd
            );

            // 模板里的表达式（`{x}`、`bind:value={ get: ... }` 里的每一项）也铺进虚拟文件了，
            // 一样能问 TS —— 高亮拿得到，补全也拿得到
            const inExpression = regions.some(
                (expression) => offset >= expression.contentStart && offset <= expression.contentEnd
            );

            log(
                'completions',
                'offset', offset,
                'in script', inScript,
                'in expression', inExpression
            );

            if (!inScript && !inExpression) return [];

            // 点号后面优先自己按类型枚举：TS 在这种地方往往返回一堆全局标识符，
            // 而不是 `Math` 自己的成员
            const members = typescriptService.memberCompletions(virtual, offset);
            if (members.length > 0) return members;

            return typescriptService.completions(virtual, offset);
        },

        completionDetail(offset: number, name: string): CompletionDetail | null {
            return typescriptService.completionDetail(virtual, offset, name);
        },

        // 虚拟文件与原文件 offset 一一对应，直接把光标偏移传进去就行
        quickInfo(offset: number): QuickInfo | null {
            if (scripts.some((script) => offset >= script.contentStart && offset <= script.contentEnd))
                return typescriptService.quickInfo(virtual, offset)
            const expression = this.expressionAt(offset);

            // 循环头不是表达式，`expressionAt` 找它不到 —— 单独认一次
            const binding = root && !expression ? loopBindingAt(root.template.children, source, offset) : null;

            if (!expression && !binding) return null;

            // 把表达式塞进真的 `for` 循环里再问 TS —— 这样循环变量的类型是 TS 自己
            // 推的，数组 / Map / Set / `entries()` / 解构绑定全都成立
            const opens = root ? loopHeadersAt(root.template.children, source, offset) : [];
            const open = opens.length > 0 ? `\n${opens.join('\n')}\n` : '\n';

            /** 追加的文本，和悬停点在它里面的位置 */
            let tail: string;
            let at: number;

            if (expression) {
                const pref = 'var expr$$tmp$ = ';

                tail = pref + expression.raw + ';' + '\n}'.repeat(opens.length);
                at = virtualText.length + open.length + pref.length + (offset - expression.contentStart);
            } else {
                // 悬停的是循环变量本身：for 体留空，把点对准最里层那个 for 头里的名字
                const before = opens.length > 1 ? `${opens.slice(0, -1).join('\n')}\n` : '';

                tail = '}'.repeat(opens.length);
                at =
                    virtualText.length +
                    1 +
                    before.length +
                    (opens[opens.length - 1] ?? '').indexOf(binding!);
            }

            typescriptService.update(virtual, virtualText + open + tail);
            const info = typescriptService.quickInfo(virtual, at);

            // 还原：临时声明只在这一次 hover 里有效，别留在语言服务里影响别的功能
            typescriptService.update(virtual, virtualText);

            return info;
        },

        semantic(): SemanticProblem[] {
            const kept: SemanticProblem[] = [];

            for (const problem of typescriptService.semanticProblems(virtual)) {
                if (REGEX_MACRO_PLACEHOLDER.test(problem.message)) continue;

                // `bind:this` 会给变量赋值 —— 所以"使用前未赋值"和"隐式 any"都不成立。
                // 虚拟文件里体现不出那次赋值（它是运行时做的），过滤掉
                const assigned = REGEX_THIS_ASSIGNS.exec(problem.message);

                if (assigned && thisNames.has(assigned[1])) continue;

                // 拼在末尾的 `bind:this` 类型检查：位置挪回模板里那一处
                const span = tailSpans.find(
                    (item) => problem.start >= item.from && problem.start < item.to
                );

                if (span) {
                    if (!REGEX_IMPLICIT_ANY.test(problem.message)) {
                        kept.push({ start: span.start, end: span.end, message: problem.message });
                    }

                    continue;
                }

                // script 里：全部照报
                if (
                    scripts.some(
                        (script) =>
                            problem.start >= script.contentStart && problem.start <= script.contentEnd
                    )
                ) {
                    kept.push(problem);
                    continue;
                }

                // 模板里的表达式（`{x}`、`onclick={...}`、`bind:value={...}` 里的每一项）
                // 也铺进虚拟文件了，是真代码，照样报
                const region = regions.find(
                    (item) => problem.start >= item.contentStart && problem.start <= item.contentEnd
                );

                if (!region) continue;

                // 只有 implicit any 是包装带来的：`set: (value) => ...`、`onclick={(ev) => ...}`
                // 的参数类型来自 DOM / 父组件，TS 在我们的嵌入形式里看不到，
                // 硬报的话每个 grain 绑定和事件处理器都会挂红线
                if (!REGEX_IMPLICIT_ANY.test(problem.message)) kept.push(problem);
            }

            // bind:this 声明的变量只在 onmount 里有效
            return [
                ...kept,
                ...thisLeaks(root, expressions, thisBindings),
                // 借用规则的提示（跟编译器同一份 —— 越界写派生、非 const 派生）
                ...borrowProblems(source, root)
            ];
        },

        references(offset: number): Reference[] {
            return typescriptService.references(virtual, offset);
        },

        stateReferences(): Reference[] {
            return stateReferencesOf(
                source,
                [root?.script, root?.module, root?.onmount],
                expressions as Expression[]
            );
        },

        definition(offset: number): Definition[] {
            const name = this.nameAt(offset);
            const declared = this.thisBindingNamed(name);

            // `bind:this={box}` 声明的变量：指回模板里那一处，
            // 别跳到我们补在虚拟文件末尾的 `declare let`
            if (declared) return [{ file: null, start: declared.start, end: declared.end }];

            return typescriptService.definition(virtual, offset);
        },

        rename(offset: number): Reference[] {
            const declared = this.thisBindingNamed(this.nameAt(offset));

            const found = new Map<number, Reference>();

            // `bind:this` 的声明在模板里；TS 只会指向我们补在末尾的 `declare let`
            if (declared) found.set(declared.start, { start: declared.start, end: declared.end });

            for (const entry of typescriptService.renameLocations(virtual, offset)) {
                // 虚拟文件末尾补的声明：偏移超出源码长度，扔掉
                if (entry.end > source.length) continue;

                found.set(entry.start, entry);
            }

            return [...found.values()].sort((a, b) => a.start - b.start);
        },

        warmup(): void {
            typescriptService.warmup();
        },

        compiled(): { js: string; css: string } | null {
            try {
                return compile(source, { filename, runtimeModule: '@graints/runtime' });
            } catch {
                return null;
            }
        },

        dispose(): void {
            typescriptService.remove(virtual);
        }
    };
}


