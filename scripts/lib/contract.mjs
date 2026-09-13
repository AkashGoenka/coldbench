// The output contract from skills/build-prompts/SKILL.md, verbatim, in one place.
// score.mjs depends on this exact text existing inside every prompt: it reads the
// answer files it names, and it maps a transcript back to its question by finding
// this path inside the transcript. Never paraphrase it.

export function outputContract (qid) {
  return `After completing the task, write your final answer to ./benchmark_output/${qid}.txt.
The file must contain ONLY repo-relative file paths, one per line. No bullets, no markdown, no explanations, no headers, no blank lines, no commentary. Include every file relevant to answering the query — files you read, edited, or determined to be relevant. Include all files you would point a colleague to if they asked the same question.
Example of correct format:
path/to/file1.ext
path/to/file2.ext
Do not skip this step. Do not add explanations before or after the list. The file must exist and contain only paths when you finish.`
}
