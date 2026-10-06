# Grain for VS Code

Grain 是一门以 TypeScript 优先的模板语言。这个扩展给 `.grain` 文件提供完整的编辑支持。

## 功能

- **语法高亮**：模板、`<script>`（内嵌 TypeScript）、`<style>`（内嵌 CSS），`bind:` 和绑定值里的关键字单独着色
- **诊断**：解析错误直接标在源码上；`grain.semanticDiagnostics` 打开时还会用 TypeScript 语言服务报类型错误
- **跳转定义 / 悬停**：`<script>` 里的符号走 TS 语言服务，能看到真实类型；模板里的 `{count}` 退回到声明源码
- **补全**：`{ ... }` 里补全 script 的声明；组件标签里补全它接受的属性
- **组件属性智能提示**：读取被导入组件的 `$props<{...}>()`，悬浮显示类型，用 `$bindable` 声明的属性会额外给出 `bind:` 形式的候选
- **编译预览**：`Grain: 编译当前文件 → JS` / `→ CSS`，产物开在只读的虚拟文档里（标签页显示 `App.grain.js`，不会有未保存提示）

## 命令

| 命令 | 说明 |
|---|---|
| `Grain: 编译当前文件 → JS` | 编译出 JS 并在新标签页打开 |
| `Grain: 编译当前文件 → CSS` | 编译出 CSS 并在新标签页打开 |

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `grain.semanticDiagnostics` | `true` | 用 TypeScript 语言服务报告类型错误（关闭后只报语法错误） |
| `grain.debug` | `false` | 把语言服务的调用情况输出到「输出 → Log (Extension Host)」 |

## 类型

扩展自带 `$state` / `$props` / `$bindable` 的声明，以及 `declare module "*.grain"`，
所以 `import Child from './Child.grain'` 不会报找不到模块。

工作区里有 `tsconfig.json` 时，它的 `lib` / `target` / `strict` 等编译选项会被采用；
没有的话用插件自带的一套（含 DOM）。

## 已知限制

- 只有顶层函数的状态写入会被分析到；回调里改响应式变量（`setInterval(() => a++, 1000)`）目前不会触发刷新
- 嵌套函数里的声明不在补全范围内
