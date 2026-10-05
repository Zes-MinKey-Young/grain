import * as vscode from 'vscode';

import type { Analysis, ComponentProp } from './analysis.js';
import { attributes_in, identifier_at } from './ast-utils.js';

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

/**
 * 光标下是不是某个导入组件的属性名。
 * 属性没有位置信息，所以拿元素的位置回头扫标签头部。
 */
function component_attribute_at(
    analysis: Analysis,
    document: vscode.TextDocument,
    position: vscode.Position
): { component: string; prop: ComponentProp } | null {
    const offset = offset_at(document, position);
    const element = analysis.element_at(offset);
    if (!element) return null;

    const props = analysis.component_props(element.name);
    if (props.length === 0) return null;

    const attribute = attributes_in(document.getText(), element.name_end, element.end).find(
        (item) => offset >= item.start && offset <= item.end
    );

    const prop = attribute && props.find((item) => item.name === attribute.name);
    if (!prop) return null;

    return { component: element.name, prop };
}

/** 一个属性候选。`order` 决定排序：`bind:` 形式在最前 */
function attribute_item(name: string, prop: ComponentProp, order: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);

    item.detail = `${prop.name}${prop.optional ? '?' : ''}: ${prop.type}`;
    item.insertText = new vscode.SnippetString(`${name}={$0}`);
    item.sortText = `${order}${name}`;

    if (prop.bindable) {
        item.documentation = new vscode.MarkdownString('可以双向绑定（子组件里是 `$bindable`）');
    }

    return item;
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

                // 模板里组件的属性名：`label` / `bind:value` 之类
                const attribute = component_attribute_at(analysis, document, position);

                if (attribute) {
                    const { prop, component } = attribute;
                    const contents = new vscode.MarkdownString();

                    contents.appendCodeblock(
                        `${prop.name}${prop.optional ? '?' : ''}: ${prop.type}`,
                        'ts'
                    );
                    contents.appendMarkdown(
                        prop.bindable
                            ? `_${component} 的属性 · 可以双向绑定_`
                            : `_${component} 的属性_`
                    );

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

                    // 在组件标签里：补全它的属性
                    const offset = offset_at(document, position);
                    const element = analysis.element_at(offset);
                    const props = element ? analysis.component_props(element.name) : [];

                    if (element && props.length > 0) {
                        const items: vscode.CompletionItem[] = [];

                        for (const prop of props) {
                            // children 是插槽，不当属性补全
                            if (prop.name === 'children') continue;

                            // `$bindable` 的属性给两个候选：bind: 形式排前面
                            if (prop.bindable) {
                                items.push(attribute_item(`bind:${prop.name}`, prop, '0'));
                                items.push(attribute_item(prop.name, prop, '1'));

                                continue;
                            }

                            items.push(attribute_item(prop.name, prop, '2'));
                        }

                        return items;
                    }

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
