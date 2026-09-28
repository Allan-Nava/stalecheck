// The checks. Each takes a parsed document and the repository around it, and returns
// findings — never throws, never guesses.
//
// The rule every one of them obeys: absence of evidence is not evidence. A check that
// cannot establish the truth returns nothing. A finding must name a file and a line, and
// must be something a person can act on without reading this source.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { matchesAny } from './glob.mjs'
import { anchors, asPath, commandsIn, programsIn, scan } from './scan.mjs'

// `subject` is the stable thing a finding is about — the path, the anchor, the script
// name. The message cannot serve: it carries detail that moves on its own, and `dated`
// says how many days ago, which changes every night. A baseline keyed on the message
// would invalidate itself by morning.
const finding = (check, file, line, subject, message, hint) => ({ check, file, line, subject, message, hint })

// --- the repository, asked once -------------------------------------------------

export function repoContext(root) {
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }
  const tracked = git('ls-files')
  const files = new Set((tracked ?? '').split('\n').filter(Boolean))
  // Suffix index: `docs/x.md` cited from a subdirectory is an honest reference, not a
  // missing file. Measured on claimcheck's corpus this was half of all path findings.
  const bySuffix = new Map()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/')
      if (!bySuffix.has(suffix)) bySuffix.set(suffix, f)
    }
  }
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    /* not a node project */
  }
  return { root, files, bySuffix, pkg, isRepo: tracked !== null }
}

const GENERATED = /(?:^|\/)(?:dist|build|out|_site|target|node_modules|coverage|\.next|vendor|graphify-out)\//

// A changelog records what was true at the time: a file it names may be legitimately
// gone, and reporting that is reporting history rather than staleness. Measured on a
// 594-document corpus this was 45 of 140 findings. Anchors are still checked there — a
// dead link is dead whoever wrote it — and `historical` in .stalecheck.json overrides.
const HISTORICAL = /(?:^|\/)(?:CHANGELOG|HISTORY|RELEASES?)(?:[.-][\w-]+)?\.mdx?$/i

// A repository that keeps `docs/incidents/` or `reports/` has the same need as a
// changelog and no way to say so, which until now forced the alternative of turning a
// whole check off. `historical` in .stalecheck.json adds to the rule above; it never
// replaces it, so a changelog stays historical whatever else is configured.
const isHistorical = (file, extra) => HISTORICAL.test(file) || matchesAny(file, extra)

// --- 1. cited paths --------------------------------------------------------------

