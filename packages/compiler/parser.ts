import { check_bindings } from './check.js';
import { ParseError } from './errors.js';
import { expand_macros, type MacroReparse } from './macro.js';

import { parse_expressions } from './read/expression.js';
import { parse_script } from './read/script.js';
import { parse_style } from './read/style.js';
import { scan_script, scan_style } from './scan.js';
import {
    REGEX_BINDING_VALUE,
    read_attribute_value,
    read_binding_value,
    read_block_attributes,
    read_fragment
} from './template.js';
import type {
    RawScript,
    RawStyle,
    RawTemplateNode,
    Root,
    RootStage,
    ScriptContext,
    Template,
    TemplateNode
} from './types.js';
import { create_locator, is_whitespace, type Locator } from './utils.js';

export interface ParseOptions {
    /** 文件名，只用于错误信息 */
    filename?: string;
}

export class Parser {
    index = 0;
    readonly length: number;
    readonly locate: Locator;
    private blank: string | null = null;

    constructor(
        public source: string,
        public options: ParseOptions = {}
    ) {
        this.length = source.length;
        this.locate = create_locator(source);
    }

    /**
     * 与 `source` 等长的"空白版"源码：除换行外全是空格。
     *
     * 解析块内容 / 表达式时拿它做前缀，AST 里的位置就自动对齐整个 SFC 的绝对偏移。
     */
    get masked(): string {
        return (this.blank ??= this.source.replace(/[^\n\r]/g, ' '));
    }

    /**
     * 完整解析：先解析出 Root（SFC 本体），再解析 CSS 与 TS。
     */
    parse(): Root {
        const root = this.parse_root();
        const masked = this.masked;

        // ---- 第二阶段：Root 结构确定之后才解析 CSS 与 TS ----
        const stylesheet = root.stylesheet ? parse_style(root.stylesheet, this.locate) : null;
        const module = root.module ? parse_script(root.module, masked) : null;
        const script = root.script ? parse_script(root.script, masked) : null;
        const onmount = root.onmount ? parse_script(root.onmount, masked) : null;
        const macro = root.macro ? parse_script(root.macro, masked) : null;

        // 模板里的 `{ ... }` 表达式同样交给 TS 解析器
        parse_expressions(root.template, masked);

        const result: Root = {
            ...root,
            stylesheet,
            module,
            script,
            onmount,
            macro,
            expanded: '',
            replacements: [],
            macros: [],
            template: root.template as Template<TemplateNode>
        };

        // `bind:` 的值可能是宏调用，先展开成真正的绑定值，再检查形状。
        // 无条件跑：内置宏（`$store`）不需要写 `<script macro>`
        // 重解析用的是 Parser 实例，从这里传进去——避免 macro 反过来 import parser
        const reparse: MacroReparse = {
            binding: (text, filename) => read_binding_value(new Parser(`{${text}}`, { filename })),
            attribute: (text, filename) => read_attribute_value(new Parser(text, { filename })),
            // 绑定语法（`listen: ...`）按绑定值读；否则按属性值——
            // 值里没有 `{` 就补一对花括号，不然会被当成一段字面文本
            value: (text, filename) =>
                REGEX_BINDING_VALUE.test(text)
                    ? read_binding_value(new Parser(`{${text}}`, { filename }))
                    : read_attribute_value(new Parser(text.includes('{') ? text : `{${text}}`, { filename }))
        };

        const run = expand_macros(result, this.source, this.options.filename, reparse);

        result.expanded = run.appended;
        result.replacements = run.replacements;
        result.macros = run.macros;

        // 都解析完了才检查 `bind:value={ ... }` 里那三个函数的形状
        check_bindings(result);

        return result;
    }

