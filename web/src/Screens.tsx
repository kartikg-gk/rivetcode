import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { sessionActions, startSession } from "./actions";
import { api, runPath, type RunDetail, type RunRow } from "./api";
import { act, runLabel, toast, useApp, useLive, type Field, type Screen } from "./state";

function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div className="fixed inset-0 z-40 bg-black/50 grid place-items-start justify-items-center pt-[8vh] px-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[84vh] overflow-y-auto rounded-xl border border-line bg-panel shadow-2xl`}>
        <header className="flex items-center px-4 py-3 border-b border-line sticky top-0 bg-panel z-10">
          <h2 className="font-semibold flex-1">{title}</h2>
          <button className="cursor-pointer text-muted" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="p-4 grid gap-3">{children}</div>
      </div>
    </div>
  );
}

function Input({ f, value, onChange }: { f: Field; value: string; onChange(v: string): void }) {
  if (f.type === "check") return <label className="flex items-center gap-2"><input type="checkbox" checked={value === "true"} onChange={(e) => onChange(String(e.target.checked))} /> {f.label}</label>;
  return (
    <label className="label">{f.label}
      {f.type === "textarea" ? <textarea className="field text-fg" rows={5} value={value} onChange={(e) => onChange(e.target.value)} />
        : f.type === "select" ? <select className="field text-fg" value={value} onChange={(e) => onChange(e.target.value)}>{f.options!.map((o) => <option key={o} value={o}>{o || "(none)"}</option>)}</select>
        : <input className="field text-fg" type={f.type === "number" ? "number" : "text"} value={value} onChange={(e) => onChange(e.target.value)} />}
      {f.hint && <span>{f.hint}</span>}
    </label>
  );
}

export function AskDialog() {
  const { ask, set } = useApp();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValues(Object.fromEntries((ask?.fields ?? []).map((f) => [f.name, f.value ?? ""]))); }, [ask]);
  if (!ask) return null;
  const close = () => set({ ask: null });
  return (
    <Modal title={ask.title} onClose={close}>
      {ask.note && <p className="text-muted">{ask.note}</p>}
      {ask.fields?.map((f) => <Input key={f.name} f={f} value={values[f.name] ?? ""} onChange={(v) => setValues({ ...values, [f.name]: v })} />)}
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={close}>Cancel</button>
        <button className={`btn ${ask.danger ? "btn-danger" : "btn-primary"}`} disabled={busy} onClick={() => {
          setBusy(true);
          void act(() => ask.run(values)).then((ok) => { setBusy(false); if (ok) close(); });
        }}>{busy ? "Working…" : ask.confirm}</button>
      </div>
    </Modal>
  );
}

