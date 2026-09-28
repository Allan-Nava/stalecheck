// A small glob matcher, because the alternative is a dependency in a tool that promises
// none. It covers what a configuration file actually writes: `docs/**`, `*.md`,
// `thoughts/**/*.md`, `reports/?.md`.
//
//   *   any run of characters within one segment
//   **  any number of segments, including none
//   ?   one character within one segment
//
// Paths are matched with forward slashes, the way git reports them. A pattern with no
// slash matches the basename anywhere, which is what people mean by `*.log`.

const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

function toRegExp(pattern) {
  const p = pattern.replace(/^\.\//, '').replace(/\/+$/, '/**')
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    // A trailing `/**` covers the directory itself as well as everything under it, which
    // is what `ignore: ["docs/**"]` is understood to mean.
    if (c === '/' && p[i + 1] === '*' && p[i + 2] === '*' && i + 3 === p.length) {
      out += '(?:/.*)?'
      break
    }
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` swallows the slash it precedes, so `a/**/b.md` also matches `a/b.md`.
        if (p[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') out += '[^/]'
    else out += escape(c)
  }
  return new RegExp(`^${out}$`)
}

const cache = new Map()
const compiled = (pattern) => {
  if (!cache.has(pattern)) cache.set(pattern, toRegExp(pattern))
  return cache.get(pattern)
}

/** True when `path` (repository-relative, forward slashes) matches any pattern. */
export function matchesAny(path, patterns) {
  if (!patterns?.length) return false
  const clean = String(path).replace(/^\.\//, '')
  const base = clean.slice(clean.lastIndexOf('/') + 1)
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern) continue
    const re = compiled(pattern)
    if (re.test(clean)) return true
    // A pattern with no slash is about the name, wherever the file sits.
    if (!pattern.includes('/') && re.test(base)) return true
  }
  return false
}
