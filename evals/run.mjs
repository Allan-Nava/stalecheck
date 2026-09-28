#!/usr/bin/env node
// Scores the checks against evals/documents.jsonl — labelled documents with the findings
// they should and should not produce. `corpus.mjs` counts findings over real repositories
// and never asks whether any of them is right: 101 findings could be 101 false positives
// and the number would look the same. This is the half that asks.
//
//   node evals/run.mjs               the table
//   node evals/run.mjs --misses      …and every fixture it got wrong
//   node evals/run.mjs --write       …and evals/results/<date>-accuracy.json
//
// Each fixture is built as a real git repository and read by the real CLI, because the
// contract is what the command prints, not what a function returns.
//
// A false positive is a maintainer sent to look at healthy documentation, so precision is
// the number that matters; recall is the one to trade away.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKS } from '../lib/checks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(dirname(HERE), 'bin', 'stalecheck.mjs')
const argv = process.argv.slice(2)
const showMisses = argv.includes('--misses')
const write = argv.includes('--write')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

function build(files) {
  const dir = mkdtempSync(join(tmpdir(), 'stalecheck-eval-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'eval@example.com')
  git(dir, 'config', 'user.name', 'eval')
  git(dir, 'config', 'commit.gpgsign', 'false')
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(p)), { recursive: true })
    writeFileSync(join(dir, p), body)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'fixture')
  return dir
}

function findings(dir) {
  let out
  try {
    out = execFileSync('node', [CLI, dir, '--json'], { encoding: 'utf8', maxBuffer: 64e6 })
  } catch (e) {
    out = e.stdout ?? '' // a run with findings exits 1, which is most of these
  }
  try {
    return JSON.parse(out).findings
  } catch {
    return null
  }
}

const key = (f) => `${f.check}|${f.file}|${f.line}`

const rows = readFileSync(join(HERE, 'documents.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

const names = Object.keys(CHECKS)
const stats = Object.fromEntries(names.map((n) => [n, { tp: 0, fp: 0, fn: 0 }]))
const misses = []
let broken = 0

for (const row of rows) {
  const dir = build(row.files)
  const got = findings(dir)
  rmSync(dir, { recursive: true, force: true })
  if (got === null) {
    broken++
    misses.push({ fixture: row.name, kind: 'unreadable output' })
    continue
  }

  // Multiset comparison: two identical findings on one line are two findings.
  const wanted = row.expect.map(key)
  const actual = got.map(key)
  const pool = [...wanted]
  for (const a of actual) {
    const i = pool.indexOf(a)
    if (i >= 0) {
      pool.splice(i, 1)
      stats[a.split('|')[0]].tp++
    } else {
      const check = a.split('|')[0]
      stats[check].fp++
      misses.push({ fixture: row.name, kind: 'false positive', check, at: a })
    }
  }
  for (const w of pool) {
    const check = w.split('|')[0]
    stats[check].fn++
    misses.push({ fixture: row.name, kind: 'missed', check, at: w })
  }
}

const div = (a, b) => (b ? a / b : null)
const pct = (x) => (x === null ? '—' : `${(100 * x).toFixed(1)}%`)

const summary = {}
for (const [name, s] of Object.entries(stats)) {
  const precision = div(s.tp, s.tp + s.fp)
  const recall = div(s.tp, s.tp + s.fn)
  summary[name] = { ...s, precision, recall, f1: precision && recall ? (2 * precision * recall) / (precision + recall) : null }
}

const totals = Object.values(stats).reduce((a, s) => ({ tp: a.tp + s.tp, fp: a.fp + s.fp, fn: a.fn + s.fn }), { tp: 0, fp: 0, fn: 0 })

console.log(`documents.jsonl: ${rows.length} fixtures, ${rows.filter((r) => r.expect.length).length} expecting a finding\n`)
console.log('check       tp    fp    fn   precision   recall')
for (const [name, s] of Object.entries(summary)) {
  if (!s.tp && !s.fp && !s.fn) continue
  console.log(`${name.padEnd(10)}${String(s.tp).padStart(4)}${String(s.fp).padStart(6)}${String(s.fn).padStart(6)}${pct(s.precision).padStart(12)}${pct(s.recall).padStart(9)}`)
}
console.log(
  `${'total'.padEnd(10)}${String(totals.tp).padStart(4)}${String(totals.fp).padStart(6)}${String(totals.fn).padStart(6)}` +
    `${pct(div(totals.tp, totals.tp + totals.fp)).padStart(12)}${pct(div(totals.tp, totals.tp + totals.fn)).padStart(9)}`,
)

if (misses.length) {
  console.log(`\n${misses.length} fixture(s) scored wrong` + (showMisses ? ':' : ' — run with --misses to see them'))
  if (showMisses) for (const m of misses) console.log(`  [${m.kind}] ${m.fixture}${m.at ? ` → ${m.at}` : ''}`)
} else {
  console.log('\nnothing scored wrong')
}

if (write) {
  const dir = join(HERE, 'results')
  mkdirSync(dir, { recursive: true })
  const at = new Date()
  const file = join(dir, `${at.toISOString().slice(0, 10)}-accuracy.json`)
  writeFileSync(file, JSON.stringify({ at: at.toISOString(), node: process.version, fixtures: rows.length, summary, totals, misses }, null, 2) + '\n')
  console.log(`\nwrote ${file}`)
}

// A false positive sends a maintainer to look at healthy documentation; CI treats it as
// a failure. A missed finding only costs coverage and is reported.
process.exitCode = totals.fp || broken ? 1 : 0
