// Recall/precision scoring of an arm's answers against a ground-truth file set.
// Ground truth shape: { "<qid>": { files: [...], ... }, ... }
// Answers: one <qid>.txt per query, one repo-relative path per line.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

export function normPath (p) {
  return String(p).trim().replace(/^\.\//, '').replace(/^\/+/, '')
}

export function loadGold (goldPath) {
  const raw = JSON.parse(readFileSync(goldPath, 'utf8'))
  const gold = new Map()
  for (const [qid, v] of Object.entries(raw)) {
    const files = Array.isArray(v) ? v : v.files
    if (!Array.isArray(files)) continue
    gold.set(qid, { files: files.map(normPath), meta: Array.isArray(v) ? {} : v })
  }
  return gold
}

// An answer file may contain stray prose despite the output contract. Keep only
// lines that look like repo-relative paths; report what was discarded so a
// malformed run is visible rather than silently scoring low.
export function parseAnswerFile (text) {
  const kept = []
  const rejected = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (/^[-*#>]|^\d+[.)]\s|\s{2,}|[`"']/.test(t) || t.includes(' ') || !t.includes('.')) {
      rejected.push(t)
      continue
    }
    kept.push(normPath(t))
  }
  return { files: [...new Set(kept)], rejected }
}

export function loadAnswers (dir) {
  const out = new Map()
  if (!existsSync(dir)) throw new Error(`answers dir not found: ${dir}`)
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.txt')) continue
    const qid = basename(f, '.txt')
    out.set(qid, parseAnswerFile(readFileSync(join(dir, f), 'utf8')))
  }
  return out
}

export function scoreOne (goldFiles, answerFiles) {
  const g = new Set(goldFiles)
  const a = new Set(answerFiles)
  const hit = [...g].filter(f => a.has(f))
  const recall = g.size ? hit.length / g.size : 0
  const precision = a.size ? hit.length / a.size : 0
  const union = new Set([...g, ...a])
  return {
    recall,
    precision,
    jaccard: union.size ? hit.length / union.size : 0,
    goldCount: g.size,
    answerCount: a.size,
    hit,
    missed: [...g].filter(f => !a.has(f))
  }
}

// Macro-average: every query weighs the same regardless of how many files its
// gold set holds. A micro-average would let one 8-file question dominate seven
// 2-file ones, which is not the question being asked.
export function scoreArm (gold, answers) {
  const rows = []
  for (const [qid, { files }] of gold) {
    const ans = answers.get(qid)
    if (!ans) continue
    rows.push({ qid, ...scoreOne(files, ans.files), rejected: ans.rejected.length })
  }
  rows.sort((x, y) => x.qid.localeCompare(y.qid, undefined, { numeric: true }))
  const n = rows.length
  const mean = k => (n ? rows.reduce((s, r) => s + r[k], 0) / n : 0)
  return {
    rows,
    n,
    missingAnswers: [...gold.keys()].filter(q => !answers.has(q)),
    recall: mean('recall'),
    precision: mean('precision'),
    jaccard: mean('jaccard')
  }
}
