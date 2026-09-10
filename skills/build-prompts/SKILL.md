---
name: build-prompts
description: Build a reproducible exploration-benchmark prompt set from a repo's issue tracker and git history. Produces scrubbed questions plus a ground-truth file list per question, so you can measure any tool, skill or rules file by running the same questions with and without it.
---

# Build benchmark prompts

You are producing a **prompt set** and its **ground truth** for a codebase-exploration
benchmark. Each question asks where something lives; the answer is the set of files a real
change to that area actually touched.

You gather. Scripts decide. Never write a ground-truth file yourself: gold sets come only
from `scripts/resolve.mjs`, so anyone can reproduce the same set from the same inputs.

## Prerequisites

Run `scripts/check.mjs --repo <path>` first. It verifies all of the following and stops with
a specific message on the first failure. Do not proceed past a failure, and do not attempt
to work around one. Report it to the user and stop.

| Requirement | Why | Check |
|---|---|---|
| `git` on PATH | linkage and file derivation | `git --version` |
| A **full** local clone of the target repo | `git log --grep` finds nothing in a shallow clone, which looks identical to "no linkage convention" | `git rev-parse --is-shallow-repository` must be `false` |
| Node 18+ | the scripts | `node --version` |
| At least 200 commits of history | too little history means too few resolvable tickets | `git rev-list --count HEAD` |
| **One** source of issues, see below | supplies question text | per source |

### Issue source: exactly one of these

The user must have one of these working before you start. Say which one you are using in
your first message, and if none is available, stop and tell them what to set up.

1. **GitHub CLI** — `gh auth status` succeeds and the repo has issues. Best case: linkage
   comes free from the closing-PR timeline.
2. **A tracker over MCP** (Jira, Linear, Azure DevOps, anything). You fetch tickets through
   it. Linkage comes from ticket keys in commit messages.
3. **A pre-exported file** — CSV or JSONL the user already has. No connectivity needed.

## Steps

### 1. Check prerequisites

```
node scripts/check.mjs --repo <path-to-clone>
```

It also reports the repo's **merge style** and samples 30 commit messages. Read that output.
If it says merge-commit rather than squash, PR descriptions are not in local git, so ticket
keys may not be either, and you will need to supply a `pr` or `commit` hint per ticket in
step 2.

### 2. Gather tickets

Fetch closed/resolved tickets and write **one JSONL file**, appending as you go rather than
holding everything in context:

```jsonl
{"id": "PROJ-412", "body": "Uploading two files to the same card silently drops one ..."}
```

- `id` — the ticket key exactly as it would appear in a commit message.
- `body` — the reporter's description, verbatim. Do not summarize, clean or rewrite it here.
  Scrubbing is step 4's job and it must see the original.
- `commit` or `pr` — optional hint, only if step 1 said merge-commit style.

**Aim for 200 to 400 tickets.** The filters reject most candidates, and a usable set is
25 to 30 questions. Do not drain the tracker.

Skip tickets that are obviously not code changes: duplicates, questions, release chores.

### 3. Resolve tickets to files

```
node scripts/resolve.mjs --repo <path> --tickets tickets.jsonl --out work/
```

This finds the commits for each ticket, derives the file set, and classifies every record as
`linked`, `unlinked`, `empty`, `ambiguous` or `filtered`. It prints a resolution rate.

If the convention was not detected, sample commit messages yourself, infer the regex, and
pass it as `--pattern`. That is a **one-time inference**: never resolve tickets individually.

**If the resolution rate is low**, do not chase the unlinked ones and do not hand-supply
file lists. Report the rate to the user and tell them this repo's history does not carry
ticket linkage, so the corpus should come from git alone instead.

### 4. Build candidates

```
node scripts/build.mjs --work work/
```

Scrubs bodies, applies the quality and file-count filters, and writes a rewrite worksheet.

### 5. Rewrite bodies into exploration questions

This is your judgement step. For each candidate in the worksheet, turn the scrubbed body
into a question someone would ask an agent while orienting in the codebase.

- Ask **where things live and how they connect**, never "fix this" or "implement that".
- Keep the reporter's vocabulary, including feature and symbol names. Real developers use
  codebase vocabulary when they prompt, and stripping it would measure a situation nobody
  is in. Vocabulary density is measured and reported, not removed.
- Never name a file path, and never name a directory that appears in the gold set.
- Keep it to two or three sentences.
- Skip a candidate if the body does not describe a real problem. Say why; it is recorded.

### 6. Finalize

```
node scripts/finalize.mjs --work work/ --rewrites rewrites.jsonl
```

Applies the leak gates, scores vocabulary density per question, and emits `prompts/`,
`ground_truth.json` and `report.md`.

Read `report.md` and give the user its headline numbers: how many questions, the vocabulary
split, how many were flagged for filename leak, and the resolution rate. Flagged questions
are not automatically dropped. Show them and let the user decide.

## The output contract

`finalize.mjs` appends this to every question. Do not vary it. `score.mjs` depends on it
twice: it reads the answer files, and it maps each run transcript back to its question by
finding this path inside the transcript.

```
After completing the task, write your final answer to ./benchmark_output/<qid>.txt.
The file must contain ONLY repo-relative file paths, one per line. No bullets, no markdown, no explanations, no headers, no blank lines, no commentary. Include every file relevant to answering the query — files you read, edited, or determined to be relevant. Include all files you would point a colleague to if they asked the same question.
Example of correct format:
path/to/file1.ext
path/to/file2.ext
Do not skip this step. Do not add explanations before or after the list. The file must exist and contain only paths when you finish.
```

Reproduced verbatim, unwrapped, in every prompt under `examples/*/prompts/` — copy it from
there rather than retyping it.

Both arms get the identical contract. It is the only thing making grading mechanical, and a
reworded contract in one arm is a single-variable violation.

## What you must not do

- Do not write or edit `ground_truth.json` by hand.
- Do not pick a commit for a ticket the script could not resolve.
- Do not drop a question because it looks too easy or too hard. The gates decide.
- Do not rewrite a body to remove vocabulary. That is measured, not removed.