    /**
     * 第一阶段：解析 SFC 本体。
     *
     * 逐个切出顶层块（`<script>` / `<script module>` / `<style>`），
     * 剩下的内容全部作为模板解析。此时块只有原文与区间，不做 TS / CSS 解析。
     */
    parse_root(): RootStage {
        let script: RawScript | null = null;
        let module: RawScript | null = null;
        let onmount: RawScript | null = null;
        let macro: RawScript | null = null;
        let stylesheet: RawStyle | null = null;

        const children: RawTemplateNode[] = [];

        while (this.index < this.length) {
            if (this.is_block('script')) {
                const block = this.read_script();

                if (block.context === 'module') {
                    if (module) this.error('A component can only have one `<script module>`', block.start, block.end);
                    module = block;
                } else if (block.context === 'onmount') {
                    if (onmount) this.error('A component can only have one `<script onmount>`', block.start, block.end);
                    onmount = block;
                } else if (block.context === 'macro') {
                    if (macro) this.error('A component can only have one `<script macro>`', block.start, block.end);
                    macro = block;
                } else {
                    if (script) this.error('A component can only have one `<script>`', block.start, block.end);
                    script = block;
                }

                continue;
            }

            if (this.is_block('style')) {
                const block = this.read_style();
                if (stylesheet) this.error('A component can only have one `<style>`', block.start, block.end);
                stylesheet = block;
                continue;
            }

            children.push(...read_fragment(this));
        }

        const start = children[0]?.start ?? 0;
        const end = children[children.length - 1]?.end ?? 0;

        return {
            type: 'Root',
            start: 0,
            end: this.length,
            module,
            script,
            onmount,
            macro,
            stylesheet,
            template: { type: 'Template', start, end, children }
        };
    }

    // ------------------------------------------------------------ 块

    /** `source` 的当前位置是否是一个 `<script>` / `<style>` 开始标签（排除 `<scriptx>` 这类） */
    is_block(name: 'script' | 'style'): boolean {
        if (!this.match('<' + name)) return false;

        const next = this.source[this.index + name.length + 1];
        return next === undefined || next === '>' || next === '/' || is_whitespace(next);
    }

    private read_script(): RawScript {
        const start = this.index;
        this.eat('<script', true);
        const attributes = read_block_attributes(this);
        this.allow_whitespace();
        this.eat('/');
        this.eat('>', true);

        const content_start = this.index;
        const { contentEnd, end } = scan_script(this.source, content_start, this.locate);
        this.index = end;

        let context: ScriptContext = 'default';

        for (const [name, value] of Object.entries(attributes)) {
            if (name !== 'module' && name !== 'onmount' && name !== 'macro') {
                this.error(
                    `\`<script>\` does not support the \`${name}\` attribute (only \`<script>\`, \`<script module>\`, \`<script onmount>\` and \`<script macro>\` are valid)`,
                    start,
                    this.index
                );
            }

            if (value !== true) {
                this.error(`The \`${name}\` attribute takes no value — write \`<script ${name}>\``, start, this.index);
            }

            context = name;
        }

        return {
            type: 'Script',
            context,
            attributes,
            start,
            end: this.index,
            contentStart: content_start,
            contentEnd,
            raw: this.source.slice(content_start, contentEnd)
        };
    }

    private read_style(): RawStyle {
        const start = this.index;
        this.eat('<style', true);
        const attributes = read_block_attributes(this);
        this.allow_whitespace();
        this.eat('/');
        this.eat('>', true);

        const content_start = this.index;
        const { contentEnd, end } = scan_style(this.source, content_start, this.locate);
        this.index = end;

        return {
            type: 'Style',
            attributes,
            start,
            end: this.index,
            contentStart: content_start,
            contentEnd,
            raw: this.source.slice(content_start, contentEnd)
        };
    }

    // ------------------------------------------------------------ 读取原语

    match(str: string): boolean {
        return this.source.startsWith(str, this.index);
    }

    eat(str: string, required = false): boolean {
        if (this.match(str)) {
            this.index += str.length;
            return true;
        }

        if (required) this.error(`Expected "${str}"`);

        return false;
    }

    /** 只在当前位置匹配时消费，`pattern` 需要带 `y` 标志 */
    read(pattern: RegExp): string | null {
        pattern.lastIndex = this.index;
        const match = pattern.exec(this.source);
        if (!match || match.index !== this.index) return null;

        this.index += match[0].length;
        return match[0];
    }

    allow_whitespace(): void {
        while (this.index < this.length && is_whitespace(this.source[this.index])) {
            this.index += 1;
        }
    }

    error(message: string, start = this.index, end = start): never {
        const { line, column } = this.locate(start);
        const filename = this.options.filename ?? 'component';
        throw new ParseError(`${message} (${filename}:${line}:${column})`, start, end, this.options.filename);
    }
}

/** 解析一个 grain 组件，返回完整 Root（CSS 与 TS 均已解析） */
export function parse(source: string, options: ParseOptions = {}): Root {
    return new Parser(source, options).parse();
}

/** 只做第一阶段：解析出 Root 的骨架，script / style 只有原文 */
export function parse_root(source: string, options: ParseOptions = {}): RootStage {
    return new Parser(source, options).parse_root();
}
