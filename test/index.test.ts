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

  it('shows original source in snippet when code has been transformed', async () => {
    // Simulate a Vue SFC-like compiler that strips a wrapping tag and shifts lines
    const originalSource = '<script>\nimport secret from "secret"\nexport default {}\n</script>'
    const transformedSource = 'import secret from "secret";\nexport default {};'

    // Source map: transformed line 1 -> original line 2, transformed line 2 -> original line 3
    // VLQ: "AACA" = (0,0,1,0) meaning gen col 0, source 0, orig line +1, orig col 0
    // Second mapping "AACA" on line 2 means same thing: gen col 0, source 0, orig line +1, orig col 0
    const sourceMap = {
      version: 3,
      sources: ['middle.js'],
      sourcesContent: [originalSource],
      mappings: 'AACA;AACA',
      names: [],
    }

    const sfcPlugin = {
      name: 'sfc-compiler',
      transform(code: string, id: string) {
        if (id === 'middle.js') {
          return { code: transformedSource, map: sourceMap }
        }
      },
    }

    const files: Record<string, string> = {
      'entry.js': 'import middle from "middle.js";console.log(middle)',
      'middle.js': originalSource,
    }
    const result = await buildWithTrace(files, ['secret'], {
      trace: true,
      patterns: [['secret']],
    }, [sfcPlugin]) as RollupError

    // The snippet should show the ORIGINAL source (with <script> tag), not the transformed JS
    expect(result.message).toContain('Code:')
    expect(result.message).toContain('<script>')
    expect(result.message).toContain('import secret from "secret"')
    // Line 2 in the original source
    expect(result.message).toMatch(/> 2 \|/)
  })

  it('shows original source via onViolation snippet when code has been transformed', async () => {
    const originalSource = '// header comment\nimport secret from "secret"\nexport default {}'
    const transformedSource = 'import secret from "secret";\nexport default {};'

    const sourceMap = {
      version: 3,
      sources: ['middle.js'],
      sourcesContent: [originalSource],
      mappings: 'AACA;AACA',
      names: [],
    }

    const transformPlugin = {
      name: 'strip-comments',
      transform(code: string, id: string) {
        if (id === 'middle.js') {
          return { code: transformedSource, map: sourceMap }
        }
      },
    }

    const violations: ImpoundViolationInfo[] = []
    const files: Record<string, string> = {
      'entry.js': 'import middle from "middle.js";console.log(middle)',
      'middle.js': originalSource,
    }
    await buildWithTrace(files, ['secret'], {
      trace: true,
      patterns: [['secret']],
      error: false,
      onViolation: (info) => { violations.push(info) },
    }, [transformPlugin])

    expect(violations).toHaveLength(1)
    expect(violations[0]!.snippet).toBeDefined()
    // Snippet line should be 2 (original position), not 1 (transformed position)
    expect(violations[0]!.snippet!.line).toBe(2)
  })

  it('falls back to originalCode when sourcesContent is missing from source map', async () => {
    const originalSource = '// original\nimport secret from "secret"\nexport default {}'
    const transformedSource = 'import secret from "secret";\nexport default {};'

    // Source map without sourcesContent
    const sourceMap = {
      version: 3,
      sources: ['middle.js'],
      mappings: 'AACA;AACA',
      names: [],
    }

    const transformPlugin = {
      name: 'strip-comments',
      transform(code: string, id: string) {
        if (id === 'middle.js') {
          return { code: transformedSource, map: sourceMap }
        }
      },
    }

    const violations: ImpoundViolationInfo[] = []
    const files: Record<string, string> = {
      'entry.js': 'import middle from "middle.js";console.log(middle)',
      'middle.js': originalSource,
    }
    await buildWithTrace(files, ['secret'], {
      trace: true,
      patterns: [['secret']],
      error: false,
      onViolation: (info) => { violations.push(info) },
    }, [transformPlugin])

    expect(violations).toHaveLength(1)
    expect(violations[0]!.snippet).toBeDefined()
    // Should still map to line 2 via the source map positions
    expect(violations[0]!.snippet!.line).toBe(2)
  })

  it('falls back to transformed code when source map has empty mappings', async () => {
    const originalSource = '// original\nimport secret from "secret"\nexport default {}'
    const transformedSource = 'import secret from "secret";\nexport default {};'

    // Source map with empty mappings — no position data
    const sourceMap = {
      version: 3,
      sources: ['middle.js'],
      sourcesContent: [originalSource],
      mappings: '',
      names: [],
    }

    const transformPlugin = {
      name: 'empty-map',
      transform(code: string, id: string) {
        if (id === 'middle.js') {
          return { code: transformedSource, map: sourceMap }
        }
      },
    }

    const violations: ImpoundViolationInfo[] = []
    const files: Record<string, string> = {
      'entry.js': 'import middle from "middle.js";console.log(middle)',
      'middle.js': originalSource,
    }
    await buildWithTrace(files, ['secret'], {
      trace: true,
      patterns: [['secret']],
      error: false,
      onViolation: (info) => { violations.push(info) },
    }, [transformPlugin])

    expect(violations).toHaveLength(1)
    expect(violations[0]!.snippet).toBeDefined()
    // With empty mappings, getCombinedSourcemap still collapses to an identity map
    // so the snippet should still work (falling back to transformed positions)
    expect(violations[0]!.snippet!.line).toBeGreaterThan(0)
  })

  it('uses transformed code when getCombinedSourcemap is not available', async () => {
    // Use ImpoundPlugin.raw to get the base plugin without builder-specific overrides,
    // exercising the base transform path (for webpack/rspack/etc.)
    const rawPlugins = ImpoundPlugin.raw({ trace: true, patterns: [['secret', 'Not allowed']] }, { framework: 'rollup' })
    const pluginArray = Array.isArray(rawPlugins) ? rawPlugins : [rawPlugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    // Base transform — no getCombinedSourcemap available
    const transformFn = typeof tracePlugin.transform === 'function' ? tracePlugin.transform : (tracePlugin.transform as any)?.handler
    await transformFn.call({}, 'import secret from "secret"\nexport default secret', 'middle.js')
    const resolveIdFn = typeof impoundPlugin.resolveId === 'function' ? impoundPlugin.resolveId : (impoundPlugin.resolveId as any)?.handler
    await resolveIdFn.call(context, 'secret', 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Code:')
    expect(errors[0]).toContain('import secret from "secret"')
  })

  it('falls back to originalCode when sourceContentFor returns null', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    const originalCode = '// original header\nimport secret from "secret"\nexport default {}'

    // Source map has sourcesContent for source index 0, but the mapping points to
    // source index 1 which has null content — sourceContentFor returns null for that source,
    // so the fallback to originalCode (from sourcesContent[0]) should be used.
    const traceContext = {
      getCombinedSourcemap: () => ({
        version: 3,
        sources: ['original.js', 'other.js'],
        sourcesContent: [originalCode, null],
        // "ACCA" = gen col 0, source index 1, orig line +1, orig col 0
        // This maps to source index 1 ('other.js') which has null content
        mappings: 'ACCA;AACA',
        names: [],
      }),
    }

    await (tracePlugin as any).transform.call(traceContext, 'import secret from "secret";\nexport default {};', 'middle.js')
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Code:')
    // Falls back to originalCode (sourcesContent[0])
    expect(errors[0]).toContain('// original header')
  })

  it('falls back to originalCode from sourcesContent[0] when source is null in mapping', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    const originalCode = '// original\nimport secret from "secret"\nexport default {}'

    // Provide getCombinedSourcemap with sourcesContent (so originalCode is set)
    // but mappings that don't include a source index — originalPositionFor returns null source
    const traceContext = {
      getCombinedSourcemap: () => ({
        version: 3,
        sources: ['middle.js'],
        sourcesContent: [originalCode],
        // "AACA" includes source index 0 — to get null source we need segments without source info
        // An empty VLQ segment with only 1 field (generated column) has no source mapping
        // VLQ "A" = [0] — only generated column, no source info
        mappings: 'A',
        names: [],
      }),
    }

    await (tracePlugin as any).transform.call(traceContext, 'import secret from "secret";\nexport default {};', 'middle.js')
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Code:')
    // originalPositionFor returns null line → falls back to transformed code (line 1)
    expect(errors[0]).toMatch(/> 1 \|/)
  })

  it('falls back gracefully when getCombinedSourcemap throws', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    const traceContext = {
      getCombinedSourcemap: () => { throw new Error('no source map available') },
    }

    await (tracePlugin as any).transform.call(traceContext, 'import secret from "secret";\nexport default {};', 'middle.js')
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Code:')
    // Falls back to transformed code positions
    expect(errors[0]).toContain('import secret from "secret"')
  })

  it('falls back to transformed code when originalCode is not set and sourceContentFor returns null', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    // Source map has mappings but empty sourcesContent — originalCode won't be set,
    // and sourceContentFor will return null
    const traceContext = {
      getCombinedSourcemap: () => ({
        version: 3,
        sources: ['middle.js'],
        sourcesContent: [],
        mappings: 'AACA;AACA',
        names: [],
      }),
    }

    await (tracePlugin as any).transform.call(traceContext, 'import secret from "secret";\nexport default {};', 'middle.js')
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Code:')
    // Falls back to transformed code since both sourceContentFor and originalCode are unavailable
    // The mapped position (line 2) is still used
    expect(errors[0]).toMatch(/> 2 \|/)
    expect(errors[0]).toContain('export default {}')
  })

  it('handles getCombinedSourcemap returning map without mappings', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    const traceContext = {
      getCombinedSourcemap: () => ({
        version: 3,
        sources: [],
        // No mappings field — sourceMap should not be stored
      }),
    }

    await (tracePlugin as any).transform.call(traceContext, 'import secret from "secret";\nexport default {};', 'middle.js')
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Code:')
    // Falls back to transformed code
    expect(errors[0]).toContain('import secret from "secret"')
  })
})

