// The command-line contract: exit codes, output shapes, configuration, and the ways a
// CI job or a person actually reaches it.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { CLI, cli, json, repo } from './helpers.mjs'

const withRepo = (files, fn) => {
  const dir = repo(files)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const BROKEN = { 'README.md': 'See [the guide](docs/guide.md).' }
const CLEAN = { 'README.md': '# Fine\n\nNothing to check here.\n' }

describe('exit codes', () => {
  test('findings exit 1, so a CI job fails', () => {
    withRepo(BROKEN, (dir) => assert.equal(cli(dir).code, 1))
  })

  test('no findings exit 0', () => {
    withRepo(CLEAN, (dir) => assert.equal(cli(dir).code, 0))
  })

  test('--warn reports and still exits 0', () => {
    withRepo(BROKEN, (dir) => {
      const r = cli(dir, '--warn')
      assert.equal(r.code, 0)
      assert.match(r.stdout, /docs\/guide\.md/)
    })
  })
})

describe('output', () => {
  test('--json carries the file, the line, the check and a hint', () => {
    withRepo(BROKEN, (dir) => {
      const r = json(dir)
      assert.equal(r.documents, 1)
      const f = r.findings[0]
      assert.equal(f.file, 'README.md')
      assert.equal(f.line, 1)
      assert.equal(f.check, 'paths')
      assert.ok(f.message && f.hint)
    })
  })

  test('the human output names the file once and every finding under it', () => {
    withRepo({ 'README.md': 'See [a](x.md) and [b](y.md).' }, (dir) => {
      const { stdout } = cli(dir)
      assert.equal(stdout.match(/^README\.md$/gm)?.length, 1)
      assert.match(stdout, /x\.md/)
      assert.match(stdout, /y\.md/)
      assert.match(stdout, /2 findings/)
    })
  })

  test('--quiet drops the hints and the summary', () => {
    withRepo(BROKEN, (dir) => {
      const { stdout } = cli(dir, '--quiet')
      assert.match(stdout, /docs\/guide\.md/)
      assert.doesNotMatch(stdout, /findings/)
    })
  })
})

describe('selecting checks', () => {
  test('--only runs just those', () => {
    withRepo({ 'README.md': 'See [a](x.md). Read 2020-01-01.' }, (dir) => {
      assert.deepEqual([...new Set(json(dir, '--only', 'dated').findings.map((f) => f.check))], ['dated'])
      assert.deepEqual([...new Set(json(dir, '--only', 'paths').findings.map((f) => f.check))], ['paths'])
    })
  })

  test('an unknown check name is ignored rather than fatal', () => {
    withRepo(BROKEN, (dir) => {
      const r = json(dir, '--only', 'nonsense,paths')
      assert.equal(r.findings.length, 1)
    })
  })
})

describe('configuration', () => {
  test('.stalecheck.json picks the checks', () => {
    withRepo({ ...BROKEN, '.stalecheck.json': JSON.stringify({ checks: ['dated'] }) }, (dir) => {
      assert.deepEqual(json(dir).findings, [], 'paths was not enabled')
    })
  })

  test('a config that is not JSON is ignored, with a word on stderr', () => {
    withRepo({ ...BROKEN, '.stalecheck.json': '{ not json' }, (dir) => {
      assert.equal(json(dir).findings.length, 1, 'the run carries on with the defaults')
    })
  })

  test('warn in the config behaves like --warn', () => {
    withRepo({ ...BROKEN, '.stalecheck.json': JSON.stringify({ warn: true }) }, (dir) => {
      assert.equal(cli(dir).code, 0)
    })
  })
})

describe('what it reads', () => {
  test('a named file is the only one read', () => {
    withRepo({ 'README.md': 'See [a](x.md).', 'docs/b.md': 'See [c](y.md).' }, (dir) => {
      assert.equal(json(dir, 'README.md').documents, 1)
      assert.equal(json(dir).documents, 2)
    })
  })

  test('a directory is walked', () => {
    withRepo({ 'README.md': '# a', 'docs/b.md': '# b', 'docs/c.md': '# c' }, (dir) => {
      assert.equal(json(dir, 'docs').documents, 2)
    })
  })

  test('node_modules is not documentation', () => {
    withRepo({ 'README.md': '# a', 'node_modules/pkg/README.md': 'See [x](gone.md).' }, (dir) => {
      const r = json(dir)
      assert.equal(r.documents, 1)
      assert.deepEqual(r.findings, [])
    })
  })
})

describe('invoked the way npm installs it', () => {
  // npm installs the bin as a symlink in node_modules/.bin. A guard that compares
  // argv[1] with the module path unresolved makes the whole tool silently do nothing,
  // which is indistinguishable from a clean run.
  test('through a symlink it still reports', () => {
    const dir = repo(BROKEN)
    const bin = mkdtempSync(join(tmpdir(), 'stalecheck-bin-'))
    const link = join(bin, 'stalecheck')
    symlinkSync(CLI, link)
    let out = ''
    let code = 0
    try {
      out = execFileSync('node', [link, '--json'], { cwd: dir, encoding: 'utf8' })
    } catch (e) {
      code = e.status
      out = e.stdout ?? ''
    }
    assert.equal(code, 1, 'a run that finds something must still exit 1')
    assert.equal(JSON.parse(out).findings.length, 1)
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })

  test('--help and --version answer', () => {
    assert.match(execFileSync('node', [CLI, '--help'], { encoding: 'utf8' }), /verifies that what the documentation says/)
    assert.match(execFileSync('node', [CLI, '--version'], { encoding: 'utf8' }), /^\d+\.\d+\.\d+/)
  })
})

describe('it gets out of the way', () => {
  test('a directory that is not a repository still works', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stalecheck-plain-'))
    writeFileSync(join(dir, 'README.md'), 'See [the guide](docs/guide.md).')
    const r = json(dir)
    assert.equal(r.findings.length, 1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('an empty repository reports nothing and exits 0', () => {
    withRepo({ 'a.txt': 'not markdown' }, (dir) => {
      const r = json(dir)
      assert.equal(r.documents, 0)
      assert.deepEqual(r.findings, [])
      assert.equal(cli(dir).code, 0)
    })
  })

  test('an unterminated fence does not swallow the run', () => {
    withRepo({ 'README.md': 'Text.\n\n```bash\nnpm run nope\n' }, (dir) => {
      assert.equal(cli(dir).code, 0, 'no package.json, so no script check — and no crash')
    })
  })
})

describe('large output', () => {
  // process.exit() tears the process down before a big stdout write has flushed to a
  // pipe. It truncated the JSON at a few kilobytes for every consumer that read it
  // through one, which is what CI and evals/corpus.mjs both do.
  test('hundreds of findings survive a pipe intact', () => {
    const many = Array.from({ length: 400 }, (_, i) => `See [doc ${i}](missing-${i}.md).`).join('\n\n')
    withRepo({ 'README.md': many }, (dir) => {
      const r = json(dir)
      assert.equal(r.findings.length, 400)
      assert.equal(r.findings.at(-1).check, 'paths')
    })
  })
})
