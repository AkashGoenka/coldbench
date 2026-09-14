// Token accounting entry point. Callers never need to know or state which
// engine produced a transcript: each function here routes a single file to
// its engine's accounting module by format (isCodexFile checks whether line
// 1 parses as a session_meta record, which Claude Code transcripts never
// emit). The actual accounting lives in ./claude.mjs and ./codex.mjs - this
// file is deliberately just the dispatch.

import { isCodexFile, computeCodexUsage, collectCodexToolIO, countCodexToolCalls } from './codex.mjs'
import { computeClaudeUsage, collectClaudeToolIO, countClaudeToolCalls } from './claude.mjs'

export function computeUsage (transcriptPath) {
  return isCodexFile(transcriptPath) ? computeCodexUsage(transcriptPath) : computeClaudeUsage(transcriptPath)
}

// Every path-looking string the agent actually saw or asked for: tool inputs and
// tool results. A gold file present in the final answer but absent here was not
// discovered in-session.
export function collectToolIO (transcriptPath) {
  return isCodexFile(transcriptPath) ? collectCodexToolIO(transcriptPath) : collectClaudeToolIO(transcriptPath)
}

export function countToolCalls (transcriptPath, names) {
  return isCodexFile(transcriptPath) ? countCodexToolCalls(transcriptPath, names) : countClaudeToolCalls(transcriptPath, names)
}
