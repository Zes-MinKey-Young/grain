// 注意：TypeScript 只能惰性加载。
// 扩展激活时同步 require('typescript') 会拖慢扩展宿主，直接触发 10 秒启动超时。
import type * as TS from 'typescript';

import { log } from './log.js';
import {
    is_runtime_file,
    RUNTIME_DECL_FILE,
    RUNTIME_MODULE_TEXT,
    RUNTIME_TYPES,
    runtime_package_json
} from './runtime-types.js';

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
 * Reactive state. Compiled down to a plain variable; functions that write to it
 * get the matching update calls appended.
 */
declare function $state<T>(initial: T): T;

/**
 * Component props — the type parameter is the props type.
 * \`let { label, children } = $props<{ label: string; children?: () => unknown }>();\`
 */
declare function $props<T extends Record<string, unknown> = Record<string, unknown>>(): T;

/**
 * A prop that supports two-way binding. When the parent writes \`bind:name={x}\`,
 * assigning to it in the child writes back to the parent's \`x\`.
 * The parameter is the fallback used when the parent passes nothing and binds nothing.
 */
declare function $bindable<T>(fallback?: T): T;

/** What a compiled component looks like from the outside */
interface GrainComponent {
    /** Mounts into the target element (top-level usage) */
    (target: Element): unknown;
    /** Kept for HMR re-mounting */
    target?: Element;
    /** Called by the parent component to create a child instance */
    create(props?: Record<string, unknown>, children?: (() => unknown) | null): unknown;
}

/**
 * Only used when the imported component is not open in the editor.
 * When it is, TS resolves \`./Child.grain\` to \`Child.grain.ts\` (its virtual file)
 * and this ambient declaration no longer applies — see VIRTUAL_EXPORT below.
 */
