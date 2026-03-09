import type { SourceMap } from 'rollup'
import type { UnpluginBuildContext, UnpluginContext, UnpluginOptions } from 'unplugin'
import { originalPositionFor, sourceContentFor, TraceMap } from '@jridgewell/trace-mapping'
import { init, parse } from 'es-module-lexer'
import { isAbsolute, join, relative } from 'pathe'
import { createUnplugin } from 'unplugin'
import { createFilter } from 'unplugin-utils'

const PROXY_ID = '\0impound:proxy'

// based on https://github.com/unjs/mocked-exports
const PROXY_CODE = `
function createMock(name, overrides = {}) {
  const proxyFn = function () {};
  proxyFn.prototype.name = name;
  const props = {};
  const proxy = new Proxy(proxyFn, {
    get(_target, prop) {
      if (prop === "caller") return null;
      if (prop === "__createMock__") return createMock;
      if (prop === "__mock__") return true;
      if (prop in overrides) return overrides[prop];
      if (prop === "then") return (fn) => Promise.resolve(fn());
      if (prop === "catch") return (_fn) => Promise.resolve();
      if (prop === "finally") return (fn) => Promise.resolve(fn());
      return (props[prop] = props[prop] || createMock(\`\${name}.\${prop.toString()}\`));
    },
    apply(_target, _this, _args) { return createMock(\`\${name}()\`); },
    construct(_target, _args, _newT) { return createMock(\`[\${name}]\`); },
    enumerate() { return []; },
  });
  return proxy;
}
export default createMock("mock");
`.trim()

export interface ImpoundTraceStep {
  /** The file path in this step of the import chain. */
  file: string
  /** The import specifier used (if not entry). */
  import?: string
  /** Line number of the import statement (1-indexed, if available). */
  line?: number
  /** Column number of the import statement (0-indexed, if available). */
  column?: number
}

export interface ImpoundSnippet {
  /** Formatted code snippet with line numbers, `>` marker, and `^` caret. */
  text: string
  /** The line number of the offending import (1-indexed). */
  line: number
  /** The column number of the offending import (0-indexed). */
  column: number
}

export interface ImpoundViolationInfo {
  /** The resolved import specifier that was denied. */
  id: string
  /** The file that contains the denied import. */
  importer: string
  /** The formatted error message. */
  message: string
  /** Import chain from entry to violation (when trace is enabled). */
  trace?: ImpoundTraceStep[]
  /** Source code snippet around the offending import (when trace is enabled). */
  snippet?: ImpoundSnippet
}

export interface ImpoundMatcherOptions {
  /** An array of patterns of importers to apply the import protection rules to. */
  include?: Array<string | RegExp>
  /** An array of patterns of importers where the import protection rules explicitly do not apply. */
  exclude?: Array<string | RegExp>
  /** Whether to throw an error or not. if set to `false`, an error will be logged to console instead. */
  error?: boolean
  /**
   * Controls whether duplicate warnings are logged when `error` is `false`.
   * - `'once'` (default): each unique violation is logged only once.
   * - `'always'`: every violation is logged, even if repeated.
   *
   * This has no effect when `error` is `true` (the default), since the build fails on the first violation.
   */
  warn?: 'once' | 'always'
  /**
   * Callback invoked on every violation. Receives the violation details.
   * Return `false` to allow the import and suppress the default error/warning.
   */
  onViolation?: (info: ImpoundViolationInfo) => boolean | void
  /**
   * An array of patterns matching resolved import targets that should be excluded from pattern checks.
   * Useful for skipping false positives from third-party packages, e.g. node_modules.
   */
  excludeFiles?: Array<string | RegExp>
  /** An array of patterns to prevent being imported, along with an optional warning and suggestions to display.  */
  patterns: [importPattern: string | RegExp | ((id: string, importer: string) => boolean | string), warning?: string, suggestions?: string[]][]
}

export interface ImpoundSharedOptions {
  cwd?: string
  /**
   * Enable import tracing and code snippets in violation reports.
   * Violations are reported eagerly with best-effort trace enrichment
   * from the module graph collected so far.
   */
  trace?: boolean
  /**
   * Maximum depth for import traces. Only used when `trace` is `true`.
   * @default 20
   */
  maxTraceDepth?: number
}

