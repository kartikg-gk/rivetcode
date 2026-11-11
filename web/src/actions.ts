import { api, runPath, sessionOf, type RunDetail } from "./api";
import { act, toast, useApp, type Ask } from "./state";

const ask = (a: Ask) => useApp.getState().set({ ask: a });
const go = (id: string) => useApp.getState().set({ selected: id });

export type Action = { id: string; label: string; about: string; args?: string; run(rest: string): void };

// What can be done to a session: the same list drives its menu, the / menu and the palette.
export function sessionActions(id: string, d: RunDetail | undefined): Action[] {
  const post = (tail: string, body?: unknown, done?: string) => { void act(() => api("POST", runPath(id, tail), body), done); };
  const chat = d?.run.node.runMode === "chat";
  const all: Action[] = [
    { id: "stop", label: "Stop", about: "stop this session; an orchestrator also stops its workers", run: () => ask({
      title: "Stop this session?", danger: true, confirm: "Stop",
      fields: d?.run.role === "orchestrator" ? [{ name: "keep", label: "Keep its workers running", type: "check" }] : [],
      run: (v) => api("POST", runPath(id, "/stop"), { keepWorkers: v.keep === "true" }),
    }) },
    { id: "resume", label: "Resume", about: "retry what was escalated or interrupted", run: () => post("/resume", undefined, "resuming") },
    { id: "switch", label: "Switch agent…", about: "hand this worker to another agent in the same worktree", args: "claude|codex|delta", run: (rest) => ask({
      title: "Switch agent", note: "Waits for the current turn to end unless you cut it short.", confirm: "Switch",
      fields: [
        { name: "agent", label: "Agent", type: "select", options: ["claude", "codex", "delta"].filter((a) => a !== d?.run.node.agent), value: rest.trim() || (d?.run.node.agent === "claude" ? "codex" : "claude") },
        { name: "model", label: "Model (optional)" }, { name: "now", label: "Cut the current turn short", type: "check" },
      ],
      run: (v) => api("POST", runPath(id, "/switch"), { agent: v.agent, ...(v.model ? { model: v.model } : {}), now: v.now === "true" }),
    }) },
    { id: "fork", label: "Fork…", about: "branch this conversation into a new session on the same checkout", run: () => ask({
      title: "Fork conversation", note: "The fork shares this checkout, so file changes are shared too.", confirm: "Fork",
      fields: [{ name: "name", label: "Name (optional)" }, { name: "at", label: "From reply position (empty: latest)", type: "number" }],
      run: async (v) => {
        const r = await api<{ runId?: string; id?: string }>("POST", runPath(id, "/fork"), { ...(v.name ? { name: v.name } : {}), ...(v.at ? { at: Number(v.at) } : {}) });
        const next = r.runId ?? r.id;
        if (next) go(next);
      },
    }) },
    { id: "rollback", label: "Roll back…", about: "go back in the chat on a new branch; optionally put the files back too", args: "[turns]", run: (rest) => ask({
      title: "Roll back conversation", note: "The old branch is kept. Restoring files puts the worktree back to how it was before that prompt; changes made since are discarded.", confirm: "Roll back", danger: true,
      fields: [{ name: "turns", label: "Turns to drop", type: "number", value: rest.trim() || "1" },
        { name: "files", label: "Files", type: "select", options: ["keep current files", "restore files too"], value: "keep current files" }],
      run: (v) => api("POST", runPath(id, "/rollback"), { turns: Number(v.turns), ...(v.files === "restore files too" ? { files: true } : {}) }),
    }) },
    { id: "carry-back", label: "Carry back…", about: "copy what this fork learned into its parent's next message; no git merge", run: () => ask({
      title: "Carry back into parent", note: "Moves conversation context only. Files are already shared.", confirm: "Carry back",
      fields: [{ name: "target", label: "Target run (empty: its source)" }, { name: "at", label: "Through position (empty: latest)", type: "number" }],
      run: (v) => api("POST", runPath(id, "/carry-back"), { ...(v.target ? { target: v.target } : {}), ...(v.at ? { at: Number(v.at) } : {}) }),
    }) },
    { id: "compact", label: "Compact", about: "ask the agent to compact its context when idle", run: () => post("/compact", {}, "compaction requested") },
    { id: "reconcile", label: "Refresh history", about: "ask the agent for its history when idle", run: () => post("/reconcile", {}, "history refresh requested") },
    { id: "pr", label: "Open pull request", about: "bring in the latest base, push and open the pull request", run: () => void act(async () => {
      const r = await api<{ url: string }>("POST", runPath(id, "/pr"));
      toast(`pull request: ${r.url}`);
    }) },
    { id: "link-pr", label: "Link pull request…", about: "watch an existing pull request for this run; empty stops watching", args: "[number]", run: (rest) => ask({
      title: "Link pull request", note: "Rivet watches its checks, reviews and merge like one it opened. One per run.", confirm: "Save",
      fields: [{ name: "number", label: "Pull request number (empty: stop watching)", type: "number", value: rest.trim() || String(d?.pr?.number ?? "") }],
      run: (v) => api("POST", runPath(id, "/link-pr"), { number: v.number ? Number(v.number) : null }),
    }) },
    { id: "review", label: "Review pull request", about: "have a reviewer agent review this worker's pull request", run: () => post("/review", undefined, "review started") },
    { id: "policy", label: d?.endOnMerge ? "Keep after merge" : "End on merge", about: "whether this run ends once its pull request merges", run: () => void act(
      () => api("PATCH", runPath(id, "/after-merge"), { endOnMerge: !d?.endOnMerge }), "merge policy changed") },
    { id: "rename", label: "Rename…", about: "give this session a name", args: "[name]", run: (rest) => ask({
      title: "Rename session", confirm: "Rename", fields: [{ name: "name", label: "Name", value: rest.trim() || d?.run.name || "" }],
      run: (v) => api("PATCH", runPath(id, "/organization"), { name: v.name }),
    }) },
    { id: "group", label: "Group…", about: "put this session in a group", args: "[name]", run: (rest) => ask({
      title: "Group session", confirm: "Save", fields: [{ name: "group", label: "Group (empty: none)", value: rest.trim() }],
      run: (v) => api("PATCH", runPath(id, "/organization"), { group: v.group ?? "" }),
    }) },
    ...(() => {
      const org = useApp.getState().runs.find((r) => r.id === id)?.organization;
      const patch = (body: unknown, done: string) => void act(() => api("PATCH", runPath(id, "/organization"), body), done);
      const later = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
      return [
        org?.pinnedAt ? { id: "unpin", label: "Unpin", about: "take this session off the pinned list", run: () => patch({ pinned: false }, "unpinned") }
          : { id: "pin", label: "Pin", about: "keep this session at the top of the list", run: () => patch({ pinned: true }, "pinned") },
        org?.snoozedUntil ? { id: "unsnooze", label: "Unsnooze", about: "show this session in the list again now", run: () => patch({ snoozedUntil: null }, "back in the list") }
          : { id: "snooze", label: "Snooze…", about: "hide this session until a time", args: "[hours]", run: (rest: string) => ask({
            title: "Snooze session", confirm: "Snooze", fields: [{ name: "hours", label: "Hours", type: "number", value: rest.trim() || "4" }],
            run: (v) => api("PATCH", runPath(id, "/organization"), { snoozedUntil: later(Number(v.hours) || 4) }),
          }) },
        { id: "unread", label: "Mark unread", about: "show this session as having something new", run: () => patch({ unread: true }, "marked unread") },
      ] as Action[];
    })(),
    { id: "archive", label: "Archive", about: "hide this session from the list", run: () => void act(() => api("PATCH", runPath(id, "/organization"), { archived: true }), "archived") },
    { id: "unarchive", label: "Unarchive", about: "show this session in the list again", run: () => void act(() => api("PATCH", runPath(id, "/organization"), { archived: false }), "back in the list") },
    { id: "clean", label: "Remove worktree…", about: "remove this run's worktree; the branch stays and dirty worktrees are kept", run: () => ask({
      title: "Remove this worktree?", note: "The branch stays. A worktree with uncommitted work is kept, not forced.", danger: true, confirm: "Remove",
      run: () => api("POST", runPath(id, "/clean")),
    }) },
  ];
  return all.filter((a) => chat || !["rollback", "compact", "reconcile"].includes(a.id));
}

export async function startSession(body: Record<string, unknown>): Promise<void> {
  const r = await api<{ runId: string }>("POST", "/runs", body);
  go(r.runId);
}

export async function send(id: string, message: string, mode: string, files: File[] = []): Promise<string> {
  if (files.length > 3 || files.reduce((total, file) => total + file.size, 0) > 512 * 1024) throw new Error("Attach up to three files totaling 512 KiB");
  const attachments = await Promise.all(files.map(file => new Promise<{ name: string; base64: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read attachment"));
    reader.onload = () => resolve({ name: file.name, base64: String(reader.result).split(",", 2)[1] ?? "" });
    reader.readAsDataURL(file);
  })));
  const r = await api<{ delivery: string }>("POST", `/sessions/${encodeURIComponent(sessionOf(id))}/send`, { message, mode, ...(attachments.length ? { attachments } : {}) });
  return r.delivery;
}
