import type { SourceMap } from 'rollup'
import type { UnpluginBuildContext, UnpluginContext, UnpluginOptions } from 'unplugin'
import { originalPositionFor, sourceContentFor, TraceMap } from '@jridgewell/trace-mapping'
import { init, parse } from 'es-module-lexer'
import { isAbsolute, join } from 'pathe'
import { createUnplugin } from 'unplugin'
import { createFilter } from 'unplugin-utils'
import { relativeToCwd, toRelative } from './path'

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
   * original source. On a Vite dev server and on webpack it parses nothing up front: it
   * walks the bundler's module graph when a violation happens. `'lazy'` collects nothing
   * and reads the bundler's own graph at `buildEnd` instead.
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

interface ModuleSource {
  code: string
  originalCode?: string
  sourceMap?: unknown
}

function stripQuery(id: string): string {
  const queryIndex = id.indexOf('?')
  return queryIndex === -1 ? id : id.slice(0, queryIndex)
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
  const importerBase = stripQuery(importer)
  for (const [specifier, specLoc] of imports) {
    const resolved = RELATIVE_IMPORT_RE.test(specifier) ? join(importerBase, '..', specifier) : specifier
    let normalizedResolved = resolved
    if (cwd && isAbsolute(resolved)) {
      normalizedResolved = relativeToCwd(cwd, resolved)
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
  // `cameFrom` maps each visited ancestor to the module that imports it, so the chain is
  // rebuilt by walking forwards from whichever entry is reached.
  const cameFrom = new Map<string, string | undefined>([[importer, undefined]])
  const queue = [importer]
  const depths = [1]
  let found: string | undefined

  for (let cursor = 0; cursor < queue.length && found === undefined; cursor++) {
    const current = queue[cursor]!
    const depth = depths[cursor]!
    if (depth > maxDepth) {
      continue
    }
    if (graph.isEntry(current)) {
      found = current
      break
    }
    for (const parent of graph.parents(current)) {
      if (cameFrom.has(parent)) {
        continue
      }
      cameFrom.set(parent, current)
      if (graph.isEntry(parent)) {
        found = parent
        break
      }
      queue.push(parent)
      depths.push(depth + 1)
    }
  }

  // A path that never reached an entry is a truncated middle, and its first step must
  // not be presented as the entry.
  if (found === undefined) {
    return [{ file: importer }]
  }

  const chain: string[] = []
  for (let node: string | undefined = found; node !== undefined; node = cameFrom.get(node)) {
    chain.push(node)
  }

  return chain.map((file, i) => {
    const next = chain[i + 1]
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
  moduleImports: Map<string, Map<string, ImportLocation>>,
  resolvedImports: Map<string, Map<string, string>>,
  entries: Set<string>,
  cwd?: string,
): TraceGraph {
  const normalize = (p: string) => toRelative(p, cwd)

  const importersOf = new Map<string, string[]>()
  for (const [moduleId, imports] of resolvedImports) {
    if (!moduleImports.has(moduleId)) {
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
      // Edges hold the target relative to cwd, while the walk carries module ids.
      const nextRelative = normalize(next)
      /* v8 ignore next -- the walk only reaches files that have resolved imports */
      for (const [specifier, resolvedId] of resolvedImports.get(file) || []) {
        if (resolvedId === next || resolvedId === nextRelative) {
          const loc = moduleImports.get(file)?.get(specifier)
          return { specifier, line: loc?.line, column: loc?.column }
        }
      }
    },
  }
}

function formatTrace(trace: ImpoundTraceStep[], cwd?: string): string {
  return trace.map((step, i) => {
    const file = toRelative(step.file, cwd)
    const loc = step.line != null ? `:${step.line}:${step.column}` : ''
    const entry = i === 0 ? ' (entry)' : ''
    const imp = step.import ? ` (import "${step.import}")` : ''
    return `  ${i + 1}. ${file}${loc}${entry}${imp}`
  }).join('\n')
}

/** Render the snippet for an import, reverse-mapped to original source when a sourcemap is held. */
function snippetFor(source: ModuleSource, loc: ImportLocation): ImpoundSnippet {
  let snippetCode = source.code
  let snippetLine = loc.line
  let snippetColumn = loc.column

  if (source.sourceMap) {
    try {
      const tracer = new TraceMap(source.sourceMap as ConstructorParameters<typeof TraceMap>[0])
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
        else if (source.originalCode) {
          snippetCode = source.originalCode
        }
      }
    }
    catch {
      // Fall back to transformed code positions
    }
  }

  return { text: generateSnippet(snippetCode, snippetLine, snippetColumn), line: snippetLine, column: snippetColumn }
}

/** Read a combined sourcemap, keeping it only when it carries mappings. */
function readSourceMap(getCombinedSourcemap: () => unknown): Pick<ModuleSource, 'sourceMap' | 'originalCode'> {
  try {
    const map = getCombinedSourcemap() as { mappings?: string, sourcesContent?: (string | null)[] } | undefined
    if (map?.mappings) {
      return { sourceMap: map, originalCode: map.sourcesContent?.[0] || undefined }
    }
  }
  catch {
    // getCombinedSourcemap may throw; fall back to transformed code
  }
  return {}
}

function enrichAndReport(
  violation: PendingViolation,
  moduleImports: Map<string, Map<string, ImportLocation>>,
  moduleSources: Map<string, ModuleSource>,
  graph: TraceGraph,
  maxTraceDepth: number,
  cwd: string | undefined,
  warnedMessages: Set<string> | undefined,
): void {
  const { id, rawId, importer, errorFn } = violation

  const trace = buildTrace(graph, importer, maxTraceDepth)

  let snippet: ImpoundSnippet | undefined
  const importerImports = moduleImports.get(importer)
  const importerSource = moduleSources.get(importer)
  /* v8 ignore start -- always defined: the importer was transformed and matched a matcher, so its source is retained */
  if (importerImports && importerSource) {
  /* v8 ignore stop */
    const loc = findImportLocation(importerImports, rawId, id, importer, cwd)
    if (loc) {
      snippet = snippetFor(importerSource, loc)
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

let lexerReady = false

/** Resolve once, then stay synchronous: a per-module `await` costs a microtask each. */
function whenLexerReady(): Promise<void> | undefined {
  if (lexerReady) {
    return
  }
  return init.then(() => {
    lexerReady = true
  })
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
      const nextRelative = toRelative(next, cwd)
      for (const [specifier, loc] of lexImports(cache, file, code)) {
        const resolved = RELATIVE_IMPORT_RE.test(specifier) ? join(stripQuery(file), '..', specifier) : specifier
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
      byId.set(relativeToCwd(cwd, resource), module)
    }
  }

  const errors = compilation.errors
  return {
    // Report through the compilation's error channel.
    addError: errors && ((message: string) => { errors.push(new Error(message)) }),
    graph: {
      getModuleInfo(id) {
        const module = byId.get(id) || byId.get(stripQuery(id))
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
  await whenLexerReady()
  reportFromGraph(ctx, violation, maxTraceDepth, cwd, errorFn, cache)
}

/** Walk a bundler's graph for a violation and report it. The lexer must already be ready. */
function reportFromGraph(
  ctx: LazyGraphContext,
  violation: PendingViolation,
  maxTraceDepth: number,
  cwd: string | undefined,
  errorFn: (msg: string) => void,
  cache: Map<string, Map<string, ImportLocation>>,
): void {
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

/** The slice of a Vite dev environment's module graph the eager path reads. */
interface DevModuleNode {
  id: string | null
  importers: Set<DevModuleNode>
  transformResult?: { code: string } | null
}
interface DevModuleGraph {
  getModuleById: (id: string) => DevModuleNode | undefined
}

/** What a transform leaves behind for a module, so a violation can render its snippet. */
interface DevSource {
  code: string
  /** Bound to the module's transform context, for importers a matcher includes. */
  getCombinedSourcemap?: () => unknown
}

/** A Vite dev server keeps a live module graph, which the eager path reads instead of its own. */
function devModuleGraph(ctx: unknown): DevModuleGraph | undefined {
  const environment = (ctx as { environment?: { mode?: string, moduleGraph?: DevModuleGraph } } | undefined)?.environment
  return environment?.mode === 'dev' ? environment.moduleGraph : undefined
}

/**
 * Adapt Vite's dev module graph to the shape the lazy walk reads. Vite rewrites a module's
 * importers on every transform, so the chain follows edits without impound tracking edges,
 * and a module nothing imports is where the browser or runner started.
 */
function devGraphContext(graph: DevModuleGraph, sources: WeakMap<DevModuleNode, DevSource>): LazyGraphContext {
  return {
    getModuleInfo(id) {
      const node = graph.getModuleById(id)
      /* v8 ignore start -- the walk only reaches ids Vite gave its own importers, and every
         module on it went through the trace transform */
      if (!node) {
        return null
      }
      const importers: string[] = []
      for (const importer of node.importers) {
        if (importer.id) {
          importers.push(importer.id)
        }
      }
      return { code: sources.get(node)?.code ?? node.transformResult?.code, importers, isEntry: importers.length === 0 }
      /* v8 ignore stop */
    },
  }
}

/**
 * Report a violation against Vite's dev graph. Synchronous, so `error: true` still fails the
 * request. The lexer is ready by now: the importer's transform awaited it.
 */
function enrichAndReportDev(
  graph: DevModuleGraph,
  sources: WeakMap<DevModuleNode, DevSource>,
  source: DevSource,
  violation: PendingViolation,
  maxTraceDepth: number,
  cwd: string | undefined,
): void {
  const cache = new Map<string, Map<string, ImportLocation>>()
  const trace = buildTrace(lazyGraph(devGraphContext(graph, sources), cwd, cache), violation.importer, maxTraceDepth)

  let snippet: ImpoundSnippet | undefined
  const loc = findImportLocation(lexImports(cache, violation.importer, source.code), violation.rawId, violation.id, violation.importer, cwd)
  if (loc) {
    // Vite collapses the sourcemap chain into its context as it goes, so reading it here,
    // before import analysis adds its own, maps exactly the code that was kept.
    /* v8 ignore next -- the importer passed a matcher, so its sourcemap getter was kept */
    const map = source.getCombinedSourcemap ? readSourceMap(source.getCombinedSourcemap) : {}
    snippet = snippetFor({ code: source.code, ...map }, loc)
  }

  // Only the lazy path leaves errorFn unset.
  reportViolation(violation, trace, snippet, cwd, violation.errorFn!, violation.warnedMessages)
}

export const ImpoundPlugin = createUnplugin<ImpoundOptions>((globalOptions, meta) => {
  const matchers = 'matchers' in globalOptions ? globalOptions.matchers : [globalOptions]
  // 'eager' collects the graph during transform, 'lazy' reads the bundler's at buildEnd.
  const traceMode: 'off' | 'eager' | 'lazy' = globalOptions.trace === 'lazy'
    ? 'lazy'
    : globalOptions.trace === true ? 'eager' : 'off'
  const traceEnabled = traceMode !== 'off'
  // webpack lets a plugin read the compilation's module graph while it is being built, so
  // eager tracing reads that instead of recording its own. rspack locks it until then.
  const nativeEager = traceMode === 'eager' && meta.framework === 'webpack'
  const maxTraceDepth = globalOptions.maxTraceDepth ?? 20

  const moduleImports = new Map<string, Map<string, ImportLocation>>()
  // Only modules a matcher includes can be the importer in a violation, so only those
  // need their code and sourcemap kept alive for a snippet.
  const moduleSources = new Map<string, ModuleSource>()
  // Maps moduleId -> Map<rawSpecifier, resolvedAbsoluteId>
  const resolvedImports = new Map<string, Map<string, string>>()
  // Importers transformed since their edges were recorded. Their edges are replaced on the
  // next resolve, and kept when a bundler does not resolve the module again.
  const staleEdges = new Set<string>()
  const entries = new Set<string>()
  // Violations waiting for the importer's transform (eager) or for the graph (lazy)
  const pendingViolations = new Map<string, PendingViolation[]>()
  // Keys already held, so a dev server resolving the same import on every reload does not
  // accumulate violations that would all collapse to one message at report time.
  const heldMessages = new Set<string>()
  // On a Vite dev server, each module's latest transform output, tied to Vite's own graph
  // node so a re-transform replaces it and a dropped module takes it with it.
  const devSources = new WeakMap<DevModuleNode, DevSource>()
  // webpack runs its resolver outside a compilation, so the current one is kept per compiler.
  const compilations = new WeakMap<object, NativeGraph['compilation']>()

  const cwd = globalOptions.cwd

  /**
   * rspack and webpack resolve an entry as it was written, relative to the compiler's
   * context, while every importer after it arrives as an absolute path.
   */
  function entryId(ctx: unknown, id: string): string {
    const native = (ctx as Partial<UnpluginBuildContext>).getNativeBuildContext?.() as { compiler?: { context?: string } } | undefined
    const context = native?.compiler?.context
    return context && RELATIVE_IMPORT_RE.test(id) ? join(context, id) : id
  }

  /** The module graph of the webpack compilation a resolve belongs to. */
  function nativeEagerGraph(ctx: unknown): LazyGraphContext | undefined {
    const native = (ctx as Partial<UnpluginBuildContext>).getNativeBuildContext?.() as { compiler?: object } & NativeGraph | undefined
    const compilation = native?.compilation ?? (native?.compiler && compilations.get(native.compiler))
    return nativeGraphContext({ compilation }, cwd)?.graph
  }

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

  function includes(matcher: MatcherState, id: string): boolean {
    let included = matcher.filterCache.get(id)
    if (included === undefined) {
      included = matcher.filter(id)
      matcher.filterCache.set(id, included)
    }
    return included
  }

  function includedByAny(id: string): boolean {
    for (const matcher of matcherStates) {
      if (includes(matcher, id)) {
        return true
      }
    }
    return false
  }

  const relativeImporterCache = new Map<string, string>()

  // Inverting `resolvedImports` is proportional to the whole graph, so it is done once
  // and reused until the graph changes.
  let cachedEagerGraph: TraceGraph | undefined
  function getEagerGraph(): TraceGraph {
    return (cachedEagerGraph ??= eagerGraph(moduleImports, resolvedImports, entries, cwd))
  }

  const plugins: UnpluginOptions[] = [{
    name: 'impound',
    enforce: 'pre' as const,
    // Reports any violation still held once the build's graph is complete.
    ...(traceEnabled ? { buildEnd: reportHeldViolations } : {}),
    ...(nativeEager
      ? {
          // Nothing is transformed through impound here, so the lexer is readied up front.
          buildStart: () => whenLexerReady(),
          webpack: (compiler: { hooks: { thisCompilation: { tap: (name: string, fn: (compilation: NonNullable<NativeGraph['compilation']>) => void) => void } } }) => {
            compiler.hooks.thisCompilation.tap('impound', compilation => compilations.set(compiler, compilation))
          },
        }
      : {}),
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
          entries.add(entryId(this, id))
          cachedEagerGraph = undefined
        }
        return
      }

      const rawId = id
      // Lazily computed once per call and shared across matchers
      let resolvedId: string | undefined
      let relativeId: string | undefined
      let relativeImporter: string | undefined
      const devGraph = traceMode === 'eager' ? devModuleGraph(this) : undefined

      // The backwards walk crosses ancestors that no matcher includes, so every edge
      // is recorded and not only those from included importers. A Vite dev server's and
      // a webpack compilation's own graph already have them.
      if (traceMode === 'eager' && !devGraph && !nativeEager) {
        resolvedId = RELATIVE_IMPORT_RE.test(rawId)
          ? join(stripQuery(importer), '..', rawId)
          : rawId
        relativeId = toRelative(resolvedId, cwd)
        let importerResolved = staleEdges.delete(importer) ? undefined : resolvedImports.get(importer)
        if (!importerResolved) {
          importerResolved = new Map()
          resolvedImports.set(importer, importerResolved)
        }
        if (importerResolved.get(rawId) !== relativeId) {
          importerResolved.set(rawId, relativeId)
          cachedEagerGraph = undefined
        }
      }

      for (const matcher of matcherStates) {
        if (!includes(matcher, importer)) {
          continue
        }

        resolvedId ??= RELATIVE_IMPORT_RE.test(rawId)
          ? join(stripQuery(importer), '..', rawId)
          : rawId

        if (matcher.excludeFilter?.(resolvedId)) {
          continue
        }

        relativeId ??= toRelative(resolvedId, cwd)
        const id = relativeId

        if (relativeImporter === undefined) {
          relativeImporter = relativeImporterCache.get(importer)
          if (relativeImporter === undefined) {
            relativeImporter = toRelative(importer, cwd)
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
            formattedImporter ??= stripQuery(relativeImporter)
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

              const devNode = devGraph?.getModuleById(importer)
              const devSource = devNode && devSources.get(devNode)
              const nativeGraph = nativeEager ? nativeEagerGraph(this) : undefined
              if (devGraph && devSource) {
                enrichAndReportDev(devGraph, devSources, devSource, violation, maxTraceDepth, cwd)
              }
              else if (nativeGraph) {
                // The importer has been built by the time its imports resolve, and so has
                // every module above it, so the chain can be read now.
                reportFromGraph(nativeGraph, violation, maxTraceDepth, cwd, violation.errorFn!, new Map())
              }
              else if (!devGraph && traceMode === 'eager' && moduleImports.has(importer)) {
                enrichAndReport(violation, moduleImports, moduleSources, getEagerGraph(), maxTraceDepth, cwd, warnedMessages)
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

  if (traceMode === 'eager' && !nativeEager) {
    function registerModule(code: string, id: string, getCombinedSourcemap?: () => unknown): void {
      // Snippets are only ever rendered for a violation's importer, which by definition
      // passed a matcher's filter, so nothing else needs its code or sourcemap retained.
      const tracked = includedByAny(id)
      let importMap = new Map<string, ImportLocation>()
      let originalCode: string | undefined
      let sourceMap: unknown

      try {
        const [imports] = parse(code, id)
        importMap = getImportLocations(code, imports)

        // The combined source map is what lets snippets point at original source.
        if (tracked && getCombinedSourcemap) {
          ({ sourceMap, originalCode } = readSourceMap(getCombinedSourcemap))
        }
      }
      catch {
        // A module that does not parse (a raw SFC, an asset) is still registered below,
        // so resolveId can report against it immediately.
        importMap = new Map()
      }

      const source: ModuleSource | undefined = tracked ? { code, originalCode, sourceMap } : undefined
      const register = (key: string) => {
        moduleImports.set(key, importMap)
        if (source) {
          moduleSources.set(key, source)
        }
      }

      register(id)
      // resolveId and transform can see the same module under different id forms.
      /* v8 ignore start -- defensive normalization for framework-specific virtual module IDs */
      const bareId = stripQuery(id)
      if (bareId !== id)
        register(bareId)
      const relativeId = toRelative(id, cwd)
      if (relativeId !== id) {
        register(relativeId)
        const relBareId = stripQuery(relativeId)
        if (relBareId !== relativeId)
          register(relBareId)
      }
      /* v8 ignore stop */
      // Edges recorded for an earlier version of this module would keep an import that has
      // since been removed, so its next resolve starts them afresh.
      staleEdges.add(id)
      staleEdges.add(bareId)
      cachedEagerGraph = undefined

      if (pendingViolations.size === 0) {
        return
      }

      // Flush violations that were waiting for this module's transform, under every id
      // form resolveId may have keyed them by.
      const candidateKeys = new Set([id, relativeId, bareId, stripQuery(relativeId)])
      for (const key of candidateKeys) {
        const pending = pendingViolations.get(key)
        if (pending) {
          pendingViolations.delete(key)
          for (const violation of pending) {
            enrichAndReport(violation, moduleImports, moduleSources, getEagerGraph(), maxTraceDepth, cwd, violation.warnedMessages)
          }
        }
      }
    }

    /**
     * On a dev server, keep only what a snippet needs. Lexing and the sourcemap wait for a
     * violation, and the chain comes from Vite's graph.
     */
    function rememberDevModule(graph: DevModuleGraph, code: string, id: string, getCombinedSourcemap?: () => unknown): void {
      const node = graph.getModuleById(id)
      /* v8 ignore next 3 -- Vite creates a module's node before transforming it */
      if (!node) {
        return
      }
      // Only an included module can be a violation's importer, so only it needs a sourcemap.
      const source: DevSource = { code, getCombinedSourcemap: includedByAny(id) ? getCombinedSourcemap : undefined }
      devSources.set(node, source)

      // Resolved before its transform, e.g. by the dependency scanner.
      const pending = pendingViolations.get(id)
      if (pending) {
        pendingViolations.delete(id)
        for (const violation of pending) {
          enrichAndReportDev(graph, devSources, source, violation, maxTraceDepth, cwd)
        }
      }
    }

    function traceTransform(code: string, id: string, getCombinedSourcemap?: () => unknown, devGraph?: DevModuleGraph): Promise<void> | undefined {
      if (BINARY_ASSET_RE.test(id))
        return

      const record = devGraph
        ? () => rememberDevModule(devGraph, code, id, getCombinedSourcemap)
        : () => registerModule(code, id, getCombinedSourcemap)
      const pending = whenLexerReady()
      if (pending) {
        return pending.then(record)
      }
      record()
    }

    const transformWithSourceMap = {
      transform(this: { getCombinedSourcemap?: () => SourceMap }, code: string, id: string) {
        return traceTransform(code, id, this.getCombinedSourcemap?.bind(this), devModuleGraph(this))
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
      for (const violation of violations) {
        held.push(violation)
      }
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
