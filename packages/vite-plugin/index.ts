import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

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
 * 目录即路由：`src/routes` 下每个 **`+page.grain`** 是一个页面，跟 SvelteKit 一个路子。
 *
 * ```
 * src/routes/+page.grain                ->  /
 * src/routes/about/+page.grain          ->  /about
 * src/routes/posts/[id]/+page.grain     ->  /posts/:id
 * src/routes/posts/[...all]/+page.grain ->  兜底（其余都归它）
 * ```
 *
 * 认 `+page.grain` 而不是"任意 .grain"：目录里还可能放共用的子组件，那样它们会被误
 * 当成路由。布局（`+layout.grain`）**没有** —— 外壳自己写一个组件。
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

/**
 * 页面文件名。目录里其它 `.grain`（共用的子组件之类）不当路由。
 */
const PAGE_FILE = '+page.grain';

/**
 * 把文件路径翻译成路由模式。
 *
 * `+page.grain` 前面那段目录就是路径：`posts/[id]/+page.grain` -> `/posts/:id`。
 * `[id]` -> `:id`，`[...all]` -> `:all*`（剩下的都归它，排序时压到最后）。
 */
function routePattern(root: string, file: string): string {
    const relative = file.slice(root.length).replace(/\\/g, '/').replace(/^\/+/, '');

    // 去掉文件名，剩下的目录层级就是路径
    const directory = relative.slice(0, relative.length - PAGE_FILE.length).replace(/\/+$/, '');
    const segments = directory === '' ? [] : directory.split('/');

    const mapped = segments.map((segment) => {
        if (!segment.startsWith('[') || !segment.endsWith(']')) return segment;

        const name = segment.slice(1, -1).replace(/^\.\.\./, '');

        return segment.startsWith('[...') ? `:${name}*` : `:${name}`;
    });

    return `/${mapped.join('/')}`;
}

