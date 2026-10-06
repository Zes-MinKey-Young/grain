// 注意：TypeScript 只能惰性加载。
// 扩展激活时同步 require('typescript') 会拖慢扩展宿主，直接触发 10 秒启动超时。
import type * as TS from 'typescript';

import { log } from './log.js';

import type { Script } from '../../compiler/index.js';

type TypeScript = typeof TS;

let typescript: TypeScript | null = null;

function get_ts(): TypeScript {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (typescript ??= require('typescript') as TypeScript);
}

/**
 * grain 内置的东西，得给 TS 一个声明它才认识。
 * 改动时同步 `examples/grain.d.ts` —— 那边是 tsc 用来检查项目的。
 */
const GRAIN_TYPES = 'grain-runtime.d.ts';
const GRAIN_TYPE_SOURCE = `/**
 * 响应式状态。编译期展开成普通变量，写了它的函数会自动接上 update 调用。
 */
declare function $state<T>(initial: T): T;

/**
 * 组件 props —— 泛型就是 props 的类型。
 * \`let { label, children } = $props<{ label: string; children?: () => unknown }>();\`
 */
declare function $props<T extends Record<string, unknown> = Record<string, unknown>>(): T;

/**
 * 可双向绑定的 prop。父组件写 \`bind:name={x}\` 时，
 * 子组件里对它的赋值会写回父组件的 \`x\`；参数是父组件没传值也没绑定时的兜底。
 */
declare function $bindable<T>(fallback?: T): T;

declare module "*.grain" {
    interface GrainComponent {
        /** 挂到目标元素上（根组件用法） */
        (target: Element): unknown;
        /** 作为子组件被父组件调用 */
        create(props?: Record<string, unknown>, children?: (() => unknown) | null): unknown;
    }

    const component: GrainComponent;
    export default component;
}
`;

let options: TS.CompilerOptions | null = null;
/** 当前生效的 tsconfig 路径（按它判断要不要重建语言服务） */
let tsconfig_path: string | null = null;
/** tsconfig.json 里的编译选项 */
let overrides: TS.CompilerOptions | null = null;

function get_options(): TS.CompilerOptions {
    const ts = get_ts();

    if (options) return options;

    const merged: TS.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        // 组件里直接写 DOM 是常态（`document`、`EventTarget`、`localStorage`…）
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowJs: false,
        ...(overrides ?? {})
    };

    // 这几项由插件自己决定，tsconfig 改不了
    merged.noEmit = true;
    merged.allowJs = false;

    return (options ??= merged);
}

/**
 * 读 tsconfig.json（会顺着 `extends` 找下去），拿来当编译选项。
 * 这样项目里配的 `lib` / `target` / `strict` 都能生效。
 */
function read_tsconfig(path: string): TS.CompilerOptions | null {
    const ts = get_ts();

    const host: TS.ParseConfigFileHost = {
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        readDirectory: (root, extensions, excludes, includes, depth) =>
            ts.sys.readDirectory(root, extensions, excludes, includes, depth),
        fileExists: (file) => ts.sys.fileExists(file),
        readFile: (file) => ts.sys.readFile(file),
        getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
        onUnRecoverableConfigFileDiagnostic: () => {}
    };

    return ts.getParsedCommandLineOfConfigFile(path, {}, host)?.options ?? null;
}

/**
 * 切换到离当前文件最近的那个 tsconfig.json。
 *
 * 按**路径**比较，所以同一个目录下反复分析不会重建语言服务；
 * 换到别的目录（配置不同）才重建。传 null 表示没有 tsconfig，用插件自带的一套。
 */
export function use_tsconfig(path: string | null): void {
    if (path === tsconfig_path) return;

    tsconfig_path = path;
    overrides = path ? read_tsconfig(path) : null;
    options = null;

    typescript_service.reset();
}

/** tsconfig 改过了，下次重新读一遍 */
export function forget_tsconfig(): void {
    tsconfig_path = null;
}

/**
 * 把 SFC 变成虚拟 `.ts`：script 之外全部替换成等长空白（换行保留）。
 *
 * 这样虚拟文件里的 offset 就是 SFC 里的 offset，TS 报出来的位置不需要换算。
 * `<script module>` 和 `<script>` 都放回原位，合成一个文件，两边的变量互相可见。
 */
