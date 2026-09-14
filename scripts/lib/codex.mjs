// Codex session-file primitives shared by usage.mjs (accounting) and
// transcripts.mjs (arm resolution). Codex writes one flat
// ~/.codex/sessions/**/*.jsonl tree instead of Claude Code's per-repo
// directory, and cwd/subagent linkage lives inside each file's session_meta
// record rather than in a filename or sibling folder - both callers need
// this exact same lookup, so it lives in one place.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJsonl } from './jsonl.mjs'

export const codexSessionsRoot = join(homedir(), '.codex', 'sessions')

function walk (dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.jsonl')) acc.push(p)
  }
  return acc
}

export const allCodexSessionFiles = (root = codexSessionsRoot) => walk(root)

// A Codex session's first line is always its session_meta record; Claude
// Code transcripts never emit that record type, so reading it also serves
// as the format check callers use to route between the two engines.
export function readCodexMeta (file) {
  try {
    const first = readFileSync(file, 'utf8').split('\n', 1)[0]
    const rec = JSON.parse(first)
    return rec.type === 'session_meta' ? rec.payload : null
  } catch {
    return null
  }
}

export const isCodexFile = file => readCodexMeta(file) !== null

export const isCodexSubagentMeta = meta =>
  Boolean(meta?.source?.subagent || meta?.thread_source === 'subagent')

// Recent Codex transcripts put the link on session_meta.parent_thread_id.
// Older thread-spawn transcripts also carry it under source.subagent. Keep
// both forms: otherwise guardian and other non-thread-spawn subagents vanish
// from an arm's token total.
export const codexParentThreadId = meta =>
  meta?.parent_thread_id || meta?.source?.subagent?.thread_spawn?.parent_thread_id

export function findCodexSessionsForCwd (cwdAbs, root = codexSessionsRoot) {
  return allCodexSessionFiles(root).filter(f => {
    const meta = readCodexMeta(f)
    return meta && !isCodexSubagentMeta(meta) && meta.cwd === cwdAbs
  })
}

// Subagent rollouts sit beside the parent file in the SAME directory (unlike
// Claude's nested subagents/ folder) and link back via parent_thread_id,
// possibly several generations deep, so this walks the chain rather than
// assuming one level.
export function findCodexSubagentFiles (file, sessionId, sessionsRoot) {
  const dir = file.slice(0, file.lastIndexOf('/'))
  // The default date hierarchy means a session started just before midnight and
  // its child started after midnight live in different directories. Scan the
  // whole Codex store for real sessions; callers can pass a fixture root in
  // tests, while non-Codex fixtures retain the old local-directory behavior.
  const root = sessionsRoot || (file.startsWith(`${codexSessionsRoot}/`) ? codexSessionsRoot : dir)
  const candidates = root === dir
    ? (existsSync(dir) ? readdirSync(dir).map(e => join(dir, e)) : [])
    : allCodexSessionFiles(root)
  const childrenByParent = new Map()
  for (const candidate of candidates) {
    if (candidate === file || !candidate.endsWith('.jsonl')) continue
    const meta = readCodexMeta(candidate)
    const parent = codexParentThreadId(meta)
    if (isCodexSubagentMeta(meta) && parent) {
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
      childrenByParent.get(parent).push(candidate)
    }
  }
  const out = []
  const queue = [sessionId]
  const seen = new Set()
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.shift()) || []) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
      const meta = readCodexMeta(child)
      if (meta?.id) queue.push(meta.id)
    }
  }
  return out
}

// Codex writes cumulative token_count snapshots (one per model round-trip)
// instead of Claude's per-block usage deltas, so the LATEST snapshot in a
// session is the authoritative total - summing them would overcount, the
// same class of bug as Claude's repeated per-block usage object.
function readCodexSessionSummary (file) {
  let latest = null
  let turns = 0
  const models = new Map()
  let compactions = 0
  for (const rec of readJsonl(file)) {
    if (rec.type === 'event_msg' && rec.payload?.type === 'token_count' && rec.payload.info?.total_token_usage) {
      latest = rec.payload.info.total_token_usage
      turns++
    }
    if (rec.type === 'turn_context' && rec.payload?.model) {
      const model = rec.payload.model
      models.set(model, (models.get(model) || 0) + 1)
    }
    if (rec.type === 'compacted') compactions++
  }
  return { latest, turns, models, compactions }
}

// Codex's cached/reasoning counts are SUBSETS of input/output tokens (OpenAI
// usage semantics), unlike Claude's cache fields above which are additive on
// top of input_tokens. total_tokens is already input + output, so it is
// trusted directly here rather than re-derived from the parts.
// cache_write_input_tokens (seen in real sessions) is likewise a subset of
// input_tokens, not additive - it is surfaced as cacheCreate for display only.
export function computeCodexUsage (transcriptPath, sessionsRoot) {
  const meta = readCodexMeta(transcriptPath)
  const { latest, turns, models, compactions: mainCompactions } = readCodexSessionSummary(transcriptPath)
  const totals = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  const add = u => { for (const k of Object.keys(totals)) totals[k] += u?.[k] || 0 }
  add(latest)

  const subFiles = meta ? findCodexSubagentFiles(transcriptPath, meta.id, sessionsRoot) : []
  let allTurns = turns
  let compactions = mainCompactions
  for (const f of subFiles) {
    const sub = readCodexSessionSummary(f)
    add(sub.latest)
    allTurns += sub.turns
    for (const [model, count] of sub.models) models.set(model, (models.get(model) || 0) + count)
    compactions += sub.compactions
  }

  return {
    input: totals.input_tokens,
    cacheCreate: totals.cache_write_input_tokens,
    cacheRead: totals.cached_input_tokens,
    output: totals.output_tokens,
    total: totals.total_tokens,
    generations: allTurns,
    subagentFiles: subFiles.length,
    models: Object.fromEntries(models),
    compactions
  }
}

// Every path-looking string a Codex session's tool calls touched. Tool calls
// are response_item records; both the call and its output are evidence the
// agent had access to a path or its contents.
export function collectCodexToolIO (transcriptPath) {
  const meta = readCodexMeta(transcriptPath)
  const recs = [transcriptPath, ...(meta ? findCodexSubagentFiles(transcriptPath, meta.id) : [])].flatMap(readJsonl)
  const blob = []
  const push = v => {
    if (typeof v === 'string') blob.push(v)
    else if (Array.isArray(v)) v.forEach(push)
    else if (v && typeof v === 'object') Object.values(v).forEach(push)
  }
  for (const rec of recs) {
    if (rec?.type !== 'response_item') continue
    const p = rec.payload
    if (p?.type === 'custom_tool_call') push(p.input)
    else if (p?.type === 'custom_tool_call_output') push(p.output)
    else if (p?.type === 'function_call') { push(p.arguments); push(p.input) }
    else if (p?.type === 'function_call_output') push(p.output)
  }
  return blob.join('\n')
}

export function countCodexToolCalls (transcriptPath, names) {
  const want = names ? new Set(names) : null
  const meta = readCodexMeta(transcriptPath)
  const recs = [transcriptPath, ...(meta ? findCodexSubagentFiles(transcriptPath, meta.id) : [])].flatMap(readJsonl)
  const counts = {}
  for (const rec of recs) {
    if (rec?.type !== 'response_item') continue
    const p = rec.payload
    if (p?.type !== 'custom_tool_call' && p?.type !== 'function_call') continue
    const name = p.name || 'unknown'
    if (want && !want.has(name)) continue
    counts[name] = (counts[name] || 0) + 1
  }
  return counts
}
