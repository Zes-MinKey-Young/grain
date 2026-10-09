/**
 * 全局类型有两份，必须保持一致：
 *
 * - `packages/runtime/globals.d.ts` —— 真源
 * - `packages/vscode/src/typescript.ts` 里的 `GRAIN_TYPE_SOURCE` —— 扩展注入的副本
 *   （用户装扩展时磁盘上没有这个仓库，声明只能打进 vsix）
 *
 * 光靠文件头那句"改这里记得同步"靠不住，所以在这里比一比。挂进了 `pnpm typecheck`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const truthPath = path.join(root, 'packages/runtime/globals.d.ts');
const injectedPath = path.join(root, 'packages/vscode/src/typescript.ts');

const truth = fs.readFileSync(truthPath, 'utf8');
const injectedSource = fs.readFileSync(injectedPath, 'utf8');

/** 六个该有的声明 */
const names = ['$state', '$props', '$bindable', '$node', '$store', '$read'];

const problems = [];

// ---- 1. 取出扩展注入的那份（模板字符串），把转义的反引号换回来 ----

const match = /const GRAIN_TYPE_SOURCE = `([\s\S]*?)`;\n/.exec(injectedSource);

if (!match) {
    problems.push('在 packages/vscode/src/typescript.ts 里没找到 GRAIN_TYPE_SOURCE');
} else {
    const injected = match[1].replace(/\\`/g, '`');
    const tidy = (text) => text.replace(/\r\n/g, '\n').trim();

    // 真源开头有一段"给读者看的说明"，注入那份不需要 —— 只比声明部分
    const firstDeclare = truth.indexOf('declare function');
    const body = truth.slice(truth.lastIndexOf('/**', firstDeclare));

    /**
     * 只比 rune 和内置宏（`$` 开头的那些）。
     *
     * 真源里还有 runtime 的 API（`reactiveArray` 之类）—— 它们是通过 import 用的，
     * 由 runtime-types.ts 提供模块声明，不进注入的那份（那份是全局的 rune + 模块声明）。
     */
    const runesOf = (text) =>
        text
            .split('\n')
            // 注释里也会提到 `declare function $state`，那些不算
            .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line) && /declare function \$\w+/.test(line))
            .map((line) => line.trim())
            .join('\n');

    const leftRunes = runesOf(tidy(body));
    const rightRunes = runesOf(tidy(injected));

    if (leftRunes !== rightRunes) {
        const left = leftRunes.split('\n');
        const right = rightRunes.split('\n');

        for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
            if (left[i] === right[i]) continue;

            problems.push(
                `两份不一致（第 ${i + 1} 行）:\n` +
                    `    真源  : ${left[i] ?? '(无)'}\n` +
                    `    注入  : ${right[i] ?? '(无)'}`
            );

            break;
        }
    }
}

// ---- 2. 该有的声明都在，且都带 @example ----

for (const name of names) {
    const at = truth.indexOf(`declare function ${name}`);

    if (at < 0) {
        problems.push(`${name}: 真源里没有这个声明`);

        continue;
    }

    const doc = truth.slice(Math.max(0, truth.lastIndexOf('/**', at)), at);

    if (!doc.includes('@example')) problems.push(`${name}: JSDoc 里没有 @example`);
}

// ---- 结果 ----

if (problems.length === 0) {
    console.log('✓ 全局类型的两份副本一致（' + names.join(' / ') + ' 都在，且都带 @example）');

    process.exit(0);
}

console.error('✗ 全局类型的两份副本不同步：\n');

for (const problem of problems) console.error('  ' + problem);

console.error('\n改 packages/runtime/globals.d.ts 之后，记得同步 packages/vscode/src/typescript.ts 里的 GRAIN_TYPE_SOURCE。');

process.exit(1);
