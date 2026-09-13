import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrub, qualityFilter, scopeFor, buildCandidates } from '../scripts/lib/build.mjs'

test('scopeFor assigns single/multi-file/cross-cutting at the documented boundaries', () => {
  assert.equal(scopeFor(1), 'single')
  assert.equal(scopeFor(2), 'single')
  assert.equal(scopeFor(3), 'multi-file')
  assert.equal(scopeFor(5), 'multi-file')
  assert.equal(scopeFor(6), 'cross-cutting')
  assert.equal(scopeFor(8), 'cross-cutting')
})

test('buildCandidates keeps in-range linked tickets and drops out-of-range ones', () => {
  const resolved = [
    { id: 'A', classification: 'linked', files: ['a.js', 'b.js'], commits: ['x'], body: longEnough('touches two files, described at length so it clears the quality filter for a real test case here.') },
    { id: 'B', classification: 'linked', files: ['a.js'], commits: ['x'], body: longEnough('touches only one file, below the minimum of two files required by the default range here.') },
    { id: 'C', classification: 'unlinked', files: [], commits: [], body: '' }
  ]
  const { rows, stats } = buildCandidates(resolved, { minFiles: 2, maxFiles: 8 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'A')
  assert.equal(stats.linkedTotal, 2)
  assert.equal(stats.droppedOutOfRange, 1)
})

test('buildCandidates assigns scope from the kept row\'s file count', () => {
  const resolved = [
    { id: 'A', classification: 'linked', files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'], commits: ['x'], body: longEnough('a cross-cutting change touching six different files across the codebase, described here.') }
  ]
  const { rows } = buildCandidates(resolved, { minFiles: 2, maxFiles: 8 })
  assert.equal(rows[0].scope, 'cross-cutting')
})

test('scrub removes a sha, an issue ref, a URL and a gold-file path, leaves prose intact', () => {
  const body = 'See commit a1b2c3d4e5f6 which references issue #4123 and https://example.com/thing. ' +
    'The bug lives in app/models/user.py and is otherwise a normal english sentence describing the problem in detail.'
  const scrubbed = scrub(body, ['app/models/user.py'])
  assert.ok(!scrubbed.includes('a1b2c3d4e5f6'.slice(0, 7)) || !/[0-9a-f]{7,40}/.test(scrubbed), 'sha should be gone')
  assert.ok(!scrubbed.includes('#4123'), 'issue ref should be gone')
  assert.ok(!scrubbed.includes('https://'), 'URL should be gone')
  assert.ok(!scrubbed.includes('app/models/user.py'), 'gold path should be gone')
  assert.ok(!scrubbed.includes('user.py'), 'gold basename should be gone')
  assert.ok(scrubbed.includes('normal english sentence'), 'unrelated prose should survive')
})

test('scrub does not mangle an unrelated word that contains a gold dir segment as a substring', () => {
  // Found on real data: scrubbing the gold file's "styles" directory segment
  // with a raw substring replace turned "stylesheet" into "heet".
  const body = 'It seems like a stylesheet regression dropped the footer styling entirely, ' +
    'and this has been happening consistently across every page for a while now, which is bad.'
  const scrubbed = scrub(body, ['site-astro/src/styles/backdrop.css'])
  assert.ok(scrubbed.includes('stylesheet'), `expected "stylesheet" intact, got: ${scrubbed}`)
})

test('qualityFilter rejects a body that is too short after scrubbing', () => {
  const result = qualityFilter('short orig', 'too short')
  assert.equal(result.ok, false)
  assert.match(result.reason, /too_short_after_scrub/)
})

test('qualityFilter rejects a body scrubbed down too far relative to the original', () => {
  const orig = 'x'.repeat(1000)
  const scrubbed = 'A reasonably long sentence that clears the length and sentence floors. It has two sentences.'
  const result = qualityFilter(orig, scrubbed, { minLen: 50, minSentences: 2, maxShrink: 0.4 })
  assert.equal(result.ok, false)
  assert.match(result.reason, /shrunk_too_much/)
})

function longEnough (s) {
  // Pad past the 200-char / 2-sentence quality floor without fighting the
  // scrubber -- plain prose, no paths/URLs/shas to strip.
  return `${s} It is a real problem that a real user reported in detail, ` +
    'with enough context here to clear both the minimum length and the minimum sentence count. ' +
    'This sentence exists purely to pad length past the two-hundred character floor for the test.'
}
