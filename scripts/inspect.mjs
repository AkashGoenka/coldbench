#!/usr/bin/env node
// coldbench inspect — what is actually in an arm's transcript folder, before you
// trust a number computed from it.
//
//   node scripts/inspect.mjs --arm base:~/bench/repo-plain --arm tool:~/bench/repo-tool
//
// score.mjs keeps the newest transcript per query and moves on. That is a silent
// choice, and on a folder holding retries it can move the token total by tens of
// percent. This prints what the choice is costing you, plus the cross-arm checks
// score.mjs cannot make while looking at one arm at a time.
//
// IF YOU ARE AN AI AGENT: run this before score.mjs, on every arm, every time. An
// arm is safe to score only when its transcript count equals its query count, it
// reports no archive subfolders, and the models match across arms. A BLOCKER line
// means the comparison does not isolate the variable under test - report it to the
// user and stop rather than quoting the delta. If several candidate folders exist,
// list them and ask which run they mean; do not choose for them.

import { resolveTranscriptDir, groupByQid, listTranscripts, archiveSubdirs } from './lib/transcripts.mjs'
import { computeUsage } from './lib/usage.mjs'
import { basename } from 'node:path'

const argv = process.argv.slice(2)
const all = name => argv.reduce((a, v, i) => (v === `--${name}` ? [...a, argv[i + 1]] : a), [])
const armSpecs = all('arm')
const asJson = argv.includes('--json')

if (!armSpecs.length) {
  console.error('usage: inspect.mjs --arm <label>:<transcriptDir|repoPath> [--arm ...] [--json]')
  process.exit(2)
}

const M = v => (v / 1e6).toFixed(2) + 'M'
const arms = []

for (const spec of armSpecs) {
  const i = spec.indexOf(':')
  const label = spec.slice(0, i)
  const { dir, tried } = resolveTranscriptDir(spec.slice(i + 1))
  if (!dir) {
    console.error(`! ${label}: no .jsonl transcripts in ${tried.join(' or ')}`)
    continue
  }

  const byQid = groupByQid(dir)
  const files = listTranscripts(dir)
  const unmapped = files.length - [...byQid.values()].reduce((s, r) => s + r.length, 0)

  const sum = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }
  const models = new Map()
  let newestOnly = 0, allRuns = 0, compacted = [], dups = []

  for (const [qid, runs] of byQid) {
    const u = computeUsage(runs[0].path)
    newestOnly += u.total
    for (const k of Object.keys(sum)) sum[k] += u[k] || 0
    for (const m of Object.keys(u.models || {})) models.set(m, (models.get(m) || 0) + 1)
    if (u.compactions > 0) compacted.push(qid)
    for (const r of runs) allRuns += computeUsage(r.path).total
    if (runs.length > 1) dups.push({ qid, n: runs.length })
  }

  arms.push({
    label, dir, files: files.length, queries: byQid.size, unmapped,
    newestOnly, allRuns, dups, compacted,
    models: Object.fromEntries(models),
    archives: archiveSubdirs(dir).map(p => basename(p)),
    split: sum
  })
}

if (asJson) {
  console.log(JSON.stringify({ arms }, null, 2))
  process.exit(0)
}

for (const a of arms) {
  console.log(`\n${a.label}  ${a.dir}`)
  console.log(`  ${a.files} transcript(s) -> ${a.queries} quer(y/ies)` +
              (a.unmapped ? `, ${a.unmapped} with no answer path (not a benchmark run)` : ''))
  const ms = Object.keys(a.models).filter(m => m !== '<synthetic>' && m !== 'unknown')
  console.log(`  models: ${ms.join(', ') || 'none'}`)
  console.log(`  tokens: ${M(a.newestOnly)} newest-only` +
              (a.allRuns !== a.newestOnly
                ? `  /  ${M(a.allRuns)} counting every run  (+${((a.allRuns / a.newestOnly - 1) * 100).toFixed(1)}%)`
                : ''))
  console.log(`    input ${M(a.split.input)}  cacheCreate ${M(a.split.cacheCreate)}` +
              `  cacheRead ${M(a.split.cacheRead)}  output ${M(a.split.output)}`)

  if (a.dups.length) {
    console.log(`  ! ${a.dups.length} quer(y/ies) have more than one transcript: ` +
                a.dups.map(d => `${d.qid} x${d.n}`).join(', '))
    console.log(`    score.mjs keeps the newest and drops the rest. Whether those were`)
    console.log(`    retries or real spend is your call, not the script's.`)
  }
  if (a.archives.length) {
    console.log(`  ! ${a.archives.length} subfolder(s) here also hold transcripts: ${a.archives.join(', ')}`)
    console.log(`    Transcript reading is flat, so these are ignored. If one of them is`)
    console.log(`    the run you meant, name it directly instead of the parent.`)
  }
  if (a.compacted.length) console.log(`  ! context compacted mid-run on: ${a.compacted.join(', ')}`)
}

// The checks that need more than one arm in view. An arm can be internally
// consistent and still not be comparable to its partner.
if (arms.length === 2) {
  const [a, b] = arms
  const clean = m => Object.keys(m).filter(x => x !== '<synthetic>' && x !== 'unknown').sort()
  const ma = clean(a.models), mb = clean(b.models)
  console.log('\ncomparability')
  if (ma.join() !== mb.join()) {
    console.log(`  ! BLOCKER models differ: ${a.label} ran ${ma.join(', ')}, ${b.label} ran ${mb.join(', ')}`)
    console.log(`    That is a second variable. The comparison does not isolate what you changed.`)
  } else console.log(`  models identical (${ma.join(', ') || 'none'})`)

  const qa = new Set([...groupByQid(a.dir).keys()]), qb = new Set([...groupByQid(b.dir).keys()])
  const onlyA = [...qa].filter(q => !qb.has(q)), onlyB = [...qb].filter(q => !qa.has(q))
  if (onlyA.length || onlyB.length) {
    console.log(`  ! query sets differ: ${onlyA.length} only in ${a.label}, ${onlyB.length} only in ${b.label}`)
    console.log(`    Compare the overlap, not each arm's own total.`)
  } else console.log(`  same ${qa.size} queries both arms`)

  if (a.dups.length || b.dups.length) {
    console.log(`  ! duplicate transcripts are asymmetric (${a.label} ${a.dups.length}, ${b.label} ${b.dups.length})`)
    console.log(`    The newest-only rule then falls harder on one side than the other.`)
  }
  if (a.compacted.length || b.compacted.length) console.log(`  ! BLOCKER compaction present - those runs saw a rewritten context`)
}
console.log()
