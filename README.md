# stalecheck

[![docs](https://img.shields.io/badge/docs-allan--nava.github.io%2Fstalecheck-2f5d8a?labelColor=1b1a18)](https://allan-nava.github.io/stalecheck/)
[![CI](https://github.com/Allan-Nava/stalecheck/actions/workflows/ci.yml/badge.svg)](https://github.com/Allan-Nava/stalecheck/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40allan_nava%2Fstalecheck?color=2f5d8a&labelColor=1b1a18)](https://www.npmjs.com/package/@allan_nava/stalecheck)
[![licence](https://img.shields.io/badge/license-MIT-2f5d8a?labelColor=1b1a18)](LICENSE)

**Verifies that what the documentation says is still true.** Not whether it reads well —
whether the file it links to is still there, whether the line it cites still exists,
whether the script it tells you to run is in the manifest, whether the fact it dated two
years ago has been looked at since.

Deterministic: no model, no network, no key, no dependencies. It never runs a command it
finds in a document.

```
docs/cli.md
    871  anchors   links to `reading-results.md#5-the-knee-named-or-refused`, and no heading there makes that anchor
             the heading was renamed; link the new one

docs/deploy/topology.md
    139  lines     cites `config/group_vars/all.yml:43`, but that file has 42 lines
             the code moved; re-anchor the citation
```

## What it checks

| Check | Finds | Default |
|---|---|---|
| `paths` | a link to a file that is not there | on |
| `lines` | a `path:line` citation past the end of the file | on |
| `anchors` | a `#anchor` with no heading behind it | on |
| `scripts` | `npm run X` where the manifest has no `X` | on |
| `versions` | the package's own version, quoted stale | on |
| `dated` | a fact dated long enough ago to be worth re-reading | on |
| `mentions` | a backticked path that is not there | **off** |
| `programs` | a command not on `PATH` or in the repository | **off** |

Everything else is silence. A check that cannot establish the truth reports nothing.

### `dated` is the one nobody else has

A document that says *"(docs.example.com, read 2026-09-22)"* is making a claim about the
world, and the world moves. `dated` finds those markers — `read`, `verified`, `checked`,
`as of`, `measured`, and the Italian `letto` and `verificato` — and reports the ones older
than `--max-age` (180 days by default), so a fact gets re-read before a release rather
than after an incident.

## Measured

`npm run corpus -- <repos>` reproduces this; `evals/results/` holds the dated runs.
Node 23.3, 2026-09-28, four repositories:

| repository | documents | findings | per doc |
|---|---|---|---|
| hookgate | 15 | 2 | 0.13 |
| claimcheck | 3 | 0 | 0.00 |
| crowdsim | 27 | 2 | 0.07 |
| a 594-document infrastructure repo | 594 | 97 | 0.16 |
| **total** | **639** | **101** | **0.16** |

The defaults were chosen from that corpus, not from taste. Three of them were decided by
measurement against what the first draft did:

- **A backticked path is not a link.** Every one of the 33 path findings in the first run
  came from a backtick and none from a link. `` `.claude/settings.json` `` names where a
  reader puts their config; it is not a file the repository is missing. The two are now
  separate checks and only `paths` is on.
- **A changelog records the past.** It named 45 of 140 findings in the infrastructure
  repo, every one a file that was legitimately removed later. Historical documents are
  excluded from `paths` and `lines` — but not from `anchors`, since a dead link is dead
  whoever wrote it.
- **The slug algorithm was wrong.** GitHub replaces each whitespace character with a
  hyphen and does not collapse runs, so a heading with an em-dash slugs to a double
  hyphen. Collapsing them reported four healthy links as broken.

Of the findings that survive, the ones worth the price: a config line cited at `:43` by
five separate production runbooks when the file has 42 lines, and two documentation links
pointing at sections that were renumbered.

### Latency — `node evals/bench.mjs`

It is meant to run in CI over a whole documentation tree, so what matters is how it
scales and which check dominates.

| corpus | p50 | marginal, per document |
|---|---|---|
| 10 documents | 73 ms | 2.51 ms |
| 100 documents | 90 ms | 0.41 ms |
| 500 documents | 150 ms | 0.20 ms |
| a real 594-document repository | **456 ms** | 0.69 ms |

Node's own startup is 48 ms of each, measured in the same run and reported beside them.
`lines` is the most expensive check, because it opens every file a document cites;
`dated` is the cheapest, because it never leaves the text.

## Install

```bash
npm install -g @allan_nava/stalecheck
```

## Use

```bash
stalecheck                     # every tracked Markdown file in the repository
stalecheck docs/ README.md     # only these
stalecheck --only paths,lines  # only these checks
stalecheck --max-age 90        # a fact older than 90 days is stale
stalecheck --json              # machine-readable, for CI
stalecheck --warn              # report everything, always exit 0
```

Exit code is 1 when anything is found, so it drops into CI as it is:

```yaml
- run: npx @allan_nava/stalecheck
```

Configuration is optional, in `.stalecheck.json` at the repository root:

```json
{
  "checks": ["paths", "lines", "anchors", "dated"],
  "maxAgeDays": 90,
  "warn": false
}
```

## The rules

1. **Absence of evidence is not evidence.** A check that cannot establish the truth
   reports nothing: an unreadable file, a path outside the repository, a heading in a
   language of headings it does not parse.
2. **Every finding names a file and a line.** A finding nobody can act on is noise.
3. **It never runs what it reads.** Commands in documents are parsed, never executed.
4. **A default is earned by measurement.** `mentions` and `programs` are off because they
   fired too often for what they returned, and the corpus says so in numbers.

## Verify

```bash
npm test                              # 47 assertions
npm run corpus -- ~/projects/*        # what it says about your own documentation
node bin/stalecheck.mjs --help
```

## Related

[claimcheck](https://github.com/Allan-Nava/claimcheck) does the same thing one level up:
a `Stop` hook that blocks an agent's claim of completion when the session's own record
contradicts it. Same discipline — deterministic, fail-quiet, defaults chosen by
measurement.

## Licence

MIT.
