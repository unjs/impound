import type { Plugin, ViteDevServer } from 'vite'
import type { ImpoundOptions, ImpoundViolationInfo } from '../src'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'pathe'
import { createServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImpoundPlugin } from '../src'

// Record which modules reach the lexer: a dev server should only parse a violation's chain.
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

let server: ViteDevServer | undefined
let root: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = undefined
  }
})

async function devServer(files: Record<string, string>, options: Partial<ImpoundOptions> = {}, plugins: Plugin[] = []) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'impound-dev-')))
  for (const [file, code] of Object.entries(files)) {
    writeFileSync(join(root, file), code)
  }
  const violations: ImpoundViolationInfo[] = []
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      ...plugins,
      ImpoundPlugin.vite({
        cwd: root,
        trace: true,
        error: false,
        warn: 'always',
        patterns: [[/secret/, 'Server-only']],
        onViolation: (info) => {
          violations.push(info)
        },
        ...options,
      } as ImpoundOptions),
    ],
  })
  const env = server.environments.client
  const dir = root
  parsed.length = 0
  return {
    violations,
    /** Resolve an import as another plugin or the dependency scanner would, outside a transform. */
    resolve: (specifier: string, importer: string) => env.pluginContainer.resolveId(specifier, join(dir, importer)),
    /** Request modules in the order a browser would. */
    load: async (...urls: string[]) => {
      for (const url of urls) {
        await env.transformRequest(url)
      }
    },
    /** Rewrite a file and invalidate it, as the watcher would. */
    edit: (file: string, code: string) => {
      writeFileSync(join(dir, file), code)
      for (const mod of env.moduleGraph.getModulesByFile(join(dir, file)) || []) {
        env.moduleGraph.invalidateModule(mod)
      }
    },
  }
}

// Steps carry the ids Vite gave the modules, which are absolute.
const chain = (info: ImpoundViolationInfo | undefined) => info?.trace?.map(step => relative(root!, step.file))

describe('trace mode on a vite dev server', () => {
  it('reports the chain from the requested entry', async () => {
    const { violations, load } = await devServer({
      'e.js': 'import \'./a.js\'\n',
      'a.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\nexport const b = 1\n',
      'secret.js': 'export const s = 1\n',
    })
    await load('/e.js', '/a.js', '/b.js')

    expect(violations).toHaveLength(1)
    expect(chain(violations[0])).toEqual(['e.js', 'a.js', 'b.js'])
    expect(violations[0]!.message).toContain('1. e.js:1:8 (entry) (import "./a.js")')
    expect(violations[0]!.snippet?.text).toContain('> 1 | import \'./secret.js\'')
  })

  it('walks through modules outside include', async () => {
    const { violations, load } = await devServer({
      'e.js': 'import \'./a.js\'\n',
      'a.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\n',
      'secret.js': 'export const s = 1\n',
    }, { include: [/b\.js$/] })
    await load('/e.js', '/a.js', '/b.js')

    expect(chain(violations[0])).toEqual(['e.js', 'a.js', 'b.js'])
    expect(violations[0]!.snippet?.text).toContain('> 1 | import \'./secret.js\'')
  })

  it('follows the chain after an import moves between modules', async () => {
    const { violations, load, edit } = await devServer({
      'e.js': 'import \'./a.js\'\nimport \'./b.js\'\n',
      'a.js': 'export const a = 1\n',
      'b.js': 'import \'./secret.js\'\nexport const b = 1\n',
      'secret.js': 'export const s = 1\n',
    })
    await load('/e.js', '/a.js', '/b.js')
    expect(chain(violations[0])).toEqual(['e.js', 'b.js'])

    edit('e.js', 'import \'./a.js\'\n')
    edit('a.js', 'import \'./b.js\'\nexport const a = 1\n')
    await load('/e.js', '/a.js')
    edit('b.js', 'import \'./secret.js\'\nexport const b = 2\n')
    await load('/b.js')

    expect(chain(violations.at(-1))).toEqual(['e.js', 'a.js', 'b.js'])
  })

  it('maps the snippet back to the original source', async () => {
    const banner: Plugin = {
      name: 'banner',
      enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/b.js')) {
          return
        }
        // Two lines prepended, so line 1 of the original is line 3 of the output.
        return {
          code: `// banner\n// banner\n${code}`,
          map: { version: 3, sources: [id], sourcesContent: [code], names: [], mappings: ';;AAAA,OAAO;AACP' },
        }
      },
    }
    const { violations, load } = await devServer({
      'e.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\nexport const b = 1\n',
      'secret.js': 'export const s = 1\n',
    }, {}, [banner])
    await load('/e.js', '/b.js')

    expect(violations[0]!.snippet).toMatchObject({ line: 1, column: 7 })
    expect(violations[0]!.snippet?.text).toContain('> 1 | import \'./secret.js\'')
    expect(violations[0]!.snippet?.text).not.toContain('banner')
  })

  it('fails the request with the chain when error is enabled', async () => {
    const { load } = await devServer({
      'e.js': 'import \'./a.js\'\n',
      'a.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\n',
      'secret.js': 'export const s = 1\n',
    }, { error: true, onViolation: undefined })
    await load('/e.js', '/a.js')

    const error = await load('/b.js').then(() => undefined, (e: Error) => e)
    expect(error?.message).toContain('Server-only [importing `secret.js` from `b.js`]')
    expect(error?.message).toContain('1. e.js')
    expect(error?.message).toContain('3. b.js')
  })

  it('lexes only the chain of a violation', async () => {
    const { violations, load } = await devServer({
      'e.js': 'import \'./a.js\'\nimport \'./c.js\'\n',
      'a.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\n',
      'c.js': 'export const c = 1\n',
      'secret.js': 'export const s = 1\n',
    })
    await load('/e.js', '/c.js')
    expect(parsed).toEqual([])

    await load('/a.js', '/b.js')
    expect(violations).toHaveLength(1)
    expect(parsed.map(id => relative(root!, id)).sort()).toEqual(['a.js', 'b.js', 'e.js'])
  })

  it('holds a violation resolved before its importer is transformed', async () => {
    const { violations, load, resolve } = await devServer({
      'e.js': 'import \'./a.js\'\n',
      'a.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\n',
      'secret.js': 'export const s = 1\n',
    })
    await load('/e.js', '/a.js')
    await resolve('./secret.js', 'b.js')
    expect(violations).toHaveLength(0)

    await load('/b.js')
    expect(chain(violations[0])).toEqual(['e.js', 'a.js', 'b.js'])
    expect(violations[0]!.snippet?.text).toContain('> 1 | import \'./secret.js\'')
  })

  it('reports the chain without a snippet when a later plugin adds the import', async () => {
    const inject: Plugin = {
      name: 'inject',
      enforce: 'post',
      transform(code, id) {
        return id.endsWith('/b.js') ? `import './secret.js'\n${code}` : undefined
      },
    }
    const { violations, load } = await devServer({
      'e.js': 'import \'./b.js\'\n',
      'b.js': 'export const b = 1\n',
      'secret.js': 'export const s = 1\n',
    }, {}, [inject])
    await load('/e.js', '/b.js')

    expect(chain(violations[0])).toEqual(['e.js', 'b.js'])
    expect(violations[0]!.snippet).toBeUndefined()
  })
})
