import type { Issue } from "../scheduler/issue.js";
import { execFile } from "node:child_process";
import type { PrStatus } from "../model.js";

export type CiState = "unknown" | "pending" | "passing" | "failing";
export type ReviewDecision = "none" | "approved" | "changes_requested" | "review_required";
export type Mergeability = "unknown" | "mergeable" | "conflicting" | "blocked" | "unstable" | "behind";

export type PrFacts = {
  open: boolean;
  merged: boolean;
  draft: boolean;
  ci: CiState;
  review: ReviewDecision;
  mergeability: Mergeability;
  // Inline review comments on the current head commit (treated as unresolved).
  reviewComments: boolean;
  headSha: string;
};

export type ReviewComment = { path: string; line: number | null; body: string };

export type GitHub = {
  // "owner/repo".
  repo: string;
  createPr(o: { title: string; head: string; base: string; body: string }): Promise<{ number: number; url: string }>;
  facts(number: number): Promise<PrFacts>;
  issue(number: number): Promise<Issue>;
  // Posts a review as a comment (the pull request's author cannot approve or request
  // changes on it), with inline comments on lines of its diff. Returns the review's id.
  postReview(number: number, o: { commitId: string; body: string; comments: { path: string; line: number; body: string }[] }): Promise<number>;
  // Files named by annotations of failing checks.
  failedPaths(number: number): Promise<string[]>;
  // Inline comments on the current head commit.
  reviewComments(number: number): Promise<ReviewComment[]>;
};

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

// owner/name from a GitHub remote URL (https, with or without a user, or ssh).
export function repoSlug(remote: string): string | null {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function run(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Never prompt: a missing login is reported, not asked for in a window or terminal.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
    const child = execFile(file, args, { windowsHide: true, timeout: 15_000, env }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    if (input !== undefined) child.stdin?.end(input);
  });
}

// A token from the environment, the gh CLI, or git's own credential store (the same
// login git push uses for this remote).
export async function githubToken(env: Record<string, string | undefined>, remote: string): Promise<string> {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const viaGh = await run("gh", ["auth", "token"]).then((t) => t.trim(), () => "");
  if (viaGh) return viaGh;
  const user = /^https:\/\/([^@/]+)@github\.com/i.exec(remote)?.[1];
  const request = ["protocol=https", "host=github.com", ...(user ? [`username=${user}`] : []), "", ""].join("\n");
  const answer = await run("git", ["credential", "fill"], request).catch(() => "");
  const password = /^password=(.+)$/m.exec(answer)?.[1]?.trim();
  if (password) return password;
  throw new Error("no GitHub token: set GITHUB_TOKEN, log in with gh, or let git store your GitHub login");
}

const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const MERGE_STATES: Record<string, Mergeability> = {
  clean: "mergeable", has_hooks: "mergeable", dirty: "conflicting", blocked: "blocked", unstable: "unstable", behind: "behind",
};

