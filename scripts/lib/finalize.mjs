// Joins a worksheet with its human rewrites, assigns qids, and computes the two
// checks that never existed anywhere -- not in this repo, not in the original
// coldstart-specific pipeline (~/benchmark-strategy/HANDOFF.md lists vocab.py and
// preflight_leak.py as "not in this folder yet, optional"). Both are advisory:
// per SKILL.md, a leak-flagged question is shown to the user, never auto-dropped.

const STOPWORDS = new Set(['index', 'test', 'tests', 'spec', 'util', 'utils', 'main', 'app', 'base', 'common', 'impl'])

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function wholeWordMatch (term, text) {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(text)
}

function tokenizeBasename (basename) {
  const stem = basename.replace(/\.[^.]+$/, '')
  const spaced = stem.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ')
  return spaced.split(/\s+/).filter(Boolean).map(t => t.toLowerCase())
}

export function vocabDensity (files, question) {
  let matched = 0
  let total = 0
  for (const f of files) {
    const basename = f.split('/').pop()
    const tokens = tokenizeBasename(basename).filter(t => t.length >= 3 && !STOPWORDS.has(t))
    for (const t of tokens) {
      total++
      if (wholeWordMatch(t, question)) matched++
    }
  }
  return total === 0 ? 1 : matched / total
}

function leakTermsFor (file) {
  const parts = file.split('/')
  const basename = parts[parts.length - 1]
  const stem = basename.replace(/\.[^.]+$/, '')
  const dirs = parts.slice(0, -1).filter(p => p.length >= 3)
  return [...new Set([basename, stem, ...dirs])].filter(t => t.length >= 3)
}

export function leakCheck (files, question) {
  const hits = new Set()
  for (const f of files) {
    for (const term of leakTermsFor(f)) {
      if (wholeWordMatch(term, question)) hits.add(term)
    }
  }
  return { flagged: hits.size > 0, terms: [...hits] }
}

function issueNumberFor (id) {
  if (/^\d+$/.test(id)) return parseInt(id, 10)
  const m = id.match(/-(\d+)$/)
  return m ? parseInt(m[1], 10) : null
}

export function finalize (worksheetRows, rewrites, { prefix }) {
  const rewriteMap = new Map(rewrites.map(r => [r.id, r]))
  const kept = []
  const skipped = []
  const notRewritten = []

  for (const row of worksheetRows) {
    const rw = rewriteMap.get(row.id)
    if (!rw) { notRewritten.push(row.id); continue }
    if (rw.skip) { skipped.push({ id: row.id, reason: rw.reason || 'no reason given' }); continue }
    kept.push({ ...row, question: rw.question })
  }

  kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const finalized = kept.map((row, i) => {
    const qid = `${prefix}_q${String(i + 1).padStart(2, '0')}`
    return {
      ...row,
      qid,
      density: vocabDensity(row.files, row.question),
      leak: leakCheck(row.files, row.question),
      issueNumber: issueNumberFor(row.id)
    }
  })

  return { finalized, skipped, notRewritten }
}

export function buildGroundTruth (finalized) {
  const out = {}
  for (const row of finalized) {
    out[row.qid] = { issue_number: row.issueNumber, scope: row.scope, files: [...row.files].sort() }
  }
  return out
}

export function renderReport ({ resolutionCounts, buildStats, finalized, skipped, notRewritten }) {
  const lines = []
  lines.push('# Build report', '')

  lines.push('## Ticket resolution', '')
  if (resolutionCounts) {
    const { total, counts } = resolutionCounts
    lines.push(`Resolved ${counts.linked}/${total} tickets.`, '')
    lines.push('| classification | count |', '|---|---|')
    for (const k of ['linked', 'unlinked', 'empty', 'ambiguous', 'filtered']) lines.push(`| ${k} | ${counts[k]} |`)
  } else {
    lines.push('(resolved.jsonl not found in work dir)')
  }
  lines.push('')

  lines.push('## Build filtering', '')
  if (buildStats) {
    lines.push(`- Linked tickets: ${buildStats.linkedTotal}`)
    lines.push(`- Kept (file count in range): ${buildStats.kept}`)
    lines.push(`- Dropped, file count out of range: ${buildStats.droppedOutOfRange}`)
    lines.push(`- Dropped, quality filter: ${buildStats.droppedQuality}`)
  } else {
    lines.push('(build-stats.json not found in work dir)')
  }
  lines.push('')

  lines.push('## Rewrite outcome', '')
  lines.push(`- Rewritten and kept: ${finalized.length}`)
  lines.push(`- Skipped by the rewriter: ${skipped.length}`)
  lines.push(`- Not yet rewritten: ${notRewritten.length}`)
  if (skipped.length) {
    lines.push('', 'Skipped:')
    for (const s of skipped) lines.push(`- ${s.id}: ${s.reason}`)
  }
  lines.push('')

  lines.push('## Final question set', '')
  lines.push(`${finalized.length} questions.`, '')
  const scopeCounts = { single: 0, 'multi-file': 0, 'cross-cutting': 0 }
  for (const r of finalized) scopeCounts[r.scope]++
  lines.push('| scope | count |', '|---|---|')
  for (const [k, v] of Object.entries(scopeCounts)) lines.push(`| ${k} | ${v} |`)
  lines.push('')

  lines.push('## Vocabulary density', '')
  if (finalized.length) {
    const densities = finalized.map(r => r.density).sort((a, b) => a - b)
    const mean = densities.reduce((a, b) => a + b, 0) / densities.length
    const median = densities[Math.floor(densities.length / 2)]
    lines.push(`- mean: ${mean.toFixed(2)}`)
    lines.push(`- median: ${median.toFixed(2)}`)
    lines.push(`- min: ${densities[0].toFixed(2)}`)
    lines.push(`- max: ${densities[densities.length - 1].toFixed(2)}`)
  } else {
    lines.push('(no finalized questions)')
  }
  lines.push('')

  lines.push('## Leak gate', '')
  const flagged = finalized.filter(r => r.leak.flagged)
  lines.push(`${flagged.length} of ${finalized.length} question(s) flagged. Not auto-dropped -- review before use.`, '')
  for (const r of flagged) lines.push(`- ${r.qid}: matched term(s) ${r.leak.terms.join(', ')}`)

  return lines.join('\n') + '\n'
}
