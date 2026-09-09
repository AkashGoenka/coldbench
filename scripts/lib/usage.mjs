// Token accounting for one run, plus the tool-I/O trace used to detect answers
// the agent produced from pretraining rather than from exploring the repo.
//
// Two rules that are easy to get wrong and both inflate or deflate the number:
//   1. Claude Code writes one transcript line per content block, each repeating
//      the SAME usage object. Summing raw lines overcounts ~2-2.6x. Dedup by
//      message.id: one usage per generation.
//   2. Subagent sidechains live beside the session file at
//      <stem>/subagents/**/*.jsonl and are NOT in the parent transcript. Their
//      tokens are real spend; omitting them makes a delegating arm look cheap.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function readJsonl (path) {
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* truncated tail */ }
  }
  return out
}

function walk (dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.jsonl')) acc.push(p)
  }
  return acc
}

export function subagentFiles (transcriptPath) {
  return walk(join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents'))
}

export function computeUsage (transcriptPath) {
  const main = readJsonl(transcriptPath)
  const subFiles = subagentFiles(transcriptPath)
  const subs = subFiles.flatMap(readJsonl)

  const seen = new Map()
  const models = new Map()
  for (const rec of [...main, ...subs]) {
    if (rec?.type !== 'assistant') continue
    const msg = rec.message
    const u = msg?.usage
    if (!u) continue
    const id = msg.id || `${rec.uuid ?? Math.random()}`
    if (seen.has(id)) continue
    seen.set(id, u)
    const m = msg.model || 'unknown'
    models.set(m, (models.get(m) || 0) + 1)
  }

  // A context compaction mid-run changes what the agent could still see, so a run
  // that compacted is not comparable to one that did not. Marker is a system
  // record, not an assistant turn, so it never reaches the loop above.
  const compactions = main.filter(r => r?.type === 'system' && r?.subtype === 'compact_boundary').length

  const t = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }
  for (const u of seen.values()) {
    t.input += u.input_tokens || 0
    t.cacheCreate += u.cache_creation_input_tokens || 0
    t.cacheRead += u.cache_read_input_tokens || 0
    t.output += u.output_tokens || 0
  }
  return {
    ...t,
    total: t.input + t.cacheCreate + t.cacheRead + t.output,
    generations: seen.size,
    subagentFiles: subFiles.length,
    models: Object.fromEntries(models),
    compactions
  }
}

// Every path-looking string the agent actually saw or asked for: tool inputs and
// tool results. A gold file present in the final answer but absent here was not
// discovered in-session.
export function collectToolIO (transcriptPath) {
  const recs = [...readJsonl(transcriptPath), ...subagentFiles(transcriptPath).flatMap(readJsonl)]
  const blob = []
  const push = v => {
    if (typeof v === 'string') blob.push(v)
    else if (Array.isArray(v)) v.forEach(push)
    else if (v && typeof v === 'object') Object.values(v).forEach(push)
  }
  for (const rec of recs) {
    const content = rec?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'tool_use') push(b.input)
      else if (b?.type === 'tool_result') push(b.content)
    }
  }
  return blob.join('\n')
}

export function countToolCalls (transcriptPath, names) {
  const want = names ? new Set(names) : null
  const recs = [...readJsonl(transcriptPath), ...subagentFiles(transcriptPath).flatMap(readJsonl)]
  const counts = {}
  for (const rec of recs) {
    const content = rec?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== 'tool_use') continue
      if (want && !want.has(b.name)) continue
      counts[b.name] = (counts[b.name] || 0) + 1
    }
  }
  return counts
}