// `from` decides which check owns the finding. A markdown link asserts a destination a
// reader will click; a backticked path usually names a convention — `.claude/settings.json`
// is where a user puts their config, not a file the repository holds. Measured over 42
// real documents in two repositories, every path finding came from a backtick and none
// from a link, so the two are not the same check and only one of them is on by default.
function pathFindings(doc, ctx, file, wantFrom, options = {}) {
  const out = []
  const dir = dirname(join(ctx.root, file))
  for (const token of doc.prose) {
    if (token.from !== wantFrom) continue
    if (isHistorical(file, options.historical)) continue
    const p = asPath(token.raw)
    if (!p?.path) continue
    // A backticked `guide.md` could name a file in any directory, so its absence proves
    // nothing. A link's destination is relative to the document and unambiguous, so it
    // is checked whether or not it carries a directory.
    if (wantFrom === 'code' && !p.rooted) continue
    if (GENERATED.test(p.path)) continue // absent whenever nobody has built it
    const relToDoc = resolve(dir, p.path)
    const relToRoot = resolve(ctx.root, p.path)
    if (existsSync(relToDoc) || existsSync(relToRoot)) continue
    const elsewhere = ctx.bySuffix.get(p.path.replace(/^\.\//, ''))
    if (elsewhere) continue // cited from another root, but a real file
    out.push(
      wantFrom === 'link'
        ? finding('paths', file, token.line, p.path, `links to \`${p.path}\`, which does not exist`, 'the file was renamed or removed; the link is dead')
        : finding('mentions', file, token.line, p.path, `mentions \`${p.path}\`, which does not exist`, 'a renamed file, or a path the reader is meant to create'),
    )
  }
  return out
}

export const checkPaths = (doc, ctx, file, options) => pathFindings(doc, ctx, file, 'link', options)
export const checkMentions = (doc, ctx, file, options) => pathFindings(doc, ctx, file, 'code', options)

// A trailing newline terminates the last line; it does not start another. Counting the
// split parts made every file look one line longer, so a citation one past the end went
// unreported and the number in the finding was wrong.
function countLines(text) {
  if (!text) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

// --- 2. line citations -----------------------------------------------------------

export function checkLines(doc, ctx, file, options = {}) {
  const out = []
  const dir = dirname(join(ctx.root, file))
  for (const token of doc.prose) {
    if (HISTORICAL.test(file)) continue
    const p = asPath(token.raw)
    if (!p?.path || p.line === null) continue
    const target = [resolve(dir, p.path), resolve(ctx.root, p.path)].find((t) => existsSync(t))
    if (!target) continue // the path check owns a missing file
    let n
    try {
      if (statSync(target).size > 8e6) continue
      n = countLines(readFileSync(target, 'utf8'))
    } catch {
      continue
    }
    if (p.line > n) {
      out.push(finding('lines', file, token.line, `${p.path}:${p.line}`, `cites \`${p.path}:${p.line}\`, but that file has ${n} lines`, 'the code moved; re-anchor the citation'))
    }
  }
  return out
}

// --- 3. anchors ------------------------------------------------------------------

export function checkAnchors(doc, ctx, file, text) {
  const out = []
  const dir = dirname(join(ctx.root, file))
  const cache = new Map()
  const anchorsOf = (path) => {
    if (!cache.has(path)) {
      try {
        cache.set(path, anchors(readFileSync(path, 'utf8')))
      } catch {
        cache.set(path, null)
      }
    }
    return cache.get(path)
  }
  for (const token of doc.prose) {
    if (token.from !== 'link') continue
    const p = asPath(token.raw)
    if (!p?.anchor) continue
    let target
    if (!p.path) target = join(ctx.root, file) // same-document link
    else if (!/\.mdx?$/i.test(p.path)) continue // only Markdown has headings we can read
    else target = [resolve(dir, p.path), resolve(ctx.root, p.path)].find((t) => existsSync(t))
    if (!target) continue
    const have = anchorsOf(target)
    if (!have || have.has(p.anchor.toLowerCase())) continue
    const where = p.path ? `${p.path}#${p.anchor}` : `#${p.anchor}`
    out.push(finding('anchors', file, token.line, where, `links to \`${where}\`, and no heading there makes that anchor`, 'the heading was renamed; link the new one'))
  }
  return out
}

// --- 4. npm scripts the repository does not have ---------------------------------

export function checkScripts(doc, ctx, file) {
  if (!ctx.pkg) return []
  const have = new Set(Object.keys(ctx.pkg.scripts ?? {}))
  const out = []
  for (const block of doc.blocks) {
    for (const cmd of commandsIn(block)) {
      for (const m of cmd.text.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)/g)) {
        if (!have.has(m[1])) {
          out.push(finding('scripts', file, cmd.line, m[1], `documents \`${m[0]}\`, and package.json has no \`${m[1]}\` script`, `scripts are: ${[...have].join(', ') || 'none'}`))
        }
      }
      // `npm test` and `npm start` are their own commands, not `run`.
      for (const m of cmd.text.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(test|start)\b/g)) {
        if (!have.has(m[1])) {
          out.push(finding('scripts', file, cmd.line, m[1], `documents \`${m[0]}\`, and package.json has no \`${m[1]}\` script`, `scripts are: ${[...have].join(', ') || 'none'}`))
        }
      }
    }
  }
  return out
}

// --- 5. the package's own version, quoted in prose -------------------------------

export function checkVersions(doc, ctx, file, options = {}) {
  if (!ctx.pkg?.name || !ctx.pkg?.version) return []
  if (isHistorical(file, options.historical)) return [] // a changelog names old versions on purpose
  const name = ctx.pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${name}@(\\d+\\.\\d+\\.\\d+[\\w.-]*)`, 'g')
  const out = []
  doc.lines.forEach((line, i) => {
    for (const m of line.matchAll(re)) {
      if (m[1] !== ctx.pkg.version) {
        out.push(finding('versions', file, i + 1, m[0], `names \`${m[0]}\`, and package.json is at ${ctx.pkg.version}`, 'bump the document with the release, or drop the version from the example'))
      }
    }
  })
  return out
}

// --- 6. dated facts ---------------------------------------------------------------

export function checkDated(doc, ctx, file, { maxAgeDays = 180, now = Date.now() } = {}) {
  const out = []
  for (const d of doc.dates) {
    const t = Date.parse(`${d.date}T00:00:00Z`)
    if (Number.isNaN(t)) continue
    const age = Math.floor((now - t) / 86400000)
    if (age > maxAgeDays) {
      out.push(finding('dated', file, d.line, `${d.word} ${d.date}`, `states a fact ${d.word} ${d.date}, ${age} days ago`, `older than ${maxAgeDays} days: re-verify it against the source, then move the date`))
    }
  }
  return out
}

// --- 7. fenced data that does not parse ------------------------------------------
// A fenced `json` block is a claim that a reader can paste it and have it work, and when
// it does not parse that claim fails while someone is following the instructions.
//
// JSON and JSONC only. A YAML parser is not something to write without a dependency, and
// this package has none — so `yaml` blocks are left alone rather than half-checked.

