# impound

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Github Actions][github-actions-src]][github-actions-href]
[![Codecov][codecov-src]][codecov-href]

> Build plugin to restrict import patterns in certain parts of your code-base.

This package is an [unplugin](https://unplugin.unjs.io/) which provides support for a wide range of bundlers.

## Usage

Install package:

```sh
# npm
npm install impound
```

```js
// rollup.config.js
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImpoundPlugin } from 'impound'

export default {
  plugins: [
    ImpoundPlugin.rollup({
      cwd: dirname(fileURLToPath(import.meta.url)),
      include: [/src\/*/],
      patterns: [
        [/^node:.*/], // disallows all node imports
        ['@nuxt/kit', 'Importing from @nuxt/kit is not allowed in your src/ directory'], // custom error message
        [(id, importer) => id.endsWith('.server') && `Server-only import in ${importer}`] // functional pattern with importer context
      ]
    }),
  ],
}
```

### Import Tracing

Enable `trace: true` to get rich violation diagnostics with full import chains and code snippets. When enabled, errors are deferred to `buildEnd` so the complete module graph can be collected first.

```js
ImpoundPlugin.rollup({
  cwd: dirname(fileURLToPath(import.meta.url)),
  trace: true,
  patterns: [
    [/\.server$/, 'Server-only import', ['Use a server function instead', 'Move this import to a .server.ts file']]
  ]
})
```

Example output:

```text
Invalid import [importing `secret` from `middle.js`]

Trace:
  1. src/routes/index.tsx:2:34 (entry) (import "../features/auth/session")
  2. src/features/auth/session.ts

Code:
  1 | import { logger } from '../utils/logger'
  2 |
> 3 | import { getUsers } from '../db/queries.server'
    |                           ^
  4 |
  5 | export function loadAuth() {

Suggestions:
  - Use a server function instead
  - Move this import to a .server.ts file
```

#### Choosing a trace mode

`trace: true` records the import graph as modules are transformed. Every module gets
parsed, and modules an `include` pattern covers also get their sourcemap built and their
source retained, so snippets can point at original source.

A narrow `include` therefore keeps eager tracing cheap: only modules that could be the
importer in a violation are retained.

`trace: 'lazy'` records nothing, and reads the bundler's own module graph when a
violation actually happens.

|  | `true` | `'lazy'` |
|---|---|---|
| Import chain | yes | yes, including dynamic imports |
| Code snippet | yes | yes |
| Snippet shows | original source | original source on webpack and rspack, otherwise the code the bundler holds |
| Per-module cost | parse, plus sourcemap + retain within `include` | none |
| Bundlers | all | all except esbuild |

Lazy reports from `buildEnd`, and a dev server only calls that when it shuts down, so
keep `true` for dev:

```js
ImpoundPlugin.vite({
  trace: isDev ? true : 'lazy',
  patterns: [[/\.server$/, 'Server-only import']]
})
```

Lazy reads the graph through `getModuleInfo` on rollup, vite and rolldown, and through
`compilation.moduleGraph` on webpack and rspack, where the snippet comes from
`originalSource()` and so shows original rather than transformed code. esbuild exposes
no module graph to a plugin, so there lazy reports the plain message with no chain or
snippet.

With `error: true`, lazy reports the first violation and fails the build there, so later
ones stay unreported until it is fixed. With either mode, `onViolation` returning `false`
suppresses the report but no longer allows the import: by the time the hook runs, the
import has already been replaced by the proxy.

### Named imports from a denied module

A denied import is replaced by a proxy module that has only a default export.
`syntheticNamedExports` papers over that on Rollup alone: rolldown, webpack, rspack and
esbuild ignore it. So on those, a named import from a denied module can fail with an
error naming `impound:proxy` before impound reports the real violation. It shows up only
when the build is allowed to continue past a violation, which means `error: false` or
lazy tracing.

## 💻 Development

- Clone this repository
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Run interactive tests using `pnpm dev`

## Acknowledgements

Some features in impound were inspired by [TanStack Start's import protection](https://tanstack.com/start/latest/docs/framework/react/guide/import-protection).

## License

Made with ❤️

Published under [MIT License](./LICENCE).

<!-- Badges -->

[npm-version-src]: https://npmx.dev/api/registry/badge/version/impound
[npm-version-href]: https://npmx.dev/package/impound
[npm-downloads-src]: https://npmx.dev/api/registry/badge/downloads/impound
[npm-downloads-href]: https://npm.chart.dev/impound
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/unjs/impound/ci.yml?branch=main&style=flat-square
[github-actions-href]: https://github.com/unjs/impound/actions?query=workflow%3Aci
[codecov-src]: https://img.shields.io/codecov/c/gh/unjs/impound/main?style=flat-square
[codecov-href]: https://codecov.io/gh/unjs/impound
