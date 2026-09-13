#!/usr/bin/env node
// coldbench resolve — ticket -> commit -> file-set resolution.
//
//   node scripts/resolve.mjs --repo <path> --tickets tickets.jsonl --out work/
//
// Reads one JSONL record per ticket ({id, body, commit?, pr?}), finds the commit(s)
// that closed each one, and classifies every ticket as linked / unlinked / empty /
// ambiguous / filtered. Never resolves a ticket by hand — if the resolution rate is
// low, that means this repo's history doesn't carry ticket linkage, not that you
// should go hand-supply file lists. See skills/build-prompts/SKILL.md step 3.
//
// If the detected linkage convention is wrong, pass --pattern with a {id} placeholder,
// e.g. --pattern 'JIRA-{id}\b'. This is a one-time override, not per-ticket.

import { writeFileSync } from 'node:fs'
import { readJsonl, writeJsonl } from './lib/jsonl.mjs'
import { detectMergeStyle } from './lib/git.mjs'
import { resolveTicket, summarizeResolution } from './lib/resolve.mjs'

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? def : argv[i + 1]
}

const repo = opt('repo')
const ticketsPath = opt('tickets')
const outDir = opt('out')
const pattern = opt('pattern')
const asJson = argv.includes('--json')

if (!repo || !ticketsPath || !outDir) {
  console.error('usage: resolve.mjs --repo <path> --tickets <tickets.jsonl> --out <workDir> [--pattern \'<template>\']')
  process.exit(2)
}

const tickets = readJsonl(ticketsPath)
const merge = detectMergeStyle(repo)

const records = tickets.map(t => resolveTicket(repo, t, { mergeStyle: merge.style, pattern }))

writeJsonl(`${outDir}/resolved.jsonl`, records)
writeFileSync(`${outDir}/meta.json`, JSON.stringify({ repo, mergeStyle: merge.style, pattern: pattern || null }, null, 2) + '\n')

const { total, counts } = summarizeResolution(records)

if (asJson) {
  console.log(JSON.stringify({ total, counts }, null, 2))
  process.exit(0)
}

const pct = n => total ? ((n / total) * 100).toFixed(1) + '%' : '0.0%'
console.log(`resolved ${counts.linked}/${total} tickets (${pct(counts.linked)})`)
console.log(`  linked:      ${String(counts.linked).padStart(4)}  (${pct(counts.linked)})`)
console.log(`  unlinked:    ${String(counts.unlinked).padStart(4)}  (${pct(counts.unlinked)})`)
console.log(`  empty:       ${String(counts.empty).padStart(4)}  (${pct(counts.empty)})`)
console.log(`  ambiguous:   ${String(counts.ambiguous).padStart(4)}  (${pct(counts.ambiguous)})`)
console.log(`  filtered:    ${String(counts.filtered).padStart(4)}  (${pct(counts.filtered)})   multi-issue PR heuristic`)
console.log(`\nWrote ${outDir}/resolved.jsonl and ${outDir}/meta.json`)