declare module "*.grain" {
    const component: GrainComponent;
    export default component;
}
`;

/**
 * 追加在每个虚拟文件末尾：让它**一定是模块**，并且有一个默认导出。
 *
 * 组件 A 里 `import B from './B.grain'` 时，如果 B 也在编辑器里开着，
 * TS 会解析到 B 的虚拟文件 `B.grain.ts`；那个文件里可能一句 import / export 都没有，
 * 于是报 "File ... is not a module"（而且是它盖掉了 `declare module "*.grain"`）。
 * 放在末尾是为了不影响任何已有偏移。
 */
export const VIRTUAL_EXPORT = `declare const __grain_component: GrainComponent;
export default __grain_component;`;

/**
 * 磁盘上的 `.grain` -> 虚拟 `.ts` 内容。
 *
 * 由 analysis 那边注入（只有它知道怎么把 SFC 铺成虚拟文件），这里只是
 * 在语言服务问起一个**还没在编辑器里打开过**的文件时临时补上 ——
 * tsconfig 的 `paths` 指向的文件经常是没打开过的，不补就解析不到。
 */
let virtual_provider: ((grain_file: string) => string | null | undefined) | null = null;

export function set_virtual_provider(provider: typeof virtual_provider): void {
    virtual_provider = provider;
}

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

/**
 * 虚拟文件 -> 真实文件。
 *
 * `import Child from './Child.grain'` 跳定义时，TS 给的目标是 `Child.grain.ts`
 * （我们喂给它的虚拟文件），那个文件在磁盘上并不存在；
 * 偏移跟原文件一一对应，所以去掉 `.ts` 就能直接跳到真正的 `.grain`。
 */
export function real_name(file: string): string {
    return file.endsWith('.grain.ts') ? file.slice(0, -'.ts'.length) : file;
}

/** 一处定义：`file` 为 null 表示就在当前文档里（偏移是原 SFC 的） */
export interface Definition {
    file: string | null;
    start: number;
    end: number;
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
    /** 没打开过的 .grain 临时编出来的虚拟文件，按修改时间决定要不要重编 */
    private lazy = new Map<string, { text: string; mtime: number }>();
    private service: TS.LanguageService | null = null;

    constructor() {
        this.contents.set(GRAIN_TYPES, GRAIN_TYPE_SOURCE);
        this.versions.set(GRAIN_TYPES, 1);
    }

    /**
     * 一个 `Foo.grain.ts`（我们给语言服务的虚拟文件名）对应的 SFC 在磁盘上，
     * 但编辑器没打开过它 —— 现场编一份出来。
     *
     * tsconfig 里 `paths` 指向的文件基本都是这种情况，不补就直接
     * "Cannot find module"。
     */
    private lazy_virtual(file: string): string | undefined {
        if (!file.endsWith('.grain.ts') || this.contents.has(file) || !virtual_provider) return undefined;

        const grain = file.slice(0, -'.ts'.length);
        if (!get_ts().sys.fileExists(grain)) return undefined;

        const mtime = Math.floor((get_ts().sys.getModifiedTime?.(grain)?.getTime() ?? 0) / 1000);
        const cached = this.lazy.get(file);

        if (cached && cached.mtime === mtime) return cached.text;

        const text = virtual_provider(grain);
        if (text === null || text === undefined) return undefined;

        this.lazy.set(file, { text, mtime });

        return text;
    }

    private host(): TS.LanguageServiceHost {
        const ts = get_ts();
        const contents = this.contents;
        const versions = this.versions;

        return {
            // 末尾那份是 `@graints/runtime` 的全局声明（项目不一定装了这个包）
            getScriptFileNames: () => [...contents.keys(), RUNTIME_DECL_FILE],
            getScriptVersion: (file) => {
                const own = versions.get(file);
                if (own !== undefined) return String(own);

                // 临时编出来的那些：按磁盘上的修改时间当版本号，改了才会重新编
                const mtime = ts.sys.getModifiedTime?.(file.slice(0, -'.ts'.length))?.getTime();

                return mtime ? String(Math.floor(mtime / 1000)) : '1';
            },
            getScriptSnapshot: (file) => {
                if (file === RUNTIME_DECL_FILE) return ts.ScriptSnapshot.fromString(RUNTIME_MODULE_TEXT);

                // `@graints/runtime`：用户项目不一定装了这个包，直接给内置声明
                if (is_runtime_file(file)) {
                    return ts.ScriptSnapshot.fromString(
                        file.endsWith('.json') ? runtime_package_json() : RUNTIME_TYPES
                    );
                }

                const content = contents.get(file) ?? this.lazy_virtual(file);

                if (content !== undefined) return ts.ScriptSnapshot.fromString(content);
                if (!ts.sys.fileExists(file)) return undefined;

                return ts.ScriptSnapshot.fromString(ts.sys.readFile(file) ?? '');
            },
            getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
            getCompilationSettings: () => get_options(),
            getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
            fileExists: (file) =>
                is_runtime_file(file) ||
                contents.has(file) ||
                this.lazy_virtual(file) !== undefined ||
                ts.sys.fileExists(file),
            readFile: (file) =>
                is_runtime_file(file)
                    ? file.endsWith('.json')
                        ? runtime_package_json()
                        : RUNTIME_TYPES
                    : (contents.get(file) ?? this.lazy_virtual(file) ?? ts.sys.readFile(file)),
            readDirectory: (...args) => ts.sys.readDirectory(...args),
            directoryExists: (dir) => ts.sys.directoryExists(dir),
            getDirectories: (dir) => ts.sys.getDirectories(dir)
        };
    }

    private get(): TS.LanguageService {
        return (this.service ??= get_ts().createLanguageService(this.host()));
    }

    /**
     * 解析一个 import 说明符，按当前编译选项来 —— 所以 tsconfig 的 `paths` 也认。
     *
     * 宿主要用我们自己的（认得虚拟文件），否则 `./Foo.grain` 解析不到 `Foo.grain.ts`。
     * 返回的是虚拟文件路径，要真实文件的话用 `real_name()` 转一下。
     */
    resolve_module(specifier: string, from: string): string | null {
        const resolved = get_ts().resolveModuleName(specifier, from, get_options(), this.host());

        return resolved.resolvedModule?.resolvedFileName ?? null;
    }

    /** 丢掉已建好的语言服务，下次用到时按新配置重建 */
    reset(): void {
        this.service = null;
        log('language service reset');
    }

    /** script 里的补全，交给 TS 语言服务 */
    completions(file: string, offset: number): CompletionEntry[] {
        const info = this.get().getCompletionsAtPosition(file, offset, {
            includeCompletionsForModuleExports: true,
            includeCompletionsWithInsertText: true
        });

        log('ts completions', file, offset, '->', info ? `${info.entries.length} entries` : 'undefined');

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
            'char', source_file ? JSON.stringify(source_file.text[dot] ?? '') : 'no virtual file'
        );

        if (!program || !source_file || source_file.text[dot] !== '.') return [];

        // 点号左边那个表达式：结束位置正好落在点号上的最内层节点
        let target: TS.Node | undefined;

        const visit = (node: TS.Node): void => {
            if (node.getEnd() === dot && node.getStart(source_file) < dot) target = node;
            node.forEachChild(visit);
        };

        visit(source_file);

        log('member_completions left', target ? `"${target.getText(source_file)}"` : 'not found');

        if (!target) return [];

        const checker = program.getTypeChecker();
        const type = checker.getApparentType(checker.getTypeAtLocation(target));
        const properties = type.getProperties();

        // `Symbol.toStringTag` 这类符号属性在 TS 里叫 `__@toStringTag@N`，
        // 拼不出合法成员表达式，不该进候选
        const visible = properties.filter((symbol) => !symbol.getName().startsWith('__'));

        log(
            'member_completions type',
            checker.typeToString(type),
            'members',
            visible.length,
            'of',
            properties.length
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
            log('language service ready');
        } catch (error) {
            console.error('[grain] failed to start the language service', error);
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
        log('quick_info', key, offset, '->', info ? 'hit' : 'miss');

        if (!info) return null;

        return {
            text: (info.displayParts ?? []).map((part) => part.text).join(''),
            documentation: (info.documentation ?? []).map((part) => part.text).join('')
        };
    }

    /**
     * 跳转定义。
     *
     * 虚拟文件里既有 script，也有模板表达式、if / for 条件，所以参数、局部变量、
     * `HTMLElement` 这类库里的类型，TS 都能自己找到（库里的会给出别的文件的区间）。
     */
    definition(file: string, offset: number): Array<{ file: string | null; start: number; end: number }> {
        const key = normalize(file);
        const found = this.get().getDefinitionAtPosition(key, offset) ?? [];

        return found.map((entry) => {
            const target = normalize(entry.fileName);

            return {
                // 跳到别的 .grain 时给真实文件，不是它那份虚拟文件
                file: target === key ? null : real_name(target),
                start: entry.textSpan.start,
                end: entry.textSpan.start + entry.textSpan.length
            };
        });
    }

    /**
     * 重命名的所有位置。
     *
     * 注意结果里可能包含我们补在虚拟文件末尾的声明（`declare let x`），
     * 那个偏移超出源码长度，由 analysis 那边过滤掉。
     */
    rename_locations(file: string, offset: number): Array<{ start: number; end: number }> {
        const key = normalize(file);
        const found = this.get().findRenameLocations(key, offset, false, false, {
            providePrefixAndSuffixTextForRename: false
        });

        return (found ?? [])
            .filter((location) => normalize(location.fileName) === key)
            .map((location) => ({
                start: location.textSpan.start,
                end: location.textSpan.start + location.textSpan.length
            }));
    }

    /**
     * 找引用（TS 会把声明本身也算一条）。
     *
     * 虚拟文件里除了 script，还有模板里的表达式（`{x}`、`onclick={...}`、`bind:value={...}`）
     * 和 if / for 的条件，所以一处问下去全都能找到。偏移跟原文件一一对应，不用换算。
     */
    references(file: string, offset: number): Array<{ start: number; end: number }> {
        const key = normalize(file);
        const found = this.get().getReferencesAtPosition(key, offset) ?? [];

        return found
            .filter((reference) => normalize(reference.fileName) === key)
            .map((reference) => ({
                start: reference.textSpan.start,
                end: reference.textSpan.start + reference.textSpan.length
            }));
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

        log('semantic', file, '->', problems.length, 'problems');

        return problems;
    }
}

export const typescript_service = new TypeScriptService();
