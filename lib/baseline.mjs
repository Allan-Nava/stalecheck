// A baseline: what was already wrong when you started, so CI can fail on what is new.
//
// Measured on a real 594-document tree, stalecheck reports 96 findings. Nobody switches
// on a gate that fails with 96 pre-existing problems, so without this the tool is honest
// and unadoptable at the same time — on exactly the repositories that most need it.
//
// A baseline is not a way to hide findings. It records them, dates them, and reports the
// ones that have since been fixed so the file can be shrunk rather than inherited.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export const FORMAT = 1

// The key is the check, the document, and the subject — never the line, and never the
// message. A line moves whenever anything above it is edited, and a message carries
// detail that moves on its own: `dated` reports how many days ago, which changes every
// night. Either would resurrect a known finding for no reason at all.
export const keyOf = (f) => `${f.check}\u0000${f.file}\u0000${f.subject ?? f.message}`

export function read(path) {
  if (!existsSync(path)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { error: 'not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.findings)) {
    return { error: 'not a stalecheck baseline' }
  }
  if (parsed.format !== FORMAT) {
    return { error: `format ${parsed.format}, and this stalecheck writes ${FORMAT}` }
  }
  return parsed
}

export function entriesFor(findings) {
  // Sorted so the file is stable between runs: a baseline that reorders itself makes a
  // diff nobody can read, and gets committed with noise every time.
  return findings
    .map((f) => ({ check: f.check, file: f.file, subject: f.subject ?? null, message: f.message }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.check.localeCompare(b.check) || String(a.subject).localeCompare(String(b.subject)))
}

/**
 * Writes only when the recorded findings actually differ. Rewriting an unchanged
 * baseline would move nothing but its timestamp, and land in the repository as a diff
 * that says nothing — which is the churn this file is supposed to avoid.
 * @returns {{count: number, changed: boolean}}
 */
export function write(path, findings, { at = new Date() } = {}) {
  const entries = entriesFor(findings)
  const before = read(path)
  if (before && !before.error && JSON.stringify(before.findings) === JSON.stringify(entries)) {
    return { count: entries.length, changed: false }
  }
  const body = {
    format: FORMAT,
    recorded: at.toISOString(),
    note: 'Findings that were already present. stalecheck fails only on what is new; run with --update-baseline to drop the ones that have been fixed.',
    findings: entries,
  }
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n')
  return { count: entries.length, changed: true }
}

/**
 * @returns {{fresh: object[], known: object[], resolved: object[]}}
 *   fresh    — findings not in the baseline: these are what CI should fail on
 *   known    — findings the baseline already records
 *   resolved — baseline entries with no matching finding any more: fixed, or the
 *              document was deleted. Reported so the file can be shrunk.
 */
export function compare(findings, baseline) {
  const recorded = new Map()
  for (const e of baseline.findings) {
    const k = keyOf(e)
    recorded.set(k, (recorded.get(k) ?? 0) + 1)
  }
  const fresh = []
  const known = []
  for (const f of findings) {
    const k = keyOf(f)
    const left = recorded.get(k) ?? 0
    if (left > 0) {
      recorded.set(k, left - 1)
      known.push(f)
    } else {
      fresh.push(f)
    }
  }
  const resolved = []
  for (const e of baseline.findings) {
    const k = keyOf(e)
    const left = recorded.get(k) ?? 0
    if (left > 0) {
      recorded.set(k, left - 1)
      resolved.push(e)
    }
  }
  return { fresh, known, resolved }
}
