import * as vscode from 'vscode';

import type { Analysis, ComponentProp } from './analysis.js';
import { attributes_in, identifier_at } from './ast-utils.js';
import { log } from './log.js';

/** 带上 scheme，免得 VSCode 警告 "document selector without scheme" */
export const SELECTOR: vscode.DocumentSelector = { scheme: 'file', language: 'grain' };

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

// ---------------------------------------------------------------- 补全

/** 记下补全发生的位置，resolve 详情时要拿它去问语言服务 */
const completion_context = new WeakMap<
    vscode.CompletionItem,
    { document: vscode.TextDocument; offset: number }
>();

/** `ts.ScriptElementKind` -> VS Code 的图标 */
const KIND_BY_TS: Record<string, vscode.CompletionItemKind> = {
    keyword: vscode.CompletionItemKind.Keyword,
    class: vscode.CompletionItemKind.Class,
    interface: vscode.CompletionItemKind.Interface,
    enum: vscode.CompletionItemKind.Enum,
    enumMember: vscode.CompletionItemKind.EnumMember,
    module: vscode.CompletionItemKind.Module,
    function: vscode.CompletionItemKind.Function,
    method: vscode.CompletionItemKind.Method,
    property: vscode.CompletionItemKind.Property,
    parameter: vscode.CompletionItemKind.Variable,
    var: vscode.CompletionItemKind.Variable,
    let: vscode.CompletionItemKind.Variable,
    const: vscode.CompletionItemKind.Constant,
    alias: vscode.CompletionItemKind.Reference,
    type: vscode.CompletionItemKind.TypeParameter,
    primitiveType: vscode.CompletionItemKind.TypeParameter
};

function kind_of(kind: string): vscode.CompletionItemKind {
    return KIND_BY_TS[kind] ?? vscode.CompletionItemKind.Variable;
}

// ---------------------------------------------------------------- 语义高亮

const TOKEN_TYPES = [
    'class',
    'enum',
    'interface',
    'namespace',
    'typeParameter',
    'type',
    'parameter',
    'variable',
    'enumMember',
    'property',
    'function',
    'method'
];

/** 顺序要跟 typescript.ts 里的 TOKEN_MODIFIER_NAMES 一致 */
const TOKEN_MODIFIERS = ['declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local'];

const LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

/** 一个属性候选。`order` 决定排序：`bind:` 形式在最前 */
function attribute_item(name: string, prop: ComponentProp, order: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);

    item.detail = `${prop.name}${prop.optional ? '?' : ''}: ${prop.type}`;
    item.insertText = new vscode.SnippetString(`${name}={$0}`);
    item.sortText = `${order}${name}`;

    if (prop.bindable) {
        item.documentation = new vscode.MarkdownString(
            'Bindable — the child declares it with `$bindable`, so writes go back to the parent'
        );
    }

    return item;
}

export function register_providers(
    context: vscode.ExtensionContext,
    get_analysis: (document: vscode.TextDocument) => Analysis | undefined,
    /** 语义高亮会比第一次分析来得更早，所以允许"要的时候现算" */
    ensure_analysis: (document: vscode.TextDocument) => Analysis | undefined
): void {
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            SELECTOR,
            {
                provideDocumentSemanticTokens(document) {
                    // 语义高亮请求得比第一次分析早，这里现算一份
                    const analysis = get_analysis(document) ?? ensure_analysis(document);
                    if (!analysis) return null;

                    const builder = new vscode.SemanticTokensBuilder(LEGEND);

                    for (const span of analysis.classifications()) {
                        let start = span.start;
                        const end = span.start + span.length;

                        // 语义 token 不能跨行，跨了就按行拆成多个
                        while (start < end) {
                            const position = document.positionAt(start);
                            const line_end = document.lineAt(position.line).range.end;
                            const stop = Math.min(end, document.offsetAt(line_end));

                            builder.push(
                                new vscode.Range(position, position.translate(0, stop - start)),
                                span.type,
                                span.modifiers
                            );

                            const next = position.line + 1;
                            if (next >= document.lineCount) break;

                            start = document.offsetAt(new vscode.Position(next, 0));
                        }
                    }

                    return builder.build();
                }
            },
            LEGEND
        )
    );

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
                            ? `_Property of \`${component}\` · bindable (two-way)_`
                            : `_Property of \`${component}\`_`
                    );

                    return new vscode.Hover(contents);
                }

                // 模板里的 `{count}`：退回到声明源码
                const declaration = declaration_at(analysis, document, position);
                if (!declaration) return null;

                const contents = new vscode.MarkdownString();
                contents.appendCodeblock(declaration.detail, 'ts');
                contents.appendMarkdown(
                    declaration.kind === 'function' ? '_function declaration_' : '_variable declaration_'
                );

                return new vscode.Hover(contents);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            SELECTOR,
            {
                provideCompletionItems(document, position, token, context) {
                    log(
                        '补全请求',
                        'language', document.languageId,
                        '触发字符', JSON.stringify(context?.triggerCharacter ?? null),
                        'offset', offset_at(document, position)
                    );

                    const analysis = get_analysis(document) ?? ensure_analysis(document);

                    log('补全请求 analysis', analysis ? '有' : '没有');

                    if (!analysis) return null;

                    const offset = offset_at(document, position);

                    // script 里：交给 TS 语言服务，补全什么它说了算
                    const entries = analysis.completions(offset);

                    log('补全请求 条目', entries.length);

                    if (entries.length > 0) {
                        return entries.map((entry) => {
                            const item = new vscode.CompletionItem(entry.name, kind_of(entry.kind));

                            item.sortText = entry.sortText;
                            if (entry.detail) item.detail = entry.detail;

                            if (entry.insertText) {
                                item.insertText = new vscode.SnippetString(entry.insertText);
                            }

                            completion_context.set(item, { document, offset });

                            return item;
                        });
                    }

                    // 在组件标签里：补全它的属性
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
                },

                resolveCompletionItem(item) {
                    const context = completion_context.get(item);
                    if (!context) return item;

                    const analysis = get_analysis(context.document);
                    const name = typeof item.label === 'string' ? item.label : item.label.label;
                    const detail = analysis?.completion_detail(context.offset, name);

                    if (detail?.detail) item.detail = detail.detail;
                    if (detail?.documentation) {
                        item.documentation = new vscode.MarkdownString(detail.documentation);
                    }

                    return item;
                }
            },
            '.',
            '{',
            ' '
        )
    );
}