function NewSession({ close }: { close(): void }) {
  const { repo, runs, set } = useApp();
  const repos = [...new Set(runs.map((r) => r.repo))];
  const [f, setF] = useState({ repo: repo || repos[0] || "", role: "worker", agent: "", model: "", name: "", base: "", issue: "", task: "" });
  const [busy, setBusy] = useState(false);
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const remember = () => { try { localStorage.setItem("rivet.repo", f.repo); } catch { /* optional */ } set({ repo: f.repo }); };
  const start = (body: Record<string, unknown>) => { setBusy(true); remember(); void act(() => startSession(body)).then((ok) => { setBusy(false); if (ok) close(); }); };
  const both = () => {
    setBusy(true); remember();
    void act(async () => {
      for (const agent of ["codex", "claude"]) await api("POST", "/runs", { repo: f.repo, task: "", role: "orchestrator", agent, name: agent, terminal: true }).then((r) => {
        const id = (r as { runId: string }).runId;
        const s = useApp.getState();
        set({ beside: s.selected, selected: id });
      });
    }).then((ok) => { setBusy(false); if (ok) close(); });
  };
  const ready = f.repo.trim() && (f.task.trim() || f.issue.trim() || f.role === "orchestrator");
  return (
    <Modal title="New session" onClose={close}>
      <label className="label">Repository folder
        <input className="field text-fg" list="repos" placeholder="E:\code\my-repo" value={f.repo} onChange={up("repo")} />
        <datalist id="repos">{repos.map((r) => <option key={r} value={r} />)}</datalist>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="label">Kind<select className="field text-fg" value={f.role} onChange={up("role")}><option value="worker">Worker: one task, own worktree and PR</option><option value="orchestrator">Orchestrator: splits work into workers</option></select></label>
        <label className="label">Agent<select className="field text-fg" value={f.agent} onChange={up("agent")}><option value="">project default</option><option value="claude">claude</option><option value="codex">codex</option></select></label>
        <label className="label">Model (optional)<input className="field text-fg" value={f.model} onChange={up("model")} /></label>
        <label className="label">Name (optional)<input className="field text-fg" value={f.name} onChange={up("name")} /></label>
        {f.role === "worker" && <label className="label">Base branch (optional)<input className="field text-fg" value={f.base} onChange={up("base")} /></label>}
        {f.role === "worker" && <label className="label">GitHub issue (optional)<input className="field text-fg" placeholder="42 or owner/repo#42" value={f.issue} onChange={up("issue")} /></label>}
      </div>
      <label className="label">{f.role === "worker" ? "Task" : "What you want"}<textarea className="field text-fg" rows={5} value={f.task} onChange={up("task")} /></label>
      <div className="flex justify-between gap-2 flex-wrap">
        <button className="btn" disabled={busy || !f.repo.trim()} onClick={both} title="Both agents in their own terminals, side by side">Open Claude and Codex</button>
        <button className="btn btn-primary" disabled={busy || !ready} onClick={() => start({
          repo: f.repo.trim(), task: f.task, role: f.role, chat: true,
          ...(f.agent ? { agent: f.agent } : {}), ...(f.model ? { model: f.model } : {}), ...(f.name ? { name: f.name } : {}), ...(f.base ? { base: f.base } : {}), ...(f.issue ? { issue: f.issue } : {}),
        })}>{busy ? "Starting…" : "Start"}</button>
      </div>
    </Modal>
  );
}

type FileTask = { name: string; goal: string; agent?: string; model?: string; base?: string; spec: Record<string, unknown> };

function TaskFile({ close }: { close(): void }) {
  const { repo, runs } = useApp();
  const [source, setSource] = useState("");
  const [folder, setFolder] = useState(repo || runs[0]?.repo || "");
  const [tasks, setTasks] = useState<FileTask[] | null>(null);
  return (
    <Modal title="Start from a task file" wide onClose={close}>
      <label className="label">Repository folder<input className="field text-fg" value={folder} onChange={(e) => setFolder(e.target.value)} /></label>
      <label className="label">Task file (YAML: each task's goal, done_when, limits, paths and tools)
        <textarea className="field text-fg mono" rows={10} value={source} onChange={(e) => { setSource(e.target.value); setTasks(null); }} />
      </label>
      {tasks && <ul className="grid gap-1 text-[13px]">{tasks.map((t) => <li key={t.name}><b>{t.name}</b> <span className="text-muted">{t.agent ?? "default agent"} {JSON.stringify(t.spec)}</span></li>)}</ul>}
      <div className="flex justify-end gap-2">
        <button className="btn" disabled={!source.trim()} onClick={() => void act(async () => setTasks((await api<{ tasks: FileTask[] }>("POST", "/tasks/parse", { source })).tasks))}>Check</button>
        <button className="btn btn-primary" disabled={!tasks?.length || !folder.trim()} onClick={() => void act(async () => {
          for (const t of tasks!) await api("POST", "/runs", { repo: folder.trim(), task: t.goal, name: t.name, spec: t.spec, ...(t.agent ? { agent: t.agent } : {}), ...(t.model ? { model: t.model } : {}), ...(t.base ? { base: t.base } : {}) });
          close();
        }, `started ${tasks?.length} workers`)}>Start {tasks?.length ?? ""} workers</button>
      </div>
    </Modal>
  );
}

type Match = { runId: string; title: string; snippet: string; source: string; position?: number };

function SearchScreen({ close }: { close(): void }) {
  const set = useApp((s) => s.set);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const run = (more: boolean) => void act(async () => {
    const q = new URLSearchParams({ query, ...(more && cursor ? { cursor } : {}) });
    const page = await api<{ matches: Match[]; nextCursor?: string | null }>("GET", `/search?${q}`);
    setMatches(more ? [...matches, ...page.matches] : page.matches);
    setCursor(page.nextCursor ?? null);
    setSearched(true);
  });
  return (
    <Modal title="Search every session" wide onClose={close}>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (query.trim()) run(false); }}>
        <input autoFocus aria-label="Search" className="field text-fg" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words from a task or conversation" />
        <button className="btn btn-primary">Search</button>
      </form>
      {searched && matches.length === 0 && <p className="text-muted">No matches.</p>}
      <ul className="grid gap-1">
        {matches.map((m, i) => {
          return <li key={i}><button className="w-full text-left p-2 rounded hover:bg-raised cursor-pointer" onClick={() => { set({ selected: m.runId }); close(); }}>
            <div className="font-medium truncate">{m.title || m.runId}{m.position ? ` #${m.position}` : ""}</div>
            <div className="text-[13px] text-muted break-words">{m.snippet}</div>
          </button></li>;
        })}
      </ul>
      {cursor && <button className="btn justify-self-center" onClick={() => run(true)}>More</button>}
    </Modal>
  );
}

