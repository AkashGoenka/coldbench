// Ephemeral git repos for testing git.mjs / resolve.mjs without committed fixtures.
// A real .git directory is the only faithful way to exercise git plumbing.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

export function makeRepo () {
  const dir = mkdtempSync(join(tmpdir(), 'coldbench-test-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')

  return {
    dir,
    git,
    commit (message, files = {}) {
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, content)
      }
      if (Object.keys(files).length) git('add', '-A')
      git('commit', '--allow-empty', '-m', message)
      return git('rev-parse', 'HEAD').trim()
    },
    branch (name) {
      git('checkout', '-q', '-b', name)
    },
    checkout (name) {
      git('checkout', '-q', name)
    },
    mergeNoFF (branch, message) {
      git('merge', '-q', '--no-ff', '-m', message, branch)
      return git('rev-parse', 'HEAD').trim()
    },
    shallowClone () {
      // --depth is silently ignored on a plain local path; force the real
      // (slower) transport with a file:// URL so the clone is actually shallow.
      const dest = mkdtempSync(join(tmpdir(), 'coldbench-test-shallow-'))
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, dest], { encoding: 'utf8' })
      return dest
    },
    cleanup () {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export function cleanupDir (dir) {
  rmSync(dir, { recursive: true, force: true })
}
