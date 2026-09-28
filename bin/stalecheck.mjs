#!/usr/bin/env node
// stalecheck — verifies that what the documentation says is still true.
//
//   stalecheck                     every tracked Markdown file under the current repo
//   stalecheck docs/ README.md     only these
//   stalecheck --only paths,lines  only these checks
//   stalecheck --max-age 90        a dated fact older than 90 days is stale
//   stalecheck --json              machine-readable, for CI
//   stalecheck --warn              report everything, always exit 0
//
// Deterministic: no model, no network. It never runs a command it finds in a document.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { CHECKS, checkDocument, repoContext } from '../lib/checks.mjs'
import * as baseline from '../lib/baseline.mjs'

const DESCRIPTIONS = {
  paths: 'a link to a file that does not exist',
  mentions: 'a backticked path that does not exist (noisy: names conventions too)',
  lines: 'a path:line citation past the end of the file',
  anchors: 'a #anchor link with no heading behind it',
  scripts: 'an npm script the manifest has not got',
  versions: "the package's own version, quoted stale",
  dated: 'a fact dated long enough ago to be worth re-reading',
  programs: 'a command that is not on PATH or in the repository',
}

const argv = process.argv.slice(2)
const TAKES_VALUE = new Set(['only', 'max-age', 'baseline'])
const flags = new Set()
const values = new Map()
const positional = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) {
    positional.push(a)
    continue
  }
  const name = a.slice(2)
  if (TAKES_VALUE.has(name)) values.set(name, argv[++i])
  else flags.add(name)
}
const flag = (name) => flags.has(name)
const value = (name, fallback) => values.get(name) ?? fallback

if (flag('help') || flag('h')) {
  process.stdout.write(
    [
      'stalecheck — verifies that what the documentation says is still true.',
      '',
      'usage: stalecheck [paths...] [options]',
      '',
      'checks:',
      ...Object.entries(CHECKS).map(([name, c]) => `  ${name.padEnd(10)}${c.default ? 'on ' : 'off'}   ${DESCRIPTIONS[name]}`),
      '',
      'options:',
      '  --only a,b      run only these checks        --max-age <days>  dated fact limit (180)',
      '  --json          machine-readable output      --warn            always exit 0',
      '  --quiet         findings only, no summary    --version',
      '',
      '  --baseline <file>    fail only on findings that are not already in <file>;',
      '                       writes it, with everything found now, when it is not there',
      '  --update-baseline    rewrite it from this run, dropping what has been fixed',
      '',
    ].join('\n'),
  )
  process.exit(0)
}


if (flag('version')) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}

// --- what to read ---------------------------------------------------------------

const targets = positional
const root = findRoot(resolve(targets[0] ?? '.'))

// The repository root, or the directory that was named — never further up. Returning
// the filesystem root when no .git is found made a run outside a repository walk the
// whole disk, which is a denial of service dressed as a documentation check.
function findRoot(start) {
  const base = existsSync(start) && statSync(start).isDirectory() ? start : resolve(start, '..')
  let dir = base
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return base
}

const IGNORE = /(?:^|\/)(?:node_modules|\.git|dist|build|out|_site|target|coverage|\.next|vendor|graphify-out)(?:\/|$)/

function walk(dir, acc = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (IGNORE.test(relative(root, p))) continue
    if (e.isDirectory()) walk(p, acc)
    else if (/\.mdx?$/i.test(e.name)) acc.push(p)
  }
  return acc
}

