import * as vscode from 'vscode';

import type { Analysis } from './analysis.js';
import { identifier_at } from './ast-utils.js';

/** 带上 scheme，免得 VSCode 警告 "document selector without scheme" */
const SELECTOR: vscode.DocumentSelector = { scheme: 'file', language: 'grain' };

/** 取光标在文档里的偏移 */
function offset_at(document: vscode.TextDocument, position: vscode.Position): number {
    return document.offsetAt(position);
}

/**
 * 光标下的标识符对应的声明。
 * 模板里的 `{count}` 和 `<script>` 里的 `count` 都算。
 */
function declaration_at(analysis: Analysis, document: vscode.TextDocument, position: vscode.Position) {
    const offset = offset_at(document, position);

    const expression = analysis.expression_at(offset);
    const script = expression ? null : analysis.script_at(offset);
    if (!expression && !script) return null;

    const name = identifier_at(expression ? expression.content : script?.content, offset);
    if (!name) return null;

    return analysis.all.get(name) ?? analysis.declarations.get(name) ?? null;
}

export function register_providers(
    context: vscode.ExtensionContext,
    get_analysis: (document: vscode.TextDocument) => Analysis | undefined
): void {
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(SELECTOR, {
            provideDefinition(document, position) {
                const analysis = get_analysis(document);
                const declaration = analysis && declaration_at(analysis, document, position);
                if (!declaration) return null;

                return new vscode.Location(
                    document.uri,
                    new vscode.Range(
                        document.positionAt(declaration.start),
                        document.positionAt(declaration.end)
                    )
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider(SELECTOR, {
            provideHover(document, position) {
                const analysis = get_analysis(document);
                if (!analysis) return null;

                // `<script>` 里：用 TS 语言服务，能看到类型
                const info = analysis.quick_info(offset_at(document, position));

                if (info) {
                    const contents = new vscode.MarkdownString();
                    contents.appendCodeblock(info.text, 'ts');
                    if (info.documentation) contents.appendMarkdown(info.documentation);

                    return new vscode.Hover(contents);
                }

                // 模板里的 `{count}`：退回到声明源码
                const declaration = declaration_at(analysis, document, position);
                if (!declaration) return null;

                const contents = new vscode.MarkdownString();
                contents.appendCodeblock(declaration.detail, 'ts');
                contents.appendMarkdown(declaration.kind === 'function' ? '_函数声明_' : '_变量声明_');

                return new vscode.Hover(contents);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            SELECTOR,
            {
                provideCompletionItems(document, position) {
                    const analysis = get_analysis(document);
                    if (!analysis) return null;

                    // 只在 `{ ... }` 里补全
                    const line = document.lineAt(position).text.slice(0, position.character);
                    if (!line.includes('{')) return null;

                    const items: vscode.CompletionItem[] = [];

                    for (const declaration of analysis.declarations.values()) {
                        const item = new vscode.CompletionItem(
                            declaration.name,
                            declaration.kind === 'function'
                                ? vscode.CompletionItemKind.Function
                                : vscode.CompletionItemKind.Variable
                        );
                        item.detail = declaration.detail;
                        items.push(item);
                    }

                    return items;
                }
            },
            '{',
            ' '
        )
    );
}
