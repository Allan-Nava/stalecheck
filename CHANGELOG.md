# Changelog

All notable changes to this project are documented here, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Allan-Nava/stalecheck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Allan-Nava/stalecheck/releases/tag/v0.1.0
