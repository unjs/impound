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
   *
   * Return `false` to allow the import and suppress the default error/warning. When
   * `trace` is enabled the hook runs after the import has already been replaced by the
   * proxy, so `false` only suppresses the report.
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
   * original source. `'lazy'` collects nothing and reads the bundler's own graph at
   * `buildEnd` instead.
   *
   * Use `'lazy'` for builds and keep `true` for a dev server: a dev server calls
   * `buildEnd` when it shuts down, so violations would go unreported for the session.
   *
   * With `error: true`, lazy reports the first violation and fails the build there, so
   * later ones stay unreported until it is fixed.
   *
   * Lazy needs a module graph, which every bundler but esbuild exposes; there it
   * reports the plain message.
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
  /** Set when the violation is reported from `resolveId`; unset when reporting is deferred to `buildEnd`. */
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

    /* v8 ignore start -- es-module-lexer emits source-ordered imports; a reset only if that changes */
    if (imp.s < offset) {
      line = 1
      lastNewline = -1
      offset = 0
    }
    /* v8 ignore stop */

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
    // The suffix match needs a path boundary, or `./data.js` matches a step for `a.js`.
    if (normalizedResolved === id || resolved === rawId || specifier === id || specifier.endsWith(`/${id}`)) {
      return specLoc
    }
  }
}

/** The graph accessors a backwards walk needs, whoever is supplying the graph. */
interface TraceGraph {
  parents: (id: string) => Iterable<string>
  isEntry: (id: string) => boolean
  /** The specifier `file` uses to import `next`, and where it appears. */
  importOf: (file: string, next: string) => { specifier: string, line?: number, column?: number } | undefined
}

/** Build an import trace from entry to the importer via BFS backwards through the graph. */
function buildTrace(graph: TraceGraph, importer: string, maxDepth: number): ImpoundTraceStep[] {
  const visited = new Set([importer])
  const queue: [string, string[]][] = [[importer, [importer]]]
  let found: string[] | undefined

  while (queue.length > 0 && !found) {
    const [current, path] = queue.shift()!
    if (path.length > maxDepth) {
      continue
    }
    if (graph.isEntry(current)) {
      found = path
      break
    }
    for (const parent of graph.parents(current)) {
      if (visited.has(parent)) {
        continue
      }
      visited.add(parent)
      const next = [...path, parent]
      if (graph.isEntry(parent)) {
        found = next
        break
      }
      queue.push([parent, next])
    }
  }

  // A path that never reached an entry is a truncated middle, and its first step must
  // not be presented as the entry.
  if (!found) {
    return [{ file: importer }]
  }

  found.reverse()

  return found.map((file, i) => {
    const next = found![i + 1]
    const edge = next === undefined ? undefined : graph.importOf(file, next)
    if (!edge) {
      return { file }
    }
    const step: ImpoundTraceStep = { file, import: edge.specifier }
    if (edge.line != null) {
      step.line = edge.line
      step.column = edge.column
    }
    return step
  })
}

/** Read the graph collected during transform, for `trace: true`. */
function eagerGraph(
  moduleGraph: Map<string, ModuleGraphEntry>,
  resolvedImports: Map<string, Map<string, string>>,
  entries: Set<string>,
  cwd?: string,
): TraceGraph {
  const normalize = (p: string) => isAbsolute(p) && cwd ? relative(cwd, p) : p

  const importersOf = new Map<string, string[]>()
  for (const [moduleId, imports] of resolvedImports) {
    if (!moduleGraph.has(moduleId)) {
      continue
    }
    for (const resolvedId of imports.values()) {
      const existing = importersOf.get(resolvedId)
      if (existing) {
        existing.push(moduleId)
      }
      else {
        importersOf.set(resolvedId, [moduleId])
      }
    }
  }

  return {
    parents: id => importersOf.get(id) || importersOf.get(normalize(id)) || [],
    isEntry: id => entries.has(id) || entries.has(normalize(id)),
    importOf(file, next) {
      /* v8 ignore next -- the walk only reaches files that have resolved imports */
      for (const [specifier, resolvedId] of resolvedImports.get(file) || []) {
        if (resolvedId === next) {
          const loc = moduleGraph.get(file)?.imports.get(specifier)
          return { specifier, line: loc?.line, column: loc?.column }
        }
      }
    },
  }
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

  const trace = buildTrace(eagerGraph(moduleGraph, resolvedImports, entries, cwd), importer, maxTraceDepth)

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

  // Only the lazy path leaves errorFn unset, and it does not call this.
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
  dynamicImporters?: readonly string[]
  isEntry?: boolean
}
interface LazyGraphContext {
  getModuleInfo: (id: string) => LazyModuleInfo | null | undefined
}