// Settings, snippets and radar belong to a project; this picks which, from the sessions or a folder.
function useProject() {
  const { runs, selected, repo } = useApp();
  const projects = useMemo(() => [...new Map(runs.map((r) => [r.project, r.repo])).entries()], [runs]);
  const current = runs.find((r) => r.id === selected)?.project ?? runs.find((r) => r.repo === repo)?.project ?? projects[0]?.[0] ?? "";
  const [project, setProject] = useState(current);
  const picker = projects.length > 1 ? (
    <label className="label">Project<select className="field text-fg" value={project} onChange={(e) => setProject(e.target.value)}>{projects.map(([p, r]) => <option key={p} value={p}>{r}</option>)}</select></label>
  ) : null;
  return { project, repo: projects.find(([p]) => p === project)?.[1] ?? "", picker };
}
const NoProject = () => <p className="text-muted">Start a session in a repository first; these belong to its project.</p>;

const SETTINGS: { key: string; about: string; options?: string[] }[] = [
  { key: "feedback.ciRetries", about: "automatic CI fixes per pull request (default 2)" },
  { key: "feedback.reviewMinutes", about: "minutes before unresolved review changes need attention (default 30)" },
  { key: "check", about: "command that must pass before a pull request" }, { key: "test", about: "tests that must pass before a pull request" },
  { key: "verify.reuse", about: "reuse a worker's own passing check", options: ["", "off"] },
  { key: "run.mode", about: "run agents as terminals or chats", options: ["", "terminal", "chat"] },
  { key: "worker.agent", about: "default agent", options: ["", "claude", "codex"] }, { key: "worker.view", about: "headless or interactive workers" },
  { key: "worker.permission", about: "permission mode" }, { key: "worker.viewl", about: "default model" }, { key: "claude.model", about: "Claude's model" }, { key: "codex.model", about: "Codex's model" },
  { key: "worker.allowedTools", about: "tools allowed without asking" }, { key: "pr", about: "open pull requests" }, { key: "review", about: "automatic review (auto)" }, { key: "review.agent", about: "reviewer's agent" },
  { key: "pr.feedback", about: "full: Rivet hands over CI and review feedback", options: ["", "full"] }, { key: "github.repo", about: "owner/name, if origin is not it" },
  { key: "copy", about: "ignored files copied into worktrees, comma-separated" }, { key: "symlink", about: "ignored folders linked into worktrees, comma-separated" },
  { key: "setup", about: "commands run in each new worktree, one per line" }, { key: "timeline.keep", about: "days to keep finished timelines, or forever" },
];

