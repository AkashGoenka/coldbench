// Git plumbing for the build-prompts pipeline. execFileSync only — no git library,
// keeping with this repo's zero-dependency rule.

import { execFileSync } from 'node:child_process'

const RS = '\x1e' // record separator between commits in a --format dump
const US = '\x1f' // field separator within one commit's --format dump

// execFileSync inherits the parent's stderr by default even though stdout is
// captured, so a probe-and-catch call would otherwise leak git's own "fatal: ..."
// straight to the terminal ahead of our own error message. Pipe it instead.
const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }

function git (repo, args) {
  try {
    return execFileSync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024, ...QUIET })
  } catch (err) {
    throw new Error(`git ${args[0]} failed in ${repo}: ${err.stderr || err.message}`)
  }
}

export function gitAvailable () {
  try {
    execFileSync('git', ['--version'], QUIET)
    return true
  } catch {
    return false
  }
}

export function isGitRepo (repo) {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--git-dir'], QUIET)
    return true
  } catch {
    return false
  }
}

export function isShallowRepo (repo) {
  return git(repo, ['-C', repo, 'rev-parse', '--is-shallow-repository']).trim() === 'true'
}

export function commitCount (repo) {
  return parseInt(git(repo, ['-C', repo, 'rev-list', '--count', 'HEAD']).trim(), 10)
}

// Evenly spaced across the FULL history, including both endpoints, not just the
// latest n. Latest-n is skewed toward whatever the maintainers did this month; an
// even spread represents the linkage convention across the repo's life.
export function sampleCommitSubjects (repo, n = 30) {
  const all = git(repo, ['-C', repo, 'log', '--format=%s']).split('\n').filter(Boolean)
  if (all.length <= n) return all
  const sampled = []
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (all.length - 1)) / (n - 1))
    sampled.push(all[idx])
  }
  return sampled
}

function parseCommitDump (raw) {
  return raw.split(RS).map(s => s.trim()).filter(Boolean).map(rec => {
    const [sha, subject, body] = rec.split(US)
    return { sha, subject: subject || '', body: body || '' }
  })
}

export function detectMergeStyle (repo, sampleSize = 300) {
  const raw = git(repo, ['-C', repo, 'log', `-n${sampleSize}`, `--format=%H${US}%s${US}%b${RS}`])
  const commits = parseCommitDump(raw)
  let mergeCount = 0
  let squashCount = 0
  for (const c of commits) {
    if (/Merge pull request #\d+/.test(c.body) || /Merge pull request #\d+/.test(c.subject)) mergeCount++
    else if (/\(#\d+\)\s*$/.test(c.subject)) squashCount++
  }
  const style = mergeCount > 0 && mergeCount >= squashCount ? 'merge-commit'
    : squashCount > 0 ? 'squash'
    : 'unknown'
  return { style, mergeCount, squashCount }
}

// --perl-regexp, not --extended-regexp: patternFor() relies on \b word boundaries,
// which POSIX ERE does not support (it matched nothing, silently, in testing).
export function findCommitsByGrep (repo, pattern) {
  let raw
  try {
    raw = git(repo, ['-C', repo, 'log', '--regexp-ignore-case', '--perl-regexp', `--grep=${pattern}`, `--format=%H${US}%s${US}%b${RS}`])
  } catch {
    return []
  }
  return parseCommitDump(raw)
}

export function findCommitByPr (repo, prNumber) {
  const byMerge = findCommitsByGrep(repo, `^Merge pull request #${prNumber}\\b`)
  if (byMerge.length) return byMerge[0].sha
  const bySquash = findCommitsByGrep(repo, `\\(#${prNumber}\\)$`)
  if (bySquash.length) return bySquash[0].sha
  return null
}

export function commitExists (repo, sha) {
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], QUIET)
    return true
  } catch {
    return false
  }
}

// Diffing directly against the first parent is load-bearing for merge commits:
// plain diff-tree on a merge returns nothing (misclassifies every PR-merge ticket
// as `empty`), and `diff-tree -m --first-parent` does NOT restrict to the first
// parent either -- diff-tree's -m ignores --first-parent and diffs against every
// parent, concatenating the results (confirmed in testing: it returned files from
// both branches). `git diff <sha>^ <sha>` diffs the merge result against its
// mainline base directly, which is "what this merge introduced" -- the same
// command also handles an ordinary single-parent commit correctly.
export function commitFiles (repo, sha) {
  try {
    return git(repo, ['-C', repo, 'diff', '--name-only', `${sha}^`, sha])
      .split('\n').map(s => s.trim()).filter(Boolean)
  } catch {
    // Root commit: no parent to diff against, so diff against the empty tree.
    return git(repo, ['-C', repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha])
      .split('\n').map(s => s.trim()).filter(Boolean)
  }
}

export function extractRefs (text, pattern) {
  const seen = new Set()
  for (const m of text.matchAll(new RegExp(pattern, 'gi'))) seen.add(m[0])
  return [...seen]
}