const DATA_FENCE = /^(json|jsonc)$/

// A fragment is not a document: an ellipsis, a bare key, or a leading comma all say the
// block is showing a piece of something larger.
const FRAGMENT = /(^|[\s{[,])(\.\.\.|…)|^\s*[.,]|^\s*"[^"]*":\s*$/m

function stripComments(text) {
  // Comments and trailing commas, outside strings. Enough for a configuration example.
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
      continue
    }
    out += c
  }
  return out
}

// Two separate things. A `jsonc` block is allowed both; a `json` block with a `//` line
// naming its file is allowed only the comment. Stripping trailing commas for `json` too
// forgave the very error the check exists to find — the fixture caught it.
const stripJsonc = (text) => stripComments(text).replace(/,(\s*[}\]])/g, '$1')

// Which line of the block the parser tripped on. Node reports a character offset for
// some errors and, for the rest, an excerpt of the source instead — so both are read, and
// when neither is there the first line of the block is the honest answer.
function offsetLine(text, message) {
  const at = Number((message.match(/position (\d+)/) ?? [])[1])
  if (Number.isFinite(at)) return text.slice(0, at).split('\n').length
  const excerpt = (message.match(/\.\.\."([\s\S]*?)"(?:\.\.\.)?\s+is not valid JSON/) ?? [])[1]
  if (excerpt) {
    const idx = text.indexOf(excerpt.trim())
    if (idx >= 0) return text.slice(0, idx + excerpt.trim().length).split('\n').length
  }
  return 1
}

const parses = (text) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// Top-level JSON values, one after another, which is what a JSON Lines example is — and
// a record in one may well span several lines. Depth is counted outside strings, the same
// way the comment stripper walks the text.
function splitValues(text) {
  const out = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      if (depth === 0 && start < 0) start = i
      continue
    }
    if (c === '{' || c === '[') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' || c === ']') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) return null // unbalanced: not a stream of values
    }
  }
  return depth === 0 ? out : null
}

const isValueStream = (body) => {
  const values = splitValues(body)
  if (!values || values.length < 2) return false
  // Every value must parse, and together they must account for the whole block.
  const joined = values.join('').replace(/\s+/g, '')
  return values.every(parses) && joined === body.replace(/\s+/g, '')
}

const parsesWrapped = (text) => {
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    try {
      JSON.parse(`${open}${text}${close}`)
      return true
    } catch {
      /* not that kind of excerpt */
    }
  }
  return false
}

export function checkFences(doc, ctx, file) {
  const out = []
  for (const block of doc.blocks) {
    if (!DATA_FENCE.test(block.lang)) continue
    const body = block.body
    if (!body.trim()) continue
    if (FRAGMENT.test(body)) continue // an ellipsis: a piece of something larger
    // A `//` line naming the file a block belongs in is a convention everyone uses, so
    // comments are removed before parsing either language — `stripComments` puts a
    // newline back in their place, which keeps the reported line honest. Only `jsonc`
    // additionally forgives a trailing comma, because forgiving it in `json` would
    // forgive the very error this check exists to find.
    const text = block.lang === 'jsonc' ? stripJsonc(body) : stripComments(body)
    try {
      JSON.parse(text)
    } catch (e) {
      // Documenting one key by showing it without the braces around it is ordinary and
      // useful — `"safety": { … }` on its own. If the block parses once it is wrapped,
      // it is a valid excerpt of an object or an array, not a broken document. Measured
      // on two real repositories this was every finding but one.
      // A trailing comma at the very end of a block is the mark of an excerpt, not an
      // error inside it. Only that one is forgiven before asking whether the block is a
      // valid piece of a larger object — a comma anywhere else stays an error.
      if (parsesWrapped(text.replace(/,\s*$/, ''))) continue
      // JSON Lines: one object per line is a format, not a broken document, and the
      // repositories measured document it that way.
      if (isValueStream(body)) continue
      const line = block.start + offsetLine(text, e.message)
      // The parser's message carries an excerpt of the source, which the finding already
      // points at by line. Keep the diagnosis, drop the quotation.
      const why = e.message
        .replace(/^JSON\.parse:\s*/, '')
        .replace(/\s*in JSON at position \d+.*$/, '')
        .replace(/,\s*\.\.\.[\s\S]*$/, '')
        .replace(/\s+is not valid JSON$/, '')
        .trim()
      out.push(
        finding('fences', file, line, `${block.lang}@${block.start}`, `a fenced \`${block.lang}\` block does not parse: ${why}`, 'a reader pasting this gets an error; fix it or mark the block as an excerpt'),
      )
    }
  }
  return out
}

// --- 7. programs the document invokes --------------------------------------------
// Off by default: a document may legitimately tell a reader to run something they are
// expected to install. Useful pointed at a repository's own tooling.

