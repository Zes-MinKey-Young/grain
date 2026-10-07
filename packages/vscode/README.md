# Grain for VS Code

Grain is a TypeScript-first template language. This extension gives `.grain` files full
editor support.

## Features

- **Syntax highlighting**: the template, `<script>` (embedded TypeScript) and `<style>`
  (embedded CSS), with `bind:` and the keywords inside a binding value coloured separately
- **Diagnostics**: parse errors are reported right on the source; with
  `grain.semanticDiagnostics` on, type errors from the TypeScript language service are
  reported too
- **Go to definition / hover**: symbols inside `<script>` go through the TS language
  service, so you see their real types; `{count}` in the template falls back to the
  declaration source
- **Completions**: declarations from the script inside `{ ... }`; the attributes a
  component accepts inside its tag
- **Component attribute hints**: reads `$props<{...}>()` from the imported component and
  shows the types on hover; props declared with `$bindable` additionally offer the
  `bind:` form
- **Compiled preview**: `Grain: Compile current file → JS` / `→ CSS` opens the output in a
  read-only virtual document (the tab shows `App.grain.js`, and never asks to be saved)

## Commands

| Command | Description |
|---|---|
| `Grain: Compile current file → JS` | compile to JS and open it in a new tab |
| `Grain: Compile current file → CSS` | compile to CSS and open it in a new tab |

## Settings

| Setting | Default | Description |
|---|---|---|
| `grain.semanticDiagnostics` | `true` | report type errors from the TypeScript language service (off leaves only syntax errors) |
| `grain.debug` | `false` | log language service calls to Output → Log (Extension Host) |

## Types

The extension ships the declarations for `$state` / `$props` / `$bindable` and
`declare module "*.grain"`, so `import Child from './Child.grain'` does not report a
missing module.

When the workspace has a `tsconfig.json`, its `lib` / `target` / `strict` and other
compiler options are used; otherwise the extension falls back to its own set (DOM included).

## Known limitations

- Only state writes in top-level functions are analysed; changing a reactive variable from
  a callback (`setInterval(() => a++, 1000)`) does not trigger a refresh yet
- Declarations inside nested functions are not offered as completions