describe('trace mode (deferred violations)', () => {
  it('defers and flushes violations when importer is not yet transformed', async () => {
    // Simulate dev-mode: resolveId fires before the importer's transform
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    // Mark entry
    await (impoundPlugin as any).resolveId.call(context, 'middle.js', undefined, { isEntry: true })
    await (tracePlugin as any).resolveId.call(context, 'middle.js', undefined, { isEntry: true })

    // resolveId BEFORE transform — violation is deferred
    const result = await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')
    expect(result).toBe('\0impound:proxy')
    expect(errors).toHaveLength(0)

    // Transform flushes the deferred violation with enriched snippet
    const multiLineCode = 'const x = 1\nimport secret from "secret"\nexport default secret'
    await (tracePlugin as any).transform(multiLineCode, 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Not allowed')
    expect(errors[0]).toContain('Code:')
    expect(errors[0]).toContain('import secret from "secret"')
    expect(errors[0]).toContain('^')
  })

  it('reports immediately when importer is already in module graph', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = {
      error: (msg: string) => errors.push(msg),
    }

    // Transform first — populates module graph
    await (tracePlugin as any).transform('import secret from "secret";export default secret', 'middle.js')

    // resolveId finds importer in module graph — reports immediately with snippet
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Not allowed')
    expect(errors[0]).toContain('Code:')
  })

  it('flushes deferred violations with absolute path when resolveId uses relative', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, cwd: '/root', patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = {
      error: (msg: string) => errors.push(msg),
    }

    // resolveId with relative importer — deferred under key 'middle.js'
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')
    expect(errors).toHaveLength(0)

    // transform with absolute path — candidate keys include relative form, so flush works
    await (tracePlugin as any).transform('import secret from "secret";export default secret', '/root/middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Not allowed')
    expect(errors[0]).toContain('Code:')
  })

  it('flushes deferred violations when transform id has query string', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = {
      error: (msg: string) => errors.push(msg),
    }

    // resolveId with bare importer — deferred under key 'app.vue'
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'app.vue')
    expect(errors).toHaveLength(0)

    // transform with query-string suffixed id (like Vue SFC script block)
    // candidate keys include bare id stripped of query, matching 'app.vue'
    await (tracePlugin as any).transform('import secret from "secret";export default secret', 'app.vue?vue&type=script')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Not allowed')
  })

  it('resolves PROXY_ID in trace mode', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const context = { error: () => {} }

    const result = await (impoundPlugin as any).resolveId.call(context, '\0impound:proxy', 'middle.js')
    expect(result).toBe('\0impound:proxy')
  })

  it('skips filtered importers in trace mode', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, include: [/^app\./], patterns: [['secret']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const context = { error: () => {} }

    // 'other.js' doesn't match include filter — should return undefined (no match)
    const result = await (impoundPlugin as any).resolveId.call(context, 'secret', 'other.js')
    expect(result).toBeUndefined()
  })

  it('handles deep import chains exceeding maxTraceDepth', async () => {
    const files: Record<string, string> = {
      'entry.js': 'import a from "a.js";console.log(a)',
      'a.js': 'import b from "b.js";export default b',
      'b.js': 'import c from "c.js";export default c',
      'c.js': 'import secret from "secret";export default secret',
    }
    const libs = ['secret']

    const result = await buildWithTrace(files, libs, {
      trace: true,
      maxTraceDepth: 1,
      patterns: [['secret']],
    }) as RollupError

    // Violation is still reported, but trace may be incomplete due to depth limit
    expect(result.message).toContain('secret')
  })

  it('accumulates multiple deferred violations for the same importer', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret'], ['other']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    // Two violations from the same importer — both deferred
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')
    await (impoundPlugin as any).resolveId.call(context, 'other', 'middle.js')
    expect(errors).toHaveLength(0)

    // Transform flushes both
    await (tracePlugin as any).transform('import secret from "secret";import other from "other";export default secret', 'middle.js')
    expect(errors).toHaveLength(2)
  })

  it('deferred violations with warn: always report all occurrences', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret'], [/^secret$/]], error: false, warn: 'always' })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const context = { error: () => {} }

    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')
    await (tracePlugin as any).transform('import secret from "secret";export default secret', 'middle.js')

    // Both patterns match and warn: always means no dedup
    expect(errorSpy).toHaveBeenCalledTimes(2)
    errorSpy.mockRestore()
  })

  it('handles importer with no matching import location for rawId', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    // Transform with code that doesn't contain the import specifier 'secret'.
    // The module graph will have the importer but no import location for 'secret'.
    await (tracePlugin as any).transform('const x = 1;export default x', 'middle.js')

    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Not allowed')
    // No Code: section since the import location wasn't found
    expect(errors[0]).not.toContain('Code:')
  })

  it('builds trace through intermediate modules with line info', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    await (tracePlugin as any).resolveId('entry.js', undefined, { isEntry: true })

    // Build the graph: entry.js -> middle.js -> secret
    await (tracePlugin as any).transform('import middle from "middle.js"\nconsole.log(middle)', 'entry.js')
    await (impoundPlugin as any).resolveId.call(context, 'middle.js', 'entry.js')

    await (tracePlugin as any).transform('import secret from "secret"\nexport default secret', 'middle.js')
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Trace:')
    expect(errors[0]).toContain('entry.js')
    expect(errors[0]).toContain('middle.js')
    expect(errors[0]).toContain('Code:')
  })

  it('formats trace with cwd and absolute step.file paths', async () => {
    // Exercises formatTrace line 263: cwd && isAbsolute(step.file) => true
    // and line 264: step.line != null => false (entry has no graphEntry so no line info)
    const files: Record<string, string> = {
      '/root/entry.js': 'import middle from "/root/middle.js";console.log(middle)',
      '/root/middle.js': 'import secret from "secret";export default secret',
    }
    const libs = ['secret']

    const result = await buildWithTrace(files, libs, {
      trace: true,
      cwd: '/root',
      patterns: [['secret']],
    }) as RollupError

    expect(result.message).toContain('Trace:')
    // entry.js should appear relativized (absolute /root/entry.js -> entry.js)
    expect(result.message).toContain('entry.js')
    expect(result.message).toContain('Code:')
  })

  it('formats trace step without line info when graphEntry has no matching specifier', async () => {
    // Entry's graphEntry has an empty import map (no matching specifier for "middle.js"),
    // so the trace step for entry.js has no line/column info.
    // This exercises formatTrace line 271 false branch: step.line == null → empty loc string
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    await (tracePlugin as any).resolveId('entry.js', undefined, { isEntry: true })

    // Transform entry with no imports — graphEntry exists but has empty import map
    await (tracePlugin as any).transform('console.log("no imports")', 'entry.js')
    // Track entry.js -> middle.js in resolvedImports
    await (impoundPlugin as any).resolveId.call(context, 'middle.js', 'entry.js')

    await (tracePlugin as any).transform('import secret from "secret"\nexport default secret', 'middle.js')
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Trace:')
    // entry.js step has no line info — formatTrace produces "entry.js (entry)" without :line:col
    expect(errors[0]).toMatch(/entry\.js \(entry\)/)
    expect(errors[0]).not.toMatch(/entry\.js:\d/)
  })

  it('formats trace without cwd', async () => {
    // Exercises formatTrace line 263: cwd falsy => step.file used as-is
    const result = await processTrace({
      trace: true,
      // No cwd
      patterns: [['secret', 'Not allowed']],
    }) as RollupError

    expect(result.message).toContain('Trace:')
    expect(result.message).toContain('entry.js')
  })

  it('finds snippet via fallback when rawId differs from source specifier', async () => {
    // Simulates frameworks like Nuxt where alias resolution rewrites import specifiers
    // before resolveId sees them (e.g. ../server/api/test → ~~/server/api/test)
    const plugins = ImpoundPlugin.rollup({ trace: true, cwd: '/root', patterns: [[/server\/api/, 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    // Transform with source code using a relative specifier
    await (tracePlugin as any).transform('import api from "../server/api/test";\nconsole.log(api)', '/root/app/app.vue')

    // But resolveId receives an absolute pre-resolved path (as if a bundler alias resolved it)
    // rawId will be the absolute path, not the relative specifier from source
    await (impoundPlugin as any).resolveId.call(context, '/root/server/api/test', '/root/app/app.vue')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Not allowed')
    // Fallback search should find the snippet by resolving '../server/api/test' relative to importer
    expect(errors[0]).toContain('Code:')
    expect(errors[0]).toContain('import api from "../server/api/test"')
    expect(errors[0]).toContain('^')
  })

  it('handles fallback when no specifier matches the resolved id', async () => {
    // The fallback loop runs but no specifier matches — snippet remains undefined
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [[/secret/, 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    // Transform with an import that doesn't match the resolved id at all
    await (tracePlugin as any).transform('import foo from "unrelated-module";\nexport default foo', 'middle.js')
    // resolveId with a completely different id
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Not allowed')
    // No Code: since no specifier in the fallback matched
    expect(errors[0]).not.toContain('Code:')
  })

  it('finds snippet via fallback without cwd', async () => {
    // Exercises the fallback path where cwd is undefined
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [[/server\/api/, 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    await (tracePlugin as any).transform('import api from "~~/server/api/test";\nconsole.log(api)', 'app.vue')
    await (impoundPlugin as any).resolveId.call(context, 'server/api/test', 'app.vue')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Code:')
  })

  it('finds snippet via suffix match when specifier uses aliases', async () => {
    // When the source has an alias like ~~/server/api/test and the resolved id is server/api/test
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [[/server\/api/, 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    // Transform with aliased import
    await (tracePlugin as any).transform('import api from "~~/server/api/test";\nconsole.log(api)', 'app.vue')

    // resolveId receives the resolved form (without alias)
    await (impoundPlugin as any).resolveId.call(context, 'server/api/test', 'app.vue')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Code:')
    expect(errors[0]).toContain('~~/server/api/test')
  })

  it('handles dynamic imports with non-literal specifiers in transform', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    // Dynamic import with a variable — imp.n is undefined, exercises the !imp.n branch
    await (tracePlugin as any).transform('const x = "mod";const m = import(x);import secret from "secret"', 'test.js')
    // Should not throw — just skip the dynamic import entry
  })

  it('registers module in graph even when parsing fails (e.g. Vue SFC)', async () => {
    // When es-module-lexer can't parse a file (like a raw Vue SFC), the module should
    // still be registered in the graph so that resolveId can report violations immediately.
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    // Transform with unparseable SFC content — parse will fail
    await (tracePlugin as any).transform('<script setup>\nimport secret from "secret"\n</script>', 'app.vue')

    // resolveId should find the importer in the graph and report immediately
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'app.vue')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Not allowed')
    // No Code: section since parsing failed and import locations are empty
    expect(errors[0]).not.toContain('Code:')
  })

  it('tracks resolved imports across multiple resolveIds from same importer', async () => {
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']] })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const errors: string[] = []
    const context = { error: (msg: string) => errors.push(msg) }

    // First resolve a non-matching import from the same importer (populates resolvedImports)
    await (impoundPlugin as any).resolveId.call(context, 'safe-module', 'middle.js')
    // Then resolve a matching import
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')

    await (tracePlugin as any).transform('import safe from "safe-module";import secret from "secret";export default secret', 'middle.js')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Not allowed')
  })

  it('deferred violations with error: false log to console', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret']], error: false })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const context = { error: () => {} }

    await (impoundPlugin as any).resolveId.call(context, 'secret', 'middle.js')
    expect(errorSpy).not.toHaveBeenCalled()

    await (tracePlugin as any).transform('import secret from "secret";export default secret', 'middle.js')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0]![0]).toContain('Code:')

    errorSpy.mockRestore()
  })

  it('deduplicates deferred violations using shared warnedMessages set from matcher', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Use two patterns that produce the same message for the same import
    const plugins = ImpoundPlugin.rollup({ trace: true, patterns: [['secret', 'Not allowed']], error: false })
    const pluginArray = Array.isArray(plugins) ? plugins : [plugins]
    const impoundPlugin = pluginArray.find(p => p.name === 'impound')!
    const tracePlugin = pluginArray.find(p => p.name === 'impound:trace')!

    const context = { error: () => {} }

    // First: defer a violation, then flush via transform
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'a.js')
    await (tracePlugin as any).transform('import secret from "secret"', 'a.js')
    expect(errorSpy).toHaveBeenCalledTimes(1)

    // Second: same import from a different file triggers immediate path (a.js already in graph).
    // The warnedMessages set is shared with the matcher, so the *immediate* violation from b.js
    // is a different message (different importer) and should log.
    await (tracePlugin as any).transform('import secret from "secret"', 'b.js')
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'b.js')
    expect(errorSpy).toHaveBeenCalledTimes(2)

    // Third: re-resolve 'secret' from a.js — immediate path, same message as first.
    // Should be deduped because the deferred flush used the matcher's warnedMessages set.
    await (impoundPlugin as any).resolveId.call(context, 'secret', 'a.js')
    expect(errorSpy).toHaveBeenCalledTimes(2) // still 2, deduped

    errorSpy.mockRestore()
  })
})

async function buildWithTrace(files: Record<string, string>, libs: string[], opts: ImpoundOptions, extraPlugins: any[] = []) {
  try {
    const entries = Object.keys(files)
    const build = await rollup({
      input: entries[0],
      plugins: [
        // Extra plugins run first so their transforms (and source maps) are available
        // when impound:trace's transform calls getCombinedSourcemap().
        ...extraPlugins,
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

async function processTrace(opts: ImpoundOptions) {
  const files: Record<string, string> = {
    'entry.js': 'import middle from "middle.js";console.log(middle)',
    'middle.js': 'import secret from "secret";export default secret',
  }
  const libs = ['secret']
  return buildWithTrace(files, libs, opts)
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
