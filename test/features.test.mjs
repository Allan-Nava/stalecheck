// The three features of v0.4.0: what a repository can configure, what a fenced data
// block has to satisfy, and what may be rewritten without asking.

import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { matchesAny } from '../lib/glob.mjs'
import { cli, json, repo } from './helpers.mjs'

const withRepo = (files, fn) => {
  const dir = repo(files)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('glob', () => {
  const cases = [
    ['docs/a.md', ['docs/**'], true],
    ['docs/deep/a.md', ['docs/**'], true],
    ['docs/deep/a.md', ['docs/*'], false],
    ['docs', ['docs/**'], true],
    ['a.md', ['*.md'], true],
    ['deep/a.md', ['*.md'], true, 'a pattern with no slash is about the name, wherever it sits'],
    ['deep/a.md', ['deep/*.md'], true],
    ['other/a.md', ['deep/*.md'], false],
    ['reports/a.md', ['reports/'], true, 'a trailing slash means the directory and everything under it'],
    ['CHANGELOG.md', ['CHANGELOG*'], true],
    ['a.md', [], false],
    ['a.md', null, false],
    ['a+b.md', ['a+b.md'], true, 'regex metacharacters are literal'],
  ]
  for (const [path, patterns, want, why] of cases) {
    test(`${path} ${want ? 'matches' : 'does not match'} ${JSON.stringify(patterns)}${why ? ` — ${why}` : ''}`, () => {
      assert.equal(matchesAny(path, patterns), want)
    })
  }
})

describe('ignore', () => {
  const FILES = {
    'README.md': 'See [a](gone-a.md).',
    'third-party/v.md': 'See [b](gone-b.md).',
  }

  test('an ignored document is not read at all', () => {
    withRepo({ ...FILES, '.stalecheck.json': JSON.stringify({ ignore: ['third-party/**'] }) }, (dir) => {
      const r = json(dir)
      assert.equal(r.documents, 1, 'and is not counted as one this run has anything to say about')
      assert.equal(r.findings.length, 1)
      assert.equal(r.findings[0].file, 'README.md')
    })
  })

  test('without it, both are', () => {
    withRepo(FILES, (dir) => {
      const r = json(dir)
      assert.equal(r.documents, 2)
      assert.equal(r.findings.length, 2)
    })
  })
})

describe('historical', () => {
  test('a configured directory records the past, like a changelog', () => {
    const files = { 'reports/r.md': 'See [gone](gone.md).' }
    withRepo(files, (dir) => assert.equal(json(dir).findings.length, 1))
    withRepo({ ...files, '.stalecheck.json': JSON.stringify({ historical: ['reports/**'] }) }, (dir) => {
      const r = json(dir)
      assert.equal(r.documents, 1, 'it is still read')
      assert.equal(r.findings.length, 0, 'but a file it names may be legitimately gone')
    })
  })

  test('a changelog stays historical whatever else is configured', () => {
    withRepo({ 'CHANGELOG.md': 'removed [it](gone.md).', '.stalecheck.json': JSON.stringify({ historical: ['reports/**'] }) }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('anchors are still checked there — a dead link is dead whoever wrote it', () => {
    withRepo({
      'reports/r.md': 'See [x](b.md#nowhere).',
      'reports/b.md': '# B\n',
      '.stalecheck.json': JSON.stringify({ historical: ['reports/**'] }),
    }, (dir) => {
      assert.deepEqual(json(dir).findings.map((f) => f.check), ['anchors'])
    })
  })
})

describe('fences', () => {
  const fence = (lang, body) => ({ 'README.md': '```' + lang + '\n' + body + '\n```\n' })

  test('a broken json block is reported on the line that broke it', () => {
    withRepo(fence('json', '{\n  "a": 1,\n  "b": [2,\n}'), (dir) => {
      const r = json(dir)
      assert.equal(r.findings.length, 1)
      assert.equal(r.findings[0].check, 'fences')
      assert.ok(r.findings[0].line > 1, 'not the fence line')
    })
  })

  test('yaml is left alone, because a parser for it is not written here', () => {
    withRepo(fence('yaml', 'a: [unclosed'), (dir) => assert.deepEqual(json(dir).findings, []))
  })

  test('an unlabelled fence is left alone', () => {
    withRepo(fence('', '{ not json at all'), (dir) => assert.deepEqual(json(dir).findings, []))
  })

  test('an excerpt of an object, shown without its braces', () => {
    withRepo(fence('json', '"safety": { "hosts": ["a"] }'), (dir) => assert.deepEqual(json(dir).findings, []))
  })

  test('an excerpt ending in a comma', () => {
    withRepo(fence('json', '"A": "1",\n"B": "2",'), (dir) => assert.deepEqual(json(dir).findings, []))
  })

  test('a comma inside the block is still an error', () => {
    withRepo(fence('json', '{ "a": [1,,2] }'), (dir) => assert.equal(json(dir).findings.length, 1))
  })

  test('json lines, including a record over several lines', () => {
    withRepo(fence('json', '{ "n": "a" }\n{ "n": "b",\n  "deep": { "x": 1 } }'), (dir) => assert.deepEqual(json(dir).findings, []))
  })

  test('a comment naming the file is a convention, not a defect', () => {
    withRepo(fence('json', '// /etc/docker/daemon.json\n{ "log-driver": "json-file" }'), (dir) => assert.deepEqual(json(dir).findings, []))
  })

  test('jsonc forgives comments and a trailing comma; json forgives only the comment', () => {
    withRepo(fence('jsonc', '{\n  // note\n  "a": [1],\n}'), (dir) => assert.deepEqual(json(dir).findings, []))
    withRepo(fence('json', '{\n  // note\n  "a": [1],\n}'), (dir) => assert.equal(json(dir).findings.length, 1, 'the trailing comma is the error this check exists to find'))
  })
})

describe('--fix', () => {
  const FILES = {
    'package.json': JSON.stringify({ name: '@a/b', version: '2.0.0' }),
    'b.md': '# B\n\n### 7. The knee, named\n',
    'sub/deep/moved.md': 'x\n',
    'README.md': 'See [k](b.md#5-the-knee-named).\n\nInstall `@a/b@1.0.0`.\n\nSee [f](docs/moved.md).\n',
  }

  test('applies the three that have one right answer', () => {
    withRepo(FILES, (dir) => {
      const r = cli(dir, '--fix')
      assert.equal(r.code, 0, 'nothing is left to fail on')
      const after = readFileSync(join(dir, 'README.md'), 'utf8')
      assert.match(after, /b\.md#7-the-knee-named/, 'the heading was renumbered')
      assert.match(after, /@a\/b@2\.0\.0/, 'package.json states the version')
      assert.match(after, /sub\/deep\/moved\.md/, 'exactly one file has that name')
    })
  })

  test('--dry-run changes nothing', () => {
    withRepo(FILES, (dir) => {
      const before = readFileSync(join(dir, 'README.md'), 'utf8')
      const r = cli(dir, '--fix', '--dry-run')
      assert.match(r.stdout, /would change 3 findings/)
      assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), before)
    })
  })

  test('two candidates is no candidate', () => {
    // The rule the whole feature rests on: rewriting documentation on a guess is worse
    // than reporting it, because a report is read and a guess is not.
    withRepo({
      ...FILES,
      'README.md': 'See [x](docs/twice.md).\n',
      'one/twice.md': 'x\n',
      'two/twice.md': 'x\n',
    }, (dir) => {
      const r = cli(dir, '--fix')
      assert.equal(r.code, 1, 'it is still a finding')
      assert.match(r.stdout, /no single right answer/)
      assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /docs\/twice\.md/, 'untouched')
    })
  })

  test('an anchor with two near-matches is left alone', () => {
    withRepo({
      'b.md': '### 7. The knee\n\n### 9. The knee\n',
      'README.md': 'See [k](b.md#5-the-knee).\n',
    }, (dir) => {
      assert.equal(cli(dir, '--fix').code, 1)
      assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /#5-the-knee/)
    })
  })

  test('a finding with no fixer is reported and left', () => {
    withRepo({ 'README.md': 'A fact, read 2019-01-01.\n' }, (dir) => {
      const r = cli(dir, '--fix')
      assert.equal(r.code, 1)
      assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /read 2019-01-01/)
    })
  })

  test('only the reported line is rewritten, not every occurrence', () => {
    withRepo({
      ...FILES,
      'README.md': 'Install `@a/b@1.0.0`.\n\nThe release notes for `@a/b@1.0.0` are elsewhere.\n',
    }, (dir) => {
      cli(dir, '--fix')
      const after = readFileSync(join(dir, 'README.md'), 'utf8')
      assert.equal((after.match(/@a\/b@2\.0\.0/g) ?? []).length, 2, 'both lines were reported, so both were fixed')
    })
  })
})
