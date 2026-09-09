import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadGold, loadAnswers, scoreArm, parseAnswerFile, scoreOne } from '../scripts/lib/score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fx = join(here, 'fixtures')

test('answer parsing keeps paths and rejects prose, bullets and duplicates', () => {
  const r = parseAnswerFile('a/b.py\n- bullet\na/b.py\nSome prose here.\n\nc/d.py\n')
  assert.deepEqual(r.files, ['a/b.py', 'c/d.py'])
  assert.equal(r.rejected.length, 2)
})

test('scoreOne computes recall, precision and jaccard', () => {
  const s = scoreOne(['a.py', 'b.py'], ['a.py', 'c.py'])
  assert.equal(s.recall, 0.5)
  assert.equal(s.precision, 0.5)
  assert.equal(s.jaccard, 1 / 3)
  assert.deepEqual(s.missed, ['b.py'])
})

test('a query with no answer file is excluded from the mean, not scored zero', () => {
  const gold = loadGold(join(fx, 'gold.json'))
  const answers = loadAnswers(join(fx, 'answers'))
  const s = scoreArm(gold, answers)
  assert.equal(s.n, 2, 'only queries with an answer file are scored')
  assert.deepEqual(s.missingAnswers, ['demo_q03'])
  // q01 recall 1.0 precision 2/3; q02 recall 1.0 precision 1.0 -> macro mean
  assert.equal(s.recall, 1)
  assert.equal(Math.round(s.precision * 1000) / 1000, 0.833)
})

test('macro-average weighs every query equally regardless of gold size', () => {
  const gold = new Map([
    ['q1', { files: ['a', 'b', 'c', 'd'] }],
    ['q2', { files: ['z'] }]
  ])
  const answers = new Map([
    ['q1', { files: ['a', 'b', 'c', 'd'], rejected: [] }],
    ['q2', { files: [], rejected: [] }]
  ])
  assert.equal(scoreArm(gold, answers).recall, 0.5, 'not 4/5 micro')
})
