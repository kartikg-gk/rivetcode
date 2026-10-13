import { execFile } from "node:child_process";
import type { Run } from "../store.js";

export type RadarHit = { a: string; b: string; files: string[] };

// A test merge of two branches that touches no worktree: which files would conflict.
export function wouldConflict(repo: string, a: string, b: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", a, b], { cwd: repo, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      if (code === 0) return resolve([]);
      // Exit 1 with a tree id first is "conflicts"; anything else means the test merge
      // could not run (an unknown branch also exits 1, but prints no tree).
      const lines = String(stdout).split(/\r?\n/);
      if (code !== 1 || !/^[0-9a-f]{40,64}$/.test(lines[0] ?? "")) return resolve(null);
      resolve(lines.slice(1).filter(Boolean));
    });
  });
}

// Live conflict check: each running leaf against its running siblings and against what
// its parent already merged. Finds clashes while agents still work, not at merge time.
export async function radar(run: Run): Promise<RadarHit[]> {
  const hits: RadarHit[] = [];
  const working = run.nodes.filter((n) => n.kind === "leaf" && n.status === "running");
  for (let i = 0; i < working.length; i++) {
    const leaf = working[i]!;
    const parent = run.nodes.find((n) => n.id === leaf.parentId);
    if (parent) {
      const files = await wouldConflict(run.repo, parent.branch, leaf.branch);
      if (files?.length) hits.push({ a: leaf.id, b: parent.id, files });
    }
    for (const other of working.slice(i + 1)) {
      if (other.parentId !== leaf.parentId) continue;
      const files = await wouldConflict(run.repo, leaf.branch, other.branch);
      if (files?.length) hits.push({ a: leaf.id, b: other.id, files });
    }
  }
  return hits;
}
