#!/usr/bin/env node
/**
 * `create-grain` — scaffold a new Grain project.
 *
 * 零依赖：拷一份模板，填几个占位符，可选的跑一次 install。
 *
 *   node packages/create-grain/index.mjs my-app          （在仓库里）
 *   pnpm create grain my-app                             （发布之后）
 *
 * 两种依赖来源：
 * - 在 grain 仓库里跑（或 `--link <repo>`）：依赖写成 `file:`，指向本地的
 *   packages/runtime 和 packages/vite-plugin，改编译器即时生效
 * - 其他情况：依赖写成 registry 上的版本号
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const template_root = join(here, 'templates');

/** registry 模式下写的版本号（包发布后这里就是给新项目用的版本） */
const REGISTRY_VERSION = '^0.1.1';

const HELP = `
create-grain — scaffold a new Grain project

Usage
  create-grain <name> [options]

Options
  -t, --template <name>   basic (default) | minimal
      --link [path]       depend on a local checkout of the grain repository
                          (default when running inside one)
      --no-link           depend on the published packages instead
      --pm <name>         pnpm | npm | yarn | bun (default: detected, else pnpm)
      --no-install        only write the files
  -f, --force             write into a non-empty directory
  -h, --help              show this message

Examples
  create-grain my-app
  create-grain my-app --template minimal --no-install
  create-grain . --force
`;

/** 模板里的占位符 -> 实际值 */
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function parse_args(argv) {
    const options = {
        name: '',
        template: 'basic',
        install: true,
        force: false,
        pm: null,
        /** null = 自动（在仓库里就 link），false = 不用本地，string = 仓库路径 */
        link: null,
        help: false
    };

    const positional = [];

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value_of = () => argv[index + 1];

        if (arg === '-h' || arg === '--help') {
            options.help = true;
        } else if (arg === '-f' || arg === '--force') {
            options.force = true;
        } else if (arg === '--no-install') {
            options.install = false;
        } else if (arg === '--no-link') {
            options.link = false;
        } else if (arg === '--link') {
            const next = value_of();
            options.link = next && !next.startsWith('-') ? ((index += 1), next) : '';
        } else if (arg === '-t' || arg === '--template') {
            options.template = value_of() ?? '';
            index += 1;
        } else if (arg === '--pm') {
            options.pm = value_of() ?? '';
            index += 1;
        } else if (arg.startsWith('--template=')) {
            options.template = arg.slice('--template='.length);
        } else if (arg.startsWith('--pm=')) {
            options.pm = arg.slice('--pm='.length);
        } else {
            positional.push(arg);
        }
    }

    options.name = positional[0] ?? '';

    return options;
}