export type ImpoundOptions = (ImpoundSharedOptions & ImpoundMatcherOptions) | (ImpoundSharedOptions & { matchers: ImpoundMatcherOptions[] })

const RELATIVE_IMPORT_RE = /^\.\.?\//

interface ImportLocation {
  line: number
  column: number
  statementStart: number
  statementEnd: number
}

interface ModuleGraphEntry {
  code: string
  originalCode?: string
  sourceMap?: unknown
  imports: Map<string, ImportLocation>
}

interface PendingViolation {
  id: string
  rawId: string
  importer: string
  relativeImporter: string
  message: string
  suggestions?: string[]
  options: ImpoundMatcherOptions
  errorFn: (msg: string) => void
  warnedMessages: Set<string> | undefined
}

/** Convert a byte offset in source code to a 1-indexed line and 0-indexed column. */
function offsetToLineColumn(code: string, offset: number): { line: number, column: number } {
  let line = 1
  let lastNewline = -1
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === '\n') {
      line++
      lastNewline = i
    }
  }
  return { line, column: offset - lastNewline - 1 }
}

/** Generate a code snippet with context lines, a `>` marker, and a `^` caret. */
function generateSnippet(code: string, line: number, column: number, context = 2): string {
  const lines = code.split('\n')
  const start = Math.max(0, line - 1 - context)
  const end = Math.min(lines.length, line + context)
  const gutterWidth = String(end).length

  const result: string[] = []
  for (let i = start; i < end; i++) {
    const lineNum = i + 1
    const gutter = String(lineNum).padStart(gutterWidth)
    const marker = lineNum === line ? '>' : ' '
    result.push(`${marker} ${gutter} | ${lines[i]}`)
    if (lineNum === line) {
      result.push(`  ${' '.repeat(gutterWidth)} | ${' '.repeat(column)}^`)
    }
  }
  return result.join('\n')
}

/** Build an import trace from entry to the importer via BFS backwards through the graph. */
function buildTrace(
  importer: string,
  moduleGraph: Map<string, ModuleGraphEntry>,
  resolvedImports: Map<string, Map<string, string>>,
  entries: Set<string>,
  maxDepth: number,
  cwd?: string,
): ImpoundTraceStep[] {
  // Helper to normalize a path to its cwd-relative form for comparisons
  const normalize = (p: string) => isAbsolute(p) && cwd ? relative(cwd, p) : p

  // BFS backwards from importer to find an entry point
  const visited = new Set<string>()
  // Each item in the queue: [currentModule, pathSoFar]
  const queue: [string, string[]][] = [[importer, [importer]]]
  visited.add(importer)

  const isEntry = (id: string) => entries.has(id) || entries.has(normalize(id))

  let bestPath: string[] = [importer]

  while (queue.length > 0) {
    const [current, path] = queue.shift()!
    if (path.length > maxDepth)
      continue

    if (isEntry(current)) {
      bestPath = path
      break
    }

    // Find importers of `current`
    const normalizedCurrent = normalize(current)
    for (const [moduleId] of moduleGraph) {
      if (visited.has(moduleId))
        continue
      // Check if moduleId imports `current` (by resolved id)
      const resolvedForModule = resolvedImports.get(moduleId)
      if (resolvedForModule) {
        for (const [, resolvedId] of resolvedForModule) {
          if (resolvedId === current || resolvedId === normalizedCurrent) {
            visited.add(moduleId)
            const newPath = [...path, moduleId]
            if (isEntry(moduleId)) {
              bestPath = newPath
              queue.length = 0 // break outer loop
              break
            }
            queue.push([moduleId, newPath])
            break
          }
        }
      }
    }
  }

  // Reverse so it goes entry -> ... -> importer
  bestPath.reverse()

  // Build trace steps with import location info
  const trace: ImpoundTraceStep[] = []
  for (let i = 0; i < bestPath.length; i++) {
    const file = bestPath[i]!
    const step: ImpoundTraceStep = { file }

    if (i === 0 && entries.has(file)) {
      // Mark entry
    }

    if (i < bestPath.length - 1) {
      // Find what specifier this file uses to import the next file
      const nextFile = bestPath[i + 1]!
      /* v8 ignore start -- BFS only builds paths through nodes with resolvedImports, so this is always defined */
      const resolvedForFile = resolvedImports.get(file)
      if (!resolvedForFile)
        continue
      /* v8 ignore stop */
      for (const [specifier, resolvedId] of resolvedForFile) {
        if (resolvedId === nextFile) {
          step.import = specifier
          const loc = moduleGraph.get(file)?.imports.get(specifier)
          if (loc) {
            step.line = loc.line
            step.column = loc.column
          }
          break
        }
      }
    }

    trace.push(step)
  }

  return trace
}

