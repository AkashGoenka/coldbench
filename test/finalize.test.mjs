import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { vocabDensity, leakCheck, finalize, buildGroundTruth } from '../scripts/lib/finalize.mjs'
import { outputContract } from '../scripts/lib/contract.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('vocabDensity is the exact fraction of meaningful basename tokens present in the question', () => {
  // gold files contribute tokens: upload(3), card(1) -- "js"/"card.js" stopword-free,
  // "index" is a stopword and dropped -- so 2 meaningful tokens total, 1 present.
  const files = ['src/upload.js', 'src/card.js', 'src/index.js']
  const question = 'Where does the upload path live?'
  const density = vocabDensity(files, question)
  assert.equal(density, 0.5)
})

test('vocabDensity is 1 when there are no meaningful tokens to match (all stopwords)', () => {
  const density = vocabDensity(['src/index.js', 'src/util.js'], 'anything at all')
  assert.equal(density, 1)
})

test('leakCheck flags a question that names a gold file\'s basename', () => {
  const r = leakCheck(['app/models/user.py'], 'Where is user.py handled?')
  assert.equal(r.flagged, true)
  assert.ok(r.terms.includes('user.py') || r.terms.includes('user'))
})

test('leakCheck does not flag on an unrelated word that merely contains a gold term as substring', () => {
  // "user" is a leak term for app/models/user.py; "username" must not trip it
  // (word-boundary matched, not substring matched).
  const r = leakCheck(['app/models/user.py'], 'How does username validation work?')
  assert.equal(r.flagged, false)
})

test('finalize joins worksheet rows to rewrites by id, skips and not-yet-rewritten are separated out', () => {
  const worksheet = [
    { id: 'A', files: ['a.js', 'b.js'], scope: 'single', file_count: 2 },
    { id: 'B', files: ['c.js', 'd.js'], scope: 'single', file_count: 2 },
    { id: 'C', files: ['e.js', 'f.js'], scope: 'single', file_count: 2 }
  ]
  const rewrites = [
    { id: 'A', question: 'Where does A live?' },
    { id: 'B', skip: true, reason: 'not a real problem' }
  ]
  const { finalized, skipped, notRewritten } = finalize(worksheet, rewrites, { prefix: 'demo' })
  assert.equal(finalized.length, 1)
  assert.equal(finalized[0].qid, 'demo_q01')
  assert.equal(skipped.length, 1)
  assert.deepEqual(notRewritten, ['C'])
})

test('ground_truth.json is byte-exact: 1-space indent, sorted files, qid order', () => {
  const worksheet = [{ id: 'A', files: ['b.js', 'a.js'], scope: 'single', file_count: 2 }]
  const rewrites = [{ id: 'A', question: 'Where does A live?' }]
  const { finalized } = finalize(worksheet, rewrites, { prefix: 'demo' })
  const gt = buildGroundTruth(finalized)
  const text = JSON.stringify(gt, null, 1) + '\n'
  assert.equal(text, '{\n "demo_q01": {\n  "issue_number": null,\n  "scope": "single",\n  "files": [\n   "a.js",\n   "b.js"\n  ]\n }\n}\n')
})

test('prompts/<qid>.txt uses the contract text verbatim from contract.mjs', () => {
  const worksheet = [{ id: 'A', files: ['a.js', 'b.js'], scope: 'single', file_count: 2 }]
  const rewrites = [{ id: 'A', question: 'Where does A live?' }]
  const { finalized } = finalize(worksheet, rewrites, { prefix: 'demo' })
  const row = finalized[0]
  const text = `1. [${row.scope}] ${row.question}\n\n${outputContract(row.qid)}\n`
  assert.ok(text.includes(outputContract('demo_q01')))
  assert.ok(text.startsWith('1. [single] Where does A live?\n\n'))
})

test('contract.mjs matches the fenced block in skills/build-prompts/SKILL.md byte-for-byte, modulo the <qid> placeholder', () => {
  const skillPath = join(__dirname, '..', 'skills', 'build-prompts', 'SKILL.md')
  const skill = readFileSync(skillPath, 'utf8')
  const lines = skill.split('\n')
  const headingIdx = lines.findIndex(l => l.trim() === '## The output contract')
  assert.ok(headingIdx !== -1, 'SKILL.md must still have an "## The output contract" heading')
  const fenceStart = lines.findIndex((l, i) => i > headingIdx && l.trim() === '```')
  const fenceEnd = lines.findIndex((l, i) => i > fenceStart && l.trim() === '```')
  const fenced = lines.slice(fenceStart + 1, fenceEnd).join('\n')

  const ours = outputContract('<qid>')
  assert.equal(ours, fenced, 'contract.mjs has drifted from the fenced block in SKILL.md')
})
