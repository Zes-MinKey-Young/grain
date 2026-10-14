/**
 * 客户端路由。
 *
 * 一个 SPA 的无预渲染路由。路由表是**编译期生成**的（`grain:routes`，插件扫 `src/routes`
 * 得到），这里只做三件运行时的活：
 *
 * - **匹配**：`/post/:id` 这种带参数的模式，匹配上就把参数挑出来
 * - **渲染**：清空容器，把页面挂上去。页面之间不复用 —— 那是列表（{#for}）的活
 * - **导航**：`navigate()` 改 history 并渲染；浏览器前进 / 后退走 `popstate`
 *
 * 刻意**不**从 `./index.js` 导入 `writable`：index 会 re-export 这里的东西，反过来 import
 * 就成环了（ESM 求值顺序是本文件先，那时 index 还没跑完）。路由状态用一个形状相同的极简
 * 订阅（见 `tiny`），模板里 `{$read(route)}` 照样能用。
 */
import type { Writable } from './index.js';

/**
 * 一个极简的可订阅值 —— 形状跟 `writable` 一样，所以能直接喂给 `$read` / `$store`。
 */
function tiny<T>(initial: T): Writable<T> {
    let value = initial;

    const listeners = new Set<(next: T) => void>();

    return {
        get: () => value,

        set(next: T): T {
            if (next === value) return value;

            value = next;

            for (const listener of [...listeners]) listener(value);

            return value;
        },

        subscribe(listener: (next: T) => void): () => void {
            listeners.add(listener);

            listener(value);

            return () => {
                listeners.delete(listener);
            };
        }
    } as Writable<T>;
}

/** 一个页面：编译产物里的默认导出 */
export type Page = (target: Element) => void;

/** 一条路由。 `path` 用 `/post/:id` 这种写法 */
export interface RouteDef {
    path: string;
    /** 同步给组件，或者给个 `() => import('./x.grain')` 让它懒加载 */
    page: Page | (() => Page | Promise<Page>);
}

/** 当前所在的路由 */
export interface Route {
    /** 实际路径，如 `/post/7` */
    path: string;
    /** 匹配上的模式，如 `/post/:id` */
    pattern: string;
    /** `:id` 这类段取出来的值 */
    params: Record<string, string>;
}

export interface Router {
    /** 当前路由（响应式） */
    route: Writable<Route>;
    /** 跳到某个路径 */
    navigate(to: string, options?: { replace?: boolean }): void;
    /** 装上监听（拦截站内链接、响应前进后退） */
    start(): void;
    /** 撤掉监听，卸载路由 */
    stop(): void;
}

/** 把模式编译成正则：`/post/:id` -> `^/post/([^/]+)$` */
function compile(pattern: string): { regex: RegExp; keys: string[] } {
    const keys: string[] = [];
    const source = pattern
        .split('/')
        .map((segment) => {
            if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            keys.push(segment.slice(1));

            return '([^/]+)';
        })
        .join('/');

    return { regex: new RegExp(`^${source}$`), keys };
}

/** 找到第一条匹配的路径 */
function match(routes: RouteDef[], path: string): { def: RouteDef; params: Record<string, string> } | null {
    for (const def of routes) {
        const { regex, keys } = compile(def.path);
        const found = regex.exec(path);

        if (!found) continue;

        const params: Record<string, string> = {};

        keys.forEach((key, at) => {
            params[key] = decodeURIComponent(found[at + 1]);
        });

        return { def, params };
    }

    return null;
}

/** 去掉查询串和 hash，只留路径；补上开头的 `/` 并保证不以 `/` 结尾（根除外） */
export function normalize(path: string): string {
    const clean = path.split('?')[0].split('#')[0];

    if (!clean.startsWith('/')) return `/${clean}`;

    return clean.length > 1 ? clean.replace(/\/+$/, '') : clean;
}

/**
 * 建一个路由。
 *
 * @param options.routes 路由表（顺序敏感：前面的先匹配）
 * @param options.target 页面挂在哪
 * @param options.fallback 都没匹配上时挂什么（不给就留空）
 */
