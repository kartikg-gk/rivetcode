import { ArrowUp, ChevronDown, GitBranch, Lock, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { startSession } from "./actions";
import { api } from "./api";
import { ModelPicker } from "./ModelPicker";
import { act, repoName, useApp, useLive } from "./state";

const ACCESS = [
  { value: "default", label: "Ask first" }, { value: "edits", label: "Accept edits" },
  { value: "auto", label: "Auto" }, { value: "full", label: "Full access" },
];

function Pop({ label, icon, children }: { label: string; icon?: ReactNode; children(close: () => void): ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div className="relative" ref={box}>
      <button className="pill" aria-expanded={open} onClick={() => setOpen(!open)}>{icon}{label}<ChevronDown size={13} /></button>
      {open && <div className="absolute top-full left-0 mt-1 z-30 w-72 rounded-xl border border-line bg-panel shadow-xl overflow-hidden">{children(() => setOpen(false))}</div>}
    </div>
  );
}

// Access is the project's setting: it applies to every session started there.
function Access({ project }: { project: string }) {
  const { data, reload } = useLive(() => api<Record<string, string>>("GET", `/projects/${encodeURIComponent(project)}/config`), [project]);
  const now = data?.["worker.permission"] ?? "edits";
  return (
    <Pop icon={<Lock size={13} />} label={ACCESS.find((a) => a.value === now)?.label ?? now}>
      {(close) => <ul className="p-1">{ACCESS.map((a) => (
        <li key={a.value}><button className={`w-full text-left rounded-md px-2 py-1.5 cursor-pointer hover:bg-raised ${a.value === now ? "bg-raised" : ""}`} onClick={() => {
          close();
          void act(async () => { await api("PUT", `/projects/${encodeURIComponent(project)}/config`, { key: "worker.permission", value: a.value }); reload(); });
        }}>{a.label}</button></li>
      ))}</ul>}
    </Pop>
  );
}

export function Home() {
  const { repo, runs, set } = useApp();
  const [agent, setAgent] = useState("claude");
  const [model, setModel] = useState("sonnet");
  const [role, setRole] = useState("worker");
  const [base, setBase] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const project = runs.find((r) => r.repo === repo)?.project ?? repoName(repo);
  const ask = () => set({ ask: {
    title: "Project folder", confirm: "Use",
    fields: [{ name: "repo", label: "Git repository folder", value: repo }],
    run: async (v) => {
      const next = (v.repo ?? "").trim();
      try { localStorage.setItem("rivet.repo", next); } catch { /* optional */ }
      set({ repo: next });
    },
  } });
  const ready = !!repo && !busy && (!!text.trim() || role === "orchestrator");
  const start = () => {
    if (!ready) return;
    setBusy(true);
    void act(() => startSession({ repo, task: text, role, agent, chat: true, ...(model ? { model } : {}), ...(base.trim() && role === "worker" ? { base: base.trim() } : {}) }))
      .then(() => setBusy(false));
  };
  const folder = <button className="underline decoration-dotted decoration-1 underline-offset-4 cursor-pointer" onClick={ask}>{repo ? repoName(repo) : "which folder"}</button>;
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <header className="topbar"><button className="text-muted cursor-pointer truncate hover:text-fg" onClick={ask}>{repo ? repoName(repo) : "Choose a folder"}</button><span className="text-muted">/</span><span className="font-medium">New thread</span></header>
      <div className="flex-1 overflow-y-auto grid place-items-center p-4">
        <div className="w-full max-w-3xl grid gap-6">
          <h1 className="text-center text-3xl font-medium tracking-tight">What should we build in {folder}?</h1>
          <div className="grid">
            <div className="composer">
              <textarea autoFocus aria-label="What to build" rows={3} className="w-full bg-transparent resize-none outline-none px-1" placeholder="Describe the task"
                value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); start(); } }} />
              <div className="flex items-center gap-1 flex-wrap">
                <ModelPicker project={project} agent={agent} model={model} pick={(a, m) => { setAgent(a); setModel(m); }} />
                {repo && <Access project={project} />}
                <Pop label={role === "worker" ? "Worker" : "Orchestrator"}>
                  {(close) => <ul className="p-1">{[["worker", "Worker", "One task, own worktree and PR"], ["orchestrator", "Orchestrator", "Splits work into workers"]].map(([v, l, about]) => (
                    <li key={v}><button className="w-full text-left rounded-md px-2 py-1.5 cursor-pointer hover:bg-raised" onClick={() => { setRole(v!); close(); }}><div>{l}</div><div className="text-xs text-muted">{about}</div></button></li>
                  ))}</ul>}
                </Pop>
                <button className="pill" title="More options" aria-label="More options" onClick={() => set({ screen: "new" })}><SlidersHorizontal size={13} /></button>
                <button className="send ml-auto" aria-label="Start" disabled={!ready} onClick={start}><ArrowUp size={17} /></button>
              </div>
            </div>
            {role === "worker" && (
              <label className="strip"><GitBranch size={13} /><input aria-label="Base branch" className="bg-transparent outline-none w-28" placeholder="default branch" value={base} onChange={(e) => setBase(e.target.value)} /></label>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
