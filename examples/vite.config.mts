import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import grain from '../packages/vite-plugin/index.js';

/**
 * 所有示例共用这一份配置（`root` 由 `scripts/example.mjs` 按示例指定）。
 * 用 `.mts` 是为了让 Vite 按 ESM 加载它。
 */
export default defineConfig({
    plugins: [grain()],
    resolve: {
        alias: {
            // 编译产物里 `import { creEle } from "grain"`，运行时源码就在仓库里
            grain: fileURLToPath(new URL('../packages/runtime/index.ts', import.meta.url))
        }
    }
});
