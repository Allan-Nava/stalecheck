// SARIF is read by a machine that will not tell you politely when it is wrong: GitHub
// either renders the annotations or silently renders nothing. These assert the parts of
// the shape that decide which.

import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { CHECKS } from '../lib/checks.mjs'
import { cli, repo } from './helpers.mjs'

const withRepo = (files, fn) => {
  const dir = repo(files)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const DOC = { 'README.md': 'See [a](gone.md).\n\nRead 2019-01-01.\n' }
const sarifFrom = (dir) => JSON.parse(readFileSync(join(dir, 'out.sarif'), 'utf8'))

describe('the document', () => {
  test('is SARIF 2.1.0 with one run and a named driver', () => {
    withRepo(DOC, (dir) => {
      cli(dir, '--sarif', 'out.sarif')
      const s = sarifFrom(dir)
      assert.equal(s.version, '2.1.0')
      assert.match(s.$schema, /sarif-2\.1\.0/)
      assert.equal(s.runs.length, 1)
      assert.equal(s.runs[0].tool.driver.name, 'stalecheck')
      assert.match(s.runs[0].tool.driver.version, /^\d+\.\d+\.\d+/)
      assert.ok(s.runs[0].tool.driver.informationUri)
    })
  })

  test('every result names a rule the driver declares', () => {
    // A ruleId with no matching rule is the most common way a SARIF upload renders
    // nothing at all.
    withRepo(DOC, (dir) => {
      cli(dir, '--sarif', 'out.sarif')
      const run = sarifFrom(dir).runs[0]
      const declared = new Set(run.tool.driver.rules.map((r) => r.id))
      assert.ok(run.results.length > 0)
      for (const r of run.results) assert.ok(declared.has(r.ruleId), `${r.ruleId} is not declared`)
    })
  })

  test('declares only the rules this run produced', () => {
    withRepo({ 'README.md': 'See [a](gone.md).' }, (dir) => {
      cli(dir, '--sarif', 'out.sarif')
      const ids = sarifFrom(dir).runs[0].tool.driver.rules.map((r) => r.id)
      assert.deepEqual(ids, ['paths'])
    })
  })

  test('each rule carries both descriptions, from the checks themselves', () => {
    withRepo(DOC, (dir) => {
      cli(dir, '--sarif', 'out.sarif')
      for (const rule of sarifFrom(dir).runs[0].tool.driver.rules) {
        assert.equal(rule.shortDescription.text, CHECKS[rule.id].short)
        assert.equal(rule.fullDescription.text, CHECKS[rule.id].long)
        assert.equal(rule.defaultConfiguration.level, 'warning')
      }
    })
  })
})

describe('locations', () => {
  test('are repository-relative, with no base id a consumer cannot resolve', () => {
    withRepo({ 'docs/a.md': 'See [x](gone.md).' }, (dir) => {
      cli(dir, '--sarif', 'out.sarif')
      const loc = sarifFrom(dir).runs[0].results[0].locations[0].physicalLocation
      assert.equal(loc.artifactLocation.uri, 'docs/a.md')
      assert.equal(loc.artifactLocation.uriBaseId, undefined)
      assert.ok(loc.region.startLine >= 1, 'SARIF lines are one-based')
    })
  })

  test('carry a fingerprint that survives the finding moving', () => {
    withRepo({ 'README.md': 'See [a](gone.md).' }, (dir) => {
      cli(dir, '--sarif', 'first.sarif')
      const before = JSON.parse(readFileSync(join(dir, 'first.sarif'), 'utf8')).runs[0].results[0]
      writeFileSync(join(dir, 'README.md'), 'One.\n\nTwo.\n\nSee [a](gone.md).')
      cli(dir, '--sarif', 'second.sarif')
      const after = JSON.parse(readFileSync(join(dir, 'second.sarif'), 'utf8')).runs[0].results[0]
      assert.notEqual(before.locations[0].physicalLocation.region.startLine, after.locations[0].physicalLocation.region.startLine)
      assert.deepEqual(before.partialFingerprints, after.partialFingerprints, 'the same finding, further down, is the same finding')
    })
  })
})

describe('with a baseline', () => {
  test('it publishes the new findings, which is what the run reports', () => {
    withRepo({ 'README.md': 'See [a](gone-a.md).' }, (dir) => {
      cli(dir, '--baseline', 'bl.json')
      cli(dir, '--sarif', 'out.sarif', '--baseline', 'bl.json')
      assert.equal(sarifFrom(dir).runs[0].results.length, 0, 'a recorded finding is not a new annotation')
    })
  })
})

describe('a clean repository', () => {
  test('still writes a valid, empty document', () => {
    withRepo({ 'README.md': '# Fine\n' }, (dir) => {
      const r = cli(dir, '--sarif', 'out.sarif')
      assert.equal(r.code, 0)
      const s = sarifFrom(dir)
      assert.equal(s.runs[0].results.length, 0)
      assert.deepEqual(s.runs[0].tool.driver.rules, [])
    })
  })
})
