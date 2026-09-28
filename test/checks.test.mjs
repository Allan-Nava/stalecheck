// What each check finds, and — mostly — what it refuses to find. Every "quiet" case
// here was a false positive measured against a real corpus before it was a test.

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { describe, test } from 'node:test'
import { checksIn, json, repo } from './helpers.mjs'

const withRepo = (files, fn) => {
  const dir = repo(files)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('paths — a link to a file that is gone', () => {
  test('a dead link is found', () => {
    withRepo({ 'README.md': 'See [the guide](docs/guide.md).' }, (dir) => {
      const r = json(dir)
      assert.deepEqual(checksIn(r), ['paths'])
      assert.equal(r.findings[0].line, 1)
      assert.match(r.findings[0].message, /docs\/guide\.md/)
    })
  })

  test('a live link is not', () => {
    withRepo({ 'README.md': 'See [the guide](docs/guide.md).', 'docs/guide.md': '# Guide\n' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('a link relative to the document, not the root', () => {
    withRepo({ 'docs/a.md': 'See [b](b.md).', 'docs/b.md': '# B\n' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('a file that exists under another root is not missing', () => {
    // `docs/guide.md` cited from a document that sits beside `sub/docs/guide.md`.
    withRepo({ 'README.md': 'See [the guide](docs/guide.md).', 'sub/docs/guide.md': '# Guide\n' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('a backticked path is a mention, not a link, and is off by default', () => {
    withRepo({ 'README.md': 'Configuration lives in `.claude/settings.json`.' }, (dir) => {
      assert.deepEqual(json(dir).findings, [], 'naming a convention is not a broken link')
      assert.deepEqual(checksIn(json(dir, '--only', 'mentions')), ['mentions'])
    })
  })

  test('a generated tree proves nothing when nobody has built it', () => {
    withRepo({ 'README.md': 'Output lands in [the bundle](dist/app.js).' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('an abbreviation in prose is not a destination', () => {
    withRepo({ 'README.md': 'Reports land in [a folder](logs-.../) per run.' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('a URL is not a path', () => {
    withRepo({ 'README.md': 'See [the docs](https://example.dev/a/b.md).' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('a changelog records the past, so a file it names may be gone', () => {
    withRepo({ 'CHANGELOG.md': '## [0.1.0]\n- removed [the old script](scripts/old.sh).' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })
})

describe('lines — a citation past the end of the file', () => {
  test('past the end is found', () => {
    withRepo({ 'README.md': 'Fixed in [config](src/a.mjs:99).', 'src/a.mjs': 'one\ntwo\n' }, (dir) => {
      const r = json(dir)
      assert.deepEqual(checksIn(r), ['lines'])
      assert.match(r.findings[0].message, /has 3 lines/)
    })
  })

  test('inside the file is not', () => {
    withRepo({ 'README.md': 'Fixed in [config](src/a.mjs:2).', 'src/a.mjs': 'one\ntwo\n' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })
})

describe('anchors — a link with no heading behind it', () => {
  test('a renumbered section is found', () => {
    withRepo({ 'a.md': 'See [the knee](b.md#5-the-knee).', 'b.md': '### 7. The knee\n' }, (dir) => {
      assert.deepEqual(checksIn(json(dir)), ['anchors'])
    })
  })

  test('a same-document anchor is checked too', () => {
    withRepo({ 'a.md': '# Title\n\nSee [below](#nowhere).\n\n## Somewhere\n' }, (dir) => {
      assert.deepEqual(checksIn(json(dir)), ['anchors'])
    })
  })

  test('an em-dash slugs to a double hyphen, and that is not broken', () => {
    // GitHub replaces each whitespace character with a hyphen and does not collapse
    // runs. Collapsing them reported four healthy links as broken across two repos.
    withRepo({ 'a.md': 'See [auth](b.md#auth--signing-in).', 'b.md': '## `auth` — signing in\n' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('a heading with code and punctuation still resolves', () => {
    withRepo({
      'a.md': 'See [delivery](b.md#5-delivery--the-rate-that-arrived).',
      'b.md': '### 5. `delivery` → the rate that arrived\n',
    }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('a heading inside a fence is not a heading', () => {
    withRepo({ 'a.md': 'See [x](b.md#not-real).', 'b.md': '# B\n\n```\n# Not real\n```\n' }, (dir) => {
      assert.deepEqual(checksIn(json(dir)), ['anchors'])
    })
  })
})

describe('scripts — an npm script the manifest has not got', () => {
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test' } })

  test('a documented script that does not exist', () => {
    withRepo({ 'package.json': pkg, 'README.md': '```bash\nnpm run build:site\n```\n' }, (dir) => {
      const r = json(dir)
      assert.deepEqual(checksIn(r), ['scripts'])
      assert.match(r.findings[0].message, /build:site/)
    })
  })

  test('a script that does exist', () => {
    withRepo({ 'package.json': pkg, 'README.md': '```bash\nnpm test\n```\n' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('a command outside a shell fence is not a command', () => {
    withRepo({ 'package.json': pkg, 'README.md': '```js\nnpm run nope\n```\n' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('a comment in a shell fence is not a command', () => {
    withRepo({ 'package.json': pkg, 'README.md': '```bash\n# npm run nope\n```\n' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })
})

describe('versions — the package quoting itself stale', () => {
  const pkg = JSON.stringify({ name: '@a/b', version: '2.0.0' })

  test('a stale version is found', () => {
    withRepo({ 'package.json': pkg, 'README.md': 'Install `@a/b@1.0.0`.' }, (dir) => {
      const r = json(dir)
      assert.deepEqual(checksIn(r), ['versions'])
      assert.match(r.findings[0].message, /package\.json is at 2\.0\.0/)
    })
  })

  test('the current version is not', () => {
    withRepo({ 'package.json': pkg, 'README.md': 'Install `@a/b@2.0.0`.' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('a changelog is meant to name old versions', () => {
    withRepo({ 'package.json': pkg, 'CHANGELOG.md': '## [1.0.0]\n`@a/b@1.0.0` shipped.' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })
})

describe('dated — a fact old enough to be worth re-reading', () => {
  test('an old fact is found', () => {
    withRepo({ 'README.md': 'The API (docs.example.com, read 2020-01-01) takes a token.' }, (dir) => {
      const r = json(dir)
      assert.deepEqual(checksIn(r), ['dated'])
      assert.match(r.findings[0].message, /read 2020-01-01/)
    })
  })

  test('a recent one is not', () => {
    const today = new Date().toISOString().slice(0, 10)
    withRepo({ 'README.md': `Verified ${today} against the source.` }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })

  test('--max-age moves the line', () => {
    const recent = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    withRepo({ 'README.md': `Checked ${recent}.` }, (dir) => {
      assert.deepEqual(json(dir).findings, [], 'inside the default 180 days')
      assert.deepEqual(checksIn(json(dir, '--max-age', '7')), ['dated'])
    })
  })

  test('a bare date is not a dated fact', () => {
    withRepo({ 'README.md': 'The incident on 2020-01-01 took four hours.' }, (dir) => {
      assert.deepEqual(json(dir).findings, [])
    })
  })
})