/**
 * 最近 `start()` 过的那个路由器。
 *
 * 一个页面一般只有一个，所以 `navigate()` 可以直接用，不用把 router 到处传。
 */
let current: Router | null = null;

/** 跳到某个路径（用当前路由器） */
export function navigate(to: string, options?: { replace?: boolean }): void {
    current?.navigate(to, options);
}

/** 当前路由（响应式）；还没 start 时是个占位 */
export const route = tiny<Route>({ path: '/', pattern: '', params: {} });

export function createRouter(options: {
    routes: RouteDef[];
    target: Element;
    fallback?: Page;
}): Router {
    const { routes, target, fallback } = options;

    // 用的是模块级那个 `route` —— 组件 import 到的就是同一个
    route.set({
        path: normalize(typeof location === 'undefined' ? '/' : location.pathname),
        pattern: '',
        params: {}
    });

    let mounted: (() => void) | null = null;

    const render = async (path: string): Promise<void> => {
        const found = match(routes, path);

        route.set({ path, pattern: found?.def.path ?? '', params: found?.params ?? {} });

        // 上一个页面：编译产物可能返回 dispose，先调掉
        mounted?.();
        mounted = null;

        target.textContent = '';

        if (!found) {
            fallback?.(target);

            return;
        }

        const given = found.def.page;
        // 同步组件直接用；`() => import(...)` 这种先取出来 —— 它拿到的是**模块命名空间**，
        // 页面在 `.default` 上
        const loaded = typeof given === 'function' && !('prototype' in given && (given as { prototype?: unknown }).prototype)
            ? await (given as () => Page | Promise<Page>)()
            : given;

        const page = (
            typeof loaded === 'function' ? loaded : (loaded as { default?: Page }).default
        ) as Page | undefined;

        if (!page) return;

        const result = page(target) as unknown;

        // 编译产物的 mount 返回一个 dispose（有的话）
        if (typeof result === 'function') mounted = result as () => void;
    };

    const navigate = (to: string, options?: { replace?: boolean }): void => {
        const path = normalize(to);

        if (typeof history !== 'undefined') {
            if (options?.replace) history.replaceState({}, '', path);
            else history.pushState({}, '', path);
        }

        void render(path);
    };

    /** 站内链接：拦下来走 navigate，别整页刷新 */
    const onClick = (raw: Event): void => {
        const event = raw as MouseEvent;

        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const anchor = (event.target as Element | null)?.closest?.('a');

        if (!anchor) return;

        const href = anchor.getAttribute('href');

        // 外链、空、带 target、下载的都放过
        if (!href || href.startsWith('http') || href.startsWith('//') || anchor.hasAttribute('target') || anchor.hasAttribute('download')) return;

        event.preventDefault();

        navigate(href);
    };

    const onPop = (): void => {
        void render(normalize(location.pathname));
    };

    const start = (): void => {
        current = self;

        document.addEventListener('click', onClick);

        if (typeof window !== 'undefined') window.addEventListener('popstate', onPop);

        void render(route.get().path);
    };

    const stop = (): void => {
        if (current === self) current = null;

        document.removeEventListener('click', onClick);

        if (typeof window !== 'undefined') window.removeEventListener('popstate', onPop);

        mounted?.();
        mounted = null;
    };

    const self: Router = { route, navigate, start, stop };

    return self;
}

/**
 * 一个 `<a>`，站内跳转走路由而不是整页刷新。
 *
 * 用法：`<a use:link href="/about">` —— 不过 grain 现在没有 `use:`，所以直接给个普通的
 * `<a href="/about">` 就行：路由 `start()` 之后会在 document 上拦截所有站内链接。
 * 这个函数留给想手动接管某几个链接的场景。
 */
export function link(anchor: Element, router: Router): void {
    anchor.addEventListener('click', (event) => {
        event.preventDefault();

        const href = anchor.getAttribute('href');

        if (href) router.navigate(href);
    });
}
