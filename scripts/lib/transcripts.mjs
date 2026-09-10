// Locating and grouping Claude Code session transcripts for an arm.
//
// Shared by score.mjs and inspect.mjs so the qid convention and the folder
// resolution live in exactly one place. A transcript is tied to its query by the
// answer path the prompt contract forces the agent to write to; see SKILL.md.

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const ANSWER_PATH_RE = /benchmark_output\/([A-Za-z0-9_-]+_q\d+)\.txt/

export const hasJsonl = d =>
  !!d && existsSync(d) && readdirSync(d).some(f => f.endsWith('.jsonl'))

// Claude Code stores transcripts under ~/.claude/projects/<path with / and . as ->.
// The mangling is lossy - benchmark/repos and benchmark-repos collapse to the same
// name - so this only ever runs forwards, never in reverse.
export function transcriptDirFor (repoPath) {
  return join(homedir(), '.claude', 'projects', resolve(repoPath).replace(/[/.]/g, '-'))
}

// An arm may name either a transcript folder or the repo copy itself. A directory
// that exists but holds no .jsonl is a repo path, not a transcript dir; accepting
// it on existence alone would silently report no tokens.
export function resolveTranscriptDir (spec) {
  if (!spec) return { dir: null, tried: [] }
  if (hasJsonl(spec)) return { dir: spec, tried: [spec] }
  const guess = transcriptDirFor(spec)
  return { dir: hasJsonl(guess) ? guess : null, tried: [spec, guess] }
}

export const listTranscripts = dir =>
  !dir || !existsSync(dir)
    ? []
    : readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f))

export function qidOf (file) {
  const m = readFileSync(file, 'utf8').match(ANSWER_PATH_RE)
  return m ? m[1] : null
}

// Every transcript per qid, newest first. score.mjs keeps only [0]; inspect.mjs
// reports the rest, because which run counts is a judgement no script can make.
export function groupByQid (dir) {
  const byQid = new Map()
  for (const f of listTranscripts(dir)) {
    const qid = qidOf(f)
    if (!qid) continue
    if (!byQid.has(qid)) byQid.set(qid, [])
    byQid.get(qid).push({ path: f, mtimeMs: statSync(f).mtimeMs })
  }
  for (const runs of byQid.values()) runs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return byQid
}

export function newestByQid (dir) {
  const out = new Map()
  for (const [qid, runs] of groupByQid(dir)) out.set(qid, runs[0].path)
  return out
}

// Archived runs often sit in subfolders beside the live ones (jsonl-v27/ and
// friends). Transcript reading is deliberately flat, so those are invisible -
// and picking the parent folder silently mixes retries into a clean arm.
export function archiveSubdirs (dir) {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .map(e => join(dir, e))
    .filter(p => statSync(p).isDirectory() && hasJsonl(p))
}
