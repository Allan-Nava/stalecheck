// The checks. Each takes a parsed document and the repository around it, and returns
// findings — never throws, never guesses.
//
// The rule every one of them obeys: absence of evidence is not evidence. A check that
// cannot establish the truth returns nothing. A finding must name a file and a line, and
// must be something a person can act on without reading this source.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
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

// --- 1. cited paths --------------------------------------------------------------

// `from` decides which check owns the finding. A markdown link asserts a destination a
// reader will click; a backticked path usually names a convention — `.claude/settings.json`
// is where a user puts their config, not a file the repository holds. Measured over 42
// real documents in two repositories, every path finding came from a backtick and none
// from a link, so the two are not the same check and only one of them is on by default.
function pathFindings(doc, ctx, file, wantFrom) {
  const out = []
  const dir = dirname(join(ctx.root, file))
  for (const token of doc.prose) {
    if (token.from !== wantFrom) continue
    if (HISTORICAL.test(file)) continue
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

export const checkPaths = (doc, ctx, file) => pathFindings(doc, ctx, file, 'link')
export const checkMentions = (doc, ctx, file) => pathFindings(doc, ctx, file, 'code')

// A trailing newline terminates the last line; it does not start another. Counting the
// split parts made every file look one line longer, so a citation one past the end went
// unreported and the number in the finding was wrong.
function countLines(text) {
  if (!text) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

// --- 2. line citations -----------------------------------------------------------

export function checkLines(doc, ctx, file) {
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

export function checkVersions(doc, ctx, file) {
  if (!ctx.pkg?.name || !ctx.pkg?.version) return []
  if (/CHANGELOG/i.test(file)) return [] // a changelog is meant to name old versions
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
      out.push(...(c.wants === 'text' ? c.fn(doc, ctx, file, text) : c.fn(doc, ctx, file, options[name] ?? {})))
    } catch {
      /* a check that throws reports nothing rather than failing the run */
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

export { relative }