/** 铺虚拟文件只需要这几个字段——解析失败时兜底扫出来的 script 也给得出 */
export interface VirtualScript {
    contentStart: number;
    contentEnd: number;
    raw: string;
}

/** 模板里的一个表达式（`{x}` / `onclick={...}`），铺进虚拟文件用 */
export interface VirtualExpression {
    contentStart: number;
    contentEnd: number;
    raw: string;
}

export function build_virtual(
    source: string,
    scripts: VirtualScript[],
    expressions: VirtualExpression[],
    /** 追加在文件末尾的声明（循环变量之类）；放在末尾是为了不影响任何已有偏移 */
    tail = ''
): string {
    let virtual = source.replace(/[^\n\r]/g, ' ');

    for (const script of scripts) {
        if (!script) continue;

        virtual = virtual.slice(0, script.contentStart) + script.raw + virtual.slice(script.contentEnd);
    }

    // 模板里的表达式也铺进来：语义高亮是 TS 给的，模板区域原来是纯空白，
    // 拿不到分类（`onclick={() => ...}` 里的函数体就没高亮）。
    //
    // 用 `( ... );` 包成表达式语句让它合法：括号和分号写在原本是空白的位置上，
    // 表达式本身还落在原来的 offset 上，不用做换算
    for (const expression of expressions) {
        const start = expression.contentStart;
        const end = expression.contentEnd;

        // 左右各得有一个空白位置放括号，而且不能踩到别的表达式 / script 上去
        if (start === 0 || end >= virtual.length) continue;
        if (virtual[start - 1] !== ' ' || virtual[end] !== ' ') continue;

        const semicolon = virtual[end + 1] === ' ';

        virtual =
            virtual.slice(0, start - 1) +
            '(' +
            expression.raw +
            ')' +
            (semicolon ? ';' : '') +
            virtual.slice(semicolon ? end + 2 : end + 1);
    }

    return tail ? `${virtual}\n${tail}` : virtual;
}

/**
 * TypeScript 内部会把路径规范化成「正斜杠 + 小写盘符」。
 * 我们不照做的话，TS 拿 `d:/a/b.ts` 来要快照，Map 里存的是 `d:\a\b.ts`，查不到，
 * 就会退化成读磁盘，然后报 `Could not find source file`。
 */
function normalize(file: string): string {
    return file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_match, drive) => `${drive.toLowerCase()}:`);
}

export function virtual_name(filename: string): string {
    return normalize(`${filename}.ts`);
}

/** script 里的一补全候选项 */
export interface CompletionEntry {
    name: string;
    /** `ts.ScriptElementKind` 的字符串值（`class` / `function` / `var` …） */
    kind: string;
    sortText: string;
    /** TS 给的插入文本，可能是 `foo($0)` 这种带占位符的 */
    insertText?: string;
    /**
     * 用来跟输入比对 / 决定替换范围的文本。
     *
     * 名字不代表实际输入时（比如 `a-b` 要写成 `["a-b"]`）TS 会给一个不一样的值；
     * 不给的话 VS Code 拿 label 去比，这类候选就永远匹配不上。
     */
    filterText?: string;
    /** 类型文本，如 `(x: number) => number` */
    detail?: string;
    documentation?: string;
}

/** 补全项的详情：签名和文档 */
export interface CompletionDetail {
    detail?: string;
    documentation?: string;
}

/** 一处语义分类：这个位置上的东西是类名 / 接口 / 参数 … */
export interface SemanticSpan {
    start: number;
    length: number;
    /** 语义 token 类型名（`class` / `interface` / `type` …） */
    type: string;
    /** 语义 token 修饰符 */
    modifiers: string[];
}

/** 跟 providers 里 legend 的顺序一致 */
const TOKEN_NAMES = [
    'class', 'enum', 'interface', 'namespace', 'typeParameter', 'type',
    'parameter', 'variable', 'enumMember', 'property', 'function', 'method'
];

/** 修饰符按位：declaration / static / async / readonly / defaultLibrary / local */
const TOKEN_MODIFIER_NAMES = [
    'declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local'
];

export interface QuickInfo {
    /** 例如 `let count: number` */
    text: string;
    documentation: string;
}

export interface SemanticProblem {
    start: number;
    end: number;
    message: string;
}

