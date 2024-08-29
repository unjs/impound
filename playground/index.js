import { dirname } from 'node:path'
import { CustodioPlugin } from 'custodio'
import { rollup } from 'rollup'

await rollup({
  input: 'src/index.js',
  plugins: [
    CustodioPlugin.rollup({
      cwd: dirname(import.meta.url),
      include: [/src\/*/],
      patterns: [
        [/^node:.*/], // disallows all node imports
        ['@nuxt/kit', 'Importing from @nuxt kit is not allowed in your src/ directory'], // custom error message
      ],
    }),
  ],
})
