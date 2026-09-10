#!/usr/bin/env node
// coldbench recover-answers — rebuild an arm's benchmark_output/*.txt from its
// transcripts.
//
//   node scripts/recover-answers.mjs --transcripts <dir|repoPath> --out answers/base
//
// Answer files are the most fragile artifact in the pipeline: they live inside a
// repo copy people delete once a run is done. The transcripts outlive them and
// already contain the writes, so a lost answer folder is recoverable rather than
// a lost run.
//
// Two ways an agent writes the file, both handled: the Write tool, and a Bash
// heredoc. Last write per query wins, matching what the file held at the end.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveTranscriptDir, listTranscripts, ANSWER_PATH_RE } from './lib/transcripts.mjs'

const argv = process.argv.slice(2)
const opt = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
const outDir = opt('out')
const force = argv.includes('--force')
const { dir, tried } = resolveTranscriptDir(opt('transcripts'))

if (!dir || !outDir) {
  console.error('usage: recover-answers.mjs --transcripts <dir|repoPath> --out <dir> [--force]')
  if (opt('transcripts') && !dir) console.error(`no .jsonl transcripts in ${tried.join(' or ')}`)
  process.exit(2)
}

const ANSWER_PATH_G = new RegExp(ANSWER_PATH_RE.source, 'g')
// cat > .../<qid>.txt << 'EOF' ... EOF  — the quoted-delimiter form, which is what
// an agent writing literal paths uses. Unquoted delimiters would risk expansion.
const HEREDOC_RE = /cat\s*>\s*\S*benchmark_output\/([A-Za-z0-9_-]+_q\d+)\.txt\s*<<\s*'(\w+)'\n([\s\S]*?)\n\2/g

const found = new Map() // qid -> { content, via }

for (const file of listTranscripts(dir)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    const content = rec?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== 'tool_use') continue
      const m = String(b.input?.file_path || '').match(ANSWER_PATH_RE)
      if (m && typeof b.input?.content === 'string') {
        found.set(m[1], { content: b.input.content, via: b.name })
        continue
      }
      const cmd = typeof b.input?.command === 'string' ? b.input.command : null
      if (!cmd) continue
      for (const h of cmd.matchAll(HEREDOC_RE)) found.set(h[1], { content: h[3] + '\n', via: 'Bash heredoc' })
    }
  }
}

if (!found.size) {
  console.error(`! no answer writes found in ${dir}`)
  console.error(`  Either this is not a benchmark run, or the prompts did not carry the output contract.`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const wrote = [], skipped = []
for (const [qid, { content, via }] of [...found].sort()) {
  const dest = join(outDir, `${qid}.txt`)
  if (existsSync(dest) && !force) { skipped.push(qid); continue }
  writeFileSync(dest, content)
  wrote.push({ qid, via, lines: content.trim().split('\n').filter(Boolean).length })
}

console.log(`\nrecovered ${wrote.length} answer file(s) into ${outDir}`)
for (const w of wrote) console.log(`  ${w.qid}  ${String(w.lines).padStart(3)} path(s)  via ${w.via}`)
if (skipped.length) console.log(`\n! ${skipped.length} already existed, left alone: ${skipped.join(', ')} (use --force to overwrite)`)
console.log(`\nRecovered answers are what the agent wrote, not a rerun. Score them as normal.`)
