import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 把 TypeScript 的 lib 文件复制到 dist 下面。
 *
 * bundle 之后 TypeScript 是照着 `__dirname` 找 lib 的，而 `__dirname` 现在是输出目录
 * （也就是 dist/），算出来的是 `dist/lib.dom.d.ts` 这种路径。不复制过去的话，
 * 连 `string`、DOM 这些内置类型都读不到 —— 语言服务会满屏"找不到名称"。
 */
const from = join('node_modules', 'typescript', 'lib');
const to = 'dist';

mkdirSync(to, { recursive: true });

const files = readdirSync(from).filter(
    (name) => name.startsWith('lib.') && name.endsWith('.d.ts')
);

for (const name of files) {
    copyFileSync(join(from, name), join(to, name));
}

console.log(`TypeScript lib: 复制了 ${files.length} 个文件到 ${to}/`);
