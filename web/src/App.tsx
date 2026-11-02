import { Activity, Columns2, Plus, Search, Settings, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, onConnection, type RunRow } from "./api";
import { Conversation } from "./Conversation";
import { AskDialog, Palette, Screens } from "./Screens";
import { ago, repoName, runLabel, useApp, useLive } from "./state";

const DOT: Record<string, string> = { active: "bg-accent", blocked: "bg-warn", waiting_input: "bg-warn", idle: "bg-muted", exited: "bg-line" };

function Row({ r, depth }: { r: RunRow; depth: number }) {
  const { selected, set } = useApp();
  const color = r.needsAnswer ? "bg-warn" : r.live ? DOT[r.activity ?? "idle"] ?? "bg-muted" : r.status === "failed" || r.status === "escalated" ? "bg-danger" : "bg-line";
  return (
    <button onClick={() => set({ selected: r.id })} style={{ paddingLeft: 10 + depth * 14 }}
      className={`w-full text-left pr-2 py-1.5 rounded-md flex items-center gap-2 cursor-pointer hover:bg-raised ${selected === r.id ? "bg-raised" : ""}`}>
      <span aria-hidden className={`size-2 rounded-full shrink-0 ${color}`} />
      <span className="truncate flex-1">{runLabel(r)}</span>
      {r.needsAnswer && <span className="text-[11px] text-warn">question</span>}
      <span className="text-[11px] text-muted shrink-0">{r.role === "orchestrator" ? "orch · " : ""}{r.agent} · {ago(r.createdAt)}</span>
    </button>
  );
}

function SplitButton() {
  const { selected, beside, runs, set } = useApp();
  return (
    <button className="btn" title="Show another session beside this one" aria-label="Show another session beside this one" disabled={!selected}
      onClick={() => set({ ask: {
        title: "Show side by side", confirm: "Show",
        fields: [{ name: "run", label: "Session", type: "select", value: beside ?? "", options: ["", ...runs.filter((r) => r.id !== selected).map((r) => r.id)], hint: "Empty closes the second column." }],
        run: async (v) => { set({ beside: v.run || null }); },
      } })}><Columns2 size={15} /></button>
  );
}

function Sidebar() {
  const { runs, set, repo } = useApp();
  const [archived, setArchived] = useState<"hide" | "only" | "all">("hide");
  const projects = useMemo(() => {
    const shown = runs.filter((r) => archived === "all" || (archived === "only" ? !!r.organization.archivedAt : !r.organization.archivedAt));
    const byRepo = new Map<string, RunRow[]>();
    for (const r of [...shown].reverse()) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
    return [...byRepo.entries()];
  }, [runs, archived]);
  return (
    <aside className="w-72 shrink-0 border-r border-line bg-panel flex flex-col min-h-0 max-md:hidden">
      <div className="p-3 flex items-center gap-2 border-b border-line">
        <span className="font-semibold text-base flex-1">Rivet</span>
        <SplitButton />
        <button className="btn" title="Search history" aria-label="Search history" onClick={() => set({ screen: "search" })}><Search size={15} /></button>
        <button className="btn" title="Machine and recovery" aria-label="Machine and recovery" onClick={() => set({ screen: "health" })}><Activity size={15} /></button>
        <button className="btn" title="Settings" aria-label="Settings" onClick={() => set({ screen: "settings" })}><Settings size={15} /></button>
      </div>
      <div className="p-3 grid gap-2 border-b border-line">
        <button className="btn btn-primary justify-center" onClick={() => set({ screen: "new" })}><Plus size={15} /> New session</button>
        <div className="grid grid-cols-3 gap-1 text-xs">
          <button className="btn justify-center" onClick={() => set({ screen: "tasks" })}>Task file</button>
          <button className="btn justify-center" onClick={() => set({ screen: "cues" })}>Cues</button>
          <button className="btn justify-center" onClick={() => set({ screen: "automations" })}>Schedules</button>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2 grid grid-cols-[minmax(0,1fr)] gap-3 content-start" aria-label="Sessions">
        {projects.length === 0 && <p className="text-muted text-sm p-2">{archived === "only" ? "Nothing archived." : "No sessions yet. Start one above."}</p>}
        {projects.map(([path, rows]) => <Project key={path} path={path} rows={rows} current={path === repo} />)}
      </nav>
      <label className="p-2 border-t border-line text-xs text-muted flex items-center gap-2">Show
        <select className="field py-0.5" value={archived} onChange={(e) => setArchived(e.target.value as typeof archived)}>
          <option value="hide">active</option><option value="only">archived</option><option value="all">all</option>
        </select>
      </label>
    </aside>
  );
}

function Project({ path, rows, current }: { path: string; rows: RunRow[]; current: boolean }) {
  const groups = new Map<string, RunRow[]>();
  const known = new Set(rows.map((r) => `${r.id}-agent`));
  for (const r of rows) if (!r.orchestrator || !known.has(r.orchestrator)) {
    const g = r.organization.group;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  return (
    <section>
      <div title={path} className={`px-2 text-xs font-semibold truncate ${current ? "text-accent" : "text-muted"}`}>{repoName(path)}</div>
      {[...groups.entries()].map(([group, list]) => (
        <div key={group}>
          {group && <div className="px-2 mt-1 text-[11px] text-muted">{group}</div>}
          {list.map((r) => (
            <div key={r.id}>
              <Row r={r} depth={0} />
              {rows.filter((w) => w.orchestrator === `${r.id}-agent`).map((w) => <Row key={w.id} r={w} depth={1} />)}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function Home() {
  const { set } = useApp();
  return (
    <div className="flex-1 grid place-items-center p-6 text-center">
      <div className="grid gap-3 max-w-md justify-items-center">
        <Zap size={28} className="text-accent" />
        <h1 className="text-xl font-semibold">Pick a session, or start one</h1>
        <p className="text-muted">Each worker gets its own worktree and branch. Rivet checks its work before opening a pull request, and you merge.</p>
        <button className="btn btn-primary" onClick={() => set({ screen: "new" })}><Plus size={15} /> New session</button>
        <p className="text-xs text-muted">Ctrl+K opens every command.</p>
      </div>
    </div>
  );
}

export function App() {
  const { selected, beside, set, toast } = useApp();
  const [online, setOnline] = useState(true);
  const list = useLive(() => api<{ runs: RunRow[] }>("GET", "/runs"), []);
  useEffect(() => { if (list.data) set({ runs: list.data.runs }); }, [list.data]);
  useEffect(() => onConnection(setOnline), []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); set({ palette: !useApp.getState().palette }); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set("run", selected); else url.searchParams.delete("run");
    history.replaceState(null, "", url);
  }, [selected]);
  return (
    <div className="h-full flex flex-col">
      {!online && <div role="status" className="bg-danger text-white text-center text-sm py-1">Lost the daemon. Reconnecting… if this stays, run: rivet daemon start</div>}
      <div className="flex-1 flex min-h-0">
        <Sidebar />
        <main className="flex-1 flex min-w-0 min-h-0">
          {selected ? <Conversation key={selected} id={selected} /> : <Home />}
          {selected && beside && beside !== selected && <div className="flex-1 flex min-w-0 border-l border-line"><Conversation key={beside} id={beside} /></div>}
        </main>
      </div>
      <Screens /><AskDialog /><Palette />
      {toast && <div role="status" className={`fixed bottom-14 left-1/2 -translate-x-1/2 z-50 max-w-[90vw] rounded-md border border-line bg-panel px-3 py-2 shadow-lg ${toast.bad ? "text-danger" : ""}`}>{toast.text}</div>}
    </div>
  );
}
