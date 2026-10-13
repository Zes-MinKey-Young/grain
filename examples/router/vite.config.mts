import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import grain from '../../packages/vite-plugin/index.js';

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [grain()],
    resolve: {
        alias: {
            '@graints/runtime': fileURLToPath(new URL('../../packages/runtime/index.ts', import.meta.url))
        }
    }
});
