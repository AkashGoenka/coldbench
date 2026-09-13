# coldbench

Measure whether a tool, skill or rules file actually helps a coding agent.

Two numbers, together or not at all: **how many tokens** a run cost, and **whether it
found the right files**. A token saving with no recall number is not a result, because the
cheapest run is always the one that gives up early.

Nothing here is specific to any tool. Point it at whatever you want to evaluate.

Two finished question sets live in [`examples/`](examples/) — 32 questions for
[arches](https://github.com/archesproject/arches) (Python) and 25 for
[JMRI](https://github.com/JMRI/JMRI) (Java), each with the ground truth it was scored
against. Start there to see what a corpus looks like before generating your own.

## The loop

1. **Generate questions** from your repo's own history. A closed ticket plus the commit
   that resolved it is a question with a known answer, so ground truth comes from the
   repository rather than from someone's judgement.
2. **Set up two arms**, identical except for the one thing under test, and prove they are
   identical except for that.
3. **Run the questions** in both arms. Each run writes a list of relevant file paths.
4. **Score** recall, precision and tokens, and compare.

Step 4 works today. Steps 1 and 2 are in progress; see Status.

## How you actually run this

Say you want to know whether some tool helps. You make two copies of the same repo:

```
~/bench/myrepo-plain     <- nothing installed
~/bench/myrepo-withtool  <- the thing you are testing
```

**1. Run the same questions in both copies.** Open an agent session in each copy and paste
the questions one at a time. Every question ends with an instruction to write its answer to
`./benchmark_output/<qid>.txt`, so after a full pass each copy has a folder like:

```
~/bench/myrepo-plain/benchmark_output/myrepo_q01.txt
~/bench/myrepo-plain/benchmark_output/myrepo_q02.txt
...
```

Each of those files is just a list of file paths the agent decided were relevant.

**2. Score both copies with one command.**

```
node scripts/score.mjs \
  --gold ground_truth.json \
  --arm plain:~/bench/myrepo-plain/benchmark_output:~/bench/myrepo-plain \
  --arm withtool:~/bench/myrepo-withtool/benchmark_output:~/bench/myrepo-withtool
```

Each `--arm` is three things separated by colons: a name you choose, the folder of answer
files, and either the transcript folder or the repo copy. Leave off the third part if you
only care about recall and not tokens.

**Check the transcript folder before you trust a token number.** Pointing at the repo copy
resolves to `~/.claude/projects/<mangled path>`, which on any machine that has benchmarked
more than once holds loose retries from several runs — and archived runs usually sit in
sibling subfolders that are not read. Scoring the wrong folder fails silently: it still
prints a number.

```
node scripts/inspect.mjs --arm plain:~/bench/myrepo-plain --arm withtool:~/bench/myrepo-withtool
```

An arm is safe to score when its transcript count equals its query count, it reports no
archive subfolders, and the models match across arms. `inspect` also shows what the
newest-transcript rule is discarding, which on one real run was 53% of the spend, and
catches a cross-arm model difference that `score` cannot see while looking at one arm at a
time. Both scripts carry instructions for an agent running them on your behalf.

If a repo copy was deleted and its answer files went with it, rebuild them from the
transcripts instead of rerunning:

```
node scripts/recover-answers.mjs --transcripts <dir> --out answers/plain
```

**3. Read the output.**

```
arm              n   recall     prec  jaccard     tokens  unseen
----------------------------------------------------------------
plain           27     ...      ...      ...        ...       0
withtool        27     ...      ...      ...        ...       1

withtool vs plain:
  recall  ... points
  tokens  ...%
```

`recall` is how much of the right answer each arm found. `tokens` is what it cost. You need
both, because the cheapest run is always the one that gave up early.

That is the whole measurement: check the arms with `inspect`, then score them.

### Confound detectors

Scoring also flags three things that quietly invalidate a comparison:

- **Model drift** — an arm whose queries did not all run on the same model is not a
  single-variable arm, whatever else you controlled.
- **Context compaction** — a run that compacted mid-flight saw a rewritten context, so it
  is not comparable to one that did not.
- **`unseen`** — a correct file the agent named but never opened. Treat a non-zero count
  as a reason to read that arm's answers before quoting its recall.

### Try it without generating anything

`examples/` ships two corpora with gold sets, so you can run the scoring half immediately:

```
node scripts/score.mjs --gold examples/arches/ground_truth.json --arm base:path/to/answers
```

Each question is a ready-to-paste prompt with the output contract already appended, and each
gold entry carries its `issue_number` and a `scope` label (`single`, `multi-file`,
`cross-cutting`) so results can be stratified rather than only averaged. See
[`examples/README.md`](examples/README.md) for the format and the caveats — in particular,
both repos are public and well-known, so treat them as a worked example rather than a
benchmark you publish against.

### Input formats

Ground truth, one entry per question:

```json
{ "repo_q01": { "files": ["app/models/user.py", "app/views/auth.py"] } }
```

Answers, one `<qid>.txt` per question, one repo-relative path per line. Lines that are not
paths are discarded and counted, so a malformed run is visible instead of quietly scoring
low.

Token accounting deduplicates by `message.id`, because a transcript repeats the same usage
object once per content block and summing raw lines overcounts by roughly 2 to 2.6 times.
Subagent transcripts are folded in, since otherwise an arm that delegates looks cheap.

No dollar figures. Prices change and subscriptions are not per-token.

## Relationship to convotokens

**coldbench does not use [convotokens](https://github.com/AkashGoenka/convotokens).** It is
not a dependency, it is not imported, and it does not need to be installed. coldbench counts
tokens with its own code.

The two do the counting the same way, and that was checked once by hand: both were run over
the same session log and produced identical numbers. That check is now a test here, against
a small log committed to this repo, so it does not depend on convotokens being present.

The reason for separate code rather than sharing it: one plugin cannot reliably find another
plugin's files on disk.

Run convotokens when you want your own spend. Run coldbench when you want a comparison.

## Reading a result honestly

**A single pair of runs is not a measurement.** Run one arm against itself first and see how
far it moves. That spread is your nondeterminism floor, and any delta smaller than it is
noise. Benchmarks that skip this step are how a 39% saving turns into 31% when rerun on an
idle machine.

**Report vocabulary, do not remove it.** Real developers use codebase vocabulary when they
prompt, and feature names often match module names. Stripping that would measure a situation
nobody is in. Score it, stratify by it, and publish the split.

**One variable per comparison.** Rules files, MCP configuration, hooks and stray files in
the working tree have all silently confounded real runs.

## Status

| Step | State |
|---|---|
| `score` | Working. Reproduces a previously published recall figure to 0.1 points. |
| Confound detection | Model drift, compaction, `unseen`; cross-arm checks in `inspect` |
| `inspect` | Working. Transcript inventory, duplicate spend, cross-arm parity |
| `recover-answers` | Working. Rebuilds answer files from transcripts |
| Question generation | Working. `check` / `resolve` / `build` / `finalize`, git-log-based linkage |
| Arm parity checking | Partial. `inspect` covers models, query sets and duplicates; working-tree and config parity not ported |
| Nondeterminism floor | Not built |
| Example corpora | arches (32q) and JMRI (25q) with gold sets, in `examples/` |

## License

MIT
