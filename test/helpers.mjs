// A throwaway git repository with documents in it. The checks ask git for the file
// index, so a fixture that is not a repository would exercise a different code path
// from the one users run.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const CLI = join(ROOT, 'bin', 'stalecheck.mjs')

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** files: { 'path': 'contents' } — every one is written and committed. */
export function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'stalecheck-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  for (const [p, body] of Object.entries(files)) {
    const full = join(dir, p)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'fixture')
  return dir
}

/** Runs the CLI as a process — stdin/stdout is the contract, not the exports. */
export function cli(dir, ...args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8' })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '' }
  }
}

export function json(dir, ...args) {
  const { stdout, code } = cli(dir, '--json', ...args)
  return { code, ...JSON.parse(stdout) }
}

export const checksIn = (result) => result.findings.map((f) => f.check)
