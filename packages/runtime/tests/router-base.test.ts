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

// base 支持：部署在 GitHub Pages 这种子路径下时，路由表和地址栏要能对上。

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

    expect(joinBase('/post/7', '/app/')).toBe('/app/post/7');
    expect(joinBase('/', '/app/')).toBe('/app/');
    expect(joinBase('/post/7', '/')).toBe('/post/7');
});

// —— 以下是带 location / history / document 桩的行为测试 ——

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
let listeners = new Map<string, Set<(event: Event) => void>>();

const target = { textContent: '' } as unknown as Element;

const fire = (type: string) => {
    const event = new Event(type);

    for (const listener of listeners.get(type) ?? []) listener(event);
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
    const on = (type: string, fn: (event: Event) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
    };
    const off = (type: string, fn: (event: Event) => void) => {
        listeners.get(type)?.delete(fn);
    };

    (globalThis as Record<string, unknown>).document = {
        addEventListener: on,
        removeEventListener: off
    };
    // popstate 挂在 window 上，click 挂在 document 上
    (globalThis as Record<string, unknown>).window = {
        addEventListener: on,
        removeEventListener: off
    };
});

it('初始路径按 base 剥掉再匹配', () => {
    createRouter({ routes, target, base: '/app/' }).start();

    const here = route.get();

    expect(here.path).toBe('/');
    expect(here.fullPath).toBe('/app/');
    expect(pages).toEqual(['/']);
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

it('popstate 走同一套剥 base', () => {
    const router = createRouter({ routes, target, base: '/app/' });

    router.start();
    pages.length = 0;

    pathname = '/app/record';
    fire('popstate');

    expect(route.get().path).toBe('/record');
    expect(pages).toEqual(['/record']);

    // base 之外的路径也按原样匹配（没有 fallback 就什么都不挂）
    pathname = '/elsewhere';
    fire('popstate');

    expect(route.get().path).toBe('/elsewhere');
    expect(pages).toEqual(['/record']);

    router.stop();
    fire('popstate');

    expect(pages).toEqual(['/record']);
});
