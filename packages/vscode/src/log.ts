import * as vscode from 'vscode';

/**
 * 独立的输出通道：「输出 → Grain」。
 *
 * 之前用的是 console.log，进的是「Log (Extension Host)」——
 * 那条通道会按日志级别过滤，还跟别的扩展的输出混在一起，经常什么都看不到。
 * 通道不受这些影响，也不受 `grain.debug` 影响：打开通道就一定能看见。
 */
let channel: vscode.OutputChannel | null = null;
let verbose = false;

function output(): vscode.OutputChannel {
    return (channel ??= vscode.window.createOutputChannel('Grain'));
}

function format(args: unknown[]): string {
    return args
        .map((arg) => {
            if (typeof arg === 'string') return arg;
            if (arg instanceof Error) return arg.stack ?? arg.message;

            try {
                return JSON.stringify(arg);
            } catch {
                return String(arg);
            }
        })
        .join(' ');
}

export function log(...args: unknown[]): void {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    output().appendLine(`${time} ${format(args)}`);
    if (verbose) console.log('[grain]', ...args);
}

/** `grain.debug`：额外打一份到 Extension Host 日志，并把通道显示出来 */
export function set_debug(value: boolean): void {
    verbose = value;
    if (value) output().show(true);
}