function SettingsScreen({ close }: { close(): void }) {
  const { project, picker } = useProject();
  const { data, reload } = useLive(() => api<Record<string, string>>("GET", `/projects/${encodeURIComponent(project)}/config`), [project]);
  const save = (key: string, value: string) => void act(async () => {
    await api("PUT", `/projects/${encodeURIComponent(project)}/config`, { key, value: value === "" ? null : value });
    reload();
  }, `saved ${key}`);
  return (
    <Modal title="Project settings" wide onClose={close}>
      {!project ? <NoProject /> : <>
        {picker}
        {data && SETTINGS.map((s) => (
          <label key={s.key} className="label"><span><code className="mono text-fg">{s.key}</code> · {s.about}</span>
            {s.options ? <select className="field text-fg" defaultValue={data[s.key] ?? ""} onChange={(e) => save(s.key, e.target.value)}>{s.options.map((o) => <option key={o} value={o}>{o || "default"}</option>)}</select>
              : <input key={data[s.key] ?? ""} className="field text-fg" defaultValue={data[s.key] ?? ""} onBlur={(e) => { if (e.target.value !== (data[s.key] ?? "")) save(s.key, e.target.value); }} />}
          </label>
        ))}
      </>}
    </Modal>
  );
}

type Snippet = { name: string; type: string; text: string };

function Snippets({ close }: { close(): void }) {
  const { selected, set } = useApp();
  const { project, repo, picker } = useProject();
  const { data } = useLive(() => api<{ snippets: Snippet[] }>("GET", `/projects/${encodeURIComponent(project)}/snippets`), [project]);
  const add = () => set({ ask: {
    title: "New snippet", confirm: "Save",
    fields: [{ name: "name", label: "Name (one word)" }, { name: "type", label: "Kind", type: "select", options: ["agent", "command"], value: "agent", hint: "agent: a prompt. command: run from the terminal with rivet snippet run." }, { name: "text", label: "Text", type: "textarea" }],
    run: (v) => api("PUT", `/projects/${encodeURIComponent(project)}/snippets/${encodeURIComponent(v.name!)}`, { type: v.type, text: v.text }),
  } });
  const runIt = (c: Snippet, session: boolean) => void act(async () => {
    if (session) await api("POST", `/sessions/${encodeURIComponent(`${selected}-agent`)}/send`, { message: c.text });
    else await startSession({ repo, task: c.text, name: c.name });
    close();
  }, session ? "sent" : "worker started");
  return (
    <Modal title="Snippets" wide onClose={close}>
      {!project ? <NoProject /> : <>
        {picker}
        {data?.snippets.length === 0 && <p className="text-muted">No saved prompts or commands yet.</p>}
        {data?.snippets.map((c) => (
          <div key={c.name} className="border border-line rounded-lg p-3 grid gap-2">
            <div className="flex items-center gap-2"><b className="flex-1">{c.name}</b><span className="text-xs text-muted">{c.type}</span></div>
            <pre className="mono text-xs whitespace-pre-wrap break-words">{c.text}</pre>
            <div className="flex gap-2 flex-wrap">
              {c.type === "agent" ? <>
                <button className="btn" disabled={!selected} onClick={() => runIt(c, true)}>Send to this session</button>
                <button className="btn" onClick={() => runIt(c, false)}>Start a worker</button>
              </> : <button className="btn" onClick={() => void navigator.clipboard.writeText(`rivet snippet run ${c.name}`).then(() => toast("copied"), () => toast(`run: rivet snippet run ${c.name}`))}>Copy command to run</button>}
              <button className="btn btn-danger ml-auto" onClick={() => void act(() => api("DELETE", `/projects/${encodeURIComponent(project)}/snippets/${encodeURIComponent(c.name)}`), "deleted")}>Delete</button>
            </div>
          </div>
        ))}
        <button className="btn justify-self-start" onClick={add}>New snippet</button>
      </>}
    </Modal>
  );
}

type Routine = { id: string; name: string; repo: string; prompt: string; role: string; cron: string; zone: string; enabled: boolean; nextRunAt: string; agent?: string };

