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

test('a query with no answer file is scored as a zero, not dropped from the mean', () => {
  const gold = loadGold(join(fx, 'gold.json'))
  const answers = loadAnswers(join(fx, 'answers'))
  const s = scoreArm(gold, answers)
  assert.equal(s.n, 3, 'every gold query is scored')
  assert.deepEqual(s.missingAnswers, ['demo_q03'])
  // q01 recall 1.0 precision 2/3; q02 1.0/1.0; q03 0/0 -> macro mean.
  assert.equal(Math.round(s.recall * 1000) / 1000, 0.667)
  assert.equal(Math.round(s.precision * 1000) / 1000, 0.556)
  assert.equal(s.rows.find(r => r.qid === 'demo_q03').missing, true)
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

// The two accounting rules that silently corrupt a token total, pinned against a
// fixture so they hold for everyone rather than only where convotokens happens
// to be installed:
//   msg_A appears on two lines with the same id and must be counted once.
//   msg_C lives in a subagent sidechain and must be counted at all.
test('token accounting dedups by message.id and folds subagent sidechains', async () => {
  const { computeUsage } = await import('../scripts/lib/usage.mjs')
  const u = computeUsage(join(fx, 'transcript/run.jsonl'))
  assert.equal(u.generations, 3, 'msg_A counted once, msg_B and msg_C once each')
  assert.equal(u.subagentFiles, 1)
  assert.equal(u.input, 31)
  assert.equal(u.cacheCreate, 302)
  assert.equal(u.cacheRead, 3003)
  assert.equal(u.output, 19)
  assert.equal(u.total, 3355, 'summing raw lines instead would give 4465')
})

test('confound detectors see model drift and compaction', async () => {
  const { computeUsage } = await import('../scripts/lib/usage.mjs')
  const u = computeUsage(join(fx, 'transcript/run.jsonl'))
  assert.equal(u.compactions, 1)
  assert.deepEqual(u.models, { 'claude-sonnet-5': 2, 'claude-haiku-4-5-20251001': 1 })
})

test('tool I/O collection sees paths from tool_use inputs', async () => {
  const { collectToolIO } = await import('../scripts/lib/usage.mjs')
  const io = collectToolIO(join(fx, 'transcript/run.jsonl'))
  assert.ok(io.includes('app/views/auth.py'), 'a file the agent read is visible')
  assert.ok(!io.includes('app/models/user.py'), 'a file it never touched is not')
})

// Codex writes cumulative token_count snapshots rather than Claude's per-block
// deltas, so the accounting bug that matters here is the opposite of the one
// above: summing snapshots overcounts, only the LATEST one is real. Pinned
// against a fixture for the same reason - so it holds without convotokens
// installed - main.jsonl's two snapshots are 105 then 315; summing would give
// 420, and folding in sub.jsonl's 60 should land on 375, not 480.
test('Codex token accounting keeps the latest snapshot, not the sum, and folds subagent files', async () => {
  const { computeUsage } = await import('../scripts/lib/usage.mjs')
  const u = computeUsage(join(fx, 'codex-transcript/main.jsonl'))
  assert.equal(u.input, 350, '300 main + 50 subagent')
  assert.equal(u.cacheRead, 120, 'subset of input, not additive - only main had any')
  assert.equal(u.cacheCreate, 7, 'cache_write_input_tokens, also a subset of input - display only, must not inflate total')
  assert.equal(u.output, 25, '15 main + 10 subagent')
  assert.equal(u.total, 375, '315 latest-main-snapshot (incl. the 7 cache-write tokens already counted in input) + 60 subagent, not 420 + 60 from summing both main snapshots')
  assert.equal(u.generations, 3, '2 main token_count updates + 1 subagent update')
  assert.equal(u.subagentFiles, 1)
  assert.deepEqual(u.models, { 'gpt-5.6-terra': 1 })
  assert.equal(u.compactions, 1)
})

test('Codex format is detected automatically by computeUsage, no engine flag needed', async () => {
  const { computeUsage } = await import('../scripts/lib/usage.mjs')
  const claude = computeUsage(join(fx, 'transcript/run.jsonl'))
  const codex = computeUsage(join(fx, 'codex-transcript/main.jsonl'))
  assert.equal(claude.total, 3355)
  assert.equal(codex.total, 375)
})

test('collectToolIO sees tool paths in a Codex response_item', async () => {
  const { collectToolIO, countToolCalls } = await import('../scripts/lib/usage.mjs')
  const io = collectToolIO(join(fx, 'codex-transcript/main.jsonl'))
  assert.ok(io.includes('app/views/auth.py'))
  assert.deepEqual(countToolCalls(join(fx, 'codex-transcript/main.jsonl')), { 'functions.exec': 1 })
})

test('resolveTranscriptDir falls back to a Codex cwd match when no Claude project directory exists', async () => {
  const { findCodexSessionsForCwd } = await import('../scripts/lib/codex.mjs')
  const root = join(fx, 'codex-transcript')
  const matches = findCodexSessionsForCwd('/tmp/codex-fixture-repo', root)
  assert.deepEqual(matches, [join(root, 'main.jsonl')], 'the subagent file is excluded, only the main session matches')
})

test('resolveTranscriptDir accepts one transcript file without scanning it as a directory', async () => {
  const { resolveTranscriptDir, listTranscripts } = await import('../scripts/lib/transcripts.mjs')
  const file = join(fx, 'codex-transcript/main.jsonl')
  const resolved = resolveTranscriptDir(file)
  assert.deepEqual(resolved.files, [file])
  assert.deepEqual(listTranscripts(file), [file])
})

test('Codex accounting follows a subagent across the session date boundary', async () => {
  const { computeCodexUsage } = await import('../scripts/lib/codex.mjs')
  const root = join(fx, 'codex-cross-date')
  const main = join(root, '2026/08/12/main.jsonl')
  const u = computeCodexUsage(main, root)
  assert.equal(u.total, 165, 'includes the next-day subagent rather than undercounting the arm')
  assert.equal(u.subagentFiles, 1)
})
