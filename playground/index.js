import { dirname } from 'node:path'
import { ImpoundPlugin } from 'impound'
import { rollup } from 'rollup'

await rollup({
  input: 'src/index.js',
  plugins: [
    ImpoundPlugin.rollup({
      cwd: dirname(import.meta.url),
      include: [/src\/*/],
      patterns: [
        [/^node:.*/], // disallows all node imports
        ['@nuxt/kit', 'Importing from @nuxt kit is not allowed in your src/ directory'], // custom error message
      ],
    }),
  ],
})