function Routines({ close }: { close(): void }) {
  const { repo, runs, set } = useApp();
  const { data } = useLive(() => api<{ routines: Routine[] }>("GET", "/routines"), []);
  const add = () => set({ ask: {
    title: "New schedule", confirm: "Save",
    fields: [
      { name: "repo", label: "Repository folder", value: repo || runs[0]?.repo || "" }, { name: "name", label: "Name (one word)" },
      { name: "cron", label: "Cron: minute hour day month weekday", value: "0 9 * * 1-5" }, { name: "zone", label: "Time zone", value: Intl.DateTimeFormat().resolvedOptions().timeZone },
      { name: "role", label: "Runs as", type: "select", options: ["worker", "orchestrator"], value: "worker" }, { name: "agent", label: "Agent", type: "select", options: ["", "claude", "codex"] },
      { name: "prompt", label: "Prompt", type: "textarea" },
    ],
    run: (v) => api("POST", "/routines", { ...v, ...(v.agent ? {} : { agent: undefined }) }),
  } });
  const path = (a: Routine, tail = "") => `/routines/${encodeURIComponent(a.id)}${tail}`;
  return (
    <Modal title="Schedules" wide onClose={close}>
      {data?.routines.length === 0 && <p className="text-muted">Nothing scheduled.</p>}
      {data?.routines.map((a) => (
        <div key={a.id} className="border border-line rounded-lg p-3 grid gap-1">
          <div className="flex items-center gap-2"><b className="flex-1">{a.name}</b><code className="mono text-xs">{a.cron}</code><span className="text-xs text-muted">{a.zone}</span></div>
          <div className="text-[13px] whitespace-pre-wrap">{a.prompt}</div>
          <div className="text-xs text-muted">{a.enabled ? `next ${new Date(a.nextRunAt).toLocaleString()}` : "paused"} · {a.role}{a.agent ? ` · ${a.agent}` : ""}</div>
          <div className="flex gap-2 flex-wrap mt-1">
            <button className="btn" onClick={() => void act(() => api("POST", path(a, "/run")), "started")}>Run now</button>
            <button className="btn" onClick={() => void act(() => api("POST", path(a, a.enabled ? "/pause" : "/resume")))}>{a.enabled ? "Pause" : "Resume"}</button>
            <button className="btn btn-danger ml-auto" onClick={() => void act(() => api("DELETE", path(a)), "deleted")}>Delete</button>
          </div>
        </div>
      ))}
      <button className="btn justify-self-start" onClick={add}>New schedule</button>
    </Modal>
  );
}

function Health({ close }: { close(): void }) {
  const { repo, set } = useApp();
  const doctor = useLive(() => api<{ checks: { level: string; name: string; message: string }[] }>("GET", `/doctor${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`), [repo]);
  const recovery = useLive(() => api<Record<string, unknown>>("GET", "/recovery"), []);
  const color: Record<string, string> = { ok: "text-ok", warn: "text-warn", fail: "text-danger" };
  return (
    <Modal title="Machine and recovery" wide onClose={close}>
      <h3 className="font-medium">What Rivet needs</h3>
      {doctor.error && <p className="text-danger">{doctor.error}</p>}
      {!doctor.data && !doctor.error && <p className="text-muted">Checking…</p>}
      <ul className="grid gap-1 text-[13px]">{doctor.data?.checks.map((c) => <li key={c.name} className="flex gap-2"><span className={`w-10 shrink-0 font-medium ${color[c.level] ?? ""}`}>{c.level}</span><b className="w-20 shrink-0">{c.name}</b><span className="break-words min-w-0">{c.message}</span></li>)}</ul>
      <p className="text-xs text-muted">Signing an agent in uses its own login in a terminal: rivet login claude, or rivet login codex.</p>
      <h3 className="font-medium">Recovery journal</h3>
      {recovery.error && <p className="text-danger">{recovery.error}</p>}
      {recovery.data && <pre className="mono text-xs whitespace-pre-wrap break-words">{JSON.stringify(recovery.data, null, 2)}</pre>}
      <button className="btn justify-self-start" onClick={() => set({ ask: {
        title: "Save a database snapshot", confirm: "Save", fields: [{ name: "path", label: "New file path" }],
        run: (v) => api("POST", "/recovery/snapshot", { path: v.path }),
      } })}>Save a snapshot…</button>
      <p className="text-xs text-muted">Rebuilding a database copy stays a terminal step: rivet recovery rebuild.</p>
    </Modal>
  );
}

