# custodio

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Github Actions][github-actions-src]][github-actions-href]
[![Codecov][codecov-src]][codecov-href]

> Builder-agnostic plugin to allow restricting import patterns in certain parts of your code-base.

## Usage

Install package:

```sh
# npm
npm install custodio
```

```js
import { dirname } from 'node:path'
import { CustodioPlugin } from 'custodio'

const build = await rollup({
  input: 'entry.js',
  plugins: [
    CustodioPlugin.rollup({
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

[npm-version-src]: https://img.shields.io/npm/v/custodio?style=flat-square
[npm-version-href]: https://npmjs.com/package/custodio
[npm-downloads-src]: https://img.shields.io/npm/dm/custodio?style=flat-square
[npm-downloads-href]: https://npmjs.com/package/custodio
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/unjs/custodio/ci.yml?branch=main&style=flat-square
[github-actions-href]: https://github.com/unjs/custodio/actions?query=workflow%3Aci
[codecov-src]: https://img.shields.io/codecov/c/gh/unjs/custodio/main?style=flat-square
[codecov-href]: https://codecov.io/gh/unjs/custodio
