/**
 * `@graints/runtime` 的声明。
 *
 * 组件里 `import { writable } from '@graints/runtime'` 时，语言服务得知道它是什么——
 * 但用户项目不一定装了这个包（本仓库的示例就没装）。所以在 host 里直接喂这份声明。
 *
 * 只要是对外的那几个 API：改了 runtime 的公开接口，这里也要跟着改。
 */
export const RUNTIME_TYPES = `
export interface Writable<T> {
    /** 当前值 */
    get(): T;
    /** 写新值，返回最终值；值没变就不通知 */
    set(next: T): T;
    /**
     * 订阅：立刻用当前值调一次，之后值变了再调。返回退订函数。
     */
    subscribe(listener: (value: T) => void): () => void;
}

export function writable<T>(initial: T): Writable<T>;

/** 一个带外部订阅的渲染函数 */
export interface Bound {
    (): unknown;
    listen?: (update: () => void) => void;
}

/** 单向绑定（属性值 / 模板插值用） */
export function creBound(
    render?: (() => unknown) | null,
    listen?: (update: (value?: unknown) => void) => void
): Bound;
`;

/** 语言服务里认这个模块名 */
export function is_runtime_file(file: string): boolean {
    return /@graints[\\/]runtime([\\/]|$)/.test(file);
}

/** 模块解析会先要 package.json */
export function runtime_package_json(): string {
    return JSON.stringify({
        name: '@graints/runtime',
        version: '0.0.0',
        types: 'index.d.ts',
        main: 'index.js'
    });
}

/** 这份声明挂进 program 时用的文件名（内容是全局的，不是模块） */
export const RUNTIME_DECL_FILE = '__graints_runtime.d.ts';

/**
 * 同一份东西的 `declare module` 版本。
 *
 * 光靠 host 里拦截模块解析不够稳（解析失败时它连问都不问），所以再挂一个全局声明文件
 * 进 program——`import { writable } from '@graints/runtime'` 就一定有类型。
 */
export const RUNTIME_MODULE_TEXT = `declare module '@graints/runtime' {
${RUNTIME_TYPES}
}
`;
