import { generate, type CssNode, type List, type TypeSelector } from 'css-tree';

import type { Stylesheet } from '../types.js';

const REGEX_KEYFRAMES = /^(-(webkit|moz|o)-)?keyframes$/;

/**
 * scope id：`grain-<hash>`，同时用作元素上的类名和选择器后缀。
 *
 * 取自文件名 + 源码内容，内容不变则 id 不变（SSR / 客户端一致），
 * 也不依赖 `crypto`，浏览器里一样能算。
 */
export function createScopeId(source: string, filename?: string): string {
    let hash = 5381;
    const input = `${filename ?? ''}\n${source}`;

    for (let i = 0; i < input.length; i += 1) {
        hash = (hash * 33 + input.charCodeAt(i)) | 0;
    }

    return `grain-${(hash >>> 0).toString(36)}`;
}

/** `<style global>` 整块都不做 scope */
export function isGlobal(stylesheet: Stylesheet): boolean {
    return stylesheet.attributes['global'] === true;
}

/**
 * 给组件样式加 scope：
 * - 每个选择器的最后一段加上 `.grain-hash`
 * - `@keyframes` 的名字带上 hash，引用处（`animation` / `animation-name`）同步改
 */
export function scopeStylesheet(stylesheet: Stylesheet, scopeId: string): string {
    const hash = scopeId.replace(/^grain-/, '');
    const keyframes = collectKeyframes(stylesheet.content.children, hash);

    walk(stylesheet.content.children, (node, insideKeyframes) => {
        if (node.type === 'Declaration') {
            if (node.property === 'animation' || node.property === 'animation-name') {
                renameAnimation(node.value, keyframes);
            }
        } else if (node.type === 'Rule' && !insideKeyframes && node.prelude.type === 'SelectorList') {
            for (const selector of node.prelude.children.toArray()) {
                if (selector.type === 'Selector') addScope(selector, scopeId);
            }
        }
    });

    // generate 出来是紧凑的，按 `}` 断个行方便看
    return `${generate(stylesheet.content).replace(/\}/g, '}\n').replace(/\n{2,}/g, '\n').trim()}\n`;
}

/** `@keyframes` 里的 `from` / `to` / `50%` 不是元素选择器，不能加 scope */
function walk(
    list: List<CssNode>,
    visit: (node: CssNode, insideKeyframes: boolean) => void,
    insideKeyframes = false
): void {
    for (const node of list.toArray()) {
        visit(node, insideKeyframes);

        if (node.type === 'Rule') {
            walk(node.block.children, visit, insideKeyframes);
        } else if (node.type === 'Atrule' && node.block) {
            walk(node.block.children, visit, insideKeyframes || REGEX_KEYFRAMES.test(node.name));
        }
    }
}

/** `@keyframes name` -> `@keyframes name-hash`，记下新旧名字 */
function collectKeyframes(list: List<CssNode>, hash: string): Map<string, string> {
    const renamed = new Map<string, string>();

    walk(list, (node) => {
        if (node.type !== 'Atrule' || !REGEX_KEYFRAMES.test(node.name)) return;

        const prelude = node.prelude;
        if (!prelude || prelude.type !== 'AtrulePrelude') return;

        const identifier = prelude.children.toArray().find((child) => child.type === 'Identifier');
        if (!identifier || identifier.type !== 'Identifier') return;

        const next = `${identifier.name}-${hash}`;
        renamed.set(identifier.name, next);
        identifier.name = next;
    });

    return renamed;
}

function renameAnimation(value: CssNode, renamed: Map<string, string>): void {
    if (value.type !== 'Value') return;

    for (const child of value.children.toArray()) {
        if (child.type !== 'Identifier') continue;

        const next = renamed.get(child.name);
        if (next) child.name = next;
    }
}

/**
 * 在最后一段复合选择器上加 `.scope`。
 *
 * `.a > .b:hover` -> `.a > .b.grain-hash:hover`
 * `*` 直接换成 scope 类，避免产生 `*.grain-hash`
 */
function addScope(selector: { type: 'Selector'; children: List<CssNode> }, scopeId: string): void {
    const items = selector.children.toArray();
    if (items.length === 0) return;

    // 最后一个组合器之后才是"目标元素"那一段
    let start = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i].type === 'Combinator') {
            start = i + 1;
            break;
        }
    }

    // 伪类 / 伪元素放在 scope 类后面
    let index = items.length;
    for (let i = items.length - 1; i >= start; i -= 1) {
        const item = items[i];
        if (item.type === 'PseudoClassSelector' || item.type === 'PseudoElementSelector') continue;

        index = i + 1;
        break;
    }

    if (index < start) index = start;

    const classSelector = { type: 'ClassSelector', name: scopeId } as CssNode;
    const previous = items[index - 1];

    if (previous && previous.type === 'TypeSelector' && (previous as TypeSelector).name === '*') {
        items.splice(index - 1, 1, classSelector);
    } else {
        items.splice(index, 0, classSelector);
    }

    selector.children.fromArray(items);
}
