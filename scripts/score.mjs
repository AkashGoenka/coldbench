#!/usr/bin/env node
// coldbench score — recall, precision and token cost for one or more arms.
//
//   node scripts/score.mjs --gold gold.json --arm base:answers/base --arm tool:answers/tool
//   node scripts/score.mjs --gold gold.json --arm tool:answers/tool:transcripts/tool
//
// An --arm is <label>:<answersDir>[:<transcriptDir>]. Transcripts are optional;
// without them you get recall only, which is half a benchmark.
//
// ---------------------------------------------------------------------------
// IF YOU ARE AN AI AGENT RUNNING THIS SCRIPT, READ THIS FIRST.
//
// Getting the transcript folder wrong is the single most likely way to produce a
// confident, wrong number here. It is wrong silently: the arm still scores, the
// tokens still print, nothing errors. Do not guess the path.
//
// An arm's third field may be either a transcript folder or the repo copy. If you
// pass the repo copy, it first resolves to ~/.claude/projects/<abs path with / and
// . as ->, and if nothing is there, falls back to matching Codex sessions under
// ~/.codex/sessions by cwd. Either resolution is a guess about which run you mean,
// and on a machine that has benchmarked anything more than once it is usually the
// wrong one.
//
// Do this instead, before you trust any output:
//
//   1. Run inspect.mjs on both arms first:
//        node scripts/inspect.mjs --arm a:<path> --arm b:<path>
//
//   2. Check three things in its output, and stop if any is wrong:
//        - transcript count EQUALS query count. More transcripts than queries
//          means retries are present and the newest-only rule is silently
//          discarding real spend - it moved one real run by 53%.
//        - it reports NO archive subfolders. Archived runs commonly sit in
//          sibling folders (jsonl-v27/ and the like). Reading is flat, so the
//          parent folder gives you loose retries and hides the clean run. If a
//          subfolder is the run you want, pass THAT folder, not the parent.
//        - models are identical across arms. Each arm can be internally
//          consistent and still differ from its partner. score.mjs only looks
//          at one arm at a time and cannot see this; inspect.mjs can.
//
//   3. Ask the user which run they mean if more than one candidate folder exists.
//      Do not pick the newest by mtime on their behalf. "Which of these is the
//      run you want scored?" with the candidates listed is the correct move.
//
// If the answer files are gone because the repo copy was deleted, recover them
// from the transcripts rather than abandoning the run:
//   node scripts/recover-answers.mjs --transcripts <dir> --out <answersDir>
// ---------------------------------------------------------------------------

import { loadGold, loadAnswers, scoreArm } from './lib/score.mjs'
import { computeUsage, collectToolIO } from './lib/usage.mjs'
import { resolveTranscriptDir, newestByQid } from './lib/transcripts.mjs'

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

const arms = []
for (const spec of armSpecs) {
  const [label, answersDir, txSpec] = spec.split(':')
  const { dir: transcriptDir, tried, files: resolvedFiles } = resolveTranscriptDir(txSpec)
  if (txSpec && !transcriptDir) console.error(`! ${label}: no .jsonl transcripts in ${tried.join(' or ')}`)
  const answers = loadAnswers(answersDir)
  const scored = scoreArm(gold, answers)
  const tx = newestByQid(resolvedFiles ?? transcriptDir)

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