/**
 * TypeScript 语言服务。整个插件共用一个实例，文档更新时刷新对应的虚拟文件。
 *
 * 语言服务本身也是第一次用到才创建——创建它要加载 `lib.es2022.d.ts`，开销不小。
 */
class TypeScriptService {
    private contents = new Map<string, string>();
    private versions = new Map<string, number>();
    private service: TS.LanguageService | null = null;

    constructor() {
        this.contents.set(GRAIN_TYPES, GRAIN_TYPE_SOURCE);
        this.versions.set(GRAIN_TYPES, 1);
    }

    private host(): TS.LanguageServiceHost {
        const ts = get_ts();
        const contents = this.contents;
        const versions = this.versions;

        return {
            getScriptFileNames: () => [...contents.keys()],
            getScriptVersion: (file) => String(versions.get(file) ?? 1),
            getScriptSnapshot: (file) => {
                const content = contents.get(file);

                if (content !== undefined) return ts.ScriptSnapshot.fromString(content);
                if (!ts.sys.fileExists(file)) return undefined;

                return ts.ScriptSnapshot.fromString(ts.sys.readFile(file) ?? '');
            },
            getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
            getCompilationSettings: () => get_options(),
            getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
            fileExists: (file) => contents.has(file) || ts.sys.fileExists(file),
            readFile: (file) => contents.get(file) ?? ts.sys.readFile(file),
            readDirectory: (...args) => ts.sys.readDirectory(...args),
            directoryExists: (dir) => ts.sys.directoryExists(dir),
            getDirectories: (dir) => ts.sys.getDirectories(dir)
        };
    }

    private get(): TS.LanguageService {
        return (this.service ??= get_ts().createLanguageService(this.host()));
    }

    /** 丢掉已建好的语言服务，下次用到时按新配置重建 */
    reset(): void {
        this.service = null;
        log('语言服务已重置');
    }

    /** script 里的补全，交给 TS 语言服务 */
    completions(file: string, offset: number): CompletionEntry[] {
        const info = this.get().getCompletionsAtPosition(file, offset, {
            includeCompletionsForModuleExports: true,
            includeCompletionsWithInsertText: true
        });

        log('TS 补全', file, offset, '->', info ? `${info.entries.length} 项` : 'undefined');

        if (!info) return [];

        return info.entries.map((entry) => ({
            name: entry.name,
            kind: String(entry.kind),
            sortText: entry.sortText ?? entry.name,
            insertText: entry.insertText,
            filterText: entry.filterText
        }));
    }

