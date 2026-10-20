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
  const wired = sharedAbove(run, node);
  if (wired.length > 0) {
    lines.push(
      "", `Do not edit these files; they are wired in once every part is merged: ${wired.join(", ")}`,
      "Test your code by importing it from its own file, not through them.",
    );
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

// The project's check runs after every merge and a failure sends the work back, so a
// leaf runs it itself before saying it is done.
export function checkNote(check: string): string {
  return `\nBefore you report done, run the project's check and make it pass: ${check}\nRivet runs it again after merging your work; if it fails, the part comes back to you.`;
}

// The shared files of every parent above a node: a part leaves them alone.
export function sharedAbove(run: Run, node: Node): string[] {
  const files: string[] = [];
  for (let p = run.nodes.find((n) => n.id === node.parentId); p; p = run.nodes.find((n) => n.id === p!.parentId)) {
    files.push(...p.shared);
  }
  return files;
}

// What a parent's agent is told once all its parts are merged: wire them into the
// shared files, and nothing else.
export function wiringPrompt(run: Run, parent: Node, children: Node[]): string {
  if (parent.agent === "fake") return parent.prompt;
  return [
    `You integrate work for the task: ${run.task}`,
    `Every part of "${parent.title}" is now merged into this branch:`,
    ...children.map((c) => `  - ${c.title}${c.files.length ? ` (${c.files.join(", ")})` : ""}`),
    "",
    `Wire them into these shared files, and change no other file: ${parent.shared.join(", ")}`,
    "Read the merged parts to see what each one needs there (exports, registrations, routes).",
    "Do not add features or change the parts themselves. Commit your change.",
  ].join("\n");
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
