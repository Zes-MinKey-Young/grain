/// <reference path="../packages/runtime/globals.d.ts" />

/**
 * Globals for the examples.
 *
 * The source of truth is `packages/runtime/globals.d.ts` — `$state`, `$props`,
 * `$bindable`, `$node` and the built-in macros all live there, and this file just pulls it
 * in. Don't duplicate declarations here.
 *
 * The VS Code extension injects the same declarations (GRAIN_TYPE_SOURCE in
 * `packages/vscode/src/typescript.ts`), which is what drives the editor when a project has
 * no `@graints/runtime` installed.
 */
