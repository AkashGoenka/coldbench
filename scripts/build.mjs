#!/usr/bin/env node
// coldbench build — scrub and filter resolved tickets into a rewrite worksheet.
//
//   node scripts/build.mjs --work work/ [--min-files 2] [--max-files 8]
//
// Keeps only `linked` tickets from resolved.jsonl, drops ones outside the
// file-count range, scrubs each body (paths, code blocks, URLs, stack frames,
// the gold files' own names), and writes work/worksheet.jsonl for the human
// rewrite pass in skills/build-prompts/SKILL.md step 5.

import { writeFileSync } from 'node:fs'
import { readJsonl, writeJsonl } from './lib/jsonl.mjs'
import { buildCandidates } from './lib/build.mjs'

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? def : argv[i + 1]
}

const workDir = opt('work')
const minFiles = parseInt(opt('min-files', '2'), 10)
const maxFiles = parseInt(opt('max-files', '8'), 10)
const asJson = argv.includes('--json')

if (!workDir) {
  console.error('usage: build.mjs --work <workDir> [--min-files 2] [--max-files 8]')
  process.exit(2)
}

const resolved = readJsonl(`${workDir}/resolved.jsonl`)
const { rows, dropped, stats } = buildCandidates(resolved, { minFiles, maxFiles })

writeJsonl(`${workDir}/worksheet.jsonl`, rows)
writeFileSync(`${workDir}/build-stats.json`, JSON.stringify(stats, null, 2) + '\n')

if (asJson) {
  console.log(JSON.stringify({ stats, dropped }, null, 2))
  process.exit(0)
}

console.log(`linked tickets:        ${stats.linkedTotal}`)
console.log(`kept (in range):       ${stats.kept}`)
console.log(`dropped, file count:   ${stats.droppedOutOfRange}  (outside ${minFiles}-${maxFiles} files)`)
console.log(`dropped, quality:      ${stats.droppedQuality}  (too short / too few sentences / scrubbed too much)`)
console.log(`\nWrote ${workDir}/worksheet.jsonl and ${workDir}/build-stats.json`)
