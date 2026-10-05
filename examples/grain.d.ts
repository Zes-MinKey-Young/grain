declare module '*.grain' {
    /** 组件编译产物的默认导出：把组件挂到目标元素上 */
    const mount: (target: Element) => unknown;
    export default mount;
}

declare module '*?grain-ast' {
    /** `App.grain?grain-ast` 返回该组件的解析结果（Root） */
    const root: unknown;
    export default root;
}
