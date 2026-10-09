import { defineConfig } from 'vite';

import grain from '{{pluginImport}}';

export default defineConfig({
    plugins: [grain()]
});
