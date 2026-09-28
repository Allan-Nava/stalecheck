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

const finding = (check, file, line, message, hint) => ({ check, file, line, message, hint })

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
        ? finding('paths', file, token.line, `links to \`${p.path}\`, which does not exist`, 'the file was renamed or removed; the link is dead')
        : finding('mentions', file, token.line, `mentions \`${p.path}\`, which does not exist`, 'a renamed file, or a path the reader is meant to create'),
    )
  }
  return out
}

export const checkPaths = (doc, ctx, file) => pathFindings(doc, ctx, file, 'link')
export const checkMentions = (doc, ctx, file) => pathFindings(doc, ctx, file, 'code')

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
      n = readFileSync(target, 'utf8').split('\n').length
    } catch {
      continue
    }
    if (p.line > n) {
      out.push(finding('lines', file, token.line, `cites \`${p.path}:${p.line}\`, but that file has ${n} lines`, 'the code moved; re-anchor the citation'))
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
    out.push(finding('anchors', file, token.line, `links to \`${where}\`, and no heading there makes that anchor`, 'the heading was renamed; link the new one'))
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
          out.push(finding('scripts', file, cmd.line, `documents \`${m[0]}\`, and package.json has no \`${m[1]}\` script`, `scripts are: ${[...have].join(', ') || 'none'}`))
        }
      }
      // `npm test` and `npm start` are their own commands, not `run`.
      for (const m of cmd.text.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(test|start)\b/g)) {
        if (!have.has(m[1])) {
          out.push(finding('scripts', file, cmd.line, `documents \`${m[0]}\`, and package.json has no \`${m[1]}\` script`, `scripts are: ${[...have].join(', ') || 'none'}`))
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
        out.push(finding('versions', file, i + 1, `names \`${m[0]}\`, and package.json is at ${ctx.pkg.version}`, 'bump the document with the release, or drop the version from the example'))
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
      out.push(finding('dated', file, d.line, `states a fact ${d.word} ${d.date}, ${age} days ago`, `older than ${maxAgeDays} days: re-verify it against the source, then move the date`))
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
            out.push(finding('programs', file, cmd.line, `runs \`${prog}\`, which is not in this repository`, 'the script moved or was removed'))
          }
          continue
        }
        const found = dirs.some((d) => existsSync(join(d, prog)))
        if (!found) {
          seen.add(prog)
          out.push(finding('programs', file, cmd.line, `runs \`${prog}\`, which is not on PATH here`, 'a tool the reader must install, or a command that no longer exists'))
        }
      }
    }
  }
  return out
}

// --- the set ----------------------------------------------------------------------

export const CHECKS = {
  paths: { fn: checkPaths, default: true, wants: 'doc' },
  mentions: { fn: checkMentions, default: false, wants: 'doc' },
  lines: { fn: checkLines, default: true, wants: 'doc' },
  anchors: { fn: checkAnchors, default: true, wants: 'text' },
  scripts: { fn: checkScripts, default: true, wants: 'doc' },
  versions: { fn: checkVersions, default: true, wants: 'doc' },
  dated: { fn: checkDated, default: true, wants: 'doc' },
  programs: { fn: checkPrograms, default: false, wants: 'doc' },
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
