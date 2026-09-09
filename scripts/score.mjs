#!/usr/bin/env node
// coldbench score — recall, precision and token cost for one or more arms.
//
//   node scripts/score.mjs --gold gold.json --arm base:answers/base --arm tool:answers/tool
//   node scripts/score.mjs --gold gold.json --arm tool:answers/tool:transcripts/tool
//
// An --arm is <label>:<answersDir>[:<transcriptDir>]. Transcripts are optional;
// without them you get recall only, which is half a benchmark.

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadGold, loadAnswers, scoreArm } from './lib/score.mjs'
import { computeUsage, collectToolIO } from './lib/usage.mjs'

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? def : argv[i + 1]
}
const all = name => argv.reduce((a, v, i) => (v === `--${name}` ? [...a, argv[i + 1]] : a), [])

const goldPath = opt('gold')
const armSpecs = all('arm')
const asJson = argv.includes('--json')

if (!goldPath || !armSpecs.length) {
  console.error('usage: score.mjs --gold <gold.json> --arm <label>:<answersDir>[:<transcriptDir>] [--arm ...]')
  process.exit(2)
}

const gold = loadGold(goldPath)

// Map each transcript to a query by the answer path the prompt contract requires
// the agent to write to. Far more reliable than parsing a leading number out of
// the first user message, which breaks on any reworded prompt.
function mapTranscripts (dir) {
  const byQid = new Map()
  if (!dir || !existsSync(dir)) return byQid
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f))
  for (const f of files) {
    const head = readFileSync(f, 'utf8')
    const m = head.match(/benchmark_output\/([A-Za-z0-9_-]+_q\d+)\.txt/)
    if (!m) continue
    const qid = m[1]
    const prev = byQid.get(qid)
    if (!prev || statSync(f).mtimeMs > statSync(prev).mtimeMs) byQid.set(qid, f)
  }
  return byQid
}

const arms = []
for (const spec of armSpecs) {
  const [label, answersDir, transcriptDir] = spec.split(':')
  const answers = loadAnswers(answersDir)
  const scored = scoreArm(gold, answers)
  const tx = mapTranscripts(transcriptDir)

  let tokens = null
  let unseen = 0
  let scoredWithTx = 0
  if (tx.size) {
    tokens = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, total: 0, generations: 0 }
    for (const row of scored.rows) {
      const f = tx.get(row.qid)
      if (!f) continue
      scoredWithTx++
      const u = computeUsage(f)
      for (const k of Object.keys(tokens)) tokens[k] += u[k] || 0
      // Contamination: a gold file the agent named but never saw in tool I/O.
      const io = collectToolIO(f)
      unseen += row.hit.filter(p => !io.includes(p)).length
    }
  }
  arms.push({ label, ...scored, tokens, unseen, scoredWithTx })
}

if (asJson) {
  console.log(JSON.stringify({ gold: goldPath, arms }, null, 2))
  process.exit(0)
}

const pct = v => (v * 100).toFixed(1) + '%'
const k = v => (v / 1000).toFixed(0) + 'k'

console.log(`\ngold: ${goldPath}  (${gold.size} queries)\n`)
console.log('arm'.padEnd(14) + 'n'.padStart(4) + 'recall'.padStart(9) + 'prec'.padStart(9) +
            'jaccard'.padStart(9) + 'tokens'.padStart(11) + 'unseen'.padStart(8))
console.log('-'.repeat(64))
for (const a of arms) {
  console.log(
    a.label.padEnd(14) + String(a.n).padStart(4) + pct(a.recall).padStart(9) +
    pct(a.precision).padStart(9) + pct(a.jaccard).padStart(9) +
    (a.tokens ? k(a.tokens.total) : '-').padStart(11) +
    (a.tokens ? String(a.unseen) : '-').padStart(8))
}

for (const a of arms) {
  if (a.missingAnswers.length) console.log(`\n! ${a.label}: no answer file for ${a.missingAnswers.length} queries: ${a.missingAnswers.join(', ')}`)
  if (a.tokens && a.scoredWithTx < a.n) console.log(`! ${a.label}: token total covers ${a.scoredWithTx}/${a.n} queries (no transcript matched the rest)`)
  if (a.tokens && a.unseen) console.log(`! ${a.label}: ${a.unseen} correct file(s) never appeared in tool I/O — named from pretraining, not exploration`)
}

if (arms.length === 2) {
  const [a, b] = arms
  console.log(`\n${b.label} vs ${a.label}:`)
  console.log(`  recall  ${(b.recall - a.recall >= 0 ? '+' : '')}${((b.recall - a.recall) * 100).toFixed(1)} points`)
  if (a.tokens && b.tokens) {
    const d = (b.tokens.total - a.tokens.total) / a.tokens.total
    console.log(`  tokens  ${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`)
  }
  console.log(`\n  A single pair of runs is not a measurement. Establish the nondeterminism`)
  console.log(`  floor first: run one arm against itself and see how far it moves.`)
}
console.log()
