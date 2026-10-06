import * as vscode from 'vscode';

import type { Analysis } from './analysis.js';
import { update_diagnostics } from './diagnostics.js';
import { register_providers, SELECTOR } from './providers.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log, set_debug } from './log.js';
import { forget_tsconfig, use_tsconfig } from './typescript.js';

/** 缓存的分析连带它当时的文档版本：版本对不上就说明文档又改过了，这份不能再用 */
const analyses = new Map<string, { analysis: Analysis; version: number }>();

/**
 * 缓存里那份跟眼前的文档是不是同一个版本。
 *
 * 补全 / hover 来问的时候文档往往已经比上次分析时新了几个字符，
 * 拿旧内容去问 TS 位置会对不上（`Math.` 会被当成别处，点号那一下直接白给）。
 */
function cached_analysis(document: vscode.TextDocument): Analysis | undefined {
    const entry = analyses.get(document.uri.toString());

    return entry?.version === document.version ? entry.analysis : undefined;
}

/** 右下角的 Grain 状态项，悬停能看到当前用的 tsconfig */
let status_item: vscode.LanguageStatusItem | null = null;

/**
 * 编译器（连带 typescript-estree → TypeScript）只能惰性加载：
 * 激活时同步 require 会把扩展宿主拖到 10 秒启动超时。
 */
type AnalysisModule = typeof import('./analysis.js');

let analysis_module: AnalysisModule | null = null;

function get_analysis_module(): AnalysisModule {
    return (analysis_module ??= require('./analysis.js') as AnalysisModule);
}

function is_grain(document: vscode.TextDocument): boolean {
    return document.languageId === 'grain';
}

/**
 * 从当前文件所在目录往上找最近的 tsconfig.json（跟 TypeScript 自己的做法一样），
 * 到工作区根为止。找不到就用插件自带的一套（含 DOM）。
 */
function nearest_tsconfig(document: vscode.TextDocument): string | null {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return null;

    const root = folder.uri.fsPath.toLowerCase();
    let directory = dirname(document.uri.fsPath);

    while (directory.toLowerCase().startsWith(root)) {
        const candidate = join(directory, 'tsconfig.json');
        if (existsSync(candidate)) return candidate;

        const parent = dirname(directory);
        if (parent === directory) break;

        directory = parent;
    }

    return null;
}

/**
 * 右下角那个 Grain 状态项。
 * 悬停能看到当前用的是哪个 tsconfig —— 找不到的话也写清楚从哪儿往上找过。
 */
function describe_tsconfig(status: vscode.LanguageStatusItem, document: vscode.TextDocument, file: string | null): void {
    if (file) {
        status.detail = `tsconfig: ${vscode.workspace.asRelativePath(file, false)}`;
        status.command = {
            command: 'vscode.open',
            title: '打开 tsconfig.json',
            arguments: [vscode.Uri.file(file)]
        };

        return;
    }

    const from = vscode.workspace.asRelativePath(dirname(document.uri.fsPath), false);

    status.detail = `tsconfig: 没找到（从 ${from} 往上到工作区根都没有），用插件自带的配置（含 DOM）`;
    status.command = undefined;
}

function refresh(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
    if (!is_grain(document)) return;

    // 用离这个文件最近的 tsconfig，并在状态项里写出来
    const tsconfig = nearest_tsconfig(document);

    use_tsconfig(tsconfig);
    if (status_item) describe_tsconfig(status_item, document, tsconfig);

    try {
        const { analyze } = get_analysis_module();
        const analysis = analyze(document.getText(), document.uri.fsPath);

        log('分析', document.uri.fsPath, 'script', analysis.root?.script ? '有' : '没有');

        analyses.set(document.uri.toString(), { analysis, version: document.version });
        update_diagnostics(document, collection, analysis);

        // 语言服务要加载 lib.es2022.d.ts，放后台预热，启动阶段不碰它
        setTimeout(() => analysis.warmup(), 0);
    } catch (error) {
        // 分析炸了也要把旧的诊断清掉，否则红线会一直挂着
        console.error('[grain] 分析失败', error);
        collection.delete(document.uri);
    }
}

/**
 * 编译产物的虚拟文档。
 *
 * 走 TextDocumentContentProvider 而不是 `openTextDocument({ content })`：
 * 后者建出来的是 Untitled 文档，一打开就带着未保存标记；
 * 前者有真实 URI，标签页直接显示 `App.grain.js`，而且是只读的，不会有保存提示。
 */
const OUTPUT_SCHEME = 'grain-output';

class OutputProvider implements vscode.TextDocumentContentProvider {
    private contents = new Map<string, string>();
    private changed = new vscode.EventEmitter<vscode.Uri>();

    readonly onDidChange = this.changed.event;

