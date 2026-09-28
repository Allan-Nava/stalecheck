#!/usr/bin/env node
// What stalecheck costs. It is meant to run in CI over a whole documentation tree, so
// the numbers that matter are how it scales with the number of documents and which
// check dominates.
//
//   node evals/bench.mjs                 the table, on a synthetic corpus
//   node evals/bench.mjs --write         …and evals/results/<date>-bench.json
//   node evals/bench.mjs --runs 10       more samples per case (default 5)
//   node evals/bench.mjs --real <repo>   …and time a real repository too
//
// No network. Node's own startup is measured first and reported beside every case,
// because a short run is mostly the interpreter and claiming otherwise would flatter
// the tool.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKS } from '../lib/checks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(dirname(HERE), 'bin', 'stalecheck.mjs')
const argv = process.argv.slice(2)
const write = argv.includes('--write')
const ri = argv.indexOf('--runs')
const RUNS = ri >= 0 ? Number(argv[ri + 1]) : 5
const rj = argv.indexOf('--real')
const REAL = rj >= 0 ? argv[rj + 1] : null

const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]

function time(fn) {
  fn() // warm the page cache so the first sample is not the outlier
  const ts = []
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint()
    fn()
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  return { p50: q(ts, 0.5), p95: q(ts, 0.95), min: Math.min(...ts), n: RUNS }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

// A document that exercises every check: links that resolve and links that do not, a
// line citation, an anchor, a fenced command, a version and a dated fact.
function document(i) {
  return `# Document ${i}

Some prose that mentions \`lib/scan.mjs\` and links to [the scanner](lib/scan.mjs).
A link that is dead: [the old guide](docs/gone-${i}.md).
A citation: [config](lib/scan.mjs:4) and one past the end: [config](lib/scan.mjs:99999).

## A heading with — an em dash

See [that heading](#a-heading-with--an-em-dash) and [one that is not there](#missing-${i}).

\`\`\`bash
npm run build
npm test
\`\`\`

The API (docs.example.com, read 2020-01-01) takes a token.
Install \`pkg@1.0.0\` to try it.
`
}

function corpus(n) {
  const dir = mkdtempSync(join(tmpdir(), `stalecheck-bench-${n}-`))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'bench@example.com')
  git(dir, 'config', 'user.name', 'bench')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'scan.mjs'), 'one\ntwo\nthree\nfour\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bench', version: '2.0.0', scripts: { test: 'x' } }))
  mkdirSync(join(dir, 'docs'), { recursive: true })
  for (let i = 0; i < n; i++) writeFileSync(join(dir, 'docs', `d${i}.md`), document(i))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'bench')
  return dir
}

const run = (dir, ...args) => {
  try {
    return execFileSync('node', [CLI, dir, '--json', ...args], { encoding: 'utf8', maxBuffer: 256e6 })
  } catch (e) {
    return e.stdout ?? '' // a run with findings exits 1, which is the normal case here
  }
}

const floor = time(() => execFileSync('node', ['-e', ''], { encoding: 'utf8' }))

const sizes = [10, 100, 500]
const dirs = new Map(sizes.map((n) => [n, corpus(n)]))
const results = {}

for (const n of sizes) {
  results[`${n} documents`] = time(() => run(dirs.get(n)))
}

// Which check costs what, on the largest synthetic corpus.
const perCheck = {}
for (const name of Object.keys(CHECKS)) {
  perCheck[name] = time(() => run(dirs.get(500), '--only', name))
}

let real = null
if (REAL && existsSync(REAL)) {
  const out = run(REAL)
  let documents = null
  try {
    documents = JSON.parse(out).documents
  } catch {
    /* unreadable */
  }
  real = { name: basename(REAL), documents, ...time(() => run(REAL)) }
}

console.log(`node ${process.version}, ${RUNS} runs per case, times in ms\n`)
console.log(`node startup alone                   p50 ${floor.p50.toFixed(1)}`)
console.log('(every case below includes that; the difference is stalecheck itself)\n')

console.log('corpus                          p50        p95   per document')
for (const [name, r] of Object.entries(results)) {
  const n = Number(name.split(' ')[0])
  console.log(`${name.padEnd(30)}${r.p50.toFixed(1).padStart(6)}${r.p95.toFixed(1).padStart(11)}${((r.p50 - floor.p50) / n).toFixed(2).padStart(15)}`)
}

console.log('\nby check, over 500 documents    p50    over startup')
for (const [name, r] of Object.entries(perCheck)) {
  console.log(`${name.padEnd(30)}${r.p50.toFixed(1).padStart(6)}${(r.p50 - floor.p50).toFixed(1).padStart(16)}`)
}

if (real) {
  console.log(`\nreal repository: ${real.name} — ${real.documents} documents, p50 ${real.p50.toFixed(0)} ms (${((real.p50 - floor.p50) / real.documents).toFixed(2)} ms per document)`)
}

if (write) {
  const out = join(HERE, 'results')
  mkdirSync(out, { recursive: true })
  const at = new Date()
  const file = join(out, `${at.toISOString().slice(0, 10)}-bench.json`)
  writeFileSync(file, JSON.stringify({ at: at.toISOString(), node: process.version, runs: RUNS, nodeStartup: floor, corpus: results, perCheck, real }, null, 2) + '\n')
  console.log(`\nwrote ${file}`)
}

for (const dir of dirs.values()) rmSync(dir, { recursive: true, force: true })
