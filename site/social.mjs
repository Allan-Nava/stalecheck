#!/usr/bin/env node
// Renders assets/social-preview.html to assets/social-preview.png at 1200x630, the size
// every platform crops from. Headless Chrome does the work; it is not a dependency of the
// package, only of regenerating this one file, which changes when the numbers do.
//
//   npm run build:social

import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]
const chrome = CANDIDATES.find((c) => existsSync(c))
if (!chrome) {
  console.error('build:social: no Chrome or Chromium found. Install one, or render assets/social-preview.html by hand at 1200x630.')
  process.exit(1)
}

// Served rather than opened as a file:// URL, because a file:// page cannot load the
// sibling stylesheet or font in every Chrome build and fails quietly when it cannot.
const PORT = 8791
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: join(ROOT, 'assets'), stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))

try {
  execFileSync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      `--screenshot=${join(ROOT, 'assets', 'social-preview.png')}`,
      '--window-size=1200,630',
      `http://localhost:${PORT}/social-preview.html`,
    ],
    { stdio: 'ignore' },
  )
  console.log('wrote assets/social-preview.png — 1200x630')
} finally {
  server.kill()
}
