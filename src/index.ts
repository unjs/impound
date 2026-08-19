import type { SourceMap } from 'rollup'
import type { UnpluginBuildContext, UnpluginContext, UnpluginOptions } from 'unplugin'
import { originalPositionFor, sourceContentFor, TraceMap } from '@jridgewell/trace-mapping'
import { init, parse } from 'es-module-lexer'
import { isAbsolute, join, relative } from 'pathe'
import { createUnplugin } from 'unplugin'
import { createFilter } from 'unplugin-utils'

const PROXY_ID = '\0impound:proxy'
const PROXY_ID_RE = /^\0impound:proxy$/

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
   *
   * `true` parses every module and materialises its sourcemap, so snippets point at
   * original source. `'lazy'` collects nothing and reads the bundler's graph at
   * `buildEnd` instead, at the cost of snippets showing transformed code. Lazy needs
   * `getModuleInfo`, so on other bundlers it reports the plain message.
   */
  trace?: boolean | 'lazy'
  /**
   * Maximum depth for import traces. Only used when `trace` is enabled.
   * @default 20
   */
  maxTraceDepth?: number
}

export type ImpoundOptions = (ImpoundSharedOptions & ImpoundMatcherOptions) | (ImpoundSharedOptions & { matchers: ImpoundMatcherOptions[] })

const RELATIVE_IMPORT_RE = /^\.\.?\//

const BINARY_ASSET_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|woff2?|[ot]tf|eot|mp[34]|webm|ogg|wav|flac|pdf|zip|gz|wasm)(?:\?.*)?$/i

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
  /** Bound at resolveId for the eager path. The lazy path reports from `buildEnd`, so it binds there instead. */
  errorFn?: (msg: string) => void
  useConsoleError: boolean
  warnedMessages: Set<string> | undefined
}

