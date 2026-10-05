import * as vscode from 'vscode';

import type { Analysis } from './analysis.js';

/** 把解析错误和 CSS 诊断打到问题面板 */
export function update_diagnostics(
    document: vscode.TextDocument,
    collection: vscode.DiagnosticCollection,
    analysis: Analysis
): void {
    const items: vscode.Diagnostic[] = [];

    if (analysis.error) {
        const start = document.positionAt(analysis.error.start);
        const end = document.positionAt(Math.max(analysis.error.end, analysis.error.start + 1));

        items.push(
            new vscode.Diagnostic(new vscode.Range(start, end), analysis.error.message, vscode.DiagnosticSeverity.Error)
        );
    }

    // TS 语义诊断（类型错误、未定义变量）。语法已经错了就不重复报
    const semantic_enabled = vscode.workspace
        .getConfiguration('grain')
        .get<boolean>('semanticDiagnostics', true);

    if (semantic_enabled && !analysis.error) {
        for (const problem of analysis.semantic()) {
            const start = document.positionAt(problem.start);
            const end = document.positionAt(problem.end);

            items.push(
                new vscode.Diagnostic(new vscode.Range(start, end), problem.message, vscode.DiagnosticSeverity.Error)
            );
        }
    }

    for (const diagnostic of analysis.root?.stylesheet?.diagnostics ?? []) {
        const start = document.positionAt(diagnostic.start);
        const end = document.positionAt(Math.max(diagnostic.end, diagnostic.start + 1));

        items.push(
            new vscode.Diagnostic(
                new vscode.Range(start, end),
                diagnostic.formattedMessage || diagnostic.message,
                vscode.DiagnosticSeverity.Warning
            )
        );
    }

    collection.set(document.uri, items);
}
