/// <reference types="bun" />
import { it, expect, beforeEach } from 'bun:test';
import {
    createRouter,
    joinBase,
    normalizeBase,
    route,
    stripBase,
    type Page,
    type RouteDef
} from '../router.js';

// base 支持：部署在 GitHub Pages 项目页这种子路径下时，路由表和地址栏要能对上。
// 除了纯函数，这里还用一套尽量贴近浏览器的桩跑完整链路：
// 初始加载、点链接、地址栏直接输、前进后退。

const pages: string[] = [];

/** 同步页面：编译产物是 function 声明（有 prototype），箭头函数会被当成懒加载器 */
const page = (name: string): Page =>
    function page() { pages.push(name); } as unknown as Page;

const routes: RouteDef[] = [
    { path: '/', page: page('/') },
    { path: '/record', page: page('/record') }
];

let pathname = '/app/';
let pushed: string[] = [];
let listeners = new Map<string, Set<(event: never) => void>>();

const target = { textContent: '' } as unknown as Element;

const on = (type: string, fn: (event: never) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
};
const off = (type: string, fn: (event: never) => void) => {
    listeners.get(type)?.delete(fn);
};
const fire = (type: string, event: unknown) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event as never);
};

/** 一个够用的 <a>：closest('a') 回到自己，getAttribute 拿 href */
const anchor = (href: string, attributes: Record<string, string> = {}) => ({
    closest: (selector: string) => (selector === 'a' ? anchorElement : null),
    getAttribute: (name: string) => (name === 'href' ? href : null),
    hasAttribute: (name: string) => name in attributes
});

let anchorElement: ReturnType<typeof anchor>;

/** 点一次链接：button 0、没有修饰键 */
const click = (href: string, attributes?: Record<string, string>) => {
    anchorElement = anchor(href, attributes);

    let prevented = false;

    fire('click', {
        target: anchorElement,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        get defaultPrevented() { return prevented; },
        preventDefault: () => { prevented = true; }
    });

    return prevented;
};

beforeEach(() => {
    pages.length = 0;
    pushed = [];
    pathname = '/app/';
    target.textContent = '';
    listeners = new Map();

    (globalThis as Record<string, unknown>).location = {
        get pathname() { return pathname; }
    };
    (globalThis as Record<string, unknown>).history = {
        pushState: (_: unknown, __: string, url: string) => pushed.push(url),
        replaceState: (_: unknown, __: string, url: string) => pushed.push(url)
    };
    (globalThis as Record<string, unknown>).document = {
        addEventListener: on,
        removeEventListener: off
    };
    // popstate 挂 window，click 挂 document
    (globalThis as Record<string, unknown>).window = {
        addEventListener: on,
        removeEventListener: off
    };
});

it('normalizeBase', () => {
    expect(normalizeBase(undefined)).toBe('/');
    expect(normalizeBase('/')).toBe('/');
    expect(normalizeBase('/app')).toBe('/app/');
    expect(normalizeBase('/app/')).toBe('/app/');
    expect(normalizeBase('/app//')).toBe('/app/');
    expect(normalizeBase('/app/?x=1#y')).toBe('/app/');
    // 相对 base 没法 pushState，退回根
    expect(normalizeBase('./')).toBe('/');
    expect(normalizeBase('app/')).toBe('/');
});

it('stripBase / joinBase', () => {
    expect(stripBase('/app/post/7', '/app/')).toBe('/post/7');
    expect(stripBase('/app', '/app/')).toBe('/');
    expect(stripBase('/app/', '/app/')).toBe('/');
    expect(stripBase('/post/7', '/app/')).toBe('/post/7');
    expect(stripBase('/post/7', '/')).toBe('/post/7');
    // 只前缀相同不算（/appx 不是 /app/ 底下）
    expect(stripBase('/appx/foo', '/app/')).toBe('/appx/foo');

    expect(joinBase('/post/7', '/app/')).toBe('/app/post/7');
    expect(joinBase('/', '/app/')).toBe('/app/');
    expect(joinBase('/post/7', '/')).toBe('/post/7');
});

it('初始路径按 base 剥掉再匹配', () => {
    createRouter({ routes, target, base: '/app/' }).start();

    const here = route.get();

    expect(here.path).toBe('/');
    expect(here.fullPath).toBe('/app/');
    expect(pages).toEqual(['/']);
});

it('深层路径直接打开也能匹配', () => {
    pathname = '/app/record';

    createRouter({ routes, target, base: '/app/' }).start();

    expect(route.get().path).toBe('/record');
    expect(route.get().fullPath).toBe('/app/record');
    expect(pages).toEqual(['/record']);
});

it('navigate 收相对路径，地址栏写完整路径', () => {
    const router = createRouter({ routes, target, base: '/app/' });

    router.start();
    router.navigate('/record');

    expect(pushed).toEqual(['/app/record']);
    expect(route.get().path).toBe('/record');
    expect(route.get().fullPath).toBe('/app/record');
    expect(pages).toEqual(['/', '/record']);
});

it('地址栏里已经带了 base 也能用', () => {
    const router = createRouter({ routes, target, base: '/app/' });

    router.start();
    router.navigate('/app/record');

    expect(pushed).toEqual(['/app/record']);
    expect(route.get().path).toBe('/record');
});

it('点站内链接走路由，不整页刷新', () => {
    const router = createRouter({ routes, target, base: '/app/' });

    router.start();
    pages.length = 0;

    // 三种写法都应该落到同一个页面
    expect(click('/record')).toBe(true);
    expect(click('/app/record')).toBe(true);
    expect(click('record')).toBe(true);

    expect(pushed).toEqual(['/app/record', '/app/record', '/app/record']);
    expect(pages).toEqual(['/record', '/record', '/record']);
    expect(route.get().path).toBe('/record');

    router.stop();
});

it('外链 / 修饰键 / download / target 放过', () => {
    const router = createRouter({ routes, target, base: '/app/' });

    router.start();
    pages.length = 0;

    expect(click('https://example.com/x')).toBe(false);
    expect(click('//example.com/x')).toBe(false);
    expect(click('')).toBe(false);
    expect(click('/record', { download: true })).toBe(false);
    expect(click('/record', { target: '_blank' })).toBe(false);

    // 修饰键：浏览器自己开新标签
    anchorElement = anchor('/record');
    fire('click', {
        target: anchorElement,
        button: 0,
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault: () => { }
    });

    expect(pushed).toEqual([]);
    expect(pages).toEqual([]);

    router.stop();
});

it('popstate 走同一套剥 base', () => {
    const router = createRouter({ routes, target, base: '/app/' });

    router.start();
    pages.length = 0;

    pathname = '/app/record';
    fire('popstate', new Event('popstate'));

    expect(route.get().path).toBe('/record');
    expect(pages).toEqual(['/record']);

    // base 之外的路径：没有 fallback 就什么都不挂，但路由状态照实更新
    pathname = '/elsewhere';
    fire('popstate', new Event('popstate'));

    expect(route.get().path).toBe('/elsewhere');
    expect(pages).toEqual(['/record']);

    router.stop();
    fire('popstate', new Event('popstate'));

    expect(pages).toEqual(['/record']);
});

it('base 缺省时行为跟以前一致', () => {
    pathname = '/record';

    const router = createRouter({ routes, target });

    router.start();

    expect(route.get().path).toBe('/record');
    expect(route.get().fullPath).toBe('/record');

    router.navigate('/');

    expect(pushed).toEqual(['/']);
});