export function checkPrograms(doc, ctx, file, { path = process.env.PATH ?? '' } = {}) {
  const dirs = path.split(':').filter(Boolean)
  const out = []
  const seen = new Set()
  for (const block of doc.blocks) {
    for (const cmd of commandsIn(block)) {
      for (const prog of programsIn(cmd.text)) {
        if (seen.has(prog)) continue
        if (prog.includes('/')) {
          // A path to a script in this repository: that one we can be sure about.
          const target = resolve(ctx.root, prog.replace(/^\.\//, ''))
          if (!existsSync(target)) {
            seen.add(prog)
            out.push(finding('programs', file, cmd.line, prog, `runs \`${prog}\`, which is not in this repository`, 'the script moved or was removed'))
          }
          continue
        }
        const found = dirs.some((d) => existsSync(join(d, prog)))
        if (!found) {
          seen.add(prog)
          out.push(finding('programs', file, cmd.line, prog, `runs \`${prog}\`, which is not on PATH here`, 'a tool the reader must install, or a command that no longer exists'))
        }
      }
    }
  }
  return out
}

// --- the set ----------------------------------------------------------------------

// One source for what each check is: the CLI prints `short`, SARIF publishes both as the
// rule's descriptions, and there is nowhere for the two to drift apart.
export const CHECKS = {
  paths: {
    fn: checkPaths,
    default: true,
    wants: 'doc',
    short: 'a link to a file that does not exist',
    long: 'A Markdown link whose target is not in the repository, at the path it names or anywhere else under it. The file was renamed or removed and the link was left behind, so a reader following it lands nowhere.',
  },
  mentions: {
    fn: checkMentions,
    default: false,
    wants: 'doc',
    short: 'a backticked path that does not exist (noisy: names conventions too)',
    long: 'A path written in backticks that is not in the repository. Off by default: prose names conventions as well as files — `.claude/settings.json` is where a reader puts their own configuration, not something the repository is missing.',
  },
  lines: {
    fn: checkLines,
    default: true,
    wants: 'doc',
    short: 'a path:line citation past the end of the file',
    long: 'A citation of the form path:line where the file has fewer lines than that. The code moved and the citation stayed, so it points past the end of what it claims to describe.',
  },
  anchors: {
    fn: checkAnchors,
    default: true,
    wants: 'text',
    short: 'a #anchor link with no heading behind it',
    long: 'A link to a #anchor that no heading in the target document produces. The heading was renamed or renumbered, so the link opens the document and jumps nowhere — which is quiet enough that nobody notices.',
  },
  scripts: {
    fn: checkScripts,
    default: true,
    wants: 'doc',
    short: 'an npm script the manifest has not got',
    long: 'A documented `npm run X` where package.json has no X script. A reader following the instructions gets an error from npm, not from the project.',
  },
  versions: {
    fn: checkVersions,
    default: true,
    wants: 'doc',
    short: "the package's own version, quoted stale",
    long: "A document naming this package at a version that is not the one package.json states. Changelogs are exempt, since naming old versions is what they are for.",
  },
  dated: {
    fn: checkDated,
    default: true,
    wants: 'doc',
    short: 'a fact dated long enough ago to be worth re-reading',
    long: 'A fact the document dates — "read 2026-09-22", "verified", "checked", "as of" — older than the age limit. The claim was true when it was written; whether it still is has not been established since.',
  },
  fences: {
    fn: checkFences,
    default: true,
    wants: 'doc',
    short: 'a fenced json block that does not parse',
    long: 'A fenced `json` or `jsonc` block that is not valid, so a reader who pastes it gets an error from the parser rather than from the project. Blocks that show a fragment — an ellipsis, a bare key — are left alone. YAML is not checked: a parser for it is not something to write without a dependency, and this package has none.',
  },
  programs: {
    fn: checkPrograms,
    default: false,
    wants: 'doc',
    short: 'a command that is not on PATH or in the repository',
    long: 'A command a fenced shell block invokes that is neither on PATH here nor a script in the repository. Off by default: documentation legitimately tells a reader to run things they are expected to install.',
  },
}

export function checkDocument(text, ctx, file, options = {}) {
  const doc = scan(text)
  const enabled = options.checks ?? Object.entries(CHECKS).filter(([, c]) => c.default).map(([k]) => k)
  const out = []
  for (const name of enabled) {
    const c = CHECKS[name]
    if (!c) continue
    try {
      // Every check receives its own options plus the ones that are not its alone —
      // `historical` decides what counts as a record of the past for all of them.
      const shared = { historical: options.historical }
      out.push(...(c.wants === 'text' ? c.fn(doc, ctx, file, text) : c.fn(doc, ctx, file, { ...shared, ...(options[name] ?? {}) })))
    } catch {
      /* a check that throws reports nothing rather than failing the run */
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

export { relative }
