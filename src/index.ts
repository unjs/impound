import { createUnplugin } from 'unplugin'
import { resolvePath } from 'mlly'
import { isAbsolute, join, relative } from 'pathe'
import { createFilter } from '@rollup/pluginutils'

export interface CustodioOptions {
  /** An array of patterns of importers to apply the import protection rules to. */
  include?: Array<string | RegExp>
  /** An array of patterns of importers where the import protection rules explicitly do not apply. */
  exclude?: Array<string | RegExp>

  cwd?: string

  /** An array of patterns to prevent being imported, along with an optional warning to display.  */
  patterns: [importPattern: string | RegExp, warning?: string][]
}

const RELATIVE_IMPORT_RE = /^\.\.?\//

export const CustodioPlugin = createUnplugin((options: CustodioOptions) => {
  const filter = createFilter(options.include, options.exclude)
  const proxy = resolvePath('unenv/runtime/mock/proxy', { url: import.meta.url })

  return {
    name: 'custodio',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!importer || !filter(importer)) {
        return
      }

      if (RELATIVE_IMPORT_RE.test(id)) {
        id = join(importer, '..', id)
      }

      if (isAbsolute(id) && options.cwd) {
        id = relative(options.cwd, id)
      }

      let matched = false
      for (const [pattern, warning] of options.patterns) {
        const usesImport = pattern instanceof RegExp ? pattern.test(id) : pattern === id
        if (usesImport) {
          const relativeImporter = isAbsolute(importer) && options.cwd ? relative(options.cwd, importer) : importer
          this.error(`${warning || 'Invalid import'} [importing \`${id}\` from \`${relativeImporter}\`]`)
          matched = true
        }
      }

      return matched ? proxy : null
    },
  }
})
