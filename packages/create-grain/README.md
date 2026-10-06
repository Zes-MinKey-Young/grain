# create-grain

Scaffolds a new Grain project. Zero dependencies — it copies a template and fills
in a few placeholders.

```sh
npx @graints/create-grain my-app         # published package
pnpm create @graints/grain my-app        # same thing, through `pnpm create`

# inside this repository
pnpm create-grain my-app                 # -> root script, links the local packages
node packages/create-grain/index.mjs my-app
```

## Options

| flag | meaning |
| --- | --- |
| `-t, --template <name>` | `basic` (default) or `minimal` |
| `--link [path]` | depend on a local grain checkout via `file:` — the default when running inside one |
| `--no-link` | depend on the published packages instead |
| `--pm <pnpm\|npm\|yarn\|bun>` | package manager; detected from `npm_config_user_agent`, else `pnpm` |
| `--no-install` | write the files, skip installing |
| `-f, --force` | write into a non-empty directory |

## Templates

- `basic` — `App.grain` + `Counter.grain`: `$state`, `{#if}` / `{#for}`, `bind:value`,
  `bind:this` with `<script onmount>`, `$props` / `$bindable`, component `<style>`
- `minimal` — one `App.grain` with a counter

Both ship `index.html`, `vite.config.mts`, `tsconfig.json`, `src/main.ts`,
`src/grain.d.ts` (the `$state` / `$props` / `$bindable` / `*.grain` types) and a
`.vscode/extensions.json` recommending `grain.grain-vscode`.

Files that npm would drop when packing a tarball are stored with a `_` prefix
(`_gitignore`, `_vscode`) and renamed while copying.
