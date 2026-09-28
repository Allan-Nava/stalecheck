// The baseline exists so a repository with a backlog can adopt the tool without either
// clearing the backlog first or switching the checks off. Everything here is about that
// bargain holding: what is recorded stays quiet, what is new is reported, and what has
// been fixed is said out loud so the file shrinks instead of being inherited.

import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { cli, json, repo } from './helpers.mjs'

const withRepo = (files, fn) => {
  const dir = repo(files)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const BL = '.stalecheck-baseline.json'
const TWO_DEAD = { 'README.md': 'See [a](gone-a.md) and [b](gone-b.md).' }

describe('recording', () => {
  test('the first run writes the file and exits 0', () => {
    withRepo(TWO_DEAD, (dir) => {
      const r = cli(dir, '--baseline', BL)
      assert.equal(r.code, 0)
      assert.match(r.stdout, /2 findings recorded/)
      const written = JSON.parse(readFileSync(join(dir, BL), 'utf8'))
      assert.equal(written.format, 1)
      assert.equal(written.findings.length, 2)
      assert.ok(written.recorded, 'the file says when it was taken')
    })
  })

  test('what it records carries the subject, not the line', () => {
    withRepo(TWO_DEAD, (dir) => {
      cli(dir, '--baseline', BL)
      const written = JSON.parse(readFileSync(join(dir, BL), 'utf8'))
      for (const f of written.findings) {
        assert.ok(f.subject, 'a subject is what makes the entry stable')
        assert.equal(f.line, undefined, 'a line moves whenever anything above it is edited')
      }
    })
  })

  test('the entries are sorted, so the file does not churn in a diff', () => {
    withRepo({ 'b.md': 'See [x](gone-x.md).', 'a.md': 'See [y](gone-y.md).' }, (dir) => {
      cli(dir, '--baseline', BL)
      const first = readFileSync(join(dir, BL), 'utf8')
      cli(dir, '--baseline', BL, '--update-baseline')
      assert.equal(readFileSync(join(dir, BL), 'utf8'), first)
    })
  })
})

describe('comparing', () => {
  test('a recorded finding does not fail the run', () => {
    withRepo(TWO_DEAD, (dir) => {
      cli(dir, '--baseline', BL)
      const r = cli(dir, '--baseline', BL)
      assert.equal(r.code, 0)
      assert.match(r.stdout, /0 new findings/)
      assert.match(r.stdout, /2 already in/)
    })
  })

  test('a new finding does', () => {
    withRepo(TWO_DEAD, (dir) => {
      cli(dir, '--baseline', BL)
      writeFileSync(join(dir, 'README.md'), 'See [a](gone-a.md) and [b](gone-b.md).\n\nAnd [c](gone-c.md).')
      const r = cli(dir, '--baseline', BL)
      assert.equal(r.code, 1)
      assert.match(r.stdout, /gone-c\.md/)
      assert.doesNotMatch(r.stdout, /gone-a\.md/, 'a recorded finding is not reported again')
      assert.match(r.stdout, /1 new finding\b/)
    })
  })

  test('moving a known finding down the document does not resurrect it', () => {
    // The point of keying on the subject: an edit above a finding changes its line and
    // nothing else, and a baseline that fails on that is a baseline nobody keeps.
    withRepo(TWO_DEAD, (dir) => {
      cli(dir, '--baseline', BL)
      writeFileSync(join(dir, 'README.md'), 'One.\n\nTwo.\n\nThree.\n\nSee [a](gone-a.md) and [b](gone-b.md).')
      const r = cli(dir, '--baseline', BL)
      assert.equal(r.code, 0)
      assert.match(r.stdout, /0 new findings/)
    })
  })

  test('the same finding twice is two findings', () => {
    withRepo({ 'README.md': 'See [a](gone.md).' }, (dir) => {
      cli(dir, '--baseline', BL)
      writeFileSync(join(dir, 'README.md'), 'See [a](gone.md).\n\nAnd again [a](gone.md).')
      const r = cli(dir, '--baseline', BL)
      assert.equal(r.code, 1, 'the second occurrence is new even though the subject matches')
      assert.match(r.stdout, /1 new finding\b/)
    })
  })
})

describe('what has been fixed', () => {
  test('is reported, and the run still passes', () => {
    withRepo(TWO_DEAD, (dir) => {
      cli(dir, '--baseline', BL)
      writeFileSync(join(dir, 'README.md'), 'See [a](gone-a.md).')
      const r = cli(dir, '--baseline', BL)
      assert.equal(r.code, 0)
      assert.match(r.stdout, /1 recorded finding has been fixed since/)
      assert.match(r.stdout, /gone-b\.md/)
      assert.match(r.stdout, /--update-baseline/)
    })
  })

  test('--update-baseline drops it from the file', () => {
    withRepo(TWO_DEAD, (dir) => {
      cli(dir, '--baseline', BL)
      writeFileSync(join(dir, 'README.md'), 'See [a](gone-a.md).')
      cli(dir, '--baseline', BL, '--update-baseline')
      const written = JSON.parse(readFileSync(join(dir, BL), 'utf8'))
      assert.equal(written.findings.length, 1)
      assert.equal(written.findings[0].subject, 'gone-a.md')
    })
  })
})

describe('the file itself', () => {
  test('a corrupt baseline reports everything rather than nothing', () => {
    // Failing open here would hide every finding in the repository behind a typo.
    withRepo({ ...TWO_DEAD, [BL]: '{ not json' }, (dir) => {
      const r = cli(dir, '--baseline', BL)
      assert.equal(r.code, 1)
      assert.match(r.stdout, /gone-a\.md/)
    })
  })

  test('a baseline from a future format is not guessed at', () => {
    withRepo({ ...TWO_DEAD, [BL]: JSON.stringify({ format: 99, findings: [] }) }, (dir) => {
      const r = cli(dir, '--baseline', BL)
      assert.equal(r.code, 1)
    })
  })

  test('.stalecheck.json can name it', () => {
    withRepo({ ...TWO_DEAD, '.stalecheck.json': JSON.stringify({ baseline: BL }) }, (dir) => {
      assert.equal(cli(dir).code, 0, 'the first run records')
      assert.equal(cli(dir).code, 0, 'the second finds nothing new')
      writeFileSync(join(dir, 'README.md'), 'See [a](gone-a.md) and [b](gone-b.md) and [c](gone-c.md).')
      assert.equal(cli(dir).code, 1)
    })
  })

  test('--json carries the baseline state', () => {
    withRepo(TWO_DEAD, (dir) => {
      cli(dir, '--baseline', BL)
      const r = json(dir, '--baseline', BL)
      assert.equal(r.findings.length, 0)
      assert.equal(r.baseline.known, 2)
      assert.equal(r.baseline.fresh, 0)
      assert.equal(r.baseline.total, 2)
    })
  })
})
