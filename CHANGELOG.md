# Changelog

All notable changes to this project are documented here, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] — 2026-09-28

Accuracy is measured now, not assumed. `evals/documents.jsonl` holds 57 labelled
fixtures, each built as a real git repository and read by the real CLI; `evals/run.mjs`
scores them on the exact `(check, file, line)` they should produce, and CI fails on a
false positive. The first draft of that set scored 100% and was worth nothing. Twelve
boundary fixtures later it found four false positives, all of them real defects.

### Fixed
- **A link inside an inline code span was followed.** `` `[x](gone.md)` `` shows Markdown
  source; it does not point anywhere. Inline code is blanked before links are matched.
- **Repeated headings were not numbered.** GitHub anchors the second `## Notes` as
  `#notes-1`; every link to one was called broken.
- **The slug trimmed when GitHub does not.** GitHub strips a character and keeps the space
  beside it, so `## 🚀 Quick start` anchors as `#-quick-start`. This cut both ways on real
  documentation: it removed a false positive and uncovered two genuinely dead anchors,
  where a document linked `#operations` at a heading GitHub anchors as `#-operations`.
- **A percent-encoded path was never decoded**, so `docs/my%20guide.md` never matched
  `docs/my guide.md`.
- **A code span delimited by more than one backtick was not recognised.** CommonMark opens
  a span with a run of backticks and closes it with the same run, which is how a span that
  itself contains a backtick is written — and how this project's own README writes one.
  Found by the dogfood run: the tool reported a dead link in its own documentation, and
  was right that it had followed something it should not have.

### Added
- Reference-style links: `[label]: docs/guide.md` on a line of its own is where such a
  link actually points, so it is what gets checked.
- `evals/bench.mjs`, the latency benchmark, and an `evals` job in CI running both it and
  the accuracy run. On a real 594-document tree a full sweep is **456 ms**, 0.69 ms per
  document; `lines` is the dearest check, `dated` the cheapest.


## [0.1.1] — 2026-09-28

### Fixed
- **A file looked one line longer than it is.** A trailing newline terminates the last
  line; counting the parts of `split('\n')` counted it as starting another. A `path:line`
  citation one past the end of a file went unreported, and when `lines` did fire its count
  was one too high. Three tests now cover the boundary: the line exactly past the end, a
  file with no trailing newline, and an empty file.


## [0.1.0] — 2026-09-28

The first release. Every default in it was chosen by running the checks over 639 real
documents in four repositories and reading what came back, not by taste.

### Added
- Six checks on by default: `paths` (a link to a file that is not there), `lines` (a
  `path:line` citation past the end), `anchors` (a `#anchor` with no heading behind it),
  `scripts` (`npm run X` the manifest has not got), `versions` (the package's own version
  quoted stale) and `dated` (a fact dated past `--max-age`, 180 days by default).
- `mentions` and `programs`, off by default: both fired too often for what they returned.
- `dated` reads `read`, `verified`, `checked`, `as of`, `measured`, and the Italian
  `letto` and `verificato`.
- A CLI with `--json` for CI, `--only`, `--max-age`, `--warn`, `--quiet`, and exit code 1
  when anything is found. Optional `.stalecheck.json`.
- `evals/corpus.mjs`, which reproduces the measurement over any set of repositories and
  writes a dated run to `evals/results/`.
- CI on Node 18, 20, 22 and 24 (and macOS), with guards for dependency-freedom, the exit
  contract, large output through a pipe, the packed file list, and a dogfood run over its
  own documentation.

### Decided by measurement
- **A backticked path is not a link.** All 33 path findings in the first run came from a
  backtick and none from a link: `` `.claude/settings.json` `` names where a reader puts
  their config, not a file the repository is missing. Split into two checks, one on.
- **A changelog records the past** — 45 of 140 findings in the largest corpus, every one a
  file legitimately removed later. Historical documents are excluded from `paths` and
  `lines`, not from `anchors`.
- **The GitHub slug algorithm replaces each whitespace character with a hyphen** and does
  not collapse runs, so a heading with an em-dash slugs to a double hyphen. Collapsing
  them reported four healthy links as broken.

### Fixed before it shipped
- Outside a repository, root detection walked up to the filesystem root and scanned
  everything under it. It now never goes above the directory it was given.
- `process.exit()` truncated a large JSON write to a pipe, which is how CI and the corpus
  runner both read it. The exit code is set instead, so Node flushes first.

[Unreleased]: https://github.com/Allan-Nava/stalecheck/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Allan-Nava/stalecheck/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Allan-Nava/stalecheck/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Allan-Nava/stalecheck/releases/tag/v0.1.0