function formatTrace(trace: ImpoundTraceStep[], cwd?: string): string {
  return trace.map((step, i) => {
    const file = cwd && isAbsolute(step.file) ? relative(cwd, step.file) : step.file
    const loc = step.line != null ? `:${step.line}:${step.column}` : ''
    const entry = i === 0 ? ' (entry)' : ''
    const imp = step.import ? ` (import "${step.import}")` : ''
    return `  ${i + 1}. ${file}${loc}${entry}${imp}`
  }).join('\n')
}

function enrichAndReport(
  violation: PendingViolation,
  moduleGraph: Map<string, ModuleGraphEntry>,
  resolvedImports: Map<string, Map<string, string>>,
  entries: Set<string>,
  maxTraceDepth: number,
  cwd: string | undefined,
  warnedMessages: Set<string> | undefined,
): void {
  const { id, rawId, importer, relativeImporter, options, suggestions, errorFn } = violation

  // Build trace
  const trace = buildTrace(importer, moduleGraph, resolvedImports, entries, maxTraceDepth, cwd)

  // Build snippet from the module graph (entries are stored under normalized key forms in transform)
  let snippet: ImpoundSnippet | undefined
  /* v8 ignore start -- always defined: enrichAndReport is only called when the importer is in the module graph */
  const importerEntry = moduleGraph.get(importer)
  if (importerEntry) {
  /* v8 ignore stop */
    // Try exact rawId first, then fall back to searching for a matching specifier.
    // rawId may differ from the source specifier when bundlers pre-resolve imports.
    let loc = importerEntry.imports.get(rawId)
    if (!loc) {
      const importerBase = importer.split('?')[0]!
      for (const [specifier, specLoc] of importerEntry.imports) {
        const resolved = RELATIVE_IMPORT_RE.test(specifier) ? join(importerBase, '..', specifier) : specifier
        let normalizedResolved = resolved
        if (cwd && isAbsolute(resolved)) {
          normalizedResolved = relative(cwd, resolved)
        }
        if (normalizedResolved === id || resolved === rawId || specifier.endsWith(id)) {
          loc = specLoc
          break
        }
      }
    }
    if (loc) {
      let snippetCode = importerEntry.code
      let snippetLine = loc.line
      let snippetColumn = loc.column

      // If a source map is available, reverse-map to original source positions
      if (importerEntry.sourceMap) {
        try {
          const tracer = new TraceMap(importerEntry.sourceMap as ConstructorParameters<typeof TraceMap>[0])
          const original = originalPositionFor(tracer, { line: loc.line, column: loc.column })
          if (original.line != null) {
            snippetLine = original.line
            /* v8 ignore start -- originalPositionFor always returns column and source when line is non-null */
            snippetColumn = original.column ?? 0
            // Prefer original source content from the source map
            const originalSource = original.source != null ? sourceContentFor(tracer, original.source) : null
            /* v8 ignore stop */
            if (originalSource != null) {
              snippetCode = originalSource
            }
            else if (importerEntry.originalCode) {
              snippetCode = importerEntry.originalCode
            }
          }
        }
        catch {
          // Fall back to transformed code positions
        }
      }

      snippet = { text: generateSnippet(snippetCode, snippetLine, snippetColumn), line: snippetLine, column: snippetColumn }
    }
  }

  let message = violation.message
  if (trace.length > 1) {
    message += `\n\nTrace:\n${formatTrace(trace, cwd)}`
  }
  if (snippet) {
    message += `\n\nCode:\n${snippet.text}`
  }
  if (suggestions?.length) {
    message += `\n\nSuggestions:\n${suggestions.map(s => `  - ${s}`).join('\n')}`
  }

  const violationInfo: ImpoundViolationInfo = {
    id,
    importer: relativeImporter,
    message,
    trace: trace.length > 1 ? trace : undefined,
    snippet,
  }

  if (options.onViolation?.(violationInfo) === false) {
    return
  }
  if (!warnedMessages || !warnedMessages.has(message)) {
    warnedMessages?.add(message)
    errorFn(message)
  }
}

