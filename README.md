# coldbench

Measure whether a tool, skill or rules file actually helps a coding agent.

Two numbers, together or not at all: **how many tokens** a run cost, and **whether it
found the right files**. A token saving with no recall number is not a result, because the
cheapest run is always the one that gives up early.

Nothing here is specific to any tool. Point it at whatever you want to evaluate.

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
files, and the repo copy itself. You do not need to find your transcript folder; pointing at
the repo copy is enough, and coldbench locates the session logs for it.

Leave off the third part if you only care about recall and not tokens.

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

That is the whole measurement. One command, after both passes are done.

### Confound detectors

Scoring also flags three things that quietly invalidate a comparison:

- **Model drift** — an arm whose queries did not all run on the same model is not a
  single-variable arm, whatever else you controlled.
- **Context compaction** — a run that compacted mid-flight saw a rewritten context, so it
  is not comparable to one that did not.
- **Contamination** — see below.

**`unseen`** is a contamination check: a gold file the agent named in its answer but which
never appeared in any tool input or output. The agent produced it from pretraining, not by
exploring your repo. On well-known open source repositories this is the difference between
a real result and a model reciting what it already knows.

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
| Confound detection | Model drift, compaction and contamination flags |
| Question generation | Skill written, scripts not built |
| Arm parity checking | Design exists, not ported |
| Nondeterminism floor | Not built |

## License

MIT
