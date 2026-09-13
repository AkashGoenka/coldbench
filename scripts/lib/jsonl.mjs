// Shared JSONL read/write. A truncated trailing line (a run cut off mid-write) is
// skipped rather than thrown on, matching what usage.mjs has always done for transcripts.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJsonl (path) {
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* truncated tail */ }
  }
  return out
}

export function writeJsonl (path, records) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''))
}

export function appendJsonl (path, record) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(record) + '\n')
}
