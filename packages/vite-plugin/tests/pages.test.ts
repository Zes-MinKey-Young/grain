import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { pageHtml, staticPages, writePages } from '../index.ts';

/** 造一个只有路由和模板的项目 */
function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'grain-pages-'));

    for (const [name, content] of Object.entries(files)) {
        const path = join(root, name);

        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, content, 'utf8');
    }

    return root;
}

const TEMPLATE = `<!doctype html>
<html>
    <body>
        <div id="app"></div>
        <script type="module" src="/src/main.ts"></script>
    </body>
</html>`;

describe('多页模式', () => {
    it('每条静态路由生成一个 index.html，入口是根相对地址', () => {
        const root = project({
            'app.html': TEMPLATE,
            'src/routes/+page.grain': '<p>home</p>',
            'src/routes/record/+page.grain': '<p>record</p>'
        });

        const input = writePages(root, {});

        expect(Object.keys(input).sort()).toEqual(['index', 'record']);
        expect(input.index).toBe(join(root, 'index.html'));
        expect(input.record).toBe(join(root, 'record', 'index.html'));

        const home = readFileSync(join(root, 'index.html'), 'utf8');
        const record = readFileSync(join(root, 'record', 'index.html'), 'utf8');

        // 不能是 `./__grain-page.ts`：`/record`（不带尾斜杠）时相对解析会跑到根目录
        expect(home).toContain('src="/__grain-page.ts"');
        expect(record).toContain('src="/record/__grain-page.ts"');

        // 模板里原来那个 module 脚本要被挖掉，只留一份
        expect(home.match(/type="module"/g) ?? []).toHaveLength(1);
        expect(home).not.toContain('/src/main.ts');

        expect(readFileSync(join(root, 'record', '__grain-page.ts'), 'utf8'))
            .toContain('src/routes/record/+page.grain');
    });

    it('动态路由跳过（没有参数生成不出来）', () => {
        const root = project({
            'app.html': TEMPLATE,
            'src/routes/+page.grain': '<p>home</p>',
            'src/routes/posts/[id]/+page.grain': '<p>post</p>'
        });

        const patterns = staticPages(root).map((page) => page.pattern);

        expect(patterns).toEqual(['/']);
        expect(writePages(root, {})).toEqual({ index: join(root, 'index.html') });
    });

    it('模板可以自己指定、挂载点也能换', () => {
        const root = project({
            'shell.html': '<body><div id="root"></div></body>',
            'src/routes/+page.grain': '<p>home</p>'
        });

        writePages(root, { template: 'shell.html', mount: '#root' });

        expect(readFileSync(join(root, '__grain-page.ts'), 'utf8'))
            .toContain('querySelector("#root")');
    });

    it('没有模板时给出可操作的报错', () => {
        const root = project({ 'src/routes/+page.grain': '<p>home</p>' });

        expect(() => writePages(root, {})).toThrow(/app\.html/);
    });

    it('模板不许是要覆盖的那个文件', () => {
        const root = project({
            'index.html': TEMPLATE,
            'src/routes/+page.grain': '<p>home</p>'
        });

        expect(() => writePages(root, { template: 'index.html' })).toThrow(/改名/);
    });

    it('pageHtml 没有 </body> 时直接追加', () => {
        expect(pageHtml('<div id="app"></div>', '/__grain-page.ts'))
            .toBe('<div id="app"></div>\n<script type="module" src="/__grain-page.ts"></script>\n');
    });
});
