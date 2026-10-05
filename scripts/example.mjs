// 统一的示例入口：
//   pnpm example                     列出所有示例
//   pnpm example counter             起 counter 的 dev server
//   pnpm example counter --build     构建 counter
//   pnpm example --build             构建所有示例
//   pnpm example counter --port 3000 指定端口
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, createServer, preview } from 'vite';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examples = join(repository, 'examples');
const config_file = join(examples, 'vite.config.mts');

const available = readdirSync(examples, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const args = process.argv.slice(2);
const names = args.filter((arg) => !arg.startsWith('--'));
const flags = args.filter((arg) => arg.startsWith('--'));

const command = flags.includes('--build') ? 'build' : flags.includes('--preview') ? 'preview' : 'serve';
const port = Number(flags.find((flag) => flag.startsWith('--port'))?.split('=')[1] ?? 5173);

if (names.length === 0 && command === 'serve') {
    console.log('可用示例：');
    for (const name of available) console.log(`  ${name}`);
    console.log('\n用法：');
    console.log('  pnpm example <name>              起 dev server');
    console.log('  pnpm example <name> --build      构建');
    console.log('  pnpm example --build             构建全部');
    console.log('  pnpm example <name> --port 3000  指定端口');
    process.exit(0);
}

const selected = names.length > 0 ? names : available;

for (const name of selected) {
    if (!available.includes(name)) {
        console.error(`没有这个示例：${name}`);
        console.error(`可用：${available.join(', ')}`);
        process.exit(1);
    }
}

if (command === 'serve' && selected.length > 1) {
    console.error('dev server 一次只能起一个示例');
    process.exit(1);
}

const options = (name) => ({
    root: join(examples, name),
    configFile: config_file,
    logLevel: 'info'
});

for (const name of selected) {
    if (command === 'build') {
        console.log(`\n构建 ${name} ...`);
        await build({ ...options(name), build: { outDir: join(examples, name, 'dist'), emptyOutDir: true } });
    } else if (command === 'preview') {
        const server = await preview({ ...options(name), preview: { port } });
        server.printUrls();
    } else {
        const server = await createServer({ ...options(name), server: { port } });
        await server.listen();
        server.printUrls();
    }
}
