# impound

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Github Actions][github-actions-src]][github-actions-href]
[![Codecov][codecov-src]][codecov-href]

> Builder-agnostic plugin to allow restricting import patterns in certain parts of your code-base.

## Usage

Install package:

```sh
# npm
npm install impound
```

```js
import { dirname } from 'node:path'
import { ImpoundPlugin } from 'impound'

const build = await rollup({
  input: 'entry.js',
  plugins: [
    ImpoundPlugin.rollup({
      cwd: dirname(import.meta.url),
      include: [/src\/*/],
      patterns: [
        [/^node:.*/], // disallows all node imports
        ['@nuxt/kit', 'Importing from @nuxt kit is not allowed in your src/ directory'] // custom error message
      ]
    }),
  ],
})
```

## 🚧 TODO

- [x] add docs
- [x] update playground
- [x] push to GitHub
- [ ] migrate to `unjs/`

## 💻 Development

- Clone this repository
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Run interactive tests using `pnpm dev`

## License

Made with ❤️

Published under [MIT License](./LICENCE).

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/impound?style=flat-square
[npm-version-href]: https://npmjs.com/package/impound
[npm-downloads-src]: https://img.shields.io/npm/dm/impound?style=flat-square
[npm-downloads-href]: https://npmjs.com/package/impound
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/unjs/impound/ci.yml?branch=main&style=flat-square
[github-actions-href]: https://github.com/unjs/impound/actions?query=workflow%3Aci
[codecov-src]: https://img.shields.io/codecov/c/gh/unjs/impound/main?style=flat-square
[codecov-href]: https://codecov.io/gh/unjs/impound