/** 目录名 -> 合法的 npm 包名（目录本身不动） */
function to_package_name(name) {
    const base = name.split(/[\\/]/).filter(Boolean).pop() ?? 'grain-app';

    const safe = base
        .trim()
        .toLowerCase()
        .replace(/^[@._]+/, '')
        .replace(/[^a-z0-9-~.]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return safe === '' ? 'grain-app' : safe;
}

const available_templates = () =>
    readdirSync(template_root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

/**
 * 找一个 grain 仓库（里面有 packages/runtime 和 packages/vite-plugin 的）。
 * 不传路径时，从自己往上两级找 —— 也就是 `packages/create-grain` 所在的那个仓库。
 */
function locate_repository(explicit) {
    const candidates = [explicit ? resolve(explicit) : null, resolve(here, '..', '..')].filter(
        (path) => path !== null
    );

    for (const candidate of candidates) {
        const has = (path) => existsSync(join(candidate, path));

        if (has('packages/runtime/package.json') && has('packages/vite-plugin/package.json')) {
            return candidate;
        }
    }

    return null;
}

/** `file:` 依赖的相对路径（同一盘符才用相对，跨盘符只能给绝对） */
function file_reference(from, to) {
    const path = relative(from, to).split('\\').join('/');

    return path.startsWith('.') ? `file:${path}` : `file:${to.split('\\').join('/')}`;
}

/**
 * vite.config 里怎么引到插件。
 *
 * 链到本地仓库时必须走**源码路径**：Vite 打包 config 时会把 node_modules 里的依赖
 * 留在外部，之后 Node 去加载它就会撞上 "Stripping types is unsupported for files
 * under node_modules"（`@grain/vite-plugin` 的入口是 index.ts）。
 * 从源码路径引，它就跟着 config 一起被打进去了。
 */
function plugin_import(target, repository) {
    if (!repository) return '@graints/vite-plugin';

    const source = join(repository, 'packages', 'vite-plugin', 'index.js');
    const path = relative(target, source).split('\\').join('/');

    if (path.startsWith('.')) return path;

    // 跨盘符，相对路径给不出来
    return pathToFileURL(source).href;
}

/** 模板里点开头的文件存成 `_` 前缀（`_gitignore`、`_vscode`），npm 打包不会漏掉 */
const dotted = (name) => (name.startsWith('_') ? `.${name.slice(1)}` : name);

/** 拷模板：目录递归，文本里的占位符替换掉 */
function copy_template(from, to, fill) {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
        const source = join(from, entry.name);
        const target = join(to, dotted(entry.name));

        if (entry.isDirectory()) {
            mkdirSync(target, { recursive: true });
            copy_template(source, target, fill);
            continue;
        }

        writeFileSync(target, fill(readFileSync(source, 'utf8')));
    }
}

function detect_pm() {
    const agent = process.env.npm_config_user_agent ?? '';

    if (agent.startsWith('pnpm')) return 'pnpm';
    if (agent.startsWith('yarn')) return 'yarn';
    if (agent.startsWith('bun')) return 'bun';
    if (agent.startsWith('npm')) return 'npm';

    return 'pnpm';
}

async function ask(question) {
    if (!process.stdin.isTTY) return null;

    const { createInterface } = await import('node:readline');
    const readline = createInterface({ input: process.stdin, output: process.stdout });

    const answer = await new Promise((done) => readline.question(question, done));

    readline.close();

    return answer.trim();
}

async function install(pm, cwd) {
    console.log(`\n安装依赖（${pm} install）...`);

    const result = await new Promise((done) => {
        const child = spawn(pm, ['install'], {
            cwd,
            stdio: 'inherit',
            // Windows 上 pnpm / yarn 是 .cmd，得走 shell
            shell: process.platform === 'win32'
        });

        child.on('close', done);
    });

    if (result !== 0) {
        console.error(`\n${pm} install 退出码 ${result} —— 自己进目录再跑一次就行`);
    }

    return result === 0;
}

async function main() {
    const options = parse_args(process.argv.slice(2));

    if (options.help) {
        console.log(HELP.trim());
        return 0;
    }

    const templates = available_templates();

    if (!templates.includes(options.template)) {
        console.error(`没有这个模板：${options.template}`);
        console.error(`可用：${templates.join(', ')}`);
        return 1;
    }

    if (!options.name) {
        const answer = await ask('项目名：');
        if (!answer) {
            console.error('需要一个项目名，或者用 `create-grain .` 就地生成');
            return 1;
        }

        options.name = answer;
    }

    const target = resolve(process.cwd(), options.name);

    if (existsSync(target) && readdirSync(target).length > 0 && !options.force) {
        console.error(`目录不是空的：${target}`);
        console.error('加 --force 覆盖，或者换个名字');
        return 1;
    }

    const repository = options.link === false ? null : locate_repository(options.link || null);

    const deps = repository
        ? {
              grain: file_reference(target, join(repository, 'packages', 'runtime')),
              plugin: file_reference(target, join(repository, 'packages', 'vite-plugin'))
          }
        : { grain: REGISTRY_VERSION, plugin: REGISTRY_VERSION };

    const values = {
        name: to_package_name(options.name),
        title: to_package_name(options.name),
        dep_grain: deps.grain,
        dep_plugin: deps.plugin,
        plugin_import: plugin_import(target, repository)
    };

    const fill = (text) =>
        text.replace(PLACEHOLDER, (whole, key) =>
            key in values ? values[key] : whole
        );

    mkdirSync(target, { recursive: true });
    copy_template(join(template_root, options.template), target, fill);

    const pm = options.pm || detect_pm();
    const display = relative(process.cwd(), target) || '.';

    console.log(`\n✔ 已生成 ${display}（模板 ${options.template}）`);
    console.log(`  依赖：${repository ? `本地仓库 ${repository}` : `registry ${REGISTRY_VERSION}`}`);

    const steps = [`cd ${display}`];

    if (options.install) {
        await install(pm, target);
    } else {
        steps.push(`${pm} install`);
    }

    steps.push(`${pm} run dev`);

    console.log(`\n下一步：`);
    for (const step of steps) console.log(`  ${step}`);

    return 0;
}

process.exitCode = await main();
