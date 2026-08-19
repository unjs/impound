import type { RollupError } from 'rollup'
import { rollup } from 'rollup'
import { describe, expect, it, vi } from 'vitest'
import { ImpoundPlugin } from '../src'

// Record which modules reach the lexer. Eager tracing parses every module to build its
// own graph; lazy tracing is supposed to parse none of them.
const parsed: string[] = []
vi.mock('es-module-lexer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('es-module-lexer')>()
  return {
    ...actual,
    parse: (code: string, id?: string) => {
      parsed.push(id ?? '?')
      return actual.parse(code, id)
    },
  }
})

const files: Record<string, string> = {
  'entry.js': 'import a from "a.js";console.log(a)',
  'a.js': 'import b from "b.js";export default b',
  'b.js': 'export default 1',
}

async function build(trace: boolean | 'lazy', extra: Record<string, string> = {}, opts: { error?: boolean } = {}) {
  parsed.length = 0
  const all = { ...files, ...extra }
  try {
    const bundle = await rollup({
      input: 'entry.js',
      plugins: [
        ImpoundPlugin.rollup({ trace, ...opts, patterns: [['secret', 'Denied']] }),
        { name: 'files', resolveId: (id: string) => (id in all || id === 'secret') ? id : undefined, load: (id: string) => all[id] },
        { name: 'lib', load: (id: string) => id === 'secret' ? 'export default 1' : undefined },
      ],
    })
    await bundle.generate({})
  }
  catch (e) { return { parsed: [...parsed], error: (e as RollupError).message } }
  return { parsed: [...parsed], error: undefined }
}

describe('what reaches the lexer', () => {
  it('eager tracing parses every module in a clean build', async () => {
    const { parsed, error } = await build(true)
    expect(error).toBeUndefined()
    expect(parsed).toEqual(['entry.js', 'a.js', 'b.js'])
  })

  it('lazy tracing parses nothing in a clean build', async () => {
    const { parsed, error } = await build('lazy')
    expect(error).toBeUndefined()
    expect(parsed).toEqual([])
  })

  it('lazy tracing reads each module on a chain once, not once per violation', async () => {
    // Two violations whose chains overlap: entry -> a (violation) -> b (violation).
    // Reporting both walks entry and a twice, so without a shared cache they are
    // parsed twice each.
    const { parsed, error } = await build('lazy', {
      'a.js': 'import s from "secret";import b from "b.js";export default s + b',
      'b.js': 'import s from "secret";export default s',
    }, { error: false })
    expect(error).toBeUndefined()
    expect(parsed.slice().sort()).toEqual(['a.js', 'b.js', 'entry.js'])
  })
})