export const ImpoundPlugin = createUnplugin<ImpoundOptions>((globalOptions) => {
  const matchers = 'matchers' in globalOptions ? globalOptions.matchers : [globalOptions]
  const traceEnabled = globalOptions.trace === true
  const maxTraceDepth = globalOptions.maxTraceDepth ?? 20

  // Shared state for trace mode
  const moduleGraph = new Map<string, ModuleGraphEntry>()
  // Maps moduleId -> Map<rawSpecifier, resolvedAbsoluteId>
  const resolvedImports = new Map<string, Map<string, string>>()
  const entries = new Set<string>()
  // Violations waiting for the importer's transform to complete
  const pendingViolations = new Map<string, PendingViolation[]>()

  const plugins: UnpluginOptions[] = matchers.map((options) => {
    const filter = createFilter(options.include, options.exclude, { resolve: globalOptions.cwd })
    const excludeFilter = options.excludeFiles?.length
      ? createFilter(options.excludeFiles, undefined, { resolve: globalOptions.cwd })
      : undefined
    const warnedMessages = options.warn !== 'always' ? new Set<string>() : undefined

    return {
      name: 'impound',
      enforce: 'pre' as const,
      load(id: string) {
        if (id === PROXY_ID) {
          return PROXY_CODE
        }
      },
      resolveId(this: UnpluginBuildContext & UnpluginContext, id: string, importer: string | undefined, resolveOptions?: { isEntry?: boolean }) {
        if (id === PROXY_ID) {
          return id
        }
        if (!importer) {
          // This is an entry point resolution
          if (traceEnabled && resolveOptions?.isEntry) {
            entries.add(id)
          }
          return
        }

        if (!filter(importer)) {
          return
        }

        const rawId = id

        if (RELATIVE_IMPORT_RE.test(id)) {
          id = join(importer, '..', id)
        }

        // Skip resolved targets matching excludeFiles
        if (excludeFilter?.(id)) {
          return
        }

        if (isAbsolute(id) && globalOptions.cwd) {
          id = relative(globalOptions.cwd, id)
        }

        // Track resolved imports for trace mode
        if (traceEnabled) {
          let importerResolved = resolvedImports.get(importer)
          if (!importerResolved) {
            importerResolved = new Map()
            resolvedImports.set(importer, importerResolved)
          }
          importerResolved.set(rawId, id)
        }

        let matched = false

        const relativeImporter = isAbsolute(importer) && globalOptions.cwd ? relative(globalOptions.cwd, importer) : importer
        for (const [pattern, warning, suggestions] of options.patterns) {
          const usesImport = pattern instanceof RegExp
            ? pattern.test(id)
            : typeof pattern === 'string'
              ? pattern === id
              : pattern(id, relativeImporter)

          if (usesImport) {
            const baseMessage = `${typeof usesImport === 'string' ? usesImport : (warning || 'Invalid import')} [importing \`${id}\` from \`${relativeImporter}\`]`

            if (traceEnabled) {
              const errorFn = options.error === false ? console.error : this.error.bind(this)
              const violation: PendingViolation = {
                id,
                rawId,
                importer,
                relativeImporter,
                message: baseMessage,
                suggestions,
                options,
                errorFn,
                warnedMessages,
              }

              if (moduleGraph.has(importer)) {
                // Importer already transformed — enrich and report immediately
                enrichAndReport(violation, moduleGraph, resolvedImports, entries, maxTraceDepth, globalOptions.cwd, warnedMessages)
              }
              else {
                // Importer not yet transformed (dev mode) — defer until after transform
                let pending = pendingViolations.get(importer)
                if (!pending) {
                  pending = []
                  pendingViolations.set(importer, pending)
                }
                pending.push(violation)
              }
            }
            else {
              let message = baseMessage
              if (suggestions?.length) {
                message += `\n\nSuggestions:\n${suggestions.map(s => `  - ${s}`).join('\n')}`
              }
              if (options.onViolation?.({ id, importer: relativeImporter, message }) === false) {
                continue
              }
              if (!warnedMessages || !warnedMessages.has(message)) {
                warnedMessages?.add(message)
                const logError = options.error === false ? console.error : this.error.bind(this)
                logError(message)
              }
            }
            matched = true
          }
        }

        return matched ? PROXY_ID : null
      },
    }
  })

  if (traceEnabled) {
    // shared transform logic for module graph building and flushing pending violations.
    async function traceTransform(code: string, id: string, getCombinedSourcemap?: () => unknown): Promise<void> {
      await init
      let importMap = new Map<string, ImportLocation>()
      let originalCode: string | undefined
      let sourceMap: unknown

      try {
        const [imports] = parse(code, id)
        for (const imp of imports) {
          if (imp.n) {
            const { line, column } = offsetToLineColumn(code, imp.s)
            importMap.set(imp.n, {
              line,
              column,
              statementStart: imp.ss,
              statementEnd: imp.se,
            })
          }
        }

        // extract the combined source map for original-source snippets.
        if (getCombinedSourcemap) {
          try {
            const map = getCombinedSourcemap() as { mappings?: string, sourcesContent?: (string | null)[] } | undefined
            if (map?.mappings) {
              sourceMap = map
              const sourcesContent = map.sourcesContent
              if (sourcesContent?.length && sourcesContent[0]) {
                originalCode = sourcesContent[0]
              }
            }
          }
          catch {
            // getCombinedSourcemap may throw — fall back to transformed code
          }
        }
      }
      catch {
        // If parsing fails (e.g. non-JS asset like a raw Vue SFC), use empty imports.
        // We still register the module in the graph so that resolveId can find
        // the importer and report violations immediately instead of deferring them.
        importMap = new Map()
      }

      const graphEntry: ModuleGraphEntry = { code, originalCode, sourceMap, imports: importMap }
      moduleGraph.set(id, graphEntry)
      // Also store under normalized key forms so enrichAndReport can find it
      // when the importer path format differs (e.g. with/without query string)
      /* v8 ignore start -- defensive normalization for framework-specific virtual module IDs */
      const bareId = id.split('?')[0]!
      if (bareId !== id)
        moduleGraph.set(bareId, graphEntry)
      if (isAbsolute(id) && globalOptions.cwd) {
        const relId = relative(globalOptions.cwd, id)
        moduleGraph.set(relId, graphEntry)
        const relBareId = relId.split('?')[0]!
        if (relBareId !== relId)
          moduleGraph.set(relBareId, graphEntry)
      }
      /* v8 ignore stop */

      // Flush any violations that were waiting for this module's transform.
      // Check multiple key forms since resolveId may use relative paths while
      // transform receives absolute paths (or vice versa with query strings).
      const relativeId = isAbsolute(id) && globalOptions.cwd ? relative(globalOptions.cwd, id) : id
      const candidateKeys = new Set([id, relativeId, id.split('?')[0]!, relativeId.split('?')[0]!])
      for (const key of candidateKeys) {
        const pending = pendingViolations.get(key)
        if (pending) {
          pendingViolations.delete(key)
          for (const violation of pending) {
            enrichAndReport(violation, moduleGraph, resolvedImports, entries, maxTraceDepth, globalOptions.cwd, violation.warnedMessages)
          }
        }
      }
    }

    // Builder-specific transform hooks that pass getCombinedSourcemap to the shared logic.
    const transformWithSourceMap = {
      transform(this: { getCombinedSourcemap?: () => SourceMap }, code: string, id: string) {
        return traceTransform(code, id, this.getCombinedSourcemap?.bind(this))
      },
    }

    const tracePlugin: UnpluginOptions = {
      name: 'impound:trace',
      resolveId(_id, importer, resolveOptions) {
        // Track entry points
        if (!importer && resolveOptions?.isEntry) {
          entries.add(_id)
        }
        return null
      },
      transform: traceTransform,
      rollup: transformWithSourceMap,
      vite: transformWithSourceMap,
      rolldown: transformWithSourceMap,
    }
    plugins.push(tracePlugin)
  }

  return plugins
})