interface NativeModule {
  resource?: string
  originalSource?: () => { source: () => string | { toString: () => string } } | null
}
interface NativeGraph {
  compilation?: {
    errors?: Error[]
    modules?: Iterable<NativeModule>
    moduleGraph?: {
      getIncomingConnections: (module: NativeModule) => Iterable<{ originModule?: NativeModule | null }>
    }
  }
}

/** A bundler graph reached through `getNativeBuildContext`, plus its error channel. */
interface NativeLazyTarget {
  graph: LazyGraphContext
  addError?: (message: string) => void
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

/** Read the bundler's own graph, for `trace: 'lazy'`. Only modules on a chain are lexed. */
function lazyGraph(
  ctx: LazyGraphContext,
  cwd: string | undefined,
  cache: Map<string, Map<string, ImportLocation>>,
): TraceGraph {
  return {
    parents(id) {
      const info = ctx.getModuleInfo(id)
      return [...info?.importers || [], ...info?.dynamicImporters || []]
    },
    isEntry: id => ctx.getModuleInfo(id)?.isEntry === true,
    importOf(file, next) {
      const code = ctx.getModuleInfo(file)?.code
      if (!code) {
        return
      }
      const nextRelative = isAbsolute(next) && cwd ? relative(cwd, next) : next
      for (const [specifier, loc] of lexImports(cache, file, code)) {
        const resolved = RELATIVE_IMPORT_RE.test(specifier) ? join(file.split('?')[0]!, '..', specifier) : specifier
        // The suffix match needs a path boundary, or `./data.js` matches `a.js`.
        if (resolved === next || resolved === nextRelative || specifier === nextRelative || specifier.endsWith(`/${nextRelative}`)) {
          return { specifier, line: loc.line, column: loc.column }
        }
      }
    },
  }
}

/**
 * Adapt webpack's and rspack's `moduleGraph` to the same shape rollup's `getModuleInfo`
 * gives, so the lazy walk works there too. `originalSource()` is the pre-transform
 * source, so these snippets point at original code rather than transformed.
 */
function nativeGraphContext(native: NativeGraph | undefined, cwd: string | undefined): NativeLazyTarget | undefined {
  const compilation = native?.compilation
  const moduleGraph = compilation?.moduleGraph
  if (!moduleGraph || !compilation?.modules) {
    return undefined
  }

  const byId = new Map<string, NativeModule>()
  for (const module of compilation.modules) {
    const resource = module.resource
    if (!resource) {
      continue
    }
    byId.set(resource, module)
    if (cwd && isAbsolute(resource)) {
      byId.set(relative(cwd, resource), module)
    }
  }

  const errors = compilation.errors
  return {
    // Report through the compilation's error channel.
    addError: errors && ((message: string) => { errors.push(new Error(message)) }),
    graph: {
      getModuleInfo(id) {
        const module = byId.get(id) || byId.get(id.split('?')[0]!)
        if (!module) {
          return null
        }
        const importers: string[] = []
        let isEntry = false
        for (const connection of moduleGraph.getIncomingConnections(module)) {
        // A connection with no origin is an entry dependency.
          if (!connection.originModule) {
            isEntry = true
            continue
          }
          if (connection.originModule.resource) {
            importers.push(connection.originModule.resource)
          }
        }
        let code: string | undefined
        try {
          code = module.originalSource?.()?.source()?.toString()
        }
        catch {
        // A module with no readable source still gets a chain, just no frame.
        }
        return { code, importers, isEntry }
      },
    },
  }
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

  const trace = buildTrace(lazyGraph(ctx, cwd, cache), violation.importer, maxTraceDepth)

  let snippet: ImpoundSnippet | undefined
  const code = ctx.getModuleInfo(violation.importer)?.code
  if (code) {
    const loc = findImportLocation(lexImports(cache, violation.importer, code), violation.rawId, violation.id, violation.importer, cwd)
    if (loc) {
      // Sourcemaps are only reachable inside a transform, so positions refer to the code
      // the bundler holds.
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

  const moduleGraph = new Map<string, ModuleGraphEntry>()
  // Maps moduleId -> Map<rawSpecifier, resolvedAbsoluteId>
  const resolvedImports = new Map<string, Map<string, string>>()
  const entries = new Set<string>()
  // Violations waiting for the importer's transform (eager) or for the graph (lazy)
  const pendingViolations = new Map<string, PendingViolation[]>()
  // Keys already held, so a dev server resolving the same import on every reload does not
  // accumulate violations that would all collapse to one message at report time.
  const heldMessages = new Set<string>()

  const cwd = globalOptions.cwd

  function hold(importer: string, violation: PendingViolation): void {
    if (violation.warnedMessages) {
      const key = `${importer}\0${violation.message}`
      if (heldMessages.has(key)) {
        return
      }
      heldMessages.add(key)
    }
    let pending = pendingViolations.get(importer)
    if (!pending) {
      pending = []
      pendingViolations.set(importer, pending)
    }
    pending.push(violation)
  }

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
    // Reports any violation still held once the build's graph is complete.
    ...(traceEnabled ? { buildEnd: reportHeldViolations } : {}),
    load: {
      filter: { id: PROXY_ID_RE },
      handler(id: string) {
        if (id === PROXY_ID) {
          // Named imports from the proxy would fail the bundler's export check, and that
          // error names `impound:proxy` instead of the offending import. Rollup only:
          // rolldown, webpack, rspack and esbuild ignore `syntheticNamedExports`.
          return { code: PROXY_CODE, syntheticNamedExports: 'default' } as unknown as string
        }
      },
    },
    resolveId(this: UnpluginBuildContext & UnpluginContext, id: string, importer: string | undefined, resolveOptions?: { isEntry?: boolean }) {
      if (id === PROXY_ID) {
        return id
      }
      if (!importer) {
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

      // The backwards walk crosses ancestors that no matcher includes, so every edge
      // is recorded and not only those from included importers.
      if (traceMode === 'eager') {
        resolvedId = RELATIVE_IMPORT_RE.test(rawId)
          ? join(importer.split('?')[0]!, '..', rawId)
          : rawId
        relativeId = isAbsolute(resolvedId) && cwd ? relative(cwd, resolvedId) : resolvedId
        let importerResolved = resolvedImports.get(importer)
        if (!importerResolved) {
          importerResolved = new Map()
          resolvedImports.set(importer, importerResolved)
        }
        importerResolved.set(rawId, relativeId)
      }

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

              if (traceMode === 'eager' && moduleGraph.has(importer)) {
                enrichAndReport(violation, moduleGraph, resolvedImports, entries, maxTraceDepth, cwd, warnedMessages)
              }
              else {
                // Held until the importer is transformed (eager) or the graph is
                // complete (lazy).
                hold(importer, violation)
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

        // The combined source map is what lets snippets point at original source.
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
            // getCombinedSourcemap may throw; fall back to transformed code
          }
        }
      }
      catch {
        // A module that does not parse (a raw SFC, an asset) is still registered below,
        // so resolveId can report against it immediately.
        importMap = new Map()
      }

      const graphEntry: ModuleGraphEntry = { code, originalCode, sourceMap, imports: importMap }
      moduleGraph.set(id, graphEntry)
      // resolveId and transform can see the same module under different id forms.
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

      // Flush violations that were waiting for this module's transform, under every id
      // form resolveId may have keyed them by.
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

  async function reportHeldViolations(this: UnpluginBuildContext, buildError?: unknown): Promise<void> {
    // The build is already failing, and the graph it left behind is incomplete.
    // Reporting here would replace the root cause in the surfaced output.
    if (buildError || pendingViolations.size === 0) {
      pendingViolations.clear()
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
    // webpack and rspack keep the same information on `compilation.moduleGraph`.
    const native = typeof ctx.getModuleInfo === 'function'
      ? undefined
      : nativeGraphContext(ctx.getNativeBuildContext?.() as NativeGraph | undefined, cwd)
    const graph: LazyGraphContext | undefined = typeof ctx.getModuleInfo === 'function'
      ? ctx as LazyGraphContext
      : native?.graph
    // Violations cluster in the same files, so their chains overlap.
    const cache = new Map<string, Map<string, ImportLocation>>()

    for (const violation of held) {
      const errorFn = violation.useConsoleError
        ? console.error
        : typeof ctx.error === 'function'
          ? ctx.error.bind(ctx)
          : native?.addError || ((msg: string) => { throw new Error(msg) })

      if (graph) {
        await enrichAndReportLazy(graph, violation, maxTraceDepth, cwd, errorFn, cache)
      }
      else {
        // esbuild exposes no module graph, so there is no chain or snippet to add.
        reportViolation(violation, [{ file: violation.relativeImporter }], undefined, cwd, errorFn, violation.warnedMessages)
      }
    }
  }

  return plugins
})
