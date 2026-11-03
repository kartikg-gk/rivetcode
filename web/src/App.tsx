import { Activity, Archive, BarChart2, ChevronDown, ChevronUp, Clock, Columns2, FileText, MessageSquarePlus, PanelLeft, Search, Settings, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, onConnection, type RunRow } from "./api";
import { Conversation } from "./Conversation";
import { Home } from "./Home";
import { AskDialog, Palette, Screens } from "./Screens";
import { ago, repoName, runLabel, useApp, useLive } from "./state";

const DOT: Record<string, string> = { active: "bg-accent", blocked: "bg-warn", waiting_input: "bg-warn", idle: "bg-muted", exited: "bg-line" };

const snoozed = (r: RunRow) => !!r.organization.snoozedUntil && Date.parse(r.organization.snoozedUntil) > Date.now();

function Card({ r, depth }: { r: RunRow; depth: number }) {
  const { selected, set } = useApp();
  const color = r.needsAnswer ? "bg-warn" : DOT[r.activity ?? "idle"] ?? "bg-muted";
  return (
    <button onClick={() => set({ selected: r.id })} style={{ marginLeft: depth * 12 }}
      className={`text-left rounded-xl px-3 py-2 grid gap-0.5 cursor-pointer hover:bg-raised ${selected === r.id ? "bg-raised" : ""}`}>
      <span className="flex items-center gap-2 text-xs text-muted min-w-0">
        <span aria-hidden className={`size-1.5 rounded-full shrink-0 ${color}`} />
        <span className="truncate">{repoName(r.repo)}{r.organization.group ? ` · ${r.organization.group}` : ""}</span>
        <span className="ml-auto shrink-0">{r.needsAnswer ? <span className="text-warn">question</span> : r.live && r.organization.busy ? <span className="text-accent">{r.organization.busy}</span> : r.role === "orchestrator" ? "orchestrator" : ""}</span>
      </span>
      <span className={`truncate flex items-center gap-1.5 ${r.organization.unread ? "font-semibold" : "font-medium"}`}>{r.organization.unread && <span aria-label="unread" className="size-1.5 rounded-full bg-accent shrink-0" />}{runLabel(r)}</span>
    </button>
  );
}

