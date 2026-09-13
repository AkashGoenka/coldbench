#!/usr/bin/env node
// coldbench finalize — join a worksheet with its rewrites into the final corpus.
//
//   node scripts/finalize.mjs --work work/ --rewrites rewrites.jsonl [--prefix name]
//
// rewrites.jsonl: one record per worksheet row, keyed by the same `id`:
//   {"id": "PROJ-412", "question": "..."}
//   {"id": "PROJ-413", "skip": true, "reason": "not a real problem"}
//
// Emits prompts/<qid>.txt, ground_truth.json and report.md into --out (default: .).
// Never hand-edit ground_truth.json -- this script is the only thing allowed to
// write it, so a corpus is always reproducible from its inputs.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readJsonl } from './lib/jsonl.mjs'
import { finalize, buildGroundTruth, renderReport } from './lib/finalize.mjs'
import { outputContract } from './lib/contract.mjs'
import { summarizeResolution } from './lib/resolve.mjs'

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? def : argv[i + 1]
}

const workDir = opt('work')
const rewritesPath = opt('rewrites')
const outDir = opt('out', '.')

if (!workDir || !rewritesPath) {
  console.error('usage: finalize.mjs --work <workDir> --rewrites <rewrites.jsonl> [--prefix <name>] [--out <dir>]')
  process.exit(2)
}

const meta = existsSync(`${workDir}/meta.json`) ? JSON.parse(readFileSync(`${workDir}/meta.json`, 'utf8')) : {}
const defaultPrefix = meta.repo
  ? meta.repo.replace(/\/$/, '').split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '_')
  : 'repo'
const prefix = opt('prefix', defaultPrefix)

const worksheet = readJsonl(`${workDir}/worksheet.jsonl`)
const rewrites = readJsonl(rewritesPath)

const { finalized, skipped, notRewritten } = finalize(worksheet, rewrites, { prefix })

const promptsDir = `${outDir}/prompts`
mkdirSync(promptsDir, { recursive: true })
finalized.forEach((row, i) => {
  const text = `${i + 1}. [${row.scope}] ${row.question}\n\n${outputContract(row.qid)}\n`
  writeFileSync(`${promptsDir}/${row.qid}.txt`, text)
})

const groundTruth = buildGroundTruth(finalized)
writeFileSync(`${outDir}/ground_truth.json`, JSON.stringify(groundTruth, null, 1) + '\n')

const resolvedPath = `${workDir}/resolved.jsonl`
const resolutionCounts = existsSync(resolvedPath) ? summarizeResolution(readJsonl(resolvedPath)) : null
const buildStatsPath = `${workDir}/build-stats.json`
const buildStats = existsSync(buildStatsPath) ? JSON.parse(readFileSync(buildStatsPath, 'utf8')) : null

const report = renderReport({ resolutionCounts, buildStats, finalized, skipped, notRewritten })
writeFileSync(`${outDir}/report.md`, report)

console.log(`Wrote ${finalized.length} prompts to ${promptsDir}/`)
console.log(`Wrote ${outDir}/ground_truth.json`)
console.log(`Wrote ${outDir}/report.md`)
if (notRewritten.length) console.log(`\n${notRewritten.length} worksheet row(s) have no rewrite yet: ${notRewritten.join(', ')}`)
const flaggedCount = finalized.filter(r => r.leak.flagged).length
if (flaggedCount) console.log(`${flaggedCount} question(s) flagged by the leak gate -- see report.md before using them.`)
