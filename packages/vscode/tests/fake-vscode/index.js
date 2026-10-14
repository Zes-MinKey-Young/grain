/**
 * `vscode` 的替身 —— 真模块只存在于扩展宿主里，测试要跑就得有个假的顶上。
 *
 * 靠 `packages/vscode/package.json` 的 `devDependencies: { "vscode": "file:./tests/fake-vscode" }`
 * 挂上去。为什么不用别的办法：
 *
 * - `Bun.plugin` 的 `onResolve`：bun 的 runtime resolver 是同步的，plugin 的 hook 是异步的，
 *   赶不上 —— 静态 import 和动态 import 都试过，都不生效
 * - 根 `package.json` 的 `overrides`：只影响外部依赖，workspace 内的包不吃它
 * - 手动往 `node_modules/vscode` 丢文件：能跑，但那个目录不进版本库，干净克隆会挂
 *
 * 设计上任何属性 / 方法调用都返回它自己（万能 Proxy），所以扩展碰到的每个 API 都不会因为
 * 缺了而崩。测试要断言的少数几个（装饰类型、监听器注册）由 `stubs` 暴露出来。
 */

/** 万能替身：属性访问、方法调用、new 构造都通通返回它自己 */
function anything() {
    const proxy = new Proxy(function () {}, {
        get: (_, prop) => (prop === 'then' ? undefined : proxy),
        apply: () => proxy,
        construct: () => proxy
    });

    return proxy;
}

/** 记录调用次数的假函数 */
function spy(fn) {
    const calls = [];

    const self = (...args) => {
        calls.push(args);

        return fn ? fn(...args) : undefined;
    };

    self.calls = calls;

    return self;
}

const channel = {
    appendLine: () => {},
    append: () => {},
    clear: () => {},
    show: () => {},
    dispose: () => {}
};

export const stubs = {
    window: {
        createTextEditorDecorationType: spy(() => ({ dispose() {} })),
        onDidChangeActiveTextEditor: spy(() => ({ dispose() {} })),
        createOutputChannel: spy(() => channel),
        showTextDocument: async () => ({}),
        activeTextEditor: undefined
    },

    workspace: {
        onDidChangeTextDocument: spy(() => ({ dispose() {} })),
        onDidChangeConfiguration: spy(() => ({ dispose() {} })),
        getConfiguration: () => ({ get: () => undefined })
    }
};

export const window = stubs.window;
export const workspace = stubs.workspace;

export const Uri = {
    file: (path) => ({ fsPath: path, toString: () => path }),
    parse: (text) => ({ fsPath: text, toString: () => text })
};

export class Range {
    constructor(start, end) {
        this.start = start;
        this.end = end;
    }
}

export const languages = anything();
export const commands = anything();

export class LanguageStatusItem {}
