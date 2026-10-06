# {{title}}

A Grain app scaffolded with `create-grain`.

## Commands

```sh
pnpm install     # or npm / yarn / bun
pnpm dev         # dev server
pnpm build       # production build into dist/
pnpm preview     # serve the build
pnpm typecheck   # tsc --noEmit
```

## Layout

```
index.html          mounts #app
src/main.ts         entry — mounts the root component
src/App.grain       root component
src/Counter.grain   child component (props + two-way binding)
src/grain.d.ts      $state / $props / $bindable / *.grain types
vite.config.mts     the grain vite plugin
```

## What the starter shows

| file | feature |
| --- | --- |
| `App.grain` | `$state`, `{#if}` / `{#for}`, `<style>`, `bind:value` |
| `App.grain` | `bind:this` + `<script onmount>` (touch the DOM once it is mounted) |
| `Counter.grain` | `$props` + `$bindable` — the parent's `count` and the child stay in sync |

## Editor

Install the **`grain.grain-vscode`** extension (`.vscode/extensions.json` recommends it)
for highlighting, diagnostics, completion and go-to-definition inside `.grain` files.

## Types

`src/grain.d.ts` declares `$state`, `$props`, `$bindable` and the `*.grain` module
type. Keep it — `pnpm typecheck` and the editor both rely on it.
