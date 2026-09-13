// Ticket -> commit -> file-set resolution. Classifies every ticket as exactly one
// of linked / unlinked / empty / ambiguous / filtered so a low resolution rate is
// visible instead of silently produced by chasing the tickets that DID resolve.

import { findCommitsByGrep, findCommitByPr, commitExists, commitFiles, extractRefs } from './git.mjs'

// Generic across trackers on purpose: a commit/PR body that references a SECOND
// ticket key (GitHub-style #123 or Jira/Linear-style PROJ-123) is a multi-issue
// PR. CLAUDE.md: detect and drop rather than attribute files back to one ticket.
//
// Known false-positive, found by running this against a real repo (coldstart):
// an all-numeric hex color literal like `#374250` matches `#\d+\b` and reads as
// an issue reference. Rare (needs a 6-digit hex code with no a-f digits, in a
// commit body), and the failure direction is safe -- it drops a resolvable
// ticket rather than mis-attributing files -- so this is left as a known
// limitation rather than a special case, which would just move the false
// positive somewhere else (e.g. a repo whose issue numbers run to 6 digits).
const GENERIC_REF_PATTERNS = [/#\d+\b/g, /\b[A-Z][A-Z0-9]*-\d+\b/g]

function otherRefs (text, ownId) {
  const all = new Set()
  for (const re of GENERIC_REF_PATTERNS) {
    for (const m of text.matchAll(re)) all.add(m[0])
  }
  all.delete(ownId)
  all.delete(`#${ownId}`)
  return [...all]
}

// A ticket's own search pattern, derived from its id's shape unless a --pattern
// template overrides it. Never a cross-ticket regex inference (SKILL.md: that is
// a one-time inference by the agent, not per-ticket).
export function patternFor (ticket, template) {
  if (template) return template.replace('{id}', escapeRegExp(ticket.id))
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(ticket.id)) return `\\b${escapeRegExp(ticket.id)}\\b`
  if (/^\d+$/.test(ticket.id)) return `#${ticket.id}\\b`
  return escapeRegExp(ticket.id)
}

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dedupeFileSets (fileSets) {
  const seen = new Map()
  for (const files of fileSets) {
    const key = [...files].sort().join('\n')
    if (!seen.has(key)) seen.set(key, files)
  }
  return [...seen.values()]
}

export function resolveTicket (repo, ticket, { mergeStyle, pattern } = {}) {
  let candidates = []

  if (mergeStyle === 'merge-commit' && (ticket.commit || ticket.pr)) {
    const sha = ticket.commit && commitExists(repo, ticket.commit)
      ? ticket.commit
      : ticket.pr ? findCommitByPr(repo, ticket.pr) : null
    if (sha) candidates = [{ sha, subject: '', body: '' }]
  }

  if (candidates.length === 0) {
    candidates = findCommitsByGrep(repo, patternFor(ticket, pattern))
  }

  const body = ticket.body || ''

  if (candidates.length === 0) {
    return { id: ticket.id, body, classification: 'unlinked', commits: [], files: [], reason: 'no commit references ticket key' }
  }

  const combinedText = candidates.map(c => `${c.subject}\n${c.body}`).join('\n')
  const refs = otherRefs(combinedText, ticket.id)
  if (refs.length > 0) {
    return {
      id: ticket.id,
      body,
      classification: 'filtered',
      commits: candidates.map(c => c.sha),
      files: [],
      reason: `commit references other ticket(s): ${refs.join(', ')}`
    }
  }

  const fileSets = candidates.map(c => commitFiles(repo, c.sha))
  const distinct = dedupeFileSets(fileSets)

  if (distinct.length > 1) {
    return {
      id: ticket.id,
      body,
      classification: 'ambiguous',
      commits: candidates.map(c => c.sha),
      files: [],
      reason: `${candidates.length} distinct commits match, file sets disagree`
    }
  }

  const files = distinct[0]
  return {
    id: ticket.id,
    body,
    classification: files.length === 0 ? 'empty' : 'linked',
    commits: candidates.map(c => c.sha),
    files,
    reason: files.length === 0 ? 'matched commit(s) touch 0 files' : null
  }
}

export function summarizeResolution (records) {
  const counts = { linked: 0, unlinked: 0, empty: 0, ambiguous: 0, filtered: 0 }
  for (const r of records) counts[r.classification]++
  return { total: records.length, counts }
}