function Radar({ close }: { close(): void }) {
  const { project, picker } = useProject();
  const { data, error } = useLive(() => api<{ conflicts: unknown[] }>("GET", `/projects/${encodeURIComponent(project)}/radar`), [project]);
  return (
    <Modal title="Conflicts between workers" onClose={close}>
      {!project ? <NoProject /> : <>
        {picker}
        {error && <p className="text-danger">{error}</p>}
        {data?.conflicts.length === 0 && <p className="text-muted">No clashes.</p>}
        {data?.conflicts.map((c, i) => <pre key={i} className="mono text-xs whitespace-pre-wrap break-words border border-line rounded p-2">{JSON.stringify(c, null, 2)}</pre>)}
      </>}
    </Modal>
  );
}

export function Screens() {
  const { screen, set } = useApp();
  const close = () => set({ screen: null });
  const map: Record<NonNullable<Screen>, ReactNode> = {
    new: <NewSession close={close} />, tasks: <TaskFile close={close} />, search: <SearchScreen close={close} />, routines: <Routines close={close} />,
    snippets: <Snippets close={close} />, settings: <SettingsScreen close={close} />, health: <Health close={close} />, radar: <Radar close={close} />,
  };
  return screen ? <>{map[screen]}</> : null;
}

// Ctrl+K: every command and every session.
export function Palette() {
  const { palette, set, runs, selected } = useApp();
  const [q, setQ] = useState("");
  const [pick, setPick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<RunDetail>();
  useEffect(() => {
    if (!palette) return;
    setQ(""); setPick(0); input.current?.focus();
    if (selected) void api<RunDetail>("GET", runPath(selected)).then(setDetail, () => setDetail(undefined));
  }, [palette]);
  if (!palette) return null;
  const close = () => set({ palette: false });
  const screens: [string, NonNullable<Screen>][] = [["New session", "new"], ["Start from a task file", "tasks"], ["Search every session", "search"], ["Snippets", "snippets"], ["Schedules", "routines"], ["Project settings", "settings"], ["Machine and recovery", "health"], ["Conflicts between workers", "radar"]];
  const items = [
    ...screens.map(([label, screen]) => ({ key: screen, label, about: "", run: () => set({ screen }) })),
    ...(selected ? sessionActions(selected, detail).map((a) => ({ key: a.id, label: a.label, about: a.about, run: () => a.run("") })) : []),
    ...[...runs].reverse().map((r: RunRow) => ({ key: r.id, label: runLabel(r), about: `session · ${r.agent} · ${r.status}`, run: () => set({ selected: r.id }) })),
  ].filter((i) => `${i.label} ${i.about}`.toLowerCase().includes(q.toLowerCase()));
  const choose = (i: (typeof items)[number] | undefined) => { if (i) { close(); i.run(); } };
  return (
    <Modal title="Commands" onClose={close}>
      <input ref={input} aria-label="Find a command" className="field text-fg" placeholder="Find a command or session" value={q} onChange={(e) => { setQ(e.target.value); setPick(0); }} onKeyDown={(e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setPick(Math.min(pick + 1, items.length - 1)); }
        if (e.key === "ArrowUp") { e.preventDefault(); setPick(Math.max(pick - 1, 0)); }
        if (e.key === "Enter") choose(items[pick]);
      }} />
      <ul className="grid">
        {items.slice(0, 40).map((i, n) => <li key={i.key}><button onClick={() => choose(i)} className={`w-full text-left px-2 py-1.5 rounded cursor-pointer flex gap-3 ${n === pick ? "bg-raised" : ""}`}><span className="truncate">{i.label}</span><span className="ml-auto text-xs text-muted truncate">{i.about}</span></button></li>)}
      </ul>
    </Modal>
  );
}
