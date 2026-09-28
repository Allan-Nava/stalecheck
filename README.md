<p align="center">
  <img src="https://raw.githubusercontent.com/Allan-Nava/stalecheck/main/assets/logo.svg" width="72" height="72" alt="stalecheck">
</p>

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
| `fences` | a fenced `json` block that does not parse | on |
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
| a 594-document infrastructure repo | 594 | 96 | 0.16 |
| **total** | **639** | **100** | **0.16** |

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

### Accuracy — `node evals/run.mjs`

59 labelled fixtures in `evals/documents.jsonl`, each built as a real git repository and
read by the real CLI, scored on the exact `(check, file, line)` it should produce:

| | precision | recall |
|---|---|---|
| all six default checks | **100%** | **100%** |

That table is the second draft, and the first one was worthless for the usual reason: it
only held cases written by someone who knew the code. Twelve boundary fixtures later it
found **four false positives**, every one a real defect:

- a link shown *inside* an inline code span — `` `[x](gone.md)` `` — was followed as a link
- GitHub numbers repeated headings, so the second `## Notes` is `#notes-1`; the slugger did not
- GitHub does **not** trim after stripping characters, so `## 🚀 Quick start` is `#-quick-start`
  with a leading hyphen; trimming called those links broken
- a percent-encoded space in a link was never decoded

A fifth arrived from the dogfood run, which checks this project's own documentation: a
code span delimited by more than one backtick — the way you write a span that contains a
backtick, and the way the paragraph above writes one — was not recognised, so the tool
followed a link that was only ever being shown.

The third one cut both ways on real documentation: it removed a false positive and
uncovered two genuinely dead anchors, where a document linked `#operations` at a heading
that GitHub actually anchors as `#-operations`. Reference-style links (`[label]: path`)
are followed now too, which was the one thing the set could not find a way to score.

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
stalecheck --baseline <file>   # fail only on findings that are not already in <file>
stalecheck --sarif <file>      # also write SARIF 2.1.0, for GitHub code scanning
stalecheck --fix               # apply the findings that have exactly one right answer
```

Exit code is 1 when anything is found, so it drops into CI as it is:

```yaml
- run: npx @allan_nava/stalecheck
```

### On the pull request, not in a log

Findings in a CI log are read once and scrolled past. SARIF puts them on the diff, beside
the line that carries them:

```yaml
- run: npx @allan_nava/stalecheck --sarif stalecheck.sarif --baseline .stalecheck-baseline.json
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: stalecheck.sarif
    category: stalecheck
```

The job needs `security-events: write`. `if: always()` matters: the run exits 1 when it
finds something, and without it the upload would be skipped exactly when there is
something to show.

Every result carries a fingerprint built from the check, the document and the subject, so
GitHub treats a finding that has moved down a file as the one it already knows rather than
as a new one. With a baseline in use, only the new findings are published — the backlog
stays in the file where it belongs.

This project's own CI uploads its own SARIF, which is the only way to know GitHub accepts
the document rather than rendering nothing in silence.

### Fixing what has exactly one right answer

```bash
stalecheck --fix            # apply them
stalecheck --fix --dry-run  # say what it would change, change nothing
```

Three findings have an answer nobody has to guess at: an anchor whose heading was
renumbered when exactly one heading is a near-match, this package's own version, which
`package.json` states, and a path when exactly one file in the repository carries that
name.

**Exactly one** is the whole rule. Two headings that both nearly match, or a filename that
exists in three directories, is reported and left alone — rewriting documentation on a
guess is worse than reporting it, because a report is read and a guess is not. Only the
line that was reported is rewritten, never every occurrence in the file.

### Telling it about this repository

`.stalecheck.json` takes two things a tool cannot infer:

```json
{
  "ignore": ["third-party/**", "docs/generated/**"],
  "historical": ["docs/incidents/**", "reports/**"]
}
```

`ignore` is documentation that should not be read at all — vendored, generated, or a
folder of working notes whose links are deliberately speculative. An ignored document is
not counted in the sweep either.

`historical` is documentation that records the past, where a file it names may be
legitimately gone. `CHANGELOG`, `HISTORY` and `RELEASES` are always historical; this adds
to that list and never replaces it. Anchors are still checked in those documents, because
a dead link is dead whoever wrote it.

### Adopting it on documentation that is already stale

A repository with a backlog does not get to start from zero. Measured on a real
594-document tree, stalecheck reports 96 findings, and nobody switches on a gate that
fails with 96 pre-existing problems.

A baseline records what was already there, so the gate fails only on what is **new**:

```bash
stalecheck --baseline .stalecheck-baseline.json   # first run: records, exits 0
stalecheck --baseline .stalecheck-baseline.json   # after that: fails only on new findings
stalecheck --baseline .stalecheck-baseline.json --update-baseline   # drop what has been fixed
```

It is a record, not a way to hide things. Entries are keyed on the check, the document and
the **subject** — the path, the anchor, the script name — never the line and never the
message: a line moves whenever anything above it is edited, and `dated` reports how many
days ago, which changes every night. Either would resurrect a known finding for nothing.

A finding that has since been fixed is reported by name, so the file shrinks instead of
being inherited. Writing is idempotent: a baseline that already records exactly these
findings is left untouched rather than restamped, so it does not land in a diff saying
nothing.

Commit the file. On the 594-document tree it is 27 kB.

Configuration is optional, in `.stalecheck.json` at the repository root:

```json
{
  "checks": ["paths", "lines", "anchors", "dated"],
  "maxAgeDays": 90,
  "baseline": ".stalecheck-baseline.json",
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
npm test                              # 104 assertions
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
