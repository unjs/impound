import type { RollupError } from 'rollup'
import type { ImpoundOptions, ImpoundViolationInfo } from '../src'
import { rollup } from 'rollup'
import { describe, expect, it, vi } from 'vitest'
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

  it('should handle absolutely resolved importers', async () => {
    const result = await process(code('/root/bar.js'), { cwd: '/root', patterns: [['bar.js']] }, '/root/entry.js') as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] Invalid import [importing \`bar.js\` from \`entry.js\`]"`)
  })

  it('should handle RegExp patterns', async () => {
    const result = await process(code('baar'), { patterns: [[/ba.r/]] }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] Invalid import [importing \`baar\` from \`entry.js\`]"`)
  })

  it('should handle functional patterns', async () => {
    const result = await process(code('bar'), { patterns: [[id => id === 'bar']] }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] Invalid import [importing \`bar\` from \`entry.js\`]"`)

    const result2 = await process(code('bar'), { patterns: [[id => id === 'bar' ? 'boo!' : false]] }) as RollupError
    expect(result2.message).toMatchInlineSnapshot(`"[plugin impound] boo! [importing \`bar\` from \`entry.js\`]"`)
  })

  it('should pass importer to functional patterns', async () => {
    const result = await process(code('bar'), { patterns: [[(id, importer) => importer === 'entry.js' && id === 'bar']] }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] Invalid import [importing \`bar\` from \`entry.js\`]"`)

    const result2 = await process(code('bar'), { patterns: [[(id, importer) => `${id} is not allowed in ${importer}`]] }) as RollupError
    expect(result2.message).toMatchInlineSnapshot(`"[plugin impound] bar is not allowed in entry.js [importing \`bar\` from \`entry.js\`]"`)
  })

  it('should handle error: false', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await process(code('bar'), { patterns: [['bar']], error: false }) as RollupError
    expect(result.message).toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith('Invalid import [importing `bar` from `entry.js`]')
    errorSpy.mockRestore()
  })

  it('deduplicates warnings by default (warn: once)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Two patterns that both match 'bar' — same message would be logged twice without dedup
    await process(code('bar'), { patterns: [['bar'], [/^bar$/]], error: false })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('logs all warnings when warn is set to always', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Two patterns that both match 'bar' — both log without dedup
    await process(code('bar'), { patterns: [['bar'], [/^bar$/]], error: false, warn: 'always' })
    expect(errorSpy).toHaveBeenCalledTimes(2)
    errorSpy.mockRestore()
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

  it('calls onViolation callback with violation info', async () => {
    const onViolation = vi.fn()
    const result = await process(code('bar'), { patterns: [['bar']], onViolation }) as RollupError
    expect(onViolation).toHaveBeenCalledWith({
      id: 'bar',
      importer: 'entry.js',
      message: 'Invalid import [importing `bar` from `entry.js`]',
    })
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] Invalid import [importing \`bar\` from \`entry.js\`]"`)
  })

  it('allows import when onViolation returns false', async () => {
    const result = await process(code('bar'), {
      patterns: [['bar']],
      onViolation: () => false,
    })
    expect(result).toMatchInlineSnapshot(`
      "var thing = "loaded";

      console.log(thing);"
    `)
  })

  it('provides a helpful error message when importing a disallowed pattern', async () => {
    const result = await process(code('bar'), { patterns: [['bar', '"bar" is a dangerous library and should never be used.']] }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] "bar" is a dangerous library and should never be used. [importing \`bar\` from \`entry.js\`]"`)
  })

  it('appends suggestions to error message', async () => {
    const result = await process(code('bar'), {
      patterns: [['bar', 'Server-only import', ['Use a server function instead', 'Move this import to a .server.ts file']]],
    }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`
      "[plugin impound] Server-only import [importing \`bar\` from \`entry.js\`]

      Suggestions:
        - Use a server function instead
        - Move this import to a .server.ts file"
    `)
  })

  it('skips pattern checks for imports matching excludeFiles', async () => {
    const result = await process(code('bar'), {
      patterns: [[/^bar$/]],
      excludeFiles: [/^bar$/],
    })
    expect(result).toMatchInlineSnapshot(`
      "var thing = "loaded";

      console.log(thing);"
    `)
  })

  it('still applies patterns to imports not matching excludeFiles', async () => {
    const result = await process(code('bar'), {
      patterns: [[/^bar$/]],
      excludeFiles: [/^foo$/],
    }) as RollupError
    expect(result.message).toMatchInlineSnapshot(`"[plugin impound] Invalid import [importing \`bar\` from \`entry.js\`]"`)
  })
})

describe('trace mode', () => {
  it('includes import trace in violation', async () => {
    const result = await processTrace({
      trace: true,
      patterns: [['secret']],
    }) as RollupError
    expect(result.message).toContain('Trace:')
    expect(result.message).toContain('entry.js')
    expect(result.message).toContain('middle.js')
  })

  it('includes code snippet in violation', async () => {
    const result = await processTrace({
      trace: true,
      patterns: [['secret']],
    }) as RollupError
    expect(result.message).toContain('Code:')
    expect(result.message).toContain('import secret from "secret"')
    expect(result.message).toContain('^')
  })

  it('includes suggestions with trace', async () => {
    const result = await processTrace({
      trace: true,
      patterns: [['secret', 'Server-only import', ['Use a server function']]],
    }) as RollupError
    expect(result.message).toContain('Suggestions:')
    expect(result.message).toContain('Use a server function')
  })

  it('calls onViolation with trace and snippet', async () => {
    const violations: ImpoundViolationInfo[] = []
    await processTrace({
      trace: true,
      patterns: [['secret']],
      error: false,
      onViolation: (info) => { violations.push(info) },
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]!.trace).toBeDefined()
    expect(violations[0]!.trace!.length).toBeGreaterThanOrEqual(2)
    expect(violations[0]!.snippet).toBeDefined()
    expect(violations[0]!.snippet!.line).toBeGreaterThan(0)
  })

  it('allows suppressing violations via onViolation returning false', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await processTrace({
      trace: true,
      patterns: [['secret']],
      error: false,
      onViolation: () => false,
    })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('deduplicates trace violations (warn: once)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await processTrace({
      trace: true,
      patterns: [['secret'], [/^secret$/]],
      error: false,
    })
    // Both patterns match but produce the same base message, so only 1 after dedup
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})

async function processTrace(opts: ImpoundOptions) {
  const files: Record<string, string> = {
    'entry.js': 'import middle from "middle.js";console.log(middle)',
    'middle.js': 'import secret from "secret";export default secret',
  }
  const libs = ['secret']

  try {
    const build = await rollup({
      input: 'entry.js',
      plugins: [
        ImpoundPlugin.rollup(opts),
        {
          name: 'virtual-files',
          load: id => files[id],
          resolveId: id => (id in files || libs.includes(id)) ? id : undefined,
        },
        {
          name: 'lib-load',
          load: id => libs.includes(id) ? 'export default "loaded"' : undefined,
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

async function process(code: string, opts: ImpoundOptions, importer = 'entry.js') {
  const libs = ['foo', 'bar']

  try {
    const build = await rollup({
      input: importer,
      plugins: [
        ImpoundPlugin.rollup(opts),
        {
          name: 'entry',
          load: id => id === importer ? code : undefined,
          resolveId: id => id === importer ? id : undefined,
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