export function githubClient(o: { repo: string; token: string; api?: string }): GitHub {
  const api = (o.api ?? "https://api.github.com").replace(/\/$/, "");
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${api}/repos/${o.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "rivet",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  type Pull = { number: number; html_url: string; state: string; merged: boolean; draft: boolean; mergeable_state?: string; head: { sha: string }; requested_reviewers?: unknown[] };
  type CheckRun = { id: number; status: string; conclusion: string | null };

  async function ciOf(sha: string): Promise<{ state: CiState; failing: CheckRun[] }> {
    const checks = (await call<{ check_runs: CheckRun[] }>("GET", `/commits/${sha}/check-runs?per_page=100`)).check_runs;
    const combined = await call<{ state: string; statuses: unknown[] }>("GET", `/commits/${sha}/status`);
    const failing = checks.filter((c) => c.status === "completed" && FAILING.has(c.conclusion ?? ""));
    const hasStatuses = combined.statuses.length > 0;
    let state: CiState = "unknown";
    if (failing.length > 0 || (hasStatuses && (combined.state === "failure" || combined.state === "error"))) state = "failing";
    else if (checks.some((c) => c.status !== "completed") || (hasStatuses && combined.state === "pending")) state = "pending";
    else if (checks.length > 0 || hasStatuses) state = "passing";
    return { state, failing };
  }

  return {
    repo: o.repo,

    async createPr({ title, head, base, body }) {
      const pr = await call<Pull>("POST", "/pulls", { title, head, base, body });
      return { number: pr.number, url: pr.html_url };
    },

    async postReview(number, { commitId, body, comments }) {
      const review = await call<{ id: number }>("POST", `/pulls/${number}/reviews`, {
        commit_id: commitId, event: "COMMENT", body, ...(comments.length ? { comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })) } : {}),
      });
      return review.id;
    },

    async issue(number) {
      type Raw = { number: number; title: string; state: string; html_url: string; body: string | null; pull_request?: unknown;
        labels: ({ name: string } | string)[]; assignees: { login: string }[] };
      const i = await call<Raw>("GET", `/issues/${number}`);
      if (i.pull_request) throw new GitHubError(422, `#${number} is a pull request, not an issue`);
      return {
        number: i.number, title: i.title, state: i.state, url: i.html_url, body: i.body ?? "",
        labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)), assignees: i.assignees.map((a) => a.login),
      };
    },

    async facts(number) {
      const pr = await call<Pull>("GET", `/pulls/${number}`);
      const ci = await ciOf(pr.head.sha);
      const reviews = await call<{ user: { login: string } | null; state: string }[]>("GET", `/pulls/${number}/reviews?per_page=100`);
      // The latest verdict of each reviewer counts.
      const latest = new Map<string, string>();
      for (const r of reviews) if (r.user && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")) latest.set(r.user.login, r.state);
      const verdicts = [...latest.values()];
      const review: ReviewDecision = verdicts.includes("CHANGES_REQUESTED") ? "changes_requested"
        : verdicts.includes("APPROVED") ? "approved"
        : (pr.requested_reviewers?.length ?? 0) > 0 ? "review_required" : "none";
      const comments = await call<{ commit_id: string }[]>("GET", `/pulls/${number}/comments?per_page=100`);
      return {
        open: pr.state === "open",
        merged: pr.merged,
        draft: pr.draft,
        ci: ci.state,
        review,
        mergeability: MERGE_STATES[pr.mergeable_state ?? ""] ?? "unknown",
        reviewComments: comments.some((c) => c.commit_id === pr.head.sha),
        headSha: pr.head.sha,
      };
    },

    async failedPaths(number) {
      const pr = await call<Pull>("GET", `/pulls/${number}`);
      const { failing } = await ciOf(pr.head.sha);
      const paths = new Set<string>();
      for (const check of failing) {
        const notes = await call<{ path: string }[]>("GET", `/check-runs/${check.id}/annotations?per_page=100`).catch(() => []);
        for (const n of notes) if (n.path) paths.add(n.path);
      }
      return [...paths];
    },

    async reviewComments(number) {
      const pr = await call<Pull>("GET", `/pulls/${number}`);
      const comments = await call<{ commit_id: string; path: string; line: number | null; body: string }[]>("GET", `/pulls/${number}/comments?per_page=100`);
      return comments.filter((c) => c.commit_id === pr.head.sha).map((c) => ({ path: c.path, line: c.line, body: c.body }));
    },
  };
}

// Where the root's pull request stands, most urgent first.
export function prStatus(f: PrFacts): PrStatus {
  if (f.merged) return "merged";
  if (!f.open) return "terminated";
  if (f.ci === "failing") return "ci_failed";
  if (f.draft) return "draft";
  if (f.review === "changes_requested" || f.reviewComments) return "changes_requested";
  if (f.mergeability === "mergeable") return "mergeable";
  if (f.review === "review_required") return "review_pending";
  if (f.mergeability === "blocked") return "pr_open";
  if (f.review === "approved") return "approved";
  return "pr_open";
}
