// Turns resolved (linked) tickets into a rewrite worksheet: filtered to a sane
// file-count range, scope-assigned, and with bodies scrubbed so a human can
// safely turn them into exploration questions without re-reading the leak risks.
//
// The scrub regexes and quality-filter thresholds are ported from
// ~/benchmark-strategy/scripts/scrub.py, field-tested across four real repos
// (MarkUs, JMRI, Arches, terraforming-mars) for the original coldstart-specific
// benchmark -- not a fresh design. Same for the scope thresholds, documented in
// that repo's HANDOFF.md and independently confirmed against both corpora
// shipped in examples/. One addition beyond the port: RE_SHA, since our tickets
// come from git history rather than GitHub issue bodies and a body referencing
// "commit a1b2c3d" is more likely here than in the original's source material.

const FILE_EXTS = '(?:rb|erb|js|jsx|ts|tsx|vue|py|java|html?|json|yml|yaml|css|scss|md)'

const RE_CODEBLOCK = /```[\s\S]*?```/g
const RE_INLINE_CODE = /`([^`]+)`/g
const RE_IMG_HTML = /<img[^>]*>/gi
const RE_IMG_MD = /!\[[^\]]*\]\([^)]+\)/g
const RE_HTML_TAG = /<\/?\w+[^>]*>/g
const RE_URL = /https?:\/\/\S+/g
const RE_ISSUE_REF = /(?<!\w)#\d{2,}\b/g
const RE_SHA = /\b[0-9a-f]{7,40}\b/gi
const RE_BACKTICK_PATH = new RegExp('`[\\w./-]+\\.' + FILE_EXTS + '`', 'g')
const RE_BARE_PATH = new RegExp('(?<![\\w/])(?:[\\w-]+/)+[\\w-]+\\.' + FILE_EXTS + '\\b', 'g')
const RE_STACK_FRAME = /^[ \t]*(?:at\s+|from\s+).*:\d+.*$/gm
const RE_FILE_LINE = new RegExp('\\b[\\w/.-]+\\.' + FILE_EXTS + ':\\d+', 'g')
const RE_MULTI_SPACE = /[ \t]+/g
const RE_MULTI_NEWLINE = /\n{3,}/g

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Word-boundary matched, not a raw substring replace: a naive .split(term) on
// the directory segment "styles" would also eat the "styles" inside the
// unrelated word "stylesheet" -- found by running this on a real issue body.
function scrubGoldPaths (text, files) {
  let s = text
  for (const f of files) {
    const parts = f.split('/')
    const basename = parts[parts.length - 1]
    const stem = basename.replace(/\.[^.]+$/, '')
    const terms = new Set([f, basename, stem, ...parts.slice(0, -1).filter(p => p.length >= 3)])
    for (const term of terms) {
      if (term.length < 3) continue
      s = s.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g'), ' ')
    }
  }
  return s
}

export function scrub (body, goldFiles = []) {
  let s = body
  s = s.replace(RE_CODEBLOCK, ' ')
  s = s.replace(RE_IMG_HTML, ' ')
  s = s.replace(RE_IMG_MD, ' ')
  s = s.replace(RE_STACK_FRAME, '')
  s = s.replace(RE_FILE_LINE, ' ')
  s = s.replace(RE_BACKTICK_PATH, ' ')
  s = s.replace(RE_BARE_PATH, ' ')
  s = s.replace(RE_URL, ' ')
  s = s.replace(RE_ISSUE_REF, ' ')
  s = s.replace(RE_SHA, ' ')
  s = s.replace(RE_HTML_TAG, ' ')
  s = s.replace(RE_INLINE_CODE, '$1')
  s = scrubGoldPaths(s, goldFiles)
  s = s.replace(RE_MULTI_SPACE, ' ')
  s = s.replace(RE_MULTI_NEWLINE, '\n\n')
  return s.trim()
}

function sentenceCount (s) {
  return (s.match(/[.!?]+/g) || []).length
}

export function qualityFilter (orig, scrubbed, { minLen = 200, minSentences = 2, maxShrink = 0.4 } = {}) {
  if (scrubbed.length < minLen) return { ok: false, reason: `too_short_after_scrub(${scrubbed.length}<${minLen})` }
  if (sentenceCount(scrubbed) < minSentences) return { ok: false, reason: `too_few_sentences(${sentenceCount(scrubbed)}<${minSentences})` }
  if (orig.length > 0 && scrubbed.length / orig.length < 1 - maxShrink) {
    return { ok: false, reason: `shrunk_too_much(${scrubbed.length}/${orig.length})` }
  }
  return { ok: true, reason: 'ok' }
}

// From HANDOFF.md, confirmed against both shipped corpora with zero exceptions.
export function scopeFor (fileCount) {
  if (fileCount <= 2) return 'single'
  if (fileCount <= 5) return 'multi-file'
  return 'cross-cutting'
}

export function buildCandidates (resolved, { minFiles = 2, maxFiles = 8 } = {}) {
  const linked = resolved.filter(r => r.classification === 'linked')
  const rows = []
  const dropped = []

  for (const r of linked) {
    if (r.files.length < minFiles || r.files.length > maxFiles) {
      dropped.push({ id: r.id, reason: `file_count_out_of_range(${r.files.length})` })
      continue
    }
    const orig = r.body || ''
    const scrubbedBody = scrub(orig, r.files)
    const quality = qualityFilter(orig, scrubbedBody)
    if (!quality.ok) {
      dropped.push({ id: r.id, reason: quality.reason })
      continue
    }
    rows.push({
      id: r.id,
      scrubbed_body: scrubbedBody,
      file_count: r.files.length,
      files: r.files,
      scope: scopeFor(r.files.length),
      commits: r.commits
    })
  }

  const stats = {
    linkedTotal: linked.length,
    kept: rows.length,
    droppedOutOfRange: dropped.filter(d => d.reason.startsWith('file_count_out_of_range')).length,
    droppedQuality: dropped.filter(d => !d.reason.startsWith('file_count_out_of_range')).length,
    minFiles,
    maxFiles
  }

  return { rows, dropped, stats }
}
