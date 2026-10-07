/**
 * `tsc -p .` 只 emit index.js / index.d.ts。
 *
 * globals.d.ts 是 ambient 的（没有 import / export），tsc 既不 emit 它，
 * 也不会把 index.ts 里那条 `/// <reference>` 带进产物 —— 两件事都得手动补：
 * 把文件拷进 dist，并在入口顶部挂上引用。这样 tsconfig 里
 * `"types": ["@graints/runtime"]` 一加载入口，全局声明就跟着进来了。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

copyFileSync('globals.d.ts', 'dist/globals.d.ts');

const entry = 'dist/index.d.ts';
const reference = '/// <reference path="./globals.d.ts" />';
const source = readFileSync(entry, 'utf8');

if (!source.includes(reference)) writeFileSync(entry, `${reference}\n${source}`);
