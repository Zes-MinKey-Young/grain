import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Plugin } from 'vite';

import {
    compile,
    nearestTsconfig,
    parse,
    readPaths,
    resolveAlias,
    type CompileOptions,
    type CompileResult,
    type PathConfig,
    type Root
} from '../compiler/index.ts';

/**
 * 组件里的 `<style>` 通过虚拟模块交给 Vite 的 CSS 管线：
 * 编译产物会 `import "<file>?grain-style.css"`，由 `load` 钩子返回 CSS 文本。
 */
const STYLE_QUERY = 'grain-style.css';

/** `App.grain?grain-ast` -> 解析结果，用来在页面上查看 AST */
const AST_QUERY = 'grain-ast';

/**
 * `grain:routes` -> 路由表。
 *
 * 目录即路由：`src/routes` 下每个 `.grain` 是一个页面。
 *
 * ```
 * src/routes/index.grain        ->  /
 * src/routes/about.grain        ->  /about
 * src/routes/post/[id].grain    ->  /post/:id
 * src/routes/[...all].grain     ->  兜底（其余都归它）
 * ```
 *
 * 页面是懒加载的（`() => import(...)`），构建时 Vite 会自动切块。
 */
const ROUTES_ID = 'grain:routes';

/**
 * `resolveId` 交出去的 id。
 *
 * 加 `\0` 前缀是 Vite 对虚拟模块的约定：dev 下如果不加，vite 会拿 `grain:routes`
 * 当普通 URL 去匹配，匹配不上就落到 SPA fallback —— 于是 `/grain:routes` 返回的是
 * index.html，路由表是空的（build 下 rollup 直接用返回值，所以那边看不出来）。
 */
const RESOLVED_ROUTES_ID = `\0${ROUTES_ID}`;

/** `src/routes` 的默认位置（相对项目根） */
const ROUTES_DIR = 'src/routes';

/** 把文件路径翻译成路由模式：`post/[id].grain` -> `/post/:id` */
function routePattern(root: string, file: string): string {
    const relative = file.slice(root.length).replace(/\\/g, '/').replace(/^\/+/, '');
    const withoutExt = relative.replace(/\.grain$/, '');

    const segments = withoutExt
        .split('/')
        .map((segment) => {
            // `index` 那一级不出现在路径里
            if (segment === 'index') return '';

            // `[id]` -> `:id`，`[...all]` -> `:all`（剩下的都归它）
            if (segment.startsWith('[') && segment.endsWith(']')) {
                const name = segment.slice(1, -1).replace(/^\.\.\./, '');

                return segment.startsWith('[...') ? `:${name}*` : `:${name}`;
            }

            return segment;
        })
        .filter((segment) => segment !== '');

    return `/${segments.join('/')}`;
}

/** 目录扫一遍，生成 `grain:routes` 的模块代码 */
function routesModule(root: string): string {
    const dir = resolve(root, ROUTES_DIR);

    let files: string[] = [];

    try {
        files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
            .filter((name) => name.endsWith('.grain'))
            .sort();
    } catch {
        // 没有 src/routes 这个目录：给个空表，别让构建挂掉
        return 'export default [];';
    }

    const routes = files.map((name) => {
        const file = resolve(dir, name);
        const pattern = routePattern(dir, file);

        // 兜底段（`[...all]`）放最后，其余按路径排
        return { pattern, file, catchAll: pattern.includes(':*') };
    });

    routes.sort((a, b) => {
        if (a.catchAll !== b.catchAll) return a.catchAll ? 1 : -1;

        return a.pattern.localeCompare(b.pattern);
    });

    const lines = routes.map(
        ({ pattern, file }) =>
            `  { path: ${JSON.stringify(pattern)}, page: () => import(${JSON.stringify(file)}) },`
    );

    return `export default [\n${lines.join('\n')}\n];\n`;
}

/** AST 里有 loc / range 之外的引用关系，序列化时截断一下避免炸掉 */
function toJson(root: Root): string {
    const seen = new WeakSet<object>();

    return JSON.stringify(
        root,
        (_key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) return '[Circular]';
                seen.add(value);
            }

            return value;
        },
        2
    );
}

/**
 * 组件级 HMR。
 *
 * 优先换掉这个组件自己的实例（`hotReplace`）—— 只重建它那一段 DOM，
 * 父组件、兄弟节点和父组件的状态都留着。
 *
 * 换不掉（它自己就是根组件、或者当前没有活着的实例）才退回"清空挂载点重新挂"；
 * 连挂载点都没有就 `invalidate()` 交给 Vite 往上冒泡。
 */
const hmrSnippet = (runtime: string) => `
import { hotReplace as __grain_hotReplace } from ${JSON.stringify(runtime)};

if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    if (mod && mod.create && __grain_hotReplace(create, mod.create) > 0) return;

    const target = mount.target;
    if (target && mod && mod.default) {
      target.replaceChildren();
      mod.default(target);
      return;
    }

    import.meta.hot.invalidate();
  });
}
`;

