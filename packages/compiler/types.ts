import type { AST as TSAst, TSESTree } from '@typescript-eslint/typescript-estree';
import type { StyleSheet as StyleSheetNode } from 'css-tree';

/**
 * 传给 typescript-estree 的选项。
 *
 * - `comment: true` 让 AST 根节点带上 `comments` 数组
 * - `jsx: false` grain 的 script 只有 TS，不解析 JSX
 * - `loc` / `range` 让节点带上位置信息（位置是相对整个 SFC 的绝对偏移）
 */
export type TSParseOptions = {
    comment: true;
    jsx: false;
    loc: true;
    range: true;
};

/** `<script>` / `<script module>` 解析出的 TS 程序 */
export type TSProgram = TSAst<TSParseOptions>;

/** 模板里 `{ ... }` 解析出的 TS 表达式节点 */
export type TSExpression = TSESTree.Expression;

// ---------------------------------------------------------------- 模板

/** 块（`<script>` / `<style>`）的属性；无值属性（如 `<script module>`）为 `true` */
export type Attributes = Record<string, string | true>;

/**
 * `bind:` 的绑定值。这是 grain 自己的语法，不是 TS 表达式：
 *
 * - `{count}` / `{count, active}` —— 变量形式
 * - `{ get: () => x, set: (v) => x = v, listen: ..., active }` —— 完整形式
 *
 * 三个函数的形状由 `check_bindings` 检验：`get` 无参数、`set` 正好一个参数、
 * `listen` 是 `(update) => ...` 或者 `listen(总线, "事件名")`（谓词可省，省了就是恒真）。
 *
 * 各项之间按顶层逗号断开，由专门的解析器读出来（不交给 TS 猜）。
 * `get` / `set` / `listen` 存的是它们**值**的源码片段，第二阶段再用 TS 解析。
 */
export interface RawBindingValue {
    /** 整个 `{ ... }` 的区间（含花括号） */
    start: number;
    end: number;
    /** 变量形式：`{count}` 里的 `count` */
    expression: RawExpression | null;
    get: RawExpression | null;
    set: RawExpression | null;
    listen: RawExpression | null;
    /** 写了 `active`（简写）或者 `active: true` */
    active: boolean;
}

/** 绑定值里该用 TS 解析的部分都解析完了 */
export interface BindingValue extends Omit<RawBindingValue, 'expression' | 'get' | 'set' | 'listen'> {
    expression: Expression | null;
    get: Expression | null;
    set: Expression | null;
    listen: Expression | null;
}

/**
 * 元素属性值：
 * - 纯文本 `class="btn"`
 * - 单个表达式 `onclick={increment}`
 * - 绑定值 `bind:value={count, active}`
 * - 文本与表达式混合 `class="btn {extra}"`
 */
export type AttributeValue = string | Expression | BindingValue | Array<string | Expression>;

/** Root 阶段的属性值，表达式还没解析 */
export type RawAttributeValue =
    | string
    | RawExpression
    | RawBindingValue
    | Array<string | RawExpression>;

export interface Position {
    /** 相对整个 SFC 源文本的起始偏移 */
    start: number;
    /** 相对整个 SFC 源文本的结束偏移（不含） */
    end: number;
}

export interface Template<N = TemplateNode> extends Position {
    type: 'Template';
    children: N[];
}

export interface Element<N = TemplateNode, V = AttributeValue> extends Position {
    type: 'element';
    name: string;
    attributes: Record<string, V | true>;
    children: N[];
}

export interface Text extends Position {
    type: 'text';
    /** 源文本原文 */
    raw: string;
    /** 解码 HTML 实体之后的文本 */
    content: string;
}

export interface Comment extends Position {
    type: 'comment';
    content: string;
}

/**
 * 模板里 `{ ... }` 表达式的公共部分。
 *
 * 跟块一样：Root 阶段只有 `raw` 和区间，第二阶段才解析出 `content`。
 */
export interface ExpressionBase extends Position {
    type: 'expression';
    /** 表达式原文（不含花括号） */
    raw: string;
    /** 表达式内容的起始偏移（`{` 之后） */
    contentStart: number;
    /** 表达式内容的结束偏移（`}` 之前） */
    contentEnd: number;
}

/** Root 阶段产出的表达式，尚未解析 TS */
export type RawExpression = ExpressionBase;

/** 第二阶段产出的表达式 */
export interface Expression extends ExpressionBase {
    content: TSExpression;
}

// ---------------------------------------------------------------- 逻辑块

