#!/usr/bin/env node
// coldbench check — preflight for the build-prompts pipeline.
//
//   node scripts/check.mjs --repo <path-to-full-clone>
//
// Verifies git is present, the path is a full (non-shallow) clone, Node is 18+,
// and there are at least 200 commits of history. Stops at the first failure —
// see skills/build-prompts/SKILL.md for why each of these matters.
//
// Issue-source (GitHub CLI / tracker MCP / exported file) is NOT checked here —
// that is the agent's judgment call per SKILL.md step 1, not something this
// script can verify.

import { runChecks } from './lib/check.mjs'

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? def : argv[i + 1]
}

const repo = opt('repo')
const asJson = argv.includes('--json')

if (!repo) {
  console.error('usage: check.mjs --repo <path-to-full-clone> [--json]')
  process.exit(2)
}

const result = runChecks(repo)

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (!result.ok) {
  console.error(`✗ ${result.message}`)
  process.exit(1)
}

console.log(`✓ git ${result.gitVersion}`)
console.log(`✓ full clone, ${result.commits} commits of history`)
console.log(`✓ node v${result.nodeVersion}`)
console.log()

const { style, mergeCount, squashCount } = result.mergeStyle
if (style === 'merge-commit') {
  console.log(`merge style: merge-commit (${mergeCount}/300 sampled commits are "Merge pull request #N")`)
} else if (style === 'squash') {
  console.log(`merge style: squash (${squashCount}/300 sampled subjects end in "(#N)")`)
} else {
  console.log('merge style: unknown (no clear squash or merge-commit signal in the last 300 commits)')
}

console.log('\nsampled commit subjects:')
result.sampledSubjects.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s}`))

console.log('\nBefore continuing: confirm you have exactly one issue source (GitHub CLI, tracker')
console.log('MCP, or an exported file) — check.mjs cannot verify this for you.')
