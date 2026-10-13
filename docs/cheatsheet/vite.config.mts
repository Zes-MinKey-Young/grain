import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import grain from '../../packages/vite-plugin/index.js';

import { dirname } from "node:path";


export default defineConfig({
    root: dirname(fileURLToPath(import.meta.url)),
    plugins: [grain()],
    resolve: {
        alias: {
            // 编译产物里 `import { creEle } from "@graints/runtime"`，运行时源码就在仓库里
            '@graints/runtime': fileURLToPath(new URL('../../packages/runtime/index.ts', import.meta.url))
        }
    }
});
