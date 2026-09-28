// Reading a Markdown document as claims that can be checked.
//
// Everything here is line-based and deliberately dumb: a document is scanned once,
// fenced blocks are tracked so prose rules do not fire inside code and code rules do
// not fire inside prose, and every claim carries the line it was made on. A finding
// without a line number is a finding nobody acts on.

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/

// A path in prose is only a path when the document presents it as one: a link target,
// or a backticked token. A bare word with a slash in it is not evidence of anything.
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const INLINE_CODE = /`([^`\n]+)`/g

// Extensions a repository actually holds. Without this, every `1.2.3` and `a.b` in
// prose becomes a path that does not exist.
export const SOURCE_EXT =
  /\.(?:mjs|cjs|jsx?|tsx?|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|ya?ml|toml|json|jsonl|md|mdx|html|css|scss|txt|env|lock|cfg|ini|conf|service|tf|tfvars|dockerfile|gitignore)$/i

/**
 * One pass over a document.
 * @returns {{lines: string[], blocks: Array, prose: Array, dates: Array}}
 *   blocks — fenced code blocks with their language, start line and body
 *   prose  — every path-shaped token outside a fence, with its line
 *   dates  — every "read|verified|checked YYYY-MM-DD" with its line
 */
export function scan(text) {
  const lines = text.split('\n')
  const blocks = []
  const prose = []
  const dates = []

  let fence = null // {marker, indent, lang, start, body[]}

  lines.forEach((line, i) => {
    const lineNo = i + 1

    if (fence) {
      // A fence closes on a marker of at least the opening length, nothing else on it.
      const close = line.match(/^(\s*)(`{3,}|~{3,})\s*$/)
      if (close && close[2][0] === fence.marker[0] && close[2].length >= fence.marker.length) {
        blocks.push({ lang: fence.lang, start: fence.start, end: lineNo, body: fence.body.join('\n') })
        fence = null
      } else {
        fence.body.push(line)
      }
      return
    }

    const open = line.match(FENCE)
    if (open) {
      fence = { marker: open[2], indent: open[1], lang: (open[3] || '').toLowerCase(), start: lineNo, body: [] }
      return
    }

    // --- prose on this line ---
    for (const m of line.matchAll(LINK)) prose.push({ raw: m[1], line: lineNo, from: 'link' })
    for (const m of line.matchAll(INLINE_CODE)) prose.push({ raw: m[1].trim(), line: lineNo, from: 'code' })

    // "read 2026-09-22", "verified 2026-09-22", "checked 2026-09-22", "as of 2026-09-22"
    for (const m of line.matchAll(/\b(read|verified|checked|as of|measured|letto|verificato)\s+(\d{4}-\d{2}-\d{2})\b/gi)) {
      dates.push({ word: m[1].toLowerCase(), date: m[2], line: lineNo })
    }
  })

  // An unterminated fence is still a block: the rest of the document is inside it.
  if (fence) blocks.push({ lang: fence.lang, start: fence.start, end: lines.length, body: fence.body.join('\n'), unterminated: true })

  return { lines, blocks, prose, dates }
}

/**
 * Split a prose token into the path and the line it cites, when it is path-shaped.
 * Returns null for anything that is not a path: a URL, a glob, a flag, a bare word.
 */
export function asPath(raw) {
  if (!raw) return null
  if (/…|\.\.\./.test(raw)) return null // an abbreviation in prose, not a destination
  const hash = raw.indexOf('#')
  const anchor = hash >= 0 ? raw.slice(hash + 1) : null
  let p = hash >= 0 ? raw.slice(0, hash) : raw

  const colon = p.lastIndexOf(':')
  let line = null
  if (colon > 0 && /^\d+$/.test(p.slice(colon + 1))) {
    line = Number(p.slice(colon + 1))
    p = p.slice(0, colon)
  }

  if (!p) return anchor ? { path: null, anchor, line: null, rooted: false } : null
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null // a scheme: http:, mailto:, node:
  if (/[*?<>|"\s]/.test(p)) return null // a glob or prose
  if (/…|\.\.\./.test(p)) return null // an abbreviation in prose, not a destination
  if (p.startsWith('~') || p.startsWith('$')) return null // a home or a variable
  if (p.startsWith('-')) return null // a flag
  // A leading slash in prose is a site route far more often than a file at the root.
  if (p.startsWith('/')) return null
  if (!SOURCE_EXT.test(p) && !p.endsWith('/')) return null

  return { path: p, anchor, line, rooted: p.includes('/') }
}

/** The headings of a document, as GitHub slugs, for checking `#anchor` links. */
export function anchors(text) {
  const out = new Set()
  const { lines, blocks } = scan(text)
  const inBlock = (n) => blocks.some((b) => n >= b.start && n <= b.end)
  lines.forEach((line, i) => {
    if (inBlock(i + 1)) return
    const m = line.match(/^#{1,6}\s+(.*?)\s*$/)
    if (!m) return
    out.add(
      m[1]
        .replace(/`/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        // One hyphen per whitespace character. GitHub does not collapse runs, so a
        // heading with an em-dash in it slugs to a double hyphen — collapsing here
        // reported four healthy links as broken across two repositories.
        .replace(/\s/g, '-'),
    )
  })
  return out
}

/**
 * The commands a fenced shell block runs, one per logical command, with the line each
 * begins on. Continuations, comments, heredoc bodies and blank lines are not commands.
 */
export function commandsIn(block) {
  if (!/^(?:bash|sh|shell|console|zsh|terminal)$/.test(block.lang)) return []
  const out = []
  let lineNo = block.start // the fence itself
  let continued = false
  let heredoc = null

  for (const raw of block.body.split('\n')) {
    lineNo++
    const line = raw.trimEnd()

    if (heredoc) {
      if (line.trim() === heredoc) heredoc = null
      continue
    }
    const hd = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)
    if (hd) heredoc = hd[1]

    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continued = false
      continue
    }
    if (!continued) {
      // A console block may prefix the command with a prompt.
      out.push({ text: trimmed.replace(/^[$>]\s+/, ''), line: lineNo })
    } else {
      out[out.length - 1].text += ' ' + trimmed
    }
    continued = trimmed.endsWith('\\')
  }
  return out
}

/**
 * The programs a command line invokes: the first word, and the first word after every
 * `&&`, `||`, `;` and `|`. Assignments, builtins and control words are not programs.
 */
const NOT_A_PROGRAM = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'function', 'return', 'exit', 'break', 'continue', 'cd', 'export', 'set', 'unset', 'local',
  'read', 'echo', 'printf', 'source', 'eval', 'exec', 'trap', 'shift', 'test', 'true', 'false',
  'alias', 'time', 'wait', 'jobs', 'kill', 'umask', 'pushd', 'popd', 'sudo', 'env', 'command',
])

export function programsIn(commandText) {
  const out = []
  for (const part of commandText.split(/\s*(?:&&|\|\||[;|])\s*/)) {
    const words = part.trim().split(/\s+/)
    let i = 0
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++ // FOO=bar cmd
    const w = words[i]
    if (!w) continue
    if (NOT_A_PROGRAM.has(w)) continue
    if (/^[-$'"(){}]/.test(w)) continue
    if (/[*?$`]/.test(w)) continue // substitution or glob: not a literal program
    out.push(w)
  }
  return out
}
