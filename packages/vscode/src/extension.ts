import * as vscode from 'vscode';

import type { Analysis } from './analysis.js';
import { update_diagnostics } from './diagnostics.js';
import { register_providers } from './providers.js';
import { set_debug } from './typescript.js';

const analyses = new Map<string, Analysis>();

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

function refresh(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
    if (!is_grain(document)) return;

    try {
        const { analyze } = get_analysis_module();
        const analysis = analyze(document.getText(), document.uri.fsPath);

        analyses.set(document.uri.toString(), analysis);
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
    const collection = vscode.languages.createDiagnosticCollection('grain');
    context.subscriptions.push(collection);

    register_providers(context, (document) => analyses.get(document.uri.toString()));

    const sync_debug = () =>
        set_debug(vscode.workspace.getConfiguration('grain').get<boolean>('debug', false));

    sync_debug();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('grain')) sync_debug();
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
        vscode.workspace.onDidSaveTextDocument(schedule),
        vscode.workspace.onDidCloseTextDocument((document) => {
            const key = document.uri.toString();

            clearTimeout(timers.get(key));
            timers.delete(key);

            analyses.get(key)?.dispose();
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
