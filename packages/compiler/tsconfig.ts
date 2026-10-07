/**
 * 读 tsconfig 的 `baseUrl` / `paths`。
 *
 * Vite 自带 `resolve.tsconfigPaths`，但它不认 `.grain` 这种扩展名（解析完还要
 * 按 JS/TS 的规矩找文件），所以 vite-plugin 自己来一遍。
 */
import { dirname, join, resolve } from 'node:path';

import ts from 'typescript';

export interface PathAlias {
    /** 形如 `@/*`，通配符只可能出现在末尾 */
    pattern: string;
    targets: string[];
}

export interface PathConfig {
    /** `paths` 相对谁解析（tsconfig 所在目录，或它配的 `baseUrl`） */
    base: string;
    aliases: PathAlias[];
}

const TSCONFIG = 'tsconfig.json';

/** 从 `from` 往上找最近的 tsconfig.json */
export function nearest_tsconfig(from: string): string | null {
    let dir = from;

    for (;;) {
        const candidate = join(dir, TSCONFIG);

        if (ts.sys.fileExists(candidate)) return candidate;

        const parent = dirname(dir);
        if (parent === dir) return null;

        dir = parent;
    }
}

export function read_paths(tsconfig: string): PathConfig | null {
    const host: ts.ParseConfigFileHost = {
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        readDirectory: (root, extensions, excludes, includes, depth) =>
            ts.sys.readDirectory(root, extensions, excludes, includes, depth),
        fileExists: (file) => ts.sys.fileExists(file),
        readFile: (file) => ts.sys.readFile(file),
        getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
        onUnRecoverableConfigFileDiagnostic: () => {}
    };

    const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, host);
    if (!parsed) return null;

    const directory = dirname(tsconfig);
    const base = parsed.options.baseUrl ? resolve(directory, parsed.options.baseUrl) : directory;
    const paths = parsed.options.paths ?? {};

    const aliases: PathAlias[] = Object.entries(paths).map(([pattern, targets]) => ({
        pattern,
        targets: targets ?? []
    }));

    return { base, aliases };
}

/** `@/Foo` -> `src/Foo` 这类替换；`*` 只可能有一个，且在末尾 */
function substitute(pattern: string, target: string, specifier: string): string | null {
    const star = pattern.indexOf('*');
    const target_star = target.indexOf('*');

    if (star < 0) return specifier === pattern ? target : null;
    if (target_star < 0) return null;

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);

    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;

    const middle = specifier.slice(prefix.length, specifier.length - suffix.length);

    return target.slice(0, target_star) + middle + target.slice(target_star + 1);
}

/** 候选文件：原样、加扩展名、`/index.<ext>` */
function candidates(path: string): string[] {
    const list = [path];

    for (const extension of ['.grain', '.ts', '.tsx', '.js', '.jsx', '.mts', '.css', '.json']) {
        list.push(path + extension, join(path, `index${extension}`));
    }

    return list;
}

/**
 * 按 tsconfig 的 `paths` 把一个 import 说明符解析成真实文件。
 *
 * @param specifier `import` 里写的那个字符串
 * @param config `read_paths()` 的结果
 * @returns 绝对路径；没匹配上（或者映射过去文件不存在）返回 null
 */
export function resolve_alias(specifier: string, config: PathConfig | null): string | null {
    if (!config) return null;

    for (const alias of config.aliases) {
        for (const target of alias.targets) {
            const mapped = substitute(alias.pattern, target, specifier);
            if (!mapped) continue;

            for (const candidate of candidates(resolve(config.base, mapped))) {
                if (ts.sys.fileExists(candidate)) return candidate;
            }
        }
    }

    return null;
}
