// Locating and grouping Claude Code session transcripts for an arm.
//
// Shared by score.mjs and inspect.mjs so the qid convention and the folder
// resolution live in exactly one place. A transcript is tied to its query by the
// answer path the prompt contract forces the agent to write to; see SKILL.md.

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { codexSessionsRoot, findCodexSessionsForCwd } from './codex.mjs'

export const ANSWER_PATH_RE = /benchmark_output\/([A-Za-z0-9_-]+_q\d+)\.txt/

export const isJsonlFile = p =>
  !!p && existsSync(p) && statSync(p).isFile() && p.endsWith('.jsonl')

export const hasJsonl = d =>
  !!d && existsSync(d) && statSync(d).isDirectory() && readdirSync(d).some(f => f.endsWith('.jsonl'))

// Claude Code stores transcripts under ~/.claude/projects/<path with / and . as ->.
// The mangling is lossy - benchmark/repos and benchmark-repos collapse to the same
// name - so this only ever runs forwards, never in reverse.
export function transcriptDirFor (repoPath) {
  return join(homedir(), '.claude', 'projects', resolve(repoPath).replace(/[/.]/g, '-'))
}

// An arm may name either a transcript folder or the repo copy itself. A directory
// that exists but holds no .jsonl is a repo path, not a transcript dir; accepting
// it on existence alone would silently report no tokens.
//
// Codex has no per-repo directory - session files sit flat under
// ~/.codex/sessions and matching ones are found by reading cwd out of each
// file's own session_meta - so a repo-path spec that misses the Claude guess
// falls through to a Codex cwd search. That search returns a scattered file
// list rather than one real directory, so `files` carries it explicitly and
// `dir` stays a display label; every reader below accepts either shape.
export function resolveTranscriptDir (spec) {
  if (!spec) return { dir: null, tried: [] }
  if (isJsonlFile(spec)) return { dir: dirname(spec), tried: [spec], files: [spec], source: 'file' }
  if (hasJsonl(spec)) return { dir: spec, tried: [spec] }
  const claudeGuess = transcriptDirFor(spec)
  if (hasJsonl(claudeGuess)) return { dir: claudeGuess, tried: [spec, claudeGuess] }
  const codexFiles = findCodexSessionsForCwd(resolve(spec))
  if (codexFiles.length) return { dir: codexSessionsRoot, tried: [spec, claudeGuess, codexSessionsRoot], files: codexFiles, source: 'codex-cwd' }
  return { dir: null, tried: [spec, claudeGuess, codexSessionsRoot] }
}

// Accepts either a literal directory (Claude Code's case: one folder per
// repo) or an already-resolved file list (Codex's case: matches scattered
// across ~/.codex/sessions) - groupByQid and archiveSubdirs below build on
// this so neither needs to know which engine produced its input.
export const listTranscripts = dirOrFiles => {
  if (Array.isArray(dirOrFiles)) return dirOrFiles
  if (isJsonlFile(dirOrFiles)) return [dirOrFiles]
  return !dirOrFiles || !existsSync(dirOrFiles)
    ? []
    : readdirSync(dirOrFiles).filter(f => f.endsWith('.jsonl')).map(f => join(dirOrFiles, f))
}

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