function collect() {
  if (targets.length) {
    const out = []
    for (const t of targets) {
      const p = resolve(t)
      if (!existsSync(p)) continue
      if (statSync(p).isDirectory()) out.push(...walk(p))
      else if (/\.mdx?$/i.test(p)) out.push(p)
    }
    return out
  }
  // In a repository, ask git: it respects .gitignore and skips what is not committed.
  try {
    const listed = execFileSync('git', ['ls-files', '*.md', '*.mdx'], { cwd: root, encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((f) => join(root, f))
      .filter((f) => !IGNORE.test(relative(root, f)))
    if (listed.length) return listed
  } catch {
    /* not a repository, or git is absent */
  }
  return walk(root)
}

// --- config ----------------------------------------------------------------------

let config = {}
for (const name of ['.stalecheck.json', '.config/stalecheck.json']) {
  const p = join(root, name)
  if (!existsSync(p)) continue
  try {
    config = JSON.parse(readFileSync(p, 'utf8'))
    break
  } catch {
    process.stderr.write(`stalecheck: ${name} is not valid JSON — ignoring it\n`)
  }
}

const only = value('only', config.only ? [].concat(config.only).join(',') : null)
const checks = only ? only.split(',').map((s) => s.trim()).filter((s) => CHECKS[s]) : config.checks ?? undefined
const maxAgeDays = Number(value('max-age', config.maxAgeDays ?? 180))
const asJson = flag('json')
const quiet = flag('quiet')
const warnOnly = flag('warn') || config.warn === true
const baselinePath = value('baseline', config.baseline ?? null)
const updateBaseline = flag('update-baseline')

// --- run --------------------------------------------------------------------------

const ctx = repoContext(root)
const files = collect()
const findings = []

for (const file of files) {
  let text
  try {
    if (statSync(file).size > 4e6) continue
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const rel = relative(root, file)
  findings.push(...checkDocument(text, ctx, rel, { checks, dated: { maxAgeDays } }))
}

// --- the baseline ---------------------------------------------------------------------
// Everything below reports on `shown`. With no baseline that is every finding; with one
// it is the findings that are new, which is the only set a gate should act on.

let shown = findings
let baseState = null

if (baselinePath) {
  const resolved = resolve(root, baselinePath)
  const existing = baseline.read(resolved)

  if (existing?.error) {
    process.stderr.write(`stalecheck: ${baselinePath} is ${existing.error} — ignoring it and reporting everything\n`)
  } else if (!existing || updateBaseline) {
    const { count, changed } = baseline.write(resolved, findings)
    if (!asJson) {
      if (!changed) {
        process.stdout.write(`${baselinePath} already records exactly these ${count} finding${count === 1 ? '' : 's'} — left untouched.\n`)
      } else {
        process.stdout.write(`${existing ? 'Rewrote' : 'Wrote'} ${baselinePath}: ${count} finding${count === 1 ? '' : 's'} recorded.\n`)
        process.stdout.write('From now on stalecheck fails only on findings that are not in it.\n')
      }
    }
    baseState = { wrote: true, recorded: count, changed }
    shown = []
  } else {
    const { fresh, known, resolved: fixed } = baseline.compare(findings, existing)
    shown = fresh
    baseState = { recorded: existing.findings.length, known: known.length, fresh: fresh.length, resolved: fixed, since: existing.recorded }
  }
}

// --- report -------------------------------------------------------------------------

const byCheck = {}
for (const f of shown) (byCheck[f.check] ??= []).push(f)

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        root,
        documents: files.length,
        findings: shown,
        byCheck: Object.fromEntries(Object.entries(byCheck).map(([k, v]) => [k, v.length])),
        ...(baseState ? { baseline: { path: baselinePath, ...baseState, total: findings.length } } : {}),
      },
      null,
      2,
    ) + '\n',
  )
} else {
  let lastFile = null
  for (const f of shown) {
    if (f.file !== lastFile) {
      process.stdout.write(`\n${f.file}\n`)
      lastFile = f.file
    }
    process.stdout.write(`  ${String(f.line).padStart(5)}  ${f.check.padEnd(9)} ${f.message}\n`)
    if (f.hint && !quiet) process.stdout.write(`         ${' '.repeat(9)} ${f.hint}\n`)
  }
  if (!quiet && !baseState?.wrote) {
    const ran = checks ?? Object.entries(CHECKS).filter(([, c]) => c.default).map(([k]) => k)
    const label = baseState ? 'new finding' : 'finding'
    process.stdout.write(`\n${files.length} document${files.length === 1 ? '' : 's'}, ${shown.length} ${label}${shown.length === 1 ? '' : 's'}`)
    process.stdout.write(shown.length ? ` — ${Object.entries(byCheck).map(([k, v]) => `${k} ${v.length}`).join(', ')}\n` : '\n')
    if (baseState) {
      process.stdout.write(`${baseState.known} already in ${baselinePath}, recorded ${String(baseState.since).slice(0, 10)}\n`)
      if (baseState.resolved.length) {
        process.stdout.write(`\n${baseState.resolved.length} recorded finding${baseState.resolved.length === 1 ? ' has' : 's have'} been fixed since:\n`)
        for (const r of baseState.resolved.slice(0, 10)) process.stdout.write(`  ${r.file}  ${r.check.padEnd(9)} ${r.message}\n`)
        if (baseState.resolved.length > 10) process.stdout.write(`  …and ${baseState.resolved.length - 10} more\n`)
        process.stdout.write('Run with --update-baseline to drop them from the file.\n')
      }
    }
    process.stdout.write(`checks: ${ran.join(', ')}\n`)
  }
}

// Not process.exit(): it tears the process down before a large stdout write has flushed
// to a pipe, which silently truncated the JSON for any consumer reading it — a CI job,
// or evals/corpus.mjs. Setting the code lets Node exit once the write completes.
process.exitCode = warnOnly || !shown.length ? 0 : 1
