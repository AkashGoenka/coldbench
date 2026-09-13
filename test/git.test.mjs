import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo, cleanupDir } from './helpers/tmprepo.mjs'
import {
  isShallowRepo, commitFiles, detectMergeStyle, findCommitsByGrep, sampleCommitSubjects
} from '../scripts/lib/git.mjs'

test('isShallowRepo is false for a full repo and true for a shallow clone', () => {
  const repo = makeRepo()
  repo.commit('first', { 'a.txt': '1' })
  repo.commit('second', { 'a.txt': '2' })
  assert.equal(isShallowRepo(repo.dir), false)

  const shallowDir = repo.shallowClone()
  assert.equal(isShallowRepo(shallowDir), true)

  cleanupDir(shallowDir)
  repo.cleanup()
})

test('commitFiles returns files for an ordinary commit', () => {
  const repo = makeRepo()
  repo.commit('init', { 'a.txt': '1' })
  const sha = repo.commit('touch b', { 'b.txt': '1' })
  assert.deepEqual(commitFiles(repo.dir, sha), ['b.txt'])
  repo.cleanup()
})

test('commitFiles on a merge commit sees only what the merge introduced, not the other parent\'s prior work', () => {
  const repo = makeRepo()
  repo.commit('init', { 'main.txt': '1' })
  repo.branch('feature')
  repo.commit('feature work', { 'feature.txt': '1' })
  repo.checkout('main')
  repo.commit('unrelated main work', { 'other.txt': '1' })
  const mergeSha = repo.mergeNoFF('feature', 'Merge pull request #7 from x/feature')
  assert.deepEqual(commitFiles(repo.dir, mergeSha), ['feature.txt'])
  repo.cleanup()
})

test('detectMergeStyle recognizes squash-style subjects', () => {
  const repo = makeRepo()
  repo.commit('init', { 'a.txt': '1' })
  repo.commit('fix: thing one (#1)', { 'a.txt': '2' })
  repo.commit('fix: thing two (#2)', { 'a.txt': '3' })
  repo.commit('fix: thing three (#3)', { 'a.txt': '4' })
  const { style, squashCount, mergeCount } = detectMergeStyle(repo.dir)
  assert.equal(style, 'squash')
  assert.equal(squashCount, 3)
  assert.equal(mergeCount, 0)
  repo.cleanup()
})

test('detectMergeStyle recognizes merge-commit style bodies', () => {
  const repo = makeRepo()
  repo.commit('init', { 'main.txt': '1' })
  repo.branch('feature')
  repo.commit('feature work', { 'feature.txt': '1' })
  repo.checkout('main')
  repo.mergeNoFF('feature', 'Merge pull request #7 from x/feature\n\nAdds feature work')
  const { style, mergeCount } = detectMergeStyle(repo.dir)
  assert.equal(style, 'merge-commit')
  assert.equal(mergeCount, 1)
  repo.cleanup()
})

test('findCommitsByGrep hits a matching subject and misses otherwise', () => {
  const repo = makeRepo()
  repo.commit('init', { 'a.txt': '1' })
  repo.commit('fix PROJ-412: dedupe upload', { 'a.txt': '2' })
  const hits = findCommitsByGrep(repo.dir, '\\bPROJ-412\\b')
  assert.equal(hits.length, 1)
  const misses = findCommitsByGrep(repo.dir, '\\bPROJ-999\\b')
  assert.equal(misses.length, 0)
  repo.cleanup()
})

test('sampleCommitSubjects covers the full history, not just the tail', () => {
  const repo = makeRepo()
  for (let i = 0; i < 20; i++) repo.commit(`commit ${i}`, { 'a.txt': String(i) })
  const sampled = sampleCommitSubjects(repo.dir, 5)
  assert.equal(sampled.length, 5)
  // git log lists newest first; the oldest commit ("commit 0") should still appear
  // in a 5-of-20 stride sample, proving it isn't just the latest n.
  assert.ok(sampled.includes('commit 0'))
  repo.cleanup()
})