export interface GrainPluginOptions {
    /** 需要处理的文件后缀，默认 `['.grain']` */
    extensions?: string[];
    /** 透传给编译器的选项（比如 `runtimeModule`） */
    compiler?: CompileOptions;
}

export default function grain(options: GrainPluginOptions = {}): Plugin {
    const extensions = options.extensions ?? ['.grain'];
    const compilerOptions = options.compiler ?? {};
    const runtime = compilerOptions.runtimeModule ?? '@graints/runtime';

    // transform（JS）和 load（CSS）会各编译一次同一个文件，按内容缓存掉
    const cache = new Map<string, CompileResult>();
    let isDev = false;
    /** tsconfig 的 `paths`；Vite 自己那套认不了 `.grain`，这里补上 */
    let paths: PathConfig | null = null;
    /** 项目根：`grain:routes` 要扫它下面的 `src/routes` */
    let projectRoot: string | null = null;

    const isGrain = (file: string) => extensions.some((extension) => file.endsWith(extension));

    /**
     * dev 下 Vite 会往 id 上加 `?import`、`&import` 之类，虚拟模块 query 不一定在第一段
     * （实际见过 `App.grain?import&grain-ast`），所以按段拆开判断
     */
    const splitId = (id: string): { file: string; queries: string[] } => {
        const [file, rawQuery] = id.split('?');

        return { file, queries: rawQuery ? rawQuery.split('&') : [] };
    };

    const compileFile = (file: string, code: string): CompileResult => {
        const key = `${file}\n${code}`;
        const cached = cache.get(key);
        if (cached) return cached;

        // dev 下编译器会往刷新函数埋循环检测点
        const result = compile(code, { ...compilerOptions, filename: file, dev: isDev });
        cache.set(key, result);

        return result;
    };

    return {
        name: 'grain',
        enforce: 'pre',

        // Vite 认 tsconfig 的 `paths`，但默认是关的（resolve.tsconfigPaths）。
        // 项目里 alias 很常用，这里替用户打开；自己设过就听他的
        config(config) {
            return {
                resolve: {
                    ...config.resolve,
                    tsconfigPaths: config.resolve?.tsconfigPaths ?? true
                }
            };
        },

        configResolved(config) {
            isDev = config.command === 'serve';

            projectRoot = config.root;

            const tsconfig = nearestTsconfig(config.root);

            paths = tsconfig ? readPaths(tsconfig) : null;
        },

        // 虚拟模块
        load(id) {
            // `grain:routes` -> 目录即路由的表（项目根在 configResolved 时就定下来了）
            if (id === RESOLVED_ROUTES_ID) return routesModule(projectRoot ?? process.cwd());

            const { file, queries } = splitId(id);
            if (!isGrain(file)) return null;

            if (queries.includes(STYLE_QUERY)) {
                // `<file>?grain-style.css` -> 组件样式（交给 Vite 当普通 CSS 处理）
                return compileFile(file, readFileSync(file, 'utf8')).css;
            }

            if (queries.includes(AST_QUERY)) {
                // `<file>?grain-ast` -> 解析结果
                return `export default ${toJson(parse(readFileSync(file, 'utf8'), { filename: file }))};`;
            }

            return null;
        },

        resolveId(id, importer) {
            // 虚拟模块：不要 Vite 去文件系统里找。交出去的是带 `\0` 的那个 id ——
            // dev 下浏览器最终请求的是改写后的地址，不这么做 import 会原样留着
            // `grain:routes`，请求它只会吃到 SPA fallback 的 index.html
            if (id === ROUTES_ID) return RESOLVED_ROUTES_ID;

            const { file, queries } = splitId(id);

            // 虚拟模块不需要 Vite 去文件系统里找
            if (queries.includes(AST_QUERY) && isGrain(file)) {
                return importer && id.startsWith('.')
                    ? `${resolve(dirname(importer), file)}?${AST_QUERY}`
                    : id;
            }

            // tsconfig 的 `paths`：`@/Foo.grain` 这种，Vite 的内置支持到不了未知扩展名
            return resolveAlias(id, paths);
        },

        // `<file>.grain` -> JS 模块。
        // dev 下 Vite 会给非 JS 后缀的 import 加上 `?import` 之类的 query，所以只排掉自己的虚拟模块
        transform(code, id) {
            const { file, queries } = splitId(id);
            if (queries.includes(STYLE_QUERY) || queries.includes(AST_QUERY) || !isGrain(file)) return null;

            const { js, css } = compileFile(file, code);
            const cssImport = css ? `\nimport ${JSON.stringify(`${file}?${STYLE_QUERY}`)};` : '';

            return {
                code: js + cssImport + (isDev ? hmrSnippet(runtime) : ''),
                map: null
            };
        }
    };
}
