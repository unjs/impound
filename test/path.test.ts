import { relative } from 'pathe'
import { describe, expect, it } from 'vitest'
import { relativeToCwd } from '../src/path'

describe('relativeToCwd', () => {
  const cwds = ['/root', '/root/', '/', 'C:/proj', 'C:\\proj', 'c:/proj', '/root/./sub/..', 'rel/dir']
  const paths = [
    '/root/a.js',
    '/root/src/deep/a.vue?vue&type=style&index=0.css',
    '/root/src/a.js?url=/../x',
    '/root',
    '/root/',
    '/rootless/a.js',
    '/root//a.js',
    '/root/./a.js',
    '/root/src/../a.js',
    '/root/src/..',
    '/root/src/.',
    '/root/src/',
    '/root/.hidden/a.js',
    '/root/..foo/a.js',
    '/root/a\\b.js',
    '/other/a.js',
    'C:/proj/src/a.js',
    'c:/proj/src/a.js',
    'C:\\proj\\src\\a.js',
    'D:/proj/a.js',
    '/',
  ]

  for (const cwd of cwds) {
    it(`matches pathe for cwd ${JSON.stringify(cwd)}`, () => {
      for (const p of paths) {
        expect(relativeToCwd(cwd, p), p).toBe(relative(cwd, p))
      }
    })
  }
})
