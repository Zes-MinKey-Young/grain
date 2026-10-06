import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Plugin } from 'vite';

import { compile, parse, type CompileOptions, type CompileResult, type Root } from '../compiler/index.js';

/**
 * 组件里的 `<style>` 通过虚拟模块交给 Vite 的 CSS 管线：
 * 编译产物会 `import "<file>?grain-style.css"`，由 `load` 钩子返回 CSS 文本。
 */
const STYLE_QUERY = 'grain-style.css';

/** `App.grain?grain-ast` -> 解析结果，用来在页面上查看 AST */
const AST_QUERY = 'grain-ast';

/** AST 里有 loc / range 之外的引用关系，序列化时截断一下避免炸掉 */
function to_json(root: Root): string {
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
 * 优先换掉这个组件自己的实例（`hot_replace`）—— 只重建它那一段 DOM，
 * 父组件、兄弟节点和父组件的状态都留着。
 *
 * 换不掉（它自己就是根组件、或者当前没有活着的实例）才退回"清空挂载点重新挂"；
 * 连挂载点都没有就 `invalidate()` 交给 Vite 往上冒泡。
 */
const hmr_snippet = (runtime: string) => `
import { hot_replace as __grain_hot_replace } from ${JSON.stringify(runtime)};

if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    if (mod && mod.create && __grain_hot_replace(create, mod.create) > 0) return;

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
    const compiler_options = options.compiler ?? {};
    const runtime = compiler_options.runtimeModule ?? '@graints/runtime';

    // transform（JS）和 load（CSS）会各编译一次同一个文件，按内容缓存掉
    const cache = new Map<string, CompileResult>();
    let is_dev = false;

    const is_grain = (file: string) => extensions.some((extension) => file.endsWith(extension));

    /**
     * dev 下 Vite 会往 id 上加 `?import`、`&import` 之类，虚拟模块 query 不一定在第一段
     * （实际见过 `App.grain?import&grain-ast`），所以按段拆开判断
     */
    const split_id = (id: string): { file: string; queries: string[] } => {
        const [file, raw_query] = id.split('?');

        return { file, queries: raw_query ? raw_query.split('&') : [] };
    };

    const compile_file = (file: string, code: string): CompileResult => {
        const key = `${file}\n${code}`;
        const cached = cache.get(key);
        if (cached) return cached;

        const result = compile(code, { ...compiler_options, filename: file });
        cache.set(key, result);

        return result;
    };

    return {
        name: 'grain',
        enforce: 'pre',

        configResolved(config) {
            is_dev = config.command === 'serve';
        },

        // 虚拟模块
        load(id) {
            const { file, queries } = split_id(id);
            if (!is_grain(file)) return null;

            if (queries.includes(STYLE_QUERY)) {
                // `<file>?grain-style.css` -> 组件样式（交给 Vite 当普通 CSS 处理）
                return compile_file(file, readFileSync(file, 'utf8')).css;
            }

            if (queries.includes(AST_QUERY)) {
                // `<file>?grain-ast` -> 解析结果
                return `export default ${to_json(parse(readFileSync(file, 'utf8'), { filename: file }))};`;
            }

            return null;
        },

        // 虚拟模块不需要 Vite 去文件系统里找
        resolveId(id, importer) {
            const { file, queries } = split_id(id);
            if (!queries.includes(AST_QUERY) || !is_grain(file)) return null;

            return importer && id.startsWith('.')
                ? `${resolve(dirname(importer), file)}?${AST_QUERY}`
                : id;
        },

        // `<file>.grain` -> JS 模块。
        // dev 下 Vite 会给非 JS 后缀的 import 加上 `?import` 之类的 query，所以只排掉自己的虚拟模块
        transform(code, id) {
            const { file, queries } = split_id(id);
            if (queries.includes(STYLE_QUERY) || queries.includes(AST_QUERY) || !is_grain(file)) return null;

            const { js, css } = compile_file(file, code);
            const css_import = css ? `\nimport ${JSON.stringify(`${file}?${STYLE_QUERY}`)};` : '';

            return {
                code: js + css_import + (is_dev ? hmr_snippet(runtime) : ''),
                map: null
            };
        }
    };
}
