export class ParseError extends Error {
    override name = 'ParseError';

    constructor(
        message: string,
        /** 相对整个 SFC 源文本的偏移 */
        public start: number,
        public end: number,
        public filename?: string
    ) {
        super(message);
    }
}