/** 目录扫一遍，生成 `grain:routes` 的模块代码 */
function routesModule(root: string): string {
    const dir = resolve(root, ROUTES_DIR);

    let files: string[] = [];

    try {
        files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
            // Windows 上 recursive readdir 给的是 `\` 分隔，先归一化再比
            .map((name) => name.replace(/\\/g, '/'))
            .filter((name) => name === PAGE_FILE || name.endsWith(`/${PAGE_FILE}`))
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

/** 多页模式生成的那个入口脚本 */
const PAGE_ENTRY_FILE = '__grain-page.ts';

export interface PagesOptions {
    /** HTML 模板（相对项目根），默认 `app.html` */
    template?: string;
    /** 挂载点选择器，默认 `#app` */
    mount?: string;
}

export interface GrainPluginOptions {
    /** 需要处理的文件后缀，默认 `['.grain']` */
    extensions?: string[];
    /** 透传给编译器的选项（比如 `runtimeModule`） */
    compiler?: CompileOptions;
    /**
     * 多页（MPA）模式：每条**静态**路由生成一个真实的 HTML 入口
     *
     * 默认是 SPA（一个 `index.html` + `grain:routes` + 前端路由）。开了这个就不一样了：
     * `src/routes/record/+page.grain` 会变成 `<root>/record/index.html`，
     * 每张页面自带入口脚本、自己 mount 自己，**不再经过路由**。
     *
     * ```
     * src/routes/+page.grain          ->  index.html
     * src/routes/record/+page.grain   ->  record/index.html
     * ```
     *
     * 好处是静态托管（GitHub Pages 之类）不需要「404 回退到 index.html」那套把戏，
     * 每条路由都是真文件、状态码都是 200，刷新和分享链接直接可用。
     *
     * 代价：页面之间是真跳转（整页刷新），站内不再有前端路由。动态段（`[id]`）
     * 没法预渲染，会被跳过并给出提示。
     *
     * 模板默认读项目根的 `app.html`（和 SvelteKit 一个名字），里面的 module 脚本会被
     * 换成该路由的入口。
     */
    pages?: boolean | PagesOptions;
}

/**
 * 扫出所有能预渲染的静态路由
 *
 * 动态段（`[id]`）和兜底段（`[...all]`）没参数没法生成，跳过。
 */
export function staticPages(root: string): { pattern: string; file: string }[] {
    const dir = resolve(root, ROUTES_DIR);

    let names: string[] = [];

    try {
        names = readdirSync(dir, { recursive: true, encoding: 'utf8' })
            .map((name) => name.replace(/\\/g, '/'))
            .filter((name) => name === PAGE_FILE || name.endsWith(`/${PAGE_FILE}`))
            .sort();
    } catch {
        return [];
    }

    return names
        .map((name) => {
            const file = resolve(dir, name);

            return { pattern: routePattern(dir, file), file };
        })
        .filter(({ pattern }) => {
            if (!pattern.includes(':')) return true;

            console.warn(`[grain] 多页模式跳过动态路由 ${pattern}（没有参数，生成不出来）`);

            return false;
        });
}

/** 每个页面自己的入口脚本：把那个 `+page.grain` 挂上去，不经过路由 */
function pageEntrySource(file: string, mount: string): string {
    return `// 由 @graints/vite-plugin 生成，别手改
import mount from ${JSON.stringify(file.replace(/\\/g, '/'))};

const target = document.querySelector(${JSON.stringify(mount)}) as HTMLElement | null;

if (target) mount(target);
`;
}

/** 模板里挖掉原来的 module 脚本，换成这一页的入口 */
export function pageHtml(template: string, entry: string): string {
    const script = `<script type="module" src="${entry}"></script>`;
    const stripped = template.replace(/[ \t]*<script[^>]*type=["']module["'][^>]*>\s*<\/script>\s*/gi, '');

    return /<\/body>/i.test(stripped)
        ? stripped.replace(/<\/body>/i, `        ${script}\n    </body>`)
        : `${stripped}\n${script}\n`;
}

/**
 * 生成多页入口，返回给 rollup 的 `input`
 *
 * 产物直接写在项目里（`index.html`、`record/index.html`），所以 vite 的 dev / preview
 * 都能按「目录里有 index.html」这条规则直接命中，不用额外写中间件。
 */
export function writePages(root: string, options: PagesOptions, explicit = true): Record<string, string> {
    const templatePath = resolve(root, options.template ?? 'app.html');
    const mount = options.mount ?? '#app';

    let template: string;

    try {
        template = readFileSync(templatePath, 'utf8');
    } catch {
        if (explicit) throw new Error(`[grain] 找不到多页模板 ${templatePath}`);

        throw new Error(
            '[grain] 多页模式需要一个 HTML 模板：把原来的 index.html 改名成 app.html '
            + '（里面的 module 脚本会被各页面的入口替换）'
        );
    }

    const entries: Record<string, string> = {};

    for (const { pattern, file } of staticPages(root)) {
        const segments = pattern === '/' ? [] : pattern.slice(1).split('/');
        const htmlPath = resolve(root, ...segments, 'index.html');

        if (htmlPath === templatePath) {
            throw new Error(
                `[grain] 模板不能是被覆盖的那个文件（${templatePath}）：`
                + '把 index.html 改名成 app.html 再开多页模式'
            );
        }

        const entryPath = resolve(root, ...segments, PAGE_ENTRY_FILE);
        // 必须用**根相对**地址：dev 下 `/record`（不带尾斜杠）会被 vite 回退到
        // `record/index.html`，但浏览器地址仍是 `/record`，`./__grain-page.ts`
        // 会解析成根目录那个 —— 页面就挂错了
        const entryUrl = `/${[...segments, PAGE_ENTRY_FILE].join('/')}`;

        mkdirSync(dirname(htmlPath), { recursive: true });
        writeFileSync(entryPath, pageEntrySource(file, mount), 'utf8');
        writeFileSync(htmlPath, pageHtml(template, entryUrl), 'utf8');

        entries[segments.length === 0 ? 'index' : segments.join('/')] = htmlPath;
    }

    return entries;
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
            const base = {
                resolve: {
                    ...config.resolve,
                    tsconfigPaths: config.resolve?.tsconfigPaths ?? true
                }
            };

            if (!options.pages) return base;

            // 多页：按路由生成入口，并接管 rollup 的 input
            const root = resolve(config.root ?? process.cwd());
            const input = writePages(
                root,
                options.pages === true ? {} : options.pages,
                options.pages !== true
            );

            return {
                ...base,
                build: {
                    ...config.build,
                    rollupOptions: {
                        ...config.build?.rollupOptions,
                        input
                    }
                }
            };
        },

        configResolved(config) {
            isDev = config.command === 'serve';

            projectRoot = config.root;

            const tsconfig = nearestTsconfig(config.root);

            paths = tsconfig ? readPaths(tsconfig) : null;
        },

        /**
         * 多页模式下把 `/record` 重定向到 `/record/`
         *
         * 目录页的 HTML 里入口是根相对地址，但浏览器地址停在 `/record` 时
         * 相对解析会跑偏；而且 vite 的目录回退在这种情况下会吐根目录的
         * `index.html`，页面就挂错了。静态托管（GitHub Pages）本来也是这么做的。
         */
        configureServer(server) {
            if (!options.pages) return;

            const root = server.config.root;
            const base = server.config.base;

            server.middlewares.use((req, res, next) => {
                const raw = (req.url ?? '').split('?')[0];

                if (!raw.startsWith(base) || raw.endsWith('/') || extname(raw)) return next();
                if (!existsSync(resolve(root, raw.slice(base.length), 'index.html'))) return next();

                res.statusCode = 302;
                res.setHeader('Location', `${raw}/`);
                res.end();
            });
        },

        /** `vite preview` 也要一样的重定向，不然本地看预览会挂错页 */
        configurePreviewServer(server) {
            if (!options.pages) return;

            const base = server.config.base;

            server.middlewares.use((req, res, next) => {
                const raw = (req.url ?? '').split('?')[0];

                if (!raw.startsWith(base) || raw.endsWith('/') || extname(raw)) return next();
                if (!existsSync(resolve(server.config.build.outDir, raw.slice(base.length), 'index.html'))) {
                    return next();
                }

                res.statusCode = 301;
                res.setHeader('Location', `${raw}/`);
                res.end();
            });
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
