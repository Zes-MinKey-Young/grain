/**
 * 跨模块的状态：编译期看不见谁在用，所以交给运行时通知。
 */
import { writable } from '@graints/runtime';

export const name = writable('ada');
