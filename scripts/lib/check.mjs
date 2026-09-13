// Preflight checks for the build-prompts pipeline. Stops at the first failure —
// each later step assumes every earlier one passed, so there is no reason to
// keep checking once one has failed.

import { execFileSync } from 'node:child_process'
import { gitAvailable, isGitRepo, isShallowRepo, commitCount, detectMergeStyle, sampleCommitSubjects } from './git.mjs'

const MIN_COMMITS = 200

export function runChecks (repo) {
  if (!gitAvailable()) {
    return { ok: false, message: 'git not found on PATH — install git and re-run.' }
  }
  if (!isGitRepo(repo)) {
    return { ok: false, message: `${repo} is not a git repository (or does not exist).` }
  }
  if (isShallowRepo(repo)) {
    return {
      ok: false,
      message: `${repo} is a shallow clone. git log --grep finds nothing in a shallow clone, ` +
        `and that looks identical to "no linkage convention." Re-clone without --depth and re-run.`
    }
  }
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10)
  if (nodeMajor < 18) {
    return { ok: false, message: `Node 18+ required, found v${process.versions.node}.` }
  }
  const commits = commitCount(repo)
  if (commits < MIN_COMMITS) {
    return {
      ok: false,
      message: `${repo} has only ${commits} commits of history; at least ${MIN_COMMITS} are needed ` +
        `for enough resolvable tickets.`
    }
  }

  const merge = detectMergeStyle(repo)
  const samples = sampleCommitSubjects(repo, 30)
  return {
    ok: true,
    repo,
    gitVersion: gitVersionString(),
    nodeVersion: process.versions.node,
    commits,
    mergeStyle: merge,
    sampledSubjects: samples
  }
}

function gitVersionString () {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8' }).replace(/^git version\s*/, '').trim()
  } catch {
    return 'unknown'
  }
}