/** `{for (... of ...)}` 的头部，用 TS 的 for-of 语句解析 */
export type TSForOf = TSESTree.ForOfStatement;

/** `{:else}` / `{:else if ...}` 分支 */
export interface ElseBlockBase<N = TemplateNode, E = Expression> extends Position {
    type: 'ElseBlock';
    /** `{:else if ...}` 的条件；`{:else}` 为 `null` */
    test: E | null;
    children: N[];
}

/** `{if ...}` ... `{/if}` */
export interface IfBlockBase<N = TemplateNode, E = Expression> extends Position {
    type: 'IfBlock';
    /** 条件表达式 */
    test: E;
    children: N[];
    /** 后续的 `{:else if ...}` / `{:else}` 分支 */
    alternates: Array<ElseBlockBase<N, E>>;
}

/** `{for (... of ...)}` ... `{/for}` */
export interface ForBlockBase<N = TemplateNode, E = Expression> extends Position {
    type: 'ForBlock';
    /** 循环头原文，如 `for (const item of list)` */
    raw: string;
    /** 循环头内容的起始偏移（`{` 之后） */
    contentStart: number;
    /** 循环头内容的结束偏移（`}` 之前） */
    contentEnd: number;
    children: N[];
    /** `{:else}` 分支，列表为空时渲染 */
    fallback: ElseBlockBase<N, E> | null;
}

export type RawElseBlock = ElseBlockBase<RawTemplateNode, RawExpression>;
export type RawIfBlock = IfBlockBase<RawTemplateNode, RawExpression>;
export type RawForBlock = ForBlockBase<RawTemplateNode, RawExpression>;

export type ElseBlock = ElseBlockBase<TemplateNode, Expression>;
export type IfBlock = IfBlockBase<TemplateNode, Expression>;

export interface ForBlock extends ForBlockBase<TemplateNode, Expression> {
    /** 第二阶段解析出的 for-of 语句，取 `left` / `right` 即可拿到绑定与迭代对象 */
    content: TSForOf;
}

export type TemplateNode = Element | Text | Comment | Expression | IfBlock | ForBlock;

export type RawTemplateNode =
    | Element<RawTemplateNode, RawAttributeValue>
    | Text
    | Comment
    | RawExpression
    | RawIfBlock
    | RawForBlock;

// ---------------------------------------------------------------- 块

/**
 * 块的公共部分。
 *
 * 注意：Root 阶段（SFC 本体解析）只产出 `raw`（内容原文）与区间，
 * `content`（真正的 TS / CSS AST）留到第二阶段填充。
 */
export interface BlockBase extends Position {
    attributes: Attributes;
    /** 内容起始偏移（开始标签 `>` 之后） */
    contentStart: number;
    /** 内容结束偏移（结束标签 `<` 之前） */
    contentEnd: number;
    /** 内容原文 */
    raw: string;
}

/**
 * script 的三种：
 * - `default`：组件实例脚本
 * - `module`：模块级，随模块只跑一次
 * - `onmount`：组件元素挂载后跑，能看见 `bind:this` 声明的变量
 */
export type ScriptContext = 'default' | 'module' | 'onmount';

/** Root 阶段产出的原始 script 块，尚未解析 TS */
export interface RawScript extends BlockBase {
    type: 'Script';
    context: ScriptContext;
}

/** 第二阶段产出的 script 块 */
export interface Script extends RawScript {
    content: TSProgram;
}

/** Root 阶段产出的原始 style 块，尚未解析 CSS */
export interface RawStyle extends BlockBase {
    type: 'Style';
}

/** css-tree 报告的诊断信息（不中断解析，交给后续阶段决定如何处理） */
export interface CssDiagnostic extends Position {
    message: string;
    formattedMessage: string;
    line: number;
    column: number;
}

/** 第二阶段产出的 style 块 */
export interface Stylesheet extends RawStyle {
    content: StyleSheetNode;
    diagnostics: CssDiagnostic[];
}

// ---------------------------------------------------------------- 根

/** 第一阶段的结果：模板已解析，script / style 只有原文 */
export interface RootStage extends Position {
    type: 'Root';
    module: RawScript | null;
    script: RawScript | null;
    onmount: RawScript | null;
    stylesheet: RawStyle | null;
    template: Template<RawTemplateNode>;
}

/** 最终产物：CSS 与 TS 都已解析完毕 */
export interface Root extends Position {
    type: 'Root';
    module: Script | null;
    script: Script | null;
    onmount: Script | null;
    stylesheet: Stylesheet | null;
    template: Template<TemplateNode>;
}
