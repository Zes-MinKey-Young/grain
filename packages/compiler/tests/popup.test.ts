/// <reference types="bun" />
import { beforeAll, it, expect } from 'bun:test';
import { Window } from 'happy-dom';
import type { Document } from 'happy-dom';
import { join } from 'node:path';

import { compile } from '..';

// 症状：点 OptionBox 什么也不出来。
//
// 结构上和 `PopupOption.grain` 一致：
//   <div class="trigger" onclick={toggle}>
//       {#if visible}<div class="popup {sliding ? 'sliding' : ''}">…</div>{/if}
//   </div>
// 点一下 -> visible = true，下一帧 sliding = true（滑入动画）。
// 两条都要生效：弹窗得出现，`sliding` 这个 class 也得跟着刷上去。

const runtimePath = join(import.meta.dir, '..', '..', 'runtime', 'index.ts');

let window: Window;
let document: Document;

beforeAll(() => {
    window = new Window();
    document = window.document as unknown as Document;

    const globals = globalThis as unknown as Record<string, unknown>;

    globals.document = document;
    globals.Node = window.Node;
    globals.window = window;
    globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
});

const mount = async (source: string): Promise<Element> => {
    const js = compile(source, { runtimeModule: runtimePath, filename: 'popup.grain' }).js;
    const file = join(import.meta.dir, '..', '..', '..', '.tmp', `popup-${Math.random().toString(36).slice(2)}.ts`);

    await Bun.write(file, js);

    const module = await import(file);
    const target = document.createElement('div');

    document.body.appendChild(target);
    module.default(target);

    return target;
};

const triggers = async (target: Element) => {
    const trigger = target.querySelector('.trigger')!;

    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    // 等 rAF（popup 里的 `requestAnimationFrame(() => isSliding = true)`）
    await new Promise((resolve) => setTimeout(resolve, 20));

    return trigger as Element;
};

// 回归线：`requestAnimationFrame(() => (sliding = true))` 里的写入必须能刷新。
//
// 曾经守卫只发在外层函数体上（`let __prev = sliding; …; if (sliding !== __prev) …`），
// 而 rAF 的回调要到下一帧才跑 —— 比较在回调执行前就做完了，class 永远刷不上，
// 页面上的症状是 OptionBox 点开什么也看不到（弹窗节点在里面，但没有 `sliding`）。
//
// 现在回调自己带守卫（含表达式体箭头），所以点开就能看到。
it('shows the popup after clicking the trigger', async () => {
    const target = await mount(`<script>
    let visible = $state(false);
    let sliding = $state(false);

    function toggle() {
        visible = true;

        requestAnimationFrame(() => (sliding = true));
    }
</script>

<div class="trigger" role="button" onclick={toggle}>
    <span>pick</span>

    {#if visible}
        <div class="popup {sliding ? 'sliding' : ''}">
            <div class="option-item">a</div>
            <div class="option-item">b</div>
        </div>
    {/if}
</div>`);

    expect(target.querySelector('.popup')).toBeNull();

    await triggers(target);

    const popup = target.querySelector('.popup');

    expect(popup).not.toBeNull();
    expect([...popup!.querySelectorAll('.option-item')].map((node) => node.textContent)).toEqual(['a', 'b']);
    expect(popup!.className).toContain('sliding');
});

it('updates a class bound outside the branch', async () => {
    // 分支已存在后，改别的 $state 也要能刷到它（`isFading` 那条路）
    const target = await mount(`<script>
    let visible = $state(true);
    let fading = $state(false);
</script>

<div class="trigger">
    {#if visible}
        <div class="popup {fading ? 'closed' : ''}">x</div>
    {/if}
</div>

<button class="fade" onclick={() => (fading = true)}>fade</button>`);

    expect(target.querySelector('.popup')!.className).not.toContain('closed');

    target.querySelector('.fade')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(target.querySelector('.popup')!.className).toContain('closed');
});
