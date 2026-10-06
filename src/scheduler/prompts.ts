import type { Run } from "../store.js";
import type { Node } from "../tree.js";

// What a leaf's agent is told. The fake agent's prompt is a script, so it gets it verbatim.
export function leafPrompt(run: Run, node: Node, retry?: string): string {
  if (node.agent === "fake") return node.prompt;
  const lines = [
    `You are one of several coding agents working on this task together: ${run.task}`,
    "",
    `Your part: ${node.title}`,
    node.prompt,
  ];
  if (node.files.length > 0) {
    lines.push("", `Files you own (stay within them where you can): ${node.files.join(", ")}`);
  }
  lines.push(
    "",
    "You work in your own git worktree on your own branch. Commit your work as you go.",
    "Other agents work on the other parts in parallel; do not do their parts.",
    `When your part is finished, run: rivet report --done --note "<one line summary>"`,
    `If you are stuck, run: rivet report --stuck --note "<what blocks you>"`,
    `If you need a decision from the user, run: rivet report --needs-input --note "<question>"`,
  );
  if (retry) lines.push("", "A previous attempt at this part failed:", retry, "", "Fix that and finish the part.");
  return lines.join("\n");
}

// What a parent's agent is told when merging a child conflicts. It may only resolve.
export function conflictPrompt(run: Run, parent: Node, child: Node, conflicts: string[]): string {
  if (parent.agent === "fake") return parent.prompt;
  return [
    `You integrate work for the task: ${run.task}`,
    `Merging "${child.title}" (branch ${child.branch}) into this branch stopped on conflicts in:`,
    ...conflicts.map((f) => `  ${f}`),
    "",
    "Resolve only these conflicts, keeping the intent of both sides. Do not change any other file",
    "and do not add features. Remove every conflict marker, then stage the files and commit the merge.",
  ].join("\n");
}