    set(uri: vscode.Uri, content: string): void {
        this.contents.set(uri.toString(), content);
        // 已经开着的那个标签页跟着刷新，不用关掉重开
        this.changed.fire(uri);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? '';
    }
}

const outputs = new OutputProvider();

/** `App.grain` -> `grain-output:/.../App.grain.js`，标签页上显示的就是这个文件名 */
function output_uri(source: vscode.Uri, kind: 'js' | 'css'): vscode.Uri {
    return vscode.Uri.from({ scheme: OUTPUT_SCHEME, path: `${source.path}.${kind}` });
}

async function show_compiled(editor: vscode.TextEditor, kind: 'js' | 'css'): Promise<void> {
    const { analyze } = get_analysis_module();
    const result = analyze(editor.document.getText(), editor.document.uri.fsPath).compiled();

    if (!result) {
        vscode.window.showErrorMessage('编译失败，先看问题面板里的错误');
        return;
    }

    const content = kind === 'js' ? result.js : result.css;

    if (kind === 'css' && !content.trim()) {
        vscode.window.showInformationMessage('这个组件没有 <style>');
        return;
    }

    const uri = output_uri(editor.document.uri, kind);
    outputs.set(uri, content);

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
}

export function activate(context: vscode.ExtensionContext): void {
    // 无条件的：用来确认扩展到底有没有激活（「输出 → Grain」里看）
    log('扩展激活', '版本', String(context.extension.packageJSON?.version ?? '?'));

    const collection = vscode.languages.createDiagnosticCollection('grain');
    context.subscriptions.push(collection);

    register_providers(
        context,
        cached_analysis,
        (document) => {
            if (!is_grain(document)) return undefined;

            // 缓存那份不是当前版本（文档改过了），就按眼前的文本重新分析
            const analysis = get_analysis_module().analyze(document.getText(), document.uri.fsPath);

            analyses.set(document.uri.toString(), { analysis, version: document.version });

            return analysis;
        }
    );

    status_item = vscode.languages.createLanguageStatusItem('grain.status', SELECTOR);
    status_item.name = 'Grain';
    status_item.text = 'Grain';
    status_item.detail = 'tsconfig: 还没分析过文件';

    context.subscriptions.push(status_item);

    const sync_debug = () =>
        set_debug(vscode.workspace.getConfiguration('grain').get<boolean>('debug', false));

    sync_debug();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('grain')) sync_debug();
        }),
        // tsconfig 改了：作废缓存，把所有 .grain 重新分析一遍
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (!document.uri.fsPath.endsWith('tsconfig.json')) return;

            forget_tsconfig();

            for (const other of vscode.workspace.textDocuments) {
                if (is_grain(other)) schedule(other);
            }
        })
    );

    // 改完停一下再解析，避免每个按键都跑一遍编译器。
    // 每个文档各用各的定时器：共用一个的话，切到另一个文档编辑会把前一个的刷新取消掉
    const timers = new Map<string, NodeJS.Timeout>();

    const schedule = (document: vscode.TextDocument) => {
        if (!is_grain(document)) return;

        const key = document.uri.toString();
        clearTimeout(timers.get(key));

        timers.set(
            key,
            setTimeout(() => {
                timers.delete(key);
                refresh(document, collection);
            }, 300)
        );
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(schedule),
        vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document)),
        vscode.workspace.onDidSaveTextDocument((document) => {
            // 组件改了，别的文档缓存的它的 props 得作废。
            // 分析模块还没加载过的话，缓存本来就不存在
            if (is_grain(document) && analysis_module) {
                analysis_module.forget_component(document.uri.fsPath);
            }

            schedule(document);
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            const key = document.uri.toString();

            clearTimeout(timers.get(key));
            timers.delete(key);

            analyses.get(key)?.analysis.dispose();
            analyses.delete(key);
            collection.delete(document.uri);
        })
    );

    // 已经在打开的文档晚点再扫：躲开扩展宿主的启动窗口，别在启动阶段把编译器拉起来
    setTimeout(() => {
        for (const document of vscode.workspace.textDocuments) schedule(document);
    }, 2000);

    const compile_command = (kind: 'js' | 'css') =>
        vscode.commands.registerCommand(
            `grain.compile${kind === 'js' ? 'Js' : 'Css'}`,
            async () => {
                const editor = vscode.window.activeTextEditor;

                if (!editor || !is_grain(editor.document)) {
                    vscode.window.showWarningMessage('当前文件不是 .grain');
                    return;
                }

                await show_compiled(editor, kind);
            }
        );

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(OUTPUT_SCHEME, outputs),
        compile_command('js'),
        compile_command('css')
    );
}

export function deactivate(): void {
    analyses.clear();
}
