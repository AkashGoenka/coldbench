#!/usr/bin/env node
// coldbench score — recall, precision and token cost for one or more arms.
//
//   node scripts/score.mjs --gold gold.json --arm base:answers/base --arm tool:answers/tool
//   node scripts/score.mjs --gold gold.json --arm tool:answers/tool:transcripts/tool
//
// An --arm is <label>:<answersDir>[:<transcriptDir>]. Transcripts are optional;
// without them you get recall only, which is half a benchmark.

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
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

// Claude Code stores transcripts under ~/.claude/projects/<path with / and . as ->.
// Nobody should have to work that out by hand, so an arm may name the repo copy
// itself and we resolve the folder.
function transcriptDirFor (repoPath) {
  const abs = resolve(repoPath)
  const mangled = abs.replace(/[/.]/g, '-')
  return join(homedir(), '.claude', 'projects', mangled)
}

const arms = []
for (const spec of armSpecs) {
  const [label, answersDir, txSpec] = spec.split(':')
  // A directory that exists but holds no .jsonl is a repo path, not a transcript
  // dir. Checking existence alone would silently accept it and report no tokens.
  const hasJsonl = d => d && existsSync(d) && readdirSync(d).some(f => f.endsWith('.jsonl'))
  let transcriptDir = txSpec
  if (txSpec && !hasJsonl(txSpec)) {
    const guess = transcriptDirFor(txSpec)
    if (hasJsonl(guess)) transcriptDir = guess
    else console.error(`! ${label}: no .jsonl transcripts in ${txSpec} or ${guess}`)
  }
  const answers = loadAnswers(answersDir)
  const scored = scoreArm(gold, answers)
  const tx = mapTranscripts(transcriptDir)

  let tokens = null
  let unseen = 0
  let scoredWithTx = 0
  const models = new Map()
  let compacted = []
  if (tx.size) {
    tokens = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, total: 0, generations: 0 }
    for (const row of scored.rows) {
      const f = tx.get(row.qid)
      if (!f) continue
      scoredWithTx++
      const u = computeUsage(f)
      for (const k of Object.keys(tokens)) tokens[k] += u[k] || 0
      for (const [m, n] of Object.entries(u.models || {})) models.set(m, (models.get(m) || 0) + n)
      if (u.compactions > 0) compacted.push(row.qid)
      // Contamination: a gold file the agent named but never saw in tool I/O.
      const io = collectToolIO(f)
      unseen += row.hit.filter(p => !io.includes(p)).length
    }
  }
  arms.push({ label, ...scored, tokens, unseen, scoredWithTx, models: Object.fromEntries(models), compacted })
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
  if (a.tokens && a.unseen) console.log(`! ${a.label}: ${a.unseen} correct file(s) never appeared in tool I/O - named from pretraining, not exploration`)
  // '<synthetic>' is a Claude Code internal marker, not a model the run chose.
  const ms = Object.keys(a.models || {}).filter(m => m !== '<synthetic>' && m !== 'unknown')
  if (ms.length > 1) console.log(`! ${a.label}: ran on ${ms.length} models (${ms.join(', ')}) - not a single-variable arm`)
  if (a.compacted?.length) console.log(`! ${a.label}: context compacted mid-run on ${a.compacted.length} quer(y/ies): ${a.compacted.join(', ')} - those runs saw a rewritten context`)
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
