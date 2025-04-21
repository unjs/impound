import { resolveModulePath } from 'exsolve'
import { isAbsolute, join, relative } from 'pathe'
import { createUnplugin } from 'unplugin'
import { createFilter } from 'unplugin-utils'

export interface ImpoundMatcherOptions {
  /** An array of patterns of importers to apply the import protection rules to. */
  include?: Array<string | RegExp>
  /** An array of patterns of importers where the import protection rules explicitly do not apply. */
  exclude?: Array<string | RegExp>
  /** Whether to throw an error or not. if set to `false`, an error will be logged to console instead. */
  error?: boolean
  /** An array of patterns to prevent being imported, along with an optional warning to display.  */
  patterns: [importPattern: string | RegExp | ((id: string) => boolean | string), warning?: string][]
}

export interface ImpoundSharedOptions {
  cwd?: string
}

export type ImpoundOptions = (ImpoundSharedOptions & ImpoundMatcherOptions) | (ImpoundSharedOptions & { matchers: ImpoundMatcherOptions[] })

const RELATIVE_IMPORT_RE = /^\.\.?\//

export const ImpoundPlugin = createUnplugin((globalOptions: ImpoundOptions) => {
  const matchers = 'matchers' in globalOptions ? globalOptions.matchers : [globalOptions]

  return matchers.map((options) => {
    const filter = createFilter(options.include, options.exclude, { resolve: globalOptions.cwd })
    const proxy = resolveModulePath('mocked-exports/proxy', { from: import.meta.url })

    return {
      name: 'impound',
      enforce: 'pre',
      resolveId(id, importer) {
        if (!importer || !filter(importer)) {
          return
        }

        if (RELATIVE_IMPORT_RE.test(id)) {
          id = join(importer, '..', id)
        }

        if (isAbsolute(id) && globalOptions.cwd) {
          id = relative(globalOptions.cwd, id)
        }

        let matched = false

        const logError = options.error === false ? console.error : this.error.bind(this)
        for (const [pattern, warning] of options.patterns) {
          const usesImport = pattern instanceof RegExp
            ? pattern.test(id)
            : typeof pattern === 'string'
              ? pattern === id
              : pattern(id)

          if (usesImport) {
            const relativeImporter = isAbsolute(importer) && globalOptions.cwd ? relative(globalOptions.cwd, importer) : importer
            logError(`${typeof usesImport === 'string' ? usesImport : (warning || 'Invalid import')} [importing \`${id}\` from \`${relativeImporter}\`]`)
            matched = true
          }
        }

        return matched ? proxy : null
      },
    }
  })
})
