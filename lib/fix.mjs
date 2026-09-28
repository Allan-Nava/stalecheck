// Fixing the findings that have exactly one right answer.
//
// The rule that keeps this safe: **a fix is applied only when there is exactly one
// candidate.** Two headings that both nearly match, or a filename that exists in three
// directories, is reported and left alone. Rewriting someone's documentation on a guess
// is worse than reporting it, because a report is read and a guess is not.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { anchors } from './scan.mjs'

// Two anchors are the same heading renumbered when they agree once the leading ordinal
// and any leading punctuation are taken off: `#5-the-knee` and `#7-the-knee`, or
// `#operations` and `#-operations`, which is what a stripped emoji leaves behind.
const bare = (slug) => String(slug).toLowerCase().replace(/^[-\d]+/, '').replace(/^-+|-+$/g, '')

function fixAnchor(finding, ctx) {
  const [target, wanted] = String(finding.subject).split('#')
  if (!wanted) return null
  const docDir = dirname(join(ctx.root, finding.file))
  const path = target ? [resolve(docDir, target), resolve(ctx.root, target)].find(existsSync) : join(ctx.root, finding.file)
  if (!path) return null
  let have
  try {
    have = [...anchors(readFileSync(path, 'utf8'))]
  } catch {
    return null
  }
  const key = bare(wanted)
  if (!key) return null
  const candidates = have.filter((h) => bare(h) === key)
  if (candidates.length !== 1) return null // ambiguous, or nothing like it: leave it alone
  return { from: `${target}#${wanted}`, to: `${target}#${candidates[0]}` }
}

function fixVersion(finding, ctx) {
  if (!ctx.pkg?.name || !ctx.pkg?.version) return null
  const at = String(finding.subject).lastIndexOf('@')
  if (at <= 0) return null
  // The right answer is not a guess: package.json states it.
  return { from: finding.subject, to: `${finding.subject.slice(0, at)}@${ctx.pkg.version}` }
}

function fixPath(finding, ctx) {
  const cited = String(finding.subject)
  const base = cited.slice(cited.lastIndexOf('/') + 1)
  if (!base) return null
  const candidates = [...ctx.files].filter((f) => f.slice(f.lastIndexOf('/') + 1) === base)
  if (candidates.length !== 1) return null
  // Written the way the document would write it: relative to the document itself.
  const docDir = dirname(join(ctx.root, finding.file))
  const to = relative(docDir, join(ctx.root, candidates[0])).split('\\').join('/')
  if (!to || to === cited) return null
  return { from: cited, to }
}

const FIXERS = { anchors: fixAnchor, versions: fixVersion, paths: fixPath }

/** The one right answer for a finding, or null when there is not exactly one. */
export function proposeFix(finding, ctx) {
  const fn = FIXERS[finding.check]
  if (!fn) return null
  try {
    const edit = fn(finding, ctx)
    return edit && edit.from !== edit.to ? { ...finding, ...edit } : null
  } catch {
    return null
  }
}

/**
 * Applies edits to one document's text. Each edit replaces its `from` on its own line,
 * once. Line-scoped on purpose: a global replace would rewrite occurrences nobody
 * reported, and this tool does not touch what it has not examined.
 */
export function applyTo(text, edits) {
  const lines = text.split('\n')
  let applied = 0
  for (const e of edits) {
    const i = e.line - 1
    if (i < 0 || i >= lines.length) continue
    if (!lines[i].includes(e.from)) continue
    lines[i] = lines[i].replace(e.from, e.to)
    applied++
  }
  return { text: lines.join('\n'), applied }
}
