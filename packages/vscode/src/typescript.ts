// 注意：TypeScript 只能惰性加载。
// 扩展激活时同步 require('typescript') 会拖慢扩展宿主，直接触发 10 秒启动超时。
import type * as TS from 'typescript';

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
/** 工作区 tsconfig.json 里的编译选项 */
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
 * 读工作区的 tsconfig.json（会顺着 `extends` 找下去），拿来当编译选项。
 * 这样项目里配的 `lib` / `target` / `strict` 都能生效。
 */
export function read_tsconfig(path: string): TS.CompilerOptions | null {
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

/** 换编译选项。语言服务不会自己重读配置，得把它丢掉重建 */
export function set_compiler_options(next: TS.CompilerOptions): void {
    overrides = next;
    options = null;

    typescript_service.reset();
}

/**
 * 把 SFC 变成虚拟 `.ts`：script 之外全部替换成等长空白（换行保留）。
 *
 * 这样虚拟文件里的 offset 就是 SFC 里的 offset，TS 报出来的位置不需要换算。
 * `<script module>` 和 `<script>` 都放回原位，合成一个文件，两边的变量互相可见。
 */
export function build_virtual(source: string, scripts: Script[], filename: string): string {
    let virtual = source.replace(/[^\n\r]/g, ' ');

    for (const script of scripts) {
        if (!script) continue;

        virtual = virtual.slice(0, script.contentStart) + script.raw + virtual.slice(script.contentEnd);
    }

    return virtual;
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

let debug = false;

/** 打开 `grain.debug` 后，把语言服务的调用情况打到 Extension Host 日志里 */
export function set_debug(value: boolean): void {
    debug = value;
}

function log(...args: unknown[]): void {
    if (debug) console.log('[grain]', ...args);
}

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
