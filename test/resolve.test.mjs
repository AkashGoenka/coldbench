import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo } from './helpers/tmprepo.mjs'
import { resolveTicket } from '../scripts/lib/resolve.mjs'

const opts = { mergeStyle: 'squash' }

test('linked: a commit references the ticket and touches files', () => {
  const repo = makeRepo()
  repo.commit('init', { 'a.txt': '1' })
  repo.commit('fix PROJ-412: dedupe upload', { 'upload.js': '1', 'card.js': '1' })
  const r = resolveTicket(repo.dir, { id: 'PROJ-412' }, opts)
  assert.equal(r.classification, 'linked')
  assert.deepEqual(r.files.sort(), ['card.js', 'upload.js'])
  repo.cleanup()
})

test('unlinked: no commit references the ticket', () => {
  const repo = makeRepo()
  repo.commit('init', { 'a.txt': '1' })
  repo.commit('unrelated change', { 'b.txt': '1' })
  const r = resolveTicket(repo.dir, { id: 'PROJ-999' }, opts)
  assert.equal(r.classification, 'unlinked')
  assert.deepEqual(r.files, [])
  repo.cleanup()
})

test('empty: the matched commit touches 0 files', () => {
  const repo = makeRepo()
  repo.commit('init', { 'a.txt': '1' })
  repo.commit('PROJ-413: revert, no-op')
  const r = resolveTicket(repo.dir, { id: 'PROJ-413' }, opts)
  assert.equal(r.classification, 'empty')
  repo.cleanup()
})

test('filtered: the matched commit also references a second ticket', () => {
  const repo = makeRepo()
  repo.commit('init', { 'a.txt': '1' })
  repo.commit('fix PROJ-414 and PROJ-415 together', { 'shared.js': '1' })
  const r = resolveTicket(repo.dir, { id: 'PROJ-414' }, opts)
  assert.equal(r.classification, 'filtered')
  assert.match(r.reason, /PROJ-415/)
  repo.cleanup()
})

test('ambiguous: two matching commits disagree on files', () => {
  const repo = makeRepo()
  repo.commit('init', { 'a.txt': '1' })
  repo.commit('PROJ-500: attempt one', { 'x.js': '1' })
  repo.commit('PROJ-500: attempt two', { 'y.js': '1' })
  const r = resolveTicket(repo.dir, { id: 'PROJ-500' }, opts)
  assert.equal(r.classification, 'ambiguous')
  assert.deepEqual(r.files, [])
  repo.cleanup()
})

test('linked, not ambiguous: two matching commits agree on files', () => {
  const repo = makeRepo()
  repo.commit('init', { 'a.txt': '1' })
  repo.commit('PROJ-600: attempt', { 'z.js': '1' })
  repo.commit('PROJ-600: follow-up touching the same file', { 'z.js': '2' })
  const r = resolveTicket(repo.dir, { id: 'PROJ-600' }, opts)
  // Two distinct commits, but the SAME file set (['z.js']) both times --
  // that should dedupe to one distinct set and classify as linked, not ambiguous.
  assert.equal(r.classification, 'linked')
  assert.deepEqual(r.files, ['z.js'])
  repo.cleanup()
})

test('merge-commit style: a PR-hint ticket resolves via findCommitByPr', () => {
  const repo = makeRepo()
  repo.commit('init', { 'main.txt': '1' })
  repo.branch('feature')
  repo.commit('feature work', { 'feature.txt': '1' })
  repo.checkout('main')
  repo.mergeNoFF('feature', 'Merge pull request #9 from x/feature')
  const r = resolveTicket(repo.dir, { id: 'PROJ-700', pr: 9 }, { mergeStyle: 'merge-commit' })
  assert.equal(r.classification, 'linked')
  assert.deepEqual(r.files, ['feature.txt'])
  repo.cleanup()
})
