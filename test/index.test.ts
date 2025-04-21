import type { RollupError } from 'rollup'
import type { ImpoundOptions } from '../src'
import { rollup } from 'rollup'
import { describe, expect, it } from 'vitest'
import { ImpoundPlugin } from '../src'

describe('impound plugin', () => {
  const code = (id: string) => `import thing from "${id}";console.log(thing)`

  it('prevents importing a disallowed pattern', async () => {
    const result = await process(code('bar'), { patterns: [['bar']] }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] Invalid import [importing \`bar\` from \`entry.js\`]"`)
  })

  it('should work with relative imports', async () => {
    const result = await process(code('./bar.js'), { patterns: [['bar.js']] }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] Invalid import [importing \`bar.js\` from \`entry.js\`]"`)
  })

  it('should handle absolute paths', async () => {
    const result = await process(code('/root/bar.js'), { cwd: '/root', patterns: [['bar.js']] }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] Invalid import [importing \`bar.js\` from \`entry.js\`]"`)
  })

  it('supports using matchers array syntax', async () => {
    const result = await process(code('bar'), {
      matchers: [
        { patterns: [['foo']] }, // This matcher shouldn't apply to 'bar'
        { patterns: [['bar', 'Using the matchers array syntax']] }, // This should match
      ],
    }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] Using the matchers array syntax [importing \`bar\` from \`entry.js\`]"`)
  })

  it(`doesn't apply rule to excluded files`, async () => {
    const result = await process(code('bar'), { patterns: [['foo']] })
    expect(result).toMatchInlineSnapshot(`
      "var thing = "loaded";

      console.log(thing);"
    `)
  })

  it('provides a helpful error message when importing a disallowed pattern', async () => {
    const result = await process(code('bar'), { patterns: [['bar', '"bar" is a dangerous library and should never be used.']] }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] "bar" is a dangerous library and should never be used. [importing \`bar\` from \`entry.js\`]"`)
  })
})

async function process(code: string, opts: ImpoundOptions) {
  const libs = ['foo', 'bar']

  try {
    const build = await rollup({
      input: 'entry.js',
      plugins: [
        ImpoundPlugin.rollup(opts),
        {
          name: 'entry',
          load: id => id === 'entry.js' ? code : undefined,
          resolveId: id => id === 'entry.js' ? id : undefined,
        },
        {
          name: 'lib-load',
          load: id => libs.includes(id) ? 'export default "loaded"' : undefined,
          resolveId: id => libs.includes(id) ? id : undefined,
        },
      ],
    })
    const bundle = await build.generate({})
    return bundle.output[0]?.code.trim()
  }
  catch (e) {
    return e as RollupError
  }
}
