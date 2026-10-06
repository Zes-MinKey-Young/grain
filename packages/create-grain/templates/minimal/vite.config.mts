import { defineConfig } from 'vite';

import grain from '{{plugin_import}}';

export default defineConfig({
    plugins: [grain()]
});
