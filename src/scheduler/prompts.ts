import type { PullRequest, Run } from "../store.js";

// What a worker's agent is told. The fake agent's prompt is a script, so it gets it verbatim.
export function workerPrompt(run: Run, retry?: string): string {
  if (run.node.agent === "fake") return run.node.prompt;
  const lines = [
    `Your task: ${run.task}`,
    "",
    "You work alone in your own git worktree and branch; other agents may work on other tasks",
    "in their own worktrees. Keep your changes to this task, and commit as you go.",
    `When the task is finished, run: rivet report --done --note "<one line summary>"`,
    `If you are stuck, run: rivet report --stuck --note "<what blocks you>"`,
    `If you need a decision, run: rivet report --needs-input --note "<question>"`,
    "Do not use your own subagent or task tools to hand work off; finish it here.",
  ];
  // Codex's sandbox does not let it write a linked worktree's git data (it lives in the
  // main repository's .git), so its commits fail; Rivet commits for it.
  if (run.node.agent === "codex") {
    lines.push("If git commit fails with \"Permission denied\" (your sandbox), leave the changes uncommitted:",
      "Rivet commits them when you report done.");
  }
  if (retry) lines.push("", "A previous attempt at this task failed:", retry, "", "Fix that and finish the task.");
  return lines.join("\n");
}

// The project's check runs when a worker says it is done and a failure sends the work
// back, so a worker runs it itself first.
export function checkNote(check: string, reuse = false): string {
  if (reuse) {
    return `\nBefore you report done, run "rivet check" and make it pass: it runs the project's check (${check}) and tests.\nA pass on the files you finish with counts as Rivet's own check; if you change anything after it, Rivet checks again when you report done, and a failure sends the task back to you.`;
  }
  return `\nBefore you report done, run the project's check and make it pass: ${check}\nRivet runs it again when you report done; if it fails, the task comes back to you.`;
}

// What an orchestrator's agent is told: it plans and coordinates, workers do the work.
export function orchestratorPrompt(run: Run): string {
  if (run.node.agent === "fake") return run.node.prompt;
  return [
    `You coordinate coding work on the project "${run.project}" (${run.repo}). Workers do the work;`,
    "you do not change code yourself. Each worker is an agent in its own git worktree and",
    "branch, started from the base branch, and opens its own pull request when it is done.",
    "",
    "How you work:",
    "- Look at what is already running before starting anything, so work is not duplicated.",
    "- Split what the user asks for into tasks that do not depend on each other, and start",
    "  one worker per task. Work that depends on other work stays in one task.",
    "- Give every worker a clear, self-contained task with the expected result and how to verify it.",
    "- Follow progress, answer workers' questions, and tell the user where things stand.",
    "- Never edit files, commit, push or open pull requests here. If asked to, start a worker.",
    "",
    "Commands:",
    `- rivet spawn --name "<label, at most 100 characters>" [--agent claude|codex] [--model <id>] [--issue <number>] "<task>"`,
    "    starts a worker. Leave --model off unless the user named a model: a model name only",
    "    works with its own agent, and each agent has a sensible default.",
    "- rivet status [<run>]   lists sessions, or shows one with its pull request",
    `- rivet send --session <run>-agent --message "<text>"   messages a worker`,
    "- rivet stop <run>   stops a worker",
    "",
    "Workers' reports (done, stuck, needs input) arrive here as messages, and so does a warning",
    "when two workers change the same files in ways that will conflict.",
    ...(run.task ? ["", `The user asks: ${run.task}`] : []),
  ].join("\n");
}

// What a worker's agent is told when bringing the latest base into its branch conflicts.
export function conflictPrompt(run: Run, conflicts: string[]): string {
  if (run.node.agent === "fake") return run.node.prompt;
  return [
    `Your task was: ${run.task}`,
    `Merging the latest ${run.base} into your branch stopped on conflicts in:`,
    ...conflicts.map((f) => `  ${f}`),
    "",
    "Resolve only these conflicts, keeping the intent of both sides. Do not change any other file.",
    "Remove every conflict marker, then stage the files and commit the merge.",
  ].join("\n");
}

// "owner/repo" from a pull request's web address.
function repoOf(pr: PullRequest): string | null {
  return /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(pr.url)?.[1] ?? null;
}

// The read-only commands a worker may run to see its pull request's feedback for itself.
export function feedbackRules(pr: PullRequest): string[] {
  const repo = repoOf(pr);
  return [
    `Bash(gh pr checks ${pr.number}:*)`, `Bash(gh pr view ${pr.number}:*)`, "Bash(gh run view:*)",
    ...(repo ? [`Bash(gh api repos/${repo}/pulls/${pr.number}/comments)`] : []),
  ];
}

// What a worker is told when CI fails on its pull request. With the failing paths it gets
// them; without, it is told where to look.
export function ciFeedback(pr: PullRequest, paths?: string[]): string {
  if (paths) return `CI failed on the pull request${paths.length ? ` in: ${paths.join(", ")}` : ""}. Fix it.`;
  return [
    `CI failed on pull request #${pr.number} (${pr.url}).`,
    `See what failed with "gh pr checks ${pr.number}" and read the failing run's log with "gh run view <run id> --log-failed", then fix it.`,
  ].join("\n");
}

// What a worker is told when its pull request gets review comments asking for changes.
export function reviewFeedback(pr: PullRequest, comments?: { path: string; line?: number | null; body: string }[]): string {
  if (comments) {
    const text = comments.map((c) => `${c.path}${c.line ? `:${c.line}` : ""}: ${c.body}`).join("\n");
    return `Review comments on the pull request:\n${text}\nAddress them.`;
  }
  const repo = repoOf(pr);
  return [
    `Pull request #${pr.number} (${pr.url}) has review comments asking for changes.`,
    `Read them with "gh pr view ${pr.number} --comments"${repo ? ` and the comments on code lines with "gh api repos/${repo}/pulls/${pr.number}/comments"` : ""}, then address each one.`,
  ].join("\n");
}
