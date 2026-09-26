import { isAbsolute, relative, resolve } from 'pathe'

// A remainder pathe would rewrite: a backslash, an empty, `.` or `..` segment (a
// leading or trailing slash is an empty one).
const UNNORMALIZED_RE = /\\|\/\/|^\/|\/$|(?:^|\/)\.\.?(?:\/|$)/

const ROOT_FOLDER_RE = /^\/(?:[A-Z]:)?$/i

// Empty when the cwd has no fast path.
const cwdPrefixes = new Map<string, string>()

/**
 * `relative(cwd, p)` for an absolute `p`. pathe resolves and splits `cwd` on every call,
 * which dominates when it runs once per import, so a `p` already normalised under `cwd`
 * is sliced instead. Anything else falls through to pathe.
 */
export function relativeToCwd(cwd: string, p: string): string {
  // A relative cwd resolves against `process.cwd()`, which can change between calls.
  if (isAbsolute(cwd)) {
    let prefix = cwdPrefixes.get(cwd)
    if (prefix === undefined) {
      const base = resolve(cwd)
      // pathe special-cases a root cwd (`/`, `/C:`), so those always take the slow path.
      prefix = ROOT_FOLDER_RE.test(base) ? '' : `${base}/`
      cwdPrefixes.set(cwd, prefix)
    }
    if (prefix && p.startsWith(prefix)) {
      const rest = p.slice(prefix.length)
      if (rest && !UNNORMALIZED_RE.test(rest)) {
        return rest
      }
    }
  }
  return relative(cwd, p)
}

/** `p` relative to `cwd` when both are set and `p` is absolute, else `p` unchanged. */
export function toRelative(p: string, cwd: string | undefined): string {
  return cwd && isAbsolute(p) ? relativeToCwd(cwd, p) : p
}
