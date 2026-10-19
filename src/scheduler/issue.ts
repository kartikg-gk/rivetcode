// Starting a worker from an issue: which issue is meant, and the task built from it.

export type Issue = {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  assignees: string[];
  body: string;
};

// The issue text a worker is given at most; the rest is cut and said so.
export const ISSUE_BODY_LIMIT = 12_000;

export class IssueRefError extends Error {}

// "42", "#42", "owner/repo#42" or an issue's web address. An issue of another repository
// is refused: its pull request could not close it.
export function issueNumber(ref: string, repo: string): number {
  const text = ref.trim();
  const plain = /^#?(\d+)$/.exec(text);
  const named = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text);
  const url = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/.exec(text);
  const [owner, number] = plain ? [repo, plain[1]!] : named ? [named[1]!, named[2]!] : url ? [url[1]!, url[2]!] : [null, null];
  if (owner === null || number === null || Number(number) <= 0) {
    throw new IssueRefError(`"${ref}" is not an issue: give 42, owner/repo#42 or the issue's address`);
  }
  if (owner.toLowerCase() !== repo.toLowerCase()) throw new IssueRefError(`issue ${owner}#${number} is not in this repository (${repo})`);
  return Number(number);
}

function section(issue: Issue): string {
  const lines = [
    `Issue: #${issue.number}`, `Title: ${issue.title}`, `State: ${issue.state}`, `URL: ${issue.url}`,
    ...(issue.labels.length ? [`Labels: ${issue.labels.join(", ")}`] : []),
    ...(issue.assignees.length ? [`Assignees: ${issue.assignees.join(", ")}`] : []),
  ];
  const body = issue.body.trim();
  if (body) {
    const cut = [...body].length > ISSUE_BODY_LIMIT;
    lines.push("", "Body:", cut ? `${[...body].slice(0, ISSUE_BODY_LIMIT).join("")}\n\n[The issue text is cut at ${ISSUE_BODY_LIMIT} characters.]` : body);
  }
  return lines.join("\n");
}

// The worker's task: the user's own words with the issue below them, or, without words,
// the issue itself as the task.
export function issueTask(issue: Issue, task?: string): string {
  if (task?.trim()) return `${task.trim()}\n\nThe issue this is about:\n${section(issue)}`;
  return [
    `Resolve issue #${issue.number}. The issue as it stands is below, so start from the code`,
    "and tests rather than fetching it again; read its comments only if you need more.",
    "Make the smallest change that resolves it and verify it.",
    "",
    section(issue),
  ].join("\n");
}
