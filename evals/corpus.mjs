#!/usr/bin/env node
// What stalecheck says about real documentation. Point it at repositories you have and
// it reports the density per check and a sample of each, which is the only way to tell a
// useful check from a noisy one.
//
//   node evals/corpus.mjs ~/projects/a ~/projects/b
//   node evals/corpus.mjs --all ~/projects/*      include the off-by-default checks
//   node evals/corpus.mjs --write ~/projects/a    …and evals/results/<date>-corpus.json
//
// A check that fires on more than about half a document without a matching share of true
// findings belongs behind a flag. That is how `mentions` and `programs` ended up off.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKS } from '../lib/checks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(dirname(HERE), 'bin', 'stalecheck.mjs')
const argv = process.argv.slice(2)
const all = argv.includes('--all')
const write = argv.includes('--write')
const roots = argv.filter((a) => !a.startsWith('--'))

if (!roots.length) {
  process.stderr.write('usage: node evals/corpus.mjs [--all] [--write] <repo> [repo...]\n')
  process.exit(2)
}

const only = all ? Object.keys(CHECKS).join(',') : null

const runs = []
for (const root of roots) {
  if (!existsSync(root)) {
    process.stderr.write(`skipping ${root}: not there\n`)
    continue
  }
  const args = [CLI, root, '--json', ...(only ? ['--only', only] : [])]
  let out
  try {
    // execFileSync throws on a non-zero exit, which is exactly what a run with findings
    // does, so the output is taken from the error as readily as from the return.
    out = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 256e6 })
  } catch (e) {
    out = e.stdout ?? ''
  }
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    process.stderr.write(`skipping ${root}: unreadable output\n`)
    continue
  }
  runs.push({ name: basename(root), root, ...parsed })
}

const pad = (s, n) => String(s).padEnd(n)
const names = Object.keys(CHECKS).filter((c) => all || CHECKS[c].default)

console.log(`${runs.length} repositories, checks: ${names.join(', ')}\n`)
console.log(`${pad('repository', 16)}${pad('docs', 7)}${pad('findings', 10)}${pad('per doc', 9)}${names.map((n) => pad(n, 10)).join('')}`)
for (const r of runs) {
  const per = (r.findings.length / Math.max(1, r.documents)).toFixed(2)
  console.log(
    pad(r.name, 16) + pad(r.documents, 7) + pad(r.findings.length, 10) + pad(per, 9) + names.map((n) => pad(r.byCheck[n] ?? 0, 10)).join(''),
  )
}

const totals = { documents: 0, findings: 0 }
const byCheck = {}
for (const r of runs) {
  totals.documents += r.documents
  totals.findings += r.findings.length
  for (const [k, v] of Object.entries(r.byCheck)) byCheck[k] = (byCheck[k] ?? 0) + v
}
console.log(`\n${pad('total', 16)}${pad(totals.documents, 7)}${pad(totals.findings, 10)}${pad((totals.findings / Math.max(1, totals.documents)).toFixed(2), 9)}${names.map((n) => pad(byCheck[n] ?? 0, 10)).join('')}`)

console.log('\nA sample of each check — read these, do not trust the counts:')
for (const name of names) {
  const sample = runs.flatMap((r) => r.findings.filter((f) => f.check === name).map((f) => ({ ...f, repo: r.name }))).slice(0, 4)
  console.log(`\n  ${name} (${byCheck[name] ?? 0})`)
  if (!sample.length) console.log('    nothing')
  for (const f of sample) console.log(`    ${f.repo}/${f.file}:${f.line}  ${f.message}`)
}

if (write) {
  const dir = join(HERE, 'results')
  mkdirSync(dir, { recursive: true })
  const at = new Date()
  const file = join(dir, `${at.toISOString().slice(0, 10)}-corpus.json`)
  writeFileSync(
    file,
    JSON.stringify(
      {
        at: at.toISOString(),
        node: process.version,
        checks: names,
        totals: { ...totals, perDocument: totals.findings / Math.max(1, totals.documents) },
        byCheck,
        repositories: runs.map((r) => ({ name: r.name, documents: r.documents, findings: r.findings.length, byCheck: r.byCheck })),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`\nwrote ${file}`)
}
