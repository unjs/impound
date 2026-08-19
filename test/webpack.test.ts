import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import webpack from 'webpack'
import { ImpoundPlugin } from '../src'

/** Build a throwaway project with webpack and return whatever impound reported. */
async function buildWithWebpack(files: Record<string, string>, trace?: boolean | 'lazy') {
  const dir = mkdtempSync(join(tmpdir(), 'impound-webpack-'))
  try {
    for (const [name, code] of Object.entries(files)) {
      writeFileSync(join(dir, name), code)
    }
    const stats = await new Promise<webpack.Stats | undefined>((resolve, reject) => {
      webpack({
        context: dir,
        mode: 'development',
        devtool: false,
        entry: join(dir, 'entry.js'),
        output: { path: join(dir, 'dist') },
        plugins: [ImpoundPlugin.webpack({
          cwd: dir,
          trace,
          patterns: [[/\.server$/, 'Server-only import', ['Use a server function instead']]],
        })],
      }, (err, stats) => err ? reject(err) : resolve(stats))
    })
    return stats?.compilation.errors.map(error => error.message).join('\n\n') ?? ''
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const files = {
  'entry.js': 'import { loadAuth } from "./session.js"\nconsole.log(loadAuth())',
  'session.js': 'import { getUsers } from "./queries.server"\n\nexport function loadAuth () {\n  return getUsers()\n}',
  'queries.server.js': 'export const getUsers = () => []',
}

describe('webpack', () => {
  it('reports a denied import', async () => {
    const message = await buildWithWebpack(files)
    expect(message).toContain('Server-only import')
    expect(message).toContain('Use a server function instead')
  })

  it('reports the import chain and a code frame with eager tracing', async () => {
    const message = await buildWithWebpack(files, true)
    expect(message).toContain('Trace:')
    expect(message).toContain('Code:')
  })

  it('reports the import chain and a code frame with lazy tracing', async () => {
    const message = await buildWithWebpack(files, 'lazy')
    expect(message).toContain('Server-only import')
    expect(message).toContain('Trace:')
    expect(message).toContain('Code:')
  })

  it('still reports when the denied import sits in a module webpack cannot map', async () => {
    // A violation reached through a dynamic import: the chain walk asks about ids the
    // module index does not hold, and must fall through rather than throw.
    const message = await buildWithWebpack({
      'entry.js': 'export const loaded = import("./session.js")',
      'session.js': 'import { getUsers } from "./queries.server"\nexport const getAuth = getUsers',
      'queries.server.js': 'export const getUsers = () => []',
    }, 'lazy')
    expect(message).toContain('Server-only import')
  })

  it('reports the same violation, chain and suggestions either way', async () => {
    const [eager, lazy] = await Promise.all([
      buildWithWebpack(files, true),
      buildWithWebpack(files, 'lazy'),
    ])
    for (const message of [eager, lazy]) {
      expect(message).toContain('Server-only import [importing `queries.server` from `session.js`]')
      // same chain, entry through to the file that holds the denied import
      expect(message).toContain('1. entry.js')
      expect(message).toContain('2. session.js')
      expect(message).toContain('import { getUsers } from "./queries.server"')
      expect(message).toContain('Use a server function instead')
    }
    // lazy also knows where in the entry the import sits, which eager does not record
    expect(lazy).toContain('(import "./session.js")')
    expect(eager).not.toContain('(import "./session.js")')
  })
})