    /**
     * `x.` 这种"刚敲下点号"的补全。
     *
     * `getCompletionsAtPosition` 在语法不完整的地方会直接返回 undefined（`Math.` 后面空着时），
     * 所以自己来：拿点号左边的表达式问类型，再把成员枚举出来。
     */
    member_completions(file: string, offset: number): CompletionEntry[] {
        const ts = get_ts();
        const dot = offset - 1;

        const program = this.get().getProgram();
        const source_file = program?.getSourceFile(file);

        // 无条件先打一条：早退的话，日志里能直接看出"虚拟文件里点号位置不是 ."
        // （多半是虚拟文件比文档旧，偏移对不上）
        log(
            'member_completions',
            'dot', dot,
            '字符', source_file ? JSON.stringify(source_file.text[dot] ?? '') : '虚拟文件不在'
        );

        if (!program || !source_file || source_file.text[dot] !== '.') return [];

        // 点号左边那个表达式：结束位置正好落在点号上的最内层节点
        let target: TS.Node | undefined;

        const visit = (node: TS.Node): void => {
            if (node.getEnd() === dot && node.getStart(source_file) < dot) target = node;
            node.forEachChild(visit);
        };

        visit(source_file);

        log('member_completions 左边', target ? `"${target.getText(source_file)}"` : '没找到');

        if (!target) return [];

        const checker = program.getTypeChecker();
        const type = checker.getApparentType(checker.getTypeAtLocation(target));
        const properties = type.getProperties();

        // `Symbol.toStringTag` 这类符号属性在 TS 里叫 `__@toStringTag@N`，
        // 拼不出合法成员表达式，不该进候选
        const visible = properties.filter((symbol) => !symbol.getName().startsWith('__'));

        log(
            'member_completions 类型',
            checker.typeToString(type),
            '成员',
            visible.length,
            '（共',
            properties.length,
            '）'
        );

        return visible.map((symbol, index) => {
            const flags = symbol.getFlags();
            let kind = 'var';

            if (flags & ts.SymbolFlags.Method) kind = 'method';
            else if (flags & ts.SymbolFlags.Function) kind = 'function';
            else if (flags & ts.SymbolFlags.Property) kind = 'property';
            else if (flags & ts.SymbolFlags.Class) kind = 'class';
            else if (flags & ts.SymbolFlags.Interface) kind = 'interface';
            else if (flags & ts.SymbolFlags.Enum) kind = 'enum';
            else if (flags & ts.SymbolFlags.Module) kind = 'module';

            return {
                name: symbol.getName(),
                kind,
                // 排在 TS 给的那些前面
                sortText: `0${String(index).padStart(4, '0')}`,
                filterText: symbol.getName(),
                detail: checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, target!))
            };
        });
    }

    /** 补全项的签名和文档（VS Code 选中某一项时才来要） */
    completion_detail(file: string, offset: number, name: string): CompletionDetail | null {
        const details = this.get().getCompletionEntryDetails(file, offset, name, undefined, undefined, undefined, undefined);
        if (!details) return null;

        const detail = details.displayParts?.map((part) => part.text).join('') ?? '';
        const documentation = details.documentation?.map((part) => part.text).join('') ?? '';

        return { detail: detail || undefined, documentation: documentation || undefined };
    }

    /**
     * 语义分类：哪些位置是类名、接口、类型别名、参数 …
     *
     * 虚拟文件和原文件偏移一一对应，所以结果可以直接用。
     * 模板区域在虚拟文件里是空白，拿不到分类 —— 那边交给 TextMate。
     */
    classifications(file: string, length: number): SemanticSpan[] {
        const ts = get_ts();
        const service = this.get();

        const { spans } = service.getEncodedSemanticClassifications(
            file,
            { start: 0, length },
            ts.SemanticClassificationFormat.TwentyTwenty
        );

        const result: SemanticSpan[] = [];

        for (let i = 0; i + 2 < spans.length; i += 3) {
            // 编码是 `type | (modifier << 8)`：高 8 位是类型（从 1 起），低 8 位是修饰符位掩码
            const encoded = spans[i + 2];
            const type = TOKEN_NAMES[(encoded >> 8) - 1];
            if (!type) continue;

            const bits = encoded & 0xff;
            const modifiers = TOKEN_MODIFIER_NAMES.filter((_, index) => bits & (1 << index));

            result.push({ start: spans[i], length: spans[i + 1], type, modifiers });
        }

        return result;
    }

    /** 提前把语言服务建好（在编辑 .grain 时后台调用，避免第一次 hover 卡一下） */
    warmup(): void {
        try {
            this.get();
            log('语言服务就绪');
        } catch (error) {
            console.error('[grain] 语言服务启动失败', error);
        }
    }

    update(file: string, content: string): void {
        const key = normalize(file);
        if (this.contents.get(key) === content) return;

        this.contents.set(key, content);
        this.versions.set(key, (this.versions.get(key) ?? 1) + 1);
    }

    remove(file: string): void {
        const key = normalize(file);

        this.contents.delete(key);
        this.versions.delete(key);
    }

    quick_info(file: string, offset: number): QuickInfo | null {
        const key = normalize(file);
        const info = this.get().getQuickInfoAtPosition(key, offset);
        log('quick_info', key, offset, '->', info ? '命中' : '没命中');

        if (!info) return null;

        return {
            text: (info.displayParts ?? []).map((part) => part.text).join(''),
            documentation: (info.documentation ?? []).map((part) => part.text).join('')
        };
    }

    semantic_problems(file: string): SemanticProblem[] {
        const ts = get_ts();
        const key = normalize(file);

        const problems = this.get()
            .getSemanticDiagnostics(key)
            .filter((diagnostic) => normalize(diagnostic.file?.fileName ?? '') === key)
            .map((diagnostic) => {
                const start = diagnostic.start ?? 0;
                const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');

                return { start, end: start + (diagnostic.length ?? 1), message };
            });

        log('semantic', file, '->', problems.length, '条');

        return problems;
    }
}

export const typescript_service = new TypeScriptService();
