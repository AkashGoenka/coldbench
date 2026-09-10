# Project guidance

@coldstart.md

## What coldbench is

A plugin for measuring whether a tool, skill or rules file actually helps a coding agent.
Two copies of one repo, identical but for the thing under test, the same exploration
questions run in both, then a comparison of tokens burned against how much of the right
answer each found. Ground truth comes from the repo's own git history: a closed issue plus
the commit that resolved it is a question with a known answer.

It is tool-agnostic. coldstart is installed in this repo for day-to-day work, but nothing
in coldbench is specific to it, and nothing here should become specific to it.

## Conventions

- **Node, `.mjs`, zero dependencies.** No build step, no TypeScript, no package installs.
  People clone this and run it. Keep it that way.
- `npm test` runs `node --test test/*.test.mjs`. The directory form fails on newer Node.
- Scripts live in `scripts/`, shared code in `scripts/lib/`. Anything used to produce a
  result belongs in the repo — if an analysis was worth doing once, it was worth a script.
- **No dollar figures anywhere.** Prices change and subscriptions are not per-token.

## Invariants you can break by accident

- **Token accounting.** Dedup by `message.id`: Claude Code repeats the same usage object
  once per content block, and raw summing inflates 2–2.6x. Fold subagent sidechains from
  `<stem>/subagents/`, or a delegating arm looks cheap. Both are pinned by tests against a
  committed fixture in `test/fixtures/transcript/`.
- **The output contract** in `skills/build-prompts/SKILL.md` is reproduced byte-for-byte in
  every prompt under `examples/*/prompts/`. `score.mjs` depends on it twice: to read answer
  files, and to map a transcript back to its question. Changing it invalidates existing
  corpora, and a reworded contract in one arm is a single-variable violation.
- **Gold sets are only ever written by code**, never by hand, so results stay reproducible.
- **Macro-average, not micro.** Every question weighs the same regardless of gold-set size.

## Known gaps, deliberately open

- Question generation: the procedure is written in `skills/build-prompts/SKILL.md`, but
  `check.mjs`, `resolve.mjs`, `build.mjs` and `finalize.mjs` do not exist yet.
- `scoreArm` drops a query with no answer file from the mean rather than scoring it zero, so
  an arm can raise its recall by not answering. Warned about, not prevented. Paired scoring
  across arms is the fix and is not built.
- Nondeterminism floor: not built. A single pair of runs is not a measurement.

## Decisions already settled — do not relitigate

- Ground truth is the issue's closing commit, accepting that a commit can include files that
  are not really the answer. It costs precision more than recall and hits both arms equally.
- Multi-issue PRs are 0–3.5% across four measured corpora: detect and drop them rather than
  attributing files back.
- Prompt vocabulary is measured and reported, never stripped. Real developers use codebase
  vocabulary, and feature names often match module names.
- No tracker integrations. Users bring their own issue source through whatever they already
  have connected. The agent gathers, scripts decide.