/** Map imports to 1-indexed lines and 0-indexed UTF-16 columns. */
function getImportLocations(code: string, imports: readonly { n: string | undefined, s: number, ss: number, se: number }[]): Map<string, ImportLocation> {
  const locations = new Map<string, ImportLocation>()
  let line = 1
  let lastNewline = -1
  let offset = 0

  for (const imp of imports) {
    if (!imp.n)
      continue

    // es-module-lexer emits source-ordered imports. Reset defensively if that ever changes.
    if (imp.s < offset) {
      line = 1
      lastNewline = -1
      offset = 0
    }

    while (offset < imp.s && offset < code.length) {
      if (code[offset] === '\n') {
        line++
        lastNewline = offset
      }
      offset++
    }

    locations.set(imp.n, {
      line,
      column: imp.s - lastNewline - 1,
      statementStart: imp.ss,
      statementEnd: imp.se,
    })
  }

  return locations
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

/** Locate a denied specifier's import statement, by raw specifier then by resolved target. */
function findImportLocation(
  imports: Map<string, ImportLocation>,
  rawId: string,
  id: string,
  importer: string,
  cwd?: string,
): ImportLocation | undefined {
  const direct = imports.get(rawId)
  if (direct) {
    return direct
  }
  const importerBase = importer.split('?')[0]!
  for (const [specifier, specLoc] of imports) {
    const resolved = RELATIVE_IMPORT_RE.test(specifier) ? join(importerBase, '..', specifier) : specifier
    let normalizedResolved = resolved
    if (cwd && isAbsolute(resolved)) {
      normalizedResolved = relative(cwd, resolved)
    }
    if (normalizedResolved === id || resolved === rawId || specifier.endsWith(id)) {
      return specLoc
    }
  }
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
  const { id, rawId, importer, errorFn } = violation

  // Build trace
  const trace = buildTrace(importer, moduleGraph, resolvedImports, entries, maxTraceDepth, cwd)

  // Build snippet from the module graph (entries are stored under normalized key forms in transform)
  let snippet: ImpoundSnippet | undefined
  /* v8 ignore start -- always defined: enrichAndReport is only called when the importer is in the module graph */
  const importerEntry = moduleGraph.get(importer)
  if (importerEntry) {
  /* v8 ignore stop */
    const loc = findImportLocation(importerEntry.imports, rawId, id, importer, cwd)
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

  // The eager path always binds errorFn at resolveId; only the lazy path leaves it unset.
  reportViolation(violation, trace, snippet, cwd, errorFn!, warnedMessages)
}

/** Assemble the final message, run the `onViolation` hook, de-duplicate, and report. */
function reportViolation(
  violation: PendingViolation,
  trace: ImpoundTraceStep[],
  snippet: ImpoundSnippet | undefined,
  cwd: string | undefined,
  errorFn: (msg: string) => void,
  warnedMessages: Set<string> | undefined,
): void {
  const { id, relativeImporter, options, suggestions } = violation

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

/** The slice of a rollup-style plugin context the lazy trace path needs. */
interface LazyModuleInfo {
  code?: string | null
  importers?: readonly string[]
  isEntry?: boolean
}
interface LazyGraphContext {
  getModuleInfo: (id: string) => LazyModuleInfo | null | undefined
}

/** Lex a module's imports once per reporting pass. Only modules on a violation's chain are read. */
function lexImports(cache: Map<string, Map<string, ImportLocation>>, id: string, code: string): Map<string, ImportLocation> {
  const cached = cache.get(id)
  if (cached) {
    return cached
  }
  let locations = new Map<string, ImportLocation>()
  try {
    const [imports] = parse(code, id)
    locations = getImportLocations(code, imports)
  }
  catch {
    // Not parseable as ESM (a raw asset, or already-compiled output). No positions, no snippet.
  }
  cache.set(id, locations)
  return locations
}

/** Build an import trace by walking `importers` backwards, rather than a graph of our own. */
function buildLazyTrace(
  ctx: LazyGraphContext,
  importer: string,
  maxDepth: number,
  cwd: string | undefined,
  cache: Map<string, Map<string, ImportLocation>>,
): ImpoundTraceStep[] {
  const visited = new Set<string>([importer])
  const queue: [string, string[]][] = [[importer, [importer]]]
  let bestPath: string[] = [importer]
  let found = false

  while (queue.length > 0 && !found) {
    const [current, path] = queue.shift()!
    if (path.length > maxDepth) {
      continue
    }
    if (ctx.getModuleInfo(current)?.isEntry) {
      bestPath = path
      break
    }
    for (const parent of ctx.getModuleInfo(current)?.importers || []) {
      if (visited.has(parent)) {
        continue
      }
      visited.add(parent)
      const next = [...path, parent]
      if (ctx.getModuleInfo(parent)?.isEntry) {
        bestPath = next
        found = true
        break
      }
      if (next.length > bestPath.length) {
        bestPath = next
      }
      queue.push([parent, next])
    }
  }

  // Reverse so it reads entry -> ... -> importer
  bestPath.reverse()

  const trace: ImpoundTraceStep[] = []
  for (let i = 0; i < bestPath.length; i++) {
    const file = bestPath[i]!
    const step: ImpoundTraceStep = { file }

    if (i < bestPath.length - 1) {
      const nextFile = bestPath[i + 1]!
      const code = ctx.getModuleInfo(file)?.code
      if (code) {
        const nextRelative = isAbsolute(nextFile) && cwd ? relative(cwd, nextFile) : nextFile
        for (const [specifier, loc] of lexImports(cache, file, code)) {
          const resolved = RELATIVE_IMPORT_RE.test(specifier) ? join(file.split('?')[0]!, '..', specifier) : specifier
          if (resolved === nextFile || resolved === nextRelative || specifier.endsWith(nextRelative)) {
            step.import = specifier
            step.line = loc.line
            step.column = loc.column
            break
          }
        }
      }
    }

    trace.push(step)
  }

  return trace
}

/** Enrich a held violation once the bundler's graph is complete. Nothing was collected earlier. */
async function enrichAndReportLazy(
  ctx: LazyGraphContext,
  violation: PendingViolation,
  maxTraceDepth: number,
  cwd: string | undefined,
  errorFn: (msg: string) => void,
  cache: Map<string, Map<string, ImportLocation>>,
): Promise<void> {
  await init

  const trace = buildLazyTrace(ctx, violation.importer, maxTraceDepth, cwd, cache)

  let snippet: ImpoundSnippet | undefined
  const code = ctx.getModuleInfo(violation.importer)?.code
  if (code) {
    const loc = findImportLocation(lexImports(cache, violation.importer, code), violation.rawId, violation.id, violation.importer, cwd)
    if (loc) {
      // No sourcemap: it is only reachable from inside a transform, which is what this skips.
      snippet = { text: generateSnippet(code, loc.line, loc.column), line: loc.line, column: loc.column }
    }
  }

  reportViolation(violation, trace, snippet, cwd, errorFn, violation.warnedMessages)
}

export const ImpoundPlugin = createUnplugin<ImpoundOptions>((globalOptions) => {
  const matchers = 'matchers' in globalOptions ? globalOptions.matchers : [globalOptions]
  // 'eager' collects the graph during transform, 'lazy' reads the bundler's at buildEnd.
  const traceMode: 'off' | 'eager' | 'lazy' = globalOptions.trace === 'lazy'
    ? 'lazy'
    : globalOptions.trace === true ? 'eager' : 'off'
  const traceEnabled = traceMode !== 'off'
  const maxTraceDepth = globalOptions.maxTraceDepth ?? 20

  // Shared state for trace mode
  const moduleGraph = new Map<string, ModuleGraphEntry>()
  // Maps moduleId -> Map<rawSpecifier, resolvedAbsoluteId>
  const resolvedImports = new Map<string, Map<string, string>>()
  const entries = new Set<string>()
  // Violations waiting for the importer's transform to complete
  const pendingViolations = new Map<string, PendingViolation[]>()

  const cwd = globalOptions.cwd

  interface MatcherState {
    options: ImpoundMatcherOptions
    filter: (id: string) => boolean
    filterCache: Map<string, boolean>
    excludeFilter?: (id: string) => boolean
    warnedMessages?: Set<string>
  }

  const matcherStates: MatcherState[] = matchers.map(options => ({
    options,
    filter: createFilter(options.include, options.exclude, { resolve: cwd }),
    filterCache: new Map(),
    excludeFilter: options.excludeFiles?.length
      ? createFilter(options.excludeFiles, undefined, { resolve: cwd })
      : undefined,
    warnedMessages: options.warn !== 'always' ? new Set<string>() : undefined,
  }))

  const relativeImporterCache = new Map<string, string>()

  const plugins: UnpluginOptions[] = [{
    name: 'impound',
    enforce: 'pre' as const,
    load: {
      filter: { id: PROXY_ID_RE },
      handler(id: string) {
        if (id === PROXY_ID) {
          // Named imports from the proxy would fail the bundler's export check, and that
          // error names `impound:proxy` instead of the offending import.
          return { code: PROXY_CODE, syntheticNamedExports: 'default' } as unknown as string
        }
      },
    },
    resolveId(this: UnpluginBuildContext & UnpluginContext, id: string, importer: string | undefined, resolveOptions?: { isEntry?: boolean }) {
      if (id === PROXY_ID) {
        return id
      }
      if (!importer) {
        // This is an entry point resolution
        if (traceMode === 'eager' && resolveOptions?.isEntry) {
          entries.add(id)
        }
        return
      }

      const rawId = id
      // Lazily computed once per call and shared across matchers
      let resolvedId: string | undefined
      let relativeId: string | undefined
      let relativeImporter: string | undefined
      let trackedForTrace = false

      for (const matcher of matcherStates) {
        let included = matcher.filterCache.get(importer)
        if (included === undefined) {
          included = matcher.filter(importer)
          matcher.filterCache.set(importer, included)
        }
        if (!included) {
          continue
        }

        resolvedId ??= RELATIVE_IMPORT_RE.test(rawId)
          ? join(importer.split('?')[0]!, '..', rawId)
          : rawId

        // Skip resolved targets matching excludeFiles
        if (matcher.excludeFilter?.(resolvedId)) {
          continue
        }

        relativeId ??= isAbsolute(resolvedId) && cwd ? relative(cwd, resolvedId) : resolvedId
        const id = relativeId

        if (relativeImporter === undefined) {
          relativeImporter = relativeImporterCache.get(importer)
          if (relativeImporter === undefined) {
            relativeImporter = isAbsolute(importer) && cwd ? relative(cwd, importer) : importer
            relativeImporterCache.set(importer, relativeImporter)
          }
        }

        // Track resolved imports for trace mode
        if (traceMode === 'eager' && !trackedForTrace) {
          trackedForTrace = true
          let importerResolved = resolvedImports.get(importer)
          if (!importerResolved) {
            importerResolved = new Map()
            resolvedImports.set(importer, importerResolved)
          }
          importerResolved.set(rawId, id)
        }

        const { options, warnedMessages } = matcher
        let matched = false
        let formattedImporter: string | undefined

        for (const [pattern, warning, suggestions] of options.patterns) {
          const usesImport = pattern instanceof RegExp
            ? pattern.test(id)
            : typeof pattern === 'string'
              ? pattern === id
              : pattern(id, relativeImporter)

          if (usesImport) {
            formattedImporter ??= relativeImporter.split('?')[0]!
            const baseMessage = `${typeof usesImport === 'string' ? usesImport : (warning || 'Invalid import')} [importing \`${id}\` from \`${formattedImporter}\`]`

            if (traceEnabled) {
              const useConsoleError = options.error === false
              const violation: PendingViolation = {
                id,
                rawId,
                importer,
                relativeImporter,
                message: baseMessage,
                suggestions,
                options,
                // The lazy path reports from buildEnd and binds its own error there.
                errorFn: traceMode === 'lazy' ? undefined : (useConsoleError ? console.error : this.error.bind(this)),
                useConsoleError,
                warnedMessages,
              }

              if (traceMode === 'lazy') {
                // Hold every violation. Nothing can enrich it until the graph is complete.
                let pending = pendingViolations.get(importer)
                if (!pending) {
                  pending = []
                  pendingViolations.set(importer, pending)
                }
                pending.push(violation)
              }
              else if (moduleGraph.has(importer)) {
                // Importer already transformed — enrich and report immediately
                enrichAndReport(violation, moduleGraph, resolvedImports, entries, maxTraceDepth, cwd, warnedMessages)
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

        if (matched) {
          return PROXY_ID
        }
      }
    },
  }]

  if (traceMode === 'eager') {
    // shared transform logic for module graph building and flushing pending violations.
    async function traceTransform(code: string, id: string, getCombinedSourcemap?: () => unknown): Promise<void> {
      if (BINARY_ASSET_RE.test(id))
        return

      await init
      let importMap = new Map<string, ImportLocation>()
      let originalCode: string | undefined
      let sourceMap: unknown

      try {
        const [imports] = parse(code, id)
        importMap = getImportLocations(code, imports)

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

    const filteredTransformWithSourceMap = {
      transform: {
        filter: { id: { exclude: BINARY_ASSET_RE } },
        handler: transformWithSourceMap.transform,
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
      transform: {
        filter: { id: { exclude: BINARY_ASSET_RE } },
        handler: traceTransform,
      },
      rollup: transformWithSourceMap,
      vite: filteredTransformWithSourceMap,
      rolldown: filteredTransformWithSourceMap,
    }
    plugins.push(tracePlugin)
  }

  if (traceMode === 'lazy') {
    // On the main plugin so violations stay attributed to `impound`. No transform hook:
    // nothing is parsed, no sourcemap forced, nothing retained.
    Object.assign(plugins[0]!, {
      async buildEnd(this: UnpluginBuildContext) {
        if (pendingViolations.size === 0) {
          return
        }

        const held: PendingViolation[] = []
        for (const violations of pendingViolations.values()) {
          held.push(...violations)
        }
        pendingViolations.clear()

        // `getModuleInfo` and `error` are not part of unplugin's build context, but the
        // underlying context supplies both on rollup, vite and rolldown.
        const ctx = this as UnpluginBuildContext & Partial<LazyGraphContext> & { error?: (msg: string) => never }
        const canEnrich = typeof ctx.getModuleInfo === 'function'
        // Violations cluster in the same files, so their chains overlap.
        const cache = new Map<string, Map<string, ImportLocation>>()

        for (const violation of held) {
          const errorFn = violation.useConsoleError
            ? console.error
            : typeof ctx.error === 'function'
              ? ctx.error.bind(ctx)
              : (msg: string) => { throw new Error(msg) }

          if (canEnrich) {
            await enrichAndReportLazy(ctx as LazyGraphContext, violation, maxTraceDepth, cwd, errorFn, cache)
          }
          else {
            // No module graph to read (webpack, rspack, esbuild). Report the plain message
            // rather than inventing a trace: a single-step trace adds no Trace block.
            reportViolation(violation, [{ file: violation.relativeImporter }], undefined, cwd, errorFn, violation.warnedMessages)
          }
        }
      },
    })
  }

  return plugins
})