function Sidebar({ close }: { close(): void }) {
  const { runs, selected, beside, set } = useApp();
  const [archived, setArchived] = useState(false);
  const [settledOpen, setSettledOpen] = useState(true);
  const { active, settled, pinned, sleeping } = useMemo(() => {
    const all = [...runs].reverse().filter((r) => !!r.organization.archivedAt === archived);
    const pinned = all.filter((r) => r.organization.pinnedAt && !snoozed(r));
    const sleeping = all.filter(snoozed);
    const shown = all.filter((r) => !r.organization.pinnedAt && !snoozed(r));
    const ids = new Set(shown.map((r) => `${r.id}-agent`));
    const tops = shown.filter((r) => !r.orchestrator || !ids.has(r.orchestrator));
    const going = (r: RunRow) => r.live || r.needsAnswer || shown.some((w) => w.orchestrator === `${r.id}-agent` && w.live);
    return { active: tops.filter(going), settled: tops.filter((r) => !going(r)), pinned, sleeping };
  }, [runs, archived]);
  const workers = (r: RunRow) => runs.filter((w) => w.orchestrator === `${r.id}-agent` && !!w.organization.archivedAt === archived);
  const split = () => set({ ask: {
    title: "Show side by side", confirm: "Show",
    fields: [{ name: "run", label: "Session", type: "select", value: beside ?? "", options: ["", ...runs.filter((r) => r.id !== selected).map((r) => r.id)], hint: "Empty closes the second column." }],
    run: async (v) => { set({ beside: v.run || null }); },
  } });
  const icon = (label: string, Icon: typeof Search, run: () => void, on = false) => (
    <button className={`icon ${on ? "text-fg bg-raised" : ""}`} title={label} aria-label={label} aria-pressed={on} onClick={run}><Icon size={16} /></button>
  );
  return (
    <aside className="w-72 shrink-0 border-r border-line bg-panel flex flex-col min-h-0 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:shadow-xl">
      <div className="h-11 px-2 flex items-center gap-2">
        {icon("Hide sidebar", PanelLeft, close)}
        <span className="font-semibold">Rivet</span>
      </div>
      <div className="px-2 pb-2 flex items-center gap-1">
        <button className="flex-1 flex items-center gap-2 px-2 py-1.5 text-muted cursor-pointer hover:text-fg" onClick={() => set({ screen: "search" })}><Search size={16} /> Search</button>
        {icon("Side by side", Columns2, split)}
        {icon("New thread", MessageSquarePlus, () => set({ selected: null, beside: null }))}
      </div>
      <nav className="flex-1 overflow-y-auto p-2 grid grid-cols-[minmax(0,1fr)] gap-1 content-start" aria-label="Sessions">
        {pinned.length > 0 && <div className="px-2 pt-1 text-xs text-muted">Pinned</div>}
        {pinned.map((r) => <Card key={r.id} r={r} depth={0} />)}
        {pinned.length > 0 && active.length > 0 && <div className="px-2 pt-2 text-xs text-muted">Active</div>}
        {active.length === 0 && settled.length === 0 && pinned.length === 0 && <p className="text-muted text-sm p-2">{archived ? "Nothing archived." : "No threads yet."}</p>}
        {active.flatMap((r) => [<Card key={r.id} r={r} depth={0} />, ...workers(r).map((w) => <Card key={w.id} r={w} depth={1} />)])}
      </nav>
      {sleeping.length > 0 && <details className="px-4 text-xs text-muted"><summary className="cursor-pointer py-1">Snoozed ({sleeping.length})</summary>
        <ul>{sleeping.map((r) => <li key={r.id}><button className="w-full text-left py-1 truncate cursor-pointer hover:text-fg" onClick={() => set({ selected: r.id })}>{runLabel(r)} · until {new Date(r.organization.snoozedUntil!).toLocaleString()}</button></li>)}</ul>
      </details>}
      {settled.length > 0 && (
        <section className="max-h-[40%] flex flex-col min-h-0 px-2">
          <button className="flex items-center gap-2 px-2 py-1 text-xs text-muted cursor-pointer" aria-expanded={settledOpen} onClick={() => setSettledOpen(!settledOpen)}>
            {archived ? "Archived" : "Settled"}<span className="flex-1 border-t border-line" />{settledOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {settledOpen && <ul className="overflow-y-auto min-h-0">{settled.flatMap((r) => [r, ...workers(r)]).map((r) => (
            <li key={r.id}><button onClick={() => set({ selected: r.id })} className={`w-full text-left px-2 py-1.5 rounded-lg flex gap-2 cursor-pointer text-muted hover:bg-raised ${selected === r.id ? "bg-raised text-fg" : ""}`}>
              <span className={`truncate flex-1 ${r.organization.unread ? "font-semibold text-fg" : ""}`}>{runLabel(r)}</span><span className="text-xs shrink-0">{ago(r.createdAt)}</span>
            </button></li>
          ))}</ul>}
        </section>
      )}
      <div className="p-2 flex items-center gap-1">
        {icon("Settings", Settings, () => set({ screen: "settings" }))}
        {icon("Machine and recovery", Activity, () => set({ screen: "health" }))}
        {icon("Conflicts between workers", BarChart2, () => set({ screen: "radar" }))}
        {icon("Cues", Sparkles, () => set({ screen: "cues" }))}
        {icon("Schedules", Clock, () => set({ screen: "automations" }))}
        {icon("Task file", FileText, () => set({ screen: "tasks" }))}
        {icon(archived ? "Show active" : "Show archived", Archive, () => setArchived(!archived), archived)}
      </div>
    </aside>
  );
}

export function App() {
  const { selected, beside, set, toast } = useApp();
  const [online, setOnline] = useState(true);
  const [sidebar, setSidebar] = useState(() => innerWidth >= 768);
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
        {sidebar ? <Sidebar close={() => setSidebar(false)} /> : (
          <div className="w-11 shrink-0 border-r border-line bg-panel p-1"><button className="icon" title="Show sidebar" aria-label="Show sidebar" onClick={() => setSidebar(true)}><PanelLeft size={16} /></button></div>
        )}
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
