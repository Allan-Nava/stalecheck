// SARIF 2.1.0, so findings land on the pull request diff instead of in a log nobody
// scrolls back to. GitHub reads this format through github/codeql-action/upload-sarif and
// renders each result as an annotation beside the line that carries it.
//
// Nothing here is new analysis: the findings already carry a file, a line, a check and a
// subject. This is a serialiser.

import { CHECKS } from './checks.mjs'

const SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'
const HOME = 'https://github.com/Allan-Nava/stalecheck'

/**
 * @param findings the findings to publish — with a baseline in use, the new ones, which
 *   is what the run reports and therefore what a reviewer should be shown
 * @param version  the running stalecheck version, for the tool driver
 */
export function toSarif(findings, { version = '0.0.0' } = {}) {
  // Only the checks that actually produced something become rules. A rule with no
  // results still shows up in GitHub's rule list, which invites questions about checks
  // this run never ran.
  const used = [...new Set(findings.map((f) => f.check))].filter((c) => CHECKS[c])

  const rules = used.map((name) => ({
    id: name,
    name,
    shortDescription: { text: CHECKS[name].short },
    fullDescription: { text: CHECKS[name].long },
    helpUri: `${HOME}#what-it-checks`,
    help: { text: CHECKS[name].long },
    // Everything is a warning. A finding is a fact — how much it matters is the
    // repository's call, and a tool that decides that for you gets switched off.
    defaultConfiguration: { level: 'warning' },
    properties: { tags: ['documentation', 'maintenance'] },
  }))

  const results = findings.map((f) => ({
    ruleId: f.check,
    level: 'warning',
    message: { text: f.hint ? `${f.message} — ${f.hint}` : f.message },
    locations: [
      {
        physicalLocation: {
          // Repository-relative and nothing else. A uriBaseId that is not declared in
          // originalUriBaseIds is a base the consumer cannot resolve, and GitHub matches
          // the diff on the plain relative path.
          artifactLocation: { uri: f.file },
          region: { startLine: Math.max(1, f.line | 0) },
        },
      },
    ],
    // What makes GitHub treat a finding on line 40 today as the same one it saw on line
    // 12 last week. The subject is the stable thing the finding is about, which is the
    // same reason the baseline keys on it.
    partialFingerprints: { stalecheckSubject: `${f.check}:${f.file}:${f.subject ?? f.message}` },
  }))

  return {
    $schema: SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'stalecheck',
            version,
            semanticVersion: version,
            informationUri: HOME,
            rules,
          },
        },
        results,
        columnKind: 'unicodeCodePoints',
      },
    ],
  }
}
