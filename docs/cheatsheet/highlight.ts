/**
 * 一个够用的 grain 语法着色器。
 *
 * 只做一件事：把一段源码切成一片片带 `kind` 的片段，交给组件去上色。
 *
 * 为什么不复用编译器：编译器的 `parse` 只管结构（SFC 分块、模板节点），它不做 token
 * 级的着色，而且解析失败就抛。这里要的是"随便给一段、尽量涂上色"，所以自己扫一遍。
 *
 * 一次扫描，靠一组有序的正则轮流匹配 —— 顺序重要：注释和字符串要先于别的规则，
 * 否则里面的内容会被当成标识符。
 */

/** 片段种类：对应 CSS 里的 class */
export type Kind =
    | 'plain'
    | 'comment'
    | 'string'
    | 'rune'
    | 'block'
    | 'interp'
    | 'tag'
    | 'attr'
    | 'keyword'
    | 'number'
    | 'punct';

export interface Piece {
    text: string;
    kind: Kind;
}

/** TS / JS 里的关键字（`<script>` 内用） */
const KEYWORDS = new Set([
    'let', 'const', 'var', 'function', 'return', 'if', 'else', 'for', 'of', 'in', 'while',
    'do', 'switch', 'case', 'default', 'break', 'continue', 'new', 'class', 'extends',
    'import', 'export', 'from', 'as', 'type', 'interface', 'async', 'await', 'try',
    'catch', 'finally', 'throw', 'typeof', 'instanceof', 'this', 'super', 'void', 'null',
    'undefined', 'true', 'false', 'readonly', 'public', 'private', 'static'
]);

/** 块标记：`{#for}` `{#if}` `{:else}` `{/for}` */
const BLOCK = /^\{[#:/][^}]*\}/;

/** rune / 宏：`$state` `$props` `$node` `$read` `$store` `$bindable` */
const RUNE = /^\$[A-Za-z_]\w*/;

/** 字符串：三种引号，含模板串 */
const STRING = /^(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/;

/** 行注释 / 块注释 */
const COMMENT = /^(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/;

/** 数字 */
const NUMBER = /^\d+(?:\.\d+)?/;

/** 标签：`<div` `</div` `<Foo.Bar` —— 只吃标签名，属性另外匹配 */
const TAG = /(^<\/?)([A-Za-z]+)([\w.]*)/;

/**
 * 属性名：`bind:value` `onclick` —— 必须**紧跟着** `=`，中间不能有空格。
 *
 * 留了空格的话（`let n = 0` 里的 `n`）就不是属性而是普通变量，那样会错涂成属性色。
 */
const ATTR = /^(?:bind:|on)?[A-Za-z_][\w:-]*(?==)/;

/** 标识符（用来认关键字） */
const WORD = /^[A-Za-z_$][\w$]*/;

/** 单字符标点 */
const PUNCT = /^[{}()[\]<>;,.=:+\-*/!?&|]/;

/**
 * 切分一段 grain 源码。
 *
 * @param source 源码
 * @returns 按顺序的片段；拼起来正好是原文
 */
export function highlight(source: string): Piece[] {
    const pieces: Piece[] = [];
    let rest = source;
    let plain = '';

    const flush = (): void => {
        if (plain) {
            pieces.push({ text: plain, kind: 'plain' });
            plain = '';
        }
    };

    const push = (text: string, kind: Kind): void => {
        flush();

        pieces.push({ text, kind });

        rest = rest.slice(text.length);
    };

    while (rest.length > 0) {
        let matched = false;

        // 注释
        const comment = COMMENT.exec(rest);
        if (comment) {
            push(comment[0], 'comment');
            matched = true;
        }

        // 字符串
        if (!matched) {
            const string = STRING.exec(rest);
            if (string) {
                push(string[0], 'string');
                matched = true;
            }
        }

        // 块标记：`{#for ...}` `{/for}`
        if (!matched) {
            const block = BLOCK.exec(rest);
            if (block) {
                push(block[0], 'block');
                matched = true;
            }
        }

        // rune / 宏
        if (!matched) {
            const rune = RUNE.exec(rest);
            if (rune) {
                push(rune[0], 'rune');
                matched = true;
            }
        }

        // 标签
        if (!matched) {
            const tag = TAG.exec(rest);
            if (tag) {
                push(tag[1], 'punct');
                push(tag[2], 'tag');
                push(tag[3], 'plain');
                matched = true;
            }
        }

        // 属性名（后面跟着 =）
        if (!matched) {
            const attr = ATTR.exec(rest);
            if (attr) {
                push(attr[0], 'attr');
                matched = true;
            }
        }

        // 数字
        if (!matched) {
            const number = NUMBER.exec(rest);
            if (number) {
                push(number[0], 'number');
                matched = true;
            }
        }

        // 单词：关键字还是普通标识符
        if (!matched) {
            const word = WORD.exec(rest);
            if (word) {
                push(word[0], KEYWORDS.has(word[0]) ? 'keyword' : 'plain');
                matched = true;
            }
        }

        // 插值的大括号单独标一下（`{count}` 里的括号）
        if (!matched && (rest[0] === '{' || rest[0] === '}')) {
            push(rest[0], 'interp');
            matched = true;
        }

        // 其余标点
        if (!matched) {
            const punct = PUNCT.exec(rest);
            if (punct) {
                push(punct[0], 'punct');
                matched = true;
            }
        }

        // 都没匹配上：攒进 plain，前进一个字符
        if (!matched) {
            plain += rest[0];
            rest = rest.slice(1);
        }
    }

    flush();

    return pieces;
}
