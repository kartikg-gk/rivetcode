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

// Work that has yet to land: a worker still working, or done with its work not merged.
function unlanded(r: Run): boolean {
  if (r.role !== "worker" || r.sharedWorkspace) return false;
  return r.node.status === "running" || (r.node.status === "done" && r.node.prStatus !== "merged" && r.node.prStatus !== "closed");
}

// Live conflict check between workers of one project: which pairs would clash when both
// land, found while one of them still works rather than when the second PR merges. With
// focus, only that worker's pairs, whether or not the other still works (checked the
// moment it finishes, since workers often commit only at the end).
export async function radar(runs: Run[], focus?: string): Promise<RadarHit[]> {
  const hits: RadarHit[] = [];
  const working = runs.filter(unlanded);
  for (let i = 0; i < working.length; i++) {
    for (const other of working.slice(i + 1)) {
      const a = working[i]!;
      if (a.repo !== other.repo) continue;
      if (focus !== undefined && a.id !== focus && other.id !== focus) continue;
      if (focus === undefined && a.node.status !== "running" && other.node.status !== "running") continue;
      const files = await wouldConflict(a.repo, a.node.branch, other.node.branch);
      if (files?.length) hits.push({ a: a.id, b: other.id, files });
    }
  }
  return hits;
}
