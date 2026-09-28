#!/usr/bin/env node
// Generates site/dist/index.html FROM README.md. The page has no prose of its own:
// every word comes from the README, except the scorecard, which is read off the newest
// run in evals/results/ so it cannot drift from what was actually measured.
//
//   npm run build:site && open site/dist/index.html
//
// `marked` is a devDependency used only here; the published package stays
// dependency-free.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'site', 'dist')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
// The mark is inlined so the header paints in one request, and copied to dist as well
// because the favicon and the social card reference it by URL.
const logo = readFileSync(join(ROOT, 'assets', 'logo.svg'), 'utf8').replace(/<\?xml[^>]*\?>/, '').replace(/width="64" height="64"/, 'width="42" height="42" class="mark"').trim()
const REPO = 'https://github.com/Allan-Nava/stalecheck'
const BLOB = `${REPO}/blob/main`

marked.setOptions({ mangle: false, headerIds: false })

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// --- the README, split on its own headings ----------------------------------

function parse(md) {
  // Drop the badges and the H1: the page has its own header, built from them.
  const body = md.replace(/^[\s\S]*?^# stalecheck\n/m, '')
  const parts = body.split(/^## /m)
  const lede = parts.shift().trim()
  return {
    lede,
    sections: parts.map((p) => {
      const nl = p.indexOf('\n')
      return { title: p.slice(0, nl).trim(), body: p.slice(nl + 1).trim() }
    }),
  }
}

// A path in backticks that exists in the repository becomes a link to it. Nothing else
// is rewritten, so the page cannot invent a destination.
function linkifyPaths(html) {
  return html.replace(/<code>([\w./-]+\.(?:mjs|json|md|yml|jsonl))<\/code>/g, (m, p) =>
    existsSync(join(ROOT, p)) ? `<a href="${BLOB}/${p}"><code>${p}</code></a>` : m,
  )
}

// --- the one thing the README does not hold: the newest measured run ---------

function newest(suffix) {
  const dir = join(ROOT, 'evals', 'results')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.endsWith(suffix)).sort()
  if (!files.length) return null
  return { name: files[files.length - 1], data: JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8')) }
}

function scorecard() {
  const corpus = newest('-corpus.json')
  const bench = newest('-bench.json')
  if (!corpus && !bench) return ''

  let rows = ''
  if (corpus) {
    for (const r of corpus.data.repositories) {
      const per = (r.findings / Math.max(1, r.documents)).toFixed(2)
      rows += `<tr><td>${esc(r.name)}</td><td>${r.documents}</td><td>${r.findings}</td><td>${per}</td></tr>`
    }
    const t = corpus.data.totals
    rows += `<tr><td><strong>total</strong></td><td><strong>${t.documents}</strong></td><td><strong>${t.findings}</strong></td><td><strong>${t.perDocument.toFixed(2)}</strong></td></tr>`
  }

  const floor = bench?.data.nodeStartup?.p50 ?? 0
  let lat = ''
  for (const [name, r] of Object.entries(bench?.data.corpus ?? {})) {
    const n = Number(name.split(' ')[0])
    lat += `<tr><td>${esc(name)}</td><td>${r.p50.toFixed(0)} ms</td><td>${((r.p50 - floor) / n).toFixed(2)} ms</td></tr>`
  }
  if (bench?.data.real) {
    const r = bench.data.real
    lat += `<tr><td>${esc(r.name)} <span class="dim">${r.documents} documents</span></td><td><strong>${r.p50.toFixed(0)} ms</strong></td><td>${((r.p50 - floor) / r.documents).toFixed(2)} ms</td></tr>`
  }

  const when = (corpus ?? bench).data.at.slice(0, 10)
  const node = (corpus ?? bench).data.node

  // The headline numbers are the whole case for trusting any of this, and until now they
  // were cells in a table a reader had to parse. The tables stay underneath.
  const accuracy = newest('-accuracy.json')
  const realRun = bench?.data.real
  const tiles = [
    corpus && [corpus.data.totals.documents.toLocaleString('en-US'), 'documents measured'],
    accuracy && [`${(100 * (accuracy.data.totals.tp / Math.max(1, accuracy.data.totals.tp + accuracy.data.totals.fp))).toFixed(0)}%`, `precision, ${accuracy.data.fixtures} fixtures`],
    realRun && [`${realRun.p50.toFixed(0)} ms`, `a ${realRun.documents}-document sweep`],
    ['0', 'dependencies'],
  ].filter(Boolean)
  const tileHtml = `<div class="tiles">${tiles.map(([n, l]) => `<div class="tile"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>`

  return `
  <section id="measured-run">
    <h2><a class="anchor" href="#measured-run">The last measured run</a></h2>
    <p>Read off <a href="${BLOB}/evals/results">evals/results</a>, not written by hand — ${esc(when)}, Node ${esc(node)}.</p>
    ${tileHtml}
    <div class="cards">
      ${corpus ? `<div class="card">
        <h3>What it finds <span class="dim">the checks that are on by default</span></h3>
        <table><thead><tr><th>repository</th><th>docs</th><th>findings</th><th>per doc</th></tr></thead><tbody>${rows}</tbody></table>
      </div>` : ''}
      ${bench ? `<div class="card">
        <h3>What it costs <span class="dim">Node startup is ${floor.toFixed(0)} ms of each</span></h3>
        <table><thead><tr><th>corpus</th><th>p50</th><th>per doc</th></tr></thead><tbody>${lat}</tbody></table>
      </div>` : ''}
    </div>
  </section>`
}

// --- render ------------------------------------------------------------------

const { lede, sections } = parse(readFileSync(join(ROOT, 'README.md'), 'utf8'))

// The README's badge block is four linked images on consecutive lines. The page builds
// its own row from them, so the originals are dropped rather than rendered twice — they
// came out as a strip of shields wedged into the opening paragraph.
const withoutBadges = lede
  .split('\n')
  .filter((line) => !/^\s*(?:\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*)+$/.test(line))
  .join('\n')
  .trim()
// The fastest way to understand the tool is four lines of its output, which the lede
// already carries — as one of eight identical <pre> blocks, with nothing saying this one
// is the point. The first block in the lede gets window chrome and the check names in
// colour. It is the same text, doing more work.
const CHECK_TINT = /^(\s*\d+\s+)(paths|lines|anchors|scripts|versions|dated|mentions|programs)(\s)/gm
function asTerminal(html) {
  let done = false
  return html.replace(/<pre>([\s\S]*?)<\/pre>/, (m, inner) => {
    if (done) return m
    done = true
    const tinted = inner.replace(CHECK_TINT, (_, n, check, tail) => `${n}<span class="ck ck-${check}">${check}</span>${tail}`)
    return `<div class="term"><div class="bar"><i></i><i></i><i></i><span>stalecheck</span></div><pre>${tinted}</pre></div>`
  })
}

const ledeHtml = asTerminal(linkifyPaths(marked.parse(withoutBadges)))

const rendered = sections.map((s) => ({
  title: s.title,
  id: slug(s.title),
  html: `<section id="${slug(s.title)}"><h2><a class="anchor" href="#${slug(s.title)}">${esc(s.title)}</a></h2>${linkifyPaths(marked.parse(s.body))}</section>`,
}))

// The scorecard goes straight after the section the README calls "Measured". Splicing
// into the list of sections, not into the lines of their concatenated HTML: the earlier
// version split on newlines and inserted the card partway through the first section,
// which emptied that section's heading and spilled the card's table out of its box.
const card = scorecard()
const measuredAt = rendered.findIndex((s) => s.title.toLowerCase() === 'measured')
if (card && measuredAt >= 0) {
  rendered.splice(measuredAt + 1, 0, { title: 'The last measured run', id: 'measured-run', html: card })
} else if (card) {
  rendered.push({ title: 'The last measured run', id: 'measured-run', html: card })
}

const nav = rendered.map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`).join('')
const parts = rendered.map((s) => s.html)

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>stalecheck — is the documentation still true?</title>
<meta name="description" content="${esc(pkg.description)}">
<meta property="og:title" content="stalecheck">
<meta property="og:description" content="${esc(pkg.description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://allan-nava.github.io/stalecheck/">
<meta property="og:image" content="https://allan-nava.github.io/stalecheck/social-preview.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://allan-nava.github.io/stalecheck/social-preview.png">
<link rel="icon" type="image/svg+xml" href="logo.svg">
<style>
:root{
  --bg:#fbfaf8; --fg:#1b1a18; --dim:#6a655e; --rule:#e3ded6;
  --accent:#2f5d8a; --card:#fff; --code:#f3f0ea;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#141312; --fg:#e8e4dd; --dim:#9a938a; --rule:#2c2a27;
  --accent:#7fb0dd; --card:#1b1a18; --code:#221f1d;
}}
:root[data-theme="dark"]{
  --bg:#141312; --fg:#e8e4dd; --dim:#9a938a; --rule:#2c2a27;
  --accent:#7fb0dd; --card:#1b1a18; --code:#221f1d;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:52rem;margin:0 auto;padding:0 16px}
header{border-bottom:1px solid var(--rule);padding:4rem 0 2.5rem}
.brand{display:flex;align-items:center;gap:.7rem;margin-bottom:.4rem}
.mark{flex:none}
h1{font-size:2.6rem;margin:0;letter-spacing:-.02em}

/* the sample output, framed as what it is */
.term{border:1px solid var(--rule);border-radius:10px;overflow:hidden;background:var(--code);margin:1.2rem 0}
.term .bar{display:flex;align-items:center;gap:.4rem;padding:.55rem .8rem;border-bottom:1px solid var(--rule);background:color-mix(in srgb,var(--code) 70%,var(--bg))}
.term .bar i{width:10px;height:10px;border-radius:50%;background:var(--rule)}
.term .bar span{margin-left:.5rem;font:500 .78rem var(--mono);color:var(--dim);letter-spacing:.02em}
.term pre{margin:0;border:0;border-radius:0;background:none}
.ck{font-weight:600}
.ck-paths{color:#7fb0dd}.ck-lines{color:#8fbcbb}
.ck-anchors{color:#b48ead}.ck-scripts{color:#a3be8c}
.ck-versions{color:#d08770}.ck-dated{color:#ebcb8b}
.ck-mentions{color:#88c0d0}.ck-programs{color:#bf616a}

/* the headline numbers, out of the tables */
.tiles{display:grid;grid-template-columns:repeat(2,1fr);gap:.8rem;margin:1.2rem 0 1.4rem}
@media(min-width:44rem){.tiles{grid-template-columns:repeat(4,1fr)}}
.tile{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:.85rem 1rem}
.tile .n{font-size:1.65rem;font-weight:700;letter-spacing:-.02em;line-height:1.1}
.tile .l{color:var(--dim);font-size:.8rem;margin-top:.15rem}
.tag{color:var(--dim);font-size:1.05rem;margin:0}
.lede{font-size:1.1rem;margin-top:1.6rem}
.lede p:first-child{font-size:1.2rem}
nav{display:flex;flex-wrap:wrap;gap:.25rem 1.1rem;padding:1rem 0;border-bottom:1px solid var(--rule);font-size:.9rem}
nav a{color:var(--dim);text-decoration:none}
nav a:hover{color:var(--accent)}
section{padding:2.4rem 0;border-bottom:1px solid var(--rule)}
section:last-child{border-bottom:0}
h2{font-size:1.5rem;margin:0 0 1rem;letter-spacing:-.01em}
h3{font-size:1.05rem;margin:1.6rem 0 .6rem}
a{color:var(--accent)}
.anchor{color:inherit;text-decoration:none}
.anchor:hover{color:var(--accent)}
code{font-family:var(--mono);font-size:.88em;background:var(--code);padding:.12em .36em;border-radius:4px}
pre{background:var(--code);padding:1rem;border-radius:8px;overflow-x:auto;border:1px solid var(--rule)}
pre code{background:none;padding:0;font-size:.85rem;line-height:1.55}
table{width:100%;border-collapse:collapse;margin:1rem 0;font-size:.92rem}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-weight:600;color:var(--dim);font-size:.82rem;text-transform:uppercase;letter-spacing:.04em}
blockquote{margin:1rem 0;padding:.2rem 0 .2rem 1rem;border-left:3px solid var(--rule);color:var(--dim)}
.cards{display:grid;gap:1rem;grid-template-columns:1fr}
@media(min-width:44rem){.cards{grid-template-columns:1fr 1fr}}
.card{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:1rem 1.1rem}
.card h3{margin-top:0}
.card table{margin:.4rem 0 0}
.dim{color:var(--dim);font-weight:400;font-size:.82rem;display:block;margin-top:.15rem}
footer{padding:2.5rem 0 4rem;color:var(--dim);font-size:.9rem}
footer a{color:var(--dim)}
.badges{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.4rem}
.badges a{display:inline-block;padding:.3rem .7rem;border:1px solid var(--rule);border-radius:999px;font-size:.82rem;text-decoration:none;color:var(--dim)}
.badges a:hover{border-color:var(--accent);color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="brand">${logo}<h1>stalecheck</h1></div>
  <p class="tag">v${esc(pkg.version)} · <code>${esc(pkg.name)}</code> · MIT</p>
  <div class="lede">${ledeHtml}</div>
  <div class="badges">
    <a href="${REPO}">GitHub</a>
    <a href="https://www.npmjs.com/package/${esc(pkg.name)}">npm</a>
    <a href="${REPO}/actions/workflows/ci.yml">CI</a>
    <a href="${BLOB}/CHANGELOG.md">Changelog</a>
  </div>
</header>
<nav>${nav}</nav>
${parts.join('\n')}
<footer>
  Generated from <a href="${BLOB}/README.md">README.md</a> by
  <a href="${BLOB}/site/build.mjs">site/build.mjs</a>. The page has no prose of its own.
</footer>
</div>
</body>
</html>
`

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'index.html'), html)
writeFileSync(join(OUT, '.nojekyll'), '')
for (const asset of ['logo.svg', 'social-preview.png']) {
  const from = join(ROOT, 'assets', asset)
  if (existsSync(from)) copyFileSync(from, join(OUT, asset))
  else console.warn(`build:site: assets/${asset} is missing — the page references it`)
}
console.log(`wrote ${join(OUT, 'index.html')} — ${(html.length / 1024).toFixed(1)} kB, ${sections.length} sections from README.md`)
