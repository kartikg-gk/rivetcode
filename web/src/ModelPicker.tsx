import { ChevronDown, KeyRound, Search, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { act } from "./state";

// Claude takes these names; Codex's list is its own, so a name is typed there.
export const MODELS: Record<string, { label: string; value: string }[]> = {
  claude: [
    { label: "Claude Opus", value: "opus" }, { label: "Claude Sonnet", value: "sonnet" },
    { label: "Claude Fable", value: "fable" }, { label: "Claude Haiku", value: "haiku" },
  ],
  codex: [{ label: "Codex default", value: "" }],
  delta: [{ label: "Delta default", value: "" }],
};
const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", delta: "Delta" };

export function ProviderMark({ agent, size = 16 }: { agent: string; size?: number }) {
  if (agent === "delta") return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className="shrink-0" fill="none" stroke="#6ea8fe" strokeWidth="2.2" strokeLinejoin="round"><path d="M12 3 L21.5 20 H2.5 Z" /></svg>
  );
  if (agent === "claude") return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className="shrink-0">
      {Array.from({ length: 12 }, (_, i) => <line key={i} x1="12" y1="12" x2="12" y2={i % 2 ? 3.5 : 1.5} stroke="#d97757" strokeWidth="2.4" strokeLinecap="round" transform={`rotate(${i * 30} 12 12)`} />)}
    </svg>
  );
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7">
      {[0, 60, 120].map((r) => <ellipse key={r} cx="12" cy="12" rx="10" ry="4.2" transform={`rotate(${r} 12 12)`} />)}
    </svg>
  );
}

const key = (agent: string, model: string) => `${agent}:${model}`;
function loadStars(): string[] {
  try { return JSON.parse(localStorage.getItem("rivet.stars") ?? "[]") as string[]; } catch { return []; }
}

// Delta's models are the ones its own configured providers offer, read from delta itself.
function useDelta(project: string, wanted: boolean) {
  const [data, setData] = useState<{ providers: string[]; models: { provider: string; id: string }[] } | { error: string }>();
  const load = () => void api<{ providers: string[]; models: { provider: string; id: string }[] }>("GET", `/delta?project=${encodeURIComponent(project)}`).then(setData, (e: Error) => setData({ error: e.message }));
  useEffect(() => { if (wanted && !data) load(); }, [wanted]);
  return { data, reload: load };
}

function DeltaKey({ providers, saved }: { providers: string[]; saved(): void }) {
  const [provider, setProvider] = useState(providers[0] ?? "");
  const [key, setKey] = useState("");
  return (
    <form className="border-t border-line p-2 grid gap-2" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api("POST", "/delta/key", { provider, key }); setKey(""); saved(); }, `saved ${provider} key in delta`); }}>
      <div className="flex items-center gap-1.5 text-xs text-muted"><KeyRound size={12} />API key, kept by delta in its own config</div>
      <div className="flex gap-1">
        <select aria-label="Provider" className="field w-auto py-1" value={provider} onChange={(e) => setProvider(e.target.value)}>{providers.map((p) => <option key={p}>{p}</option>)}</select>
        <input aria-label="API key" type="password" autoComplete="off" spellCheck={false} className="field py-1" placeholder="paste key" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn" disabled={!key.trim() || !provider}>Save</button>
      </div>
    </form>
  );
}

export function ModelPicker({ project, agent, model, pick }: { project: string; agent: string; model: string; pick(agent: string, model: string): void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<string>(agent);
  const [stars, setStars] = useState(loadStars);
  const box = useRef<HTMLDivElement>(null);
  const delta = useDelta(project, open && tab === "delta");
  const deltaModels = delta.data && "models" in delta.data ? delta.data.models.map((m) => ({ label: m.id, value: `${m.provider}/${m.id}`, sub: m.provider })) : [];
  const all = Object.entries(MODELS).flatMap(([a, list]) => [...list, ...(a === "delta" ? deltaModels : [])].map((m) => ({ ...m, agent: a })));
  const current = all.find((m) => m.agent === agent && m.value === model);
  const choose = (a: string, m: string) => { pick(a, m); setQ(""); setOpen(false); };
  useEffect(() => {
    // Ctrl+1..4 picks from the open list, as the list's hints say.
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      const n = Number(e.key);
      if (open && e.ctrlKey && n >= 1 && n <= 9 && shown[n - 1]) { e.preventDefault(); choose(shown[n - 1]!.agent, shown[n - 1]!.value); }
    };
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", keys);
    window.addEventListener("mousedown", away);
    return () => { window.removeEventListener("keydown", keys); window.removeEventListener("mousedown", away); };
  });
  const toggleStar = (k: string) => {
    const next = stars.includes(k) ? stars.filter((s) => s !== k) : [...stars, k];
    setStars(next);
    try { localStorage.setItem("rivet.stars", JSON.stringify(next)); } catch { /* optional */ }
  };
  const pool = tab === "starred" ? all.filter((m) => stars.includes(key(m.agent, m.value))) : all.filter((m) => m.agent === tab);
  const shown = pool.filter((m) => m.label.toLowerCase().includes(q.toLowerCase()));
  const typed = q.trim();
  const target = tab === "starred" ? agent : tab;
  const rail = (id: string, label: string, mark: React.ReactNode) => (
    <button key={id} title={label} aria-label={label} aria-pressed={tab === id} onClick={() => setTab(id)}
      className={`relative grid place-items-center size-10 rounded-lg cursor-pointer hover:bg-raised ${tab === id ? "bg-raised" : "text-muted"}`}>
      {mark}{tab === id && <span className="absolute -right-1 top-2 bottom-2 w-0.5 rounded bg-accent" />}
    </button>
  );
  return (
    <div className="relative" ref={box}>
      <button className="pill" aria-expanded={open} onClick={() => { setTab(agent); setOpen(!open); }}>
        <ProviderMark agent={agent} size={15} />{current?.label ?? (model || `${NAMES[agent]} default`)}<ChevronDown size={13} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 w-[22rem] max-w-[90vw] rounded-xl border border-line bg-panel shadow-xl flex overflow-hidden">
          <div className="grid content-start gap-1 p-1.5 border-r border-line">
            {rail("starred", "Starred", <Star size={17} />)}
            {Object.keys(MODELS).map((a) => rail(a, NAMES[a]!, <ProviderMark agent={a} size={19} />))}
          </div>
          <div className="flex-1 min-w-0">
            <label className="flex items-center gap-2 px-3 py-2.5 border-b border-line"><Search size={14} className="text-muted" />
              <input autoFocus aria-label="Search or type a model" className="bg-transparent outline-none w-full" placeholder="Search models…" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <ul className="max-h-72 overflow-y-auto p-1">
              {tab === "starred" && shown.length === 0 && <li className="px-3 py-3 text-sm text-muted">Star a model to keep it here.</li>}
              {shown.map((m, i) => {
                const k = key(m.agent, m.value);
                return (
                  <li key={k} className={`group flex items-center gap-2 rounded-lg px-2 hover:bg-raised ${m.agent === agent && m.value === model ? "bg-raised" : ""}`}>
                    <button className="flex-1 min-w-0 text-left py-1.5 cursor-pointer" onClick={() => choose(m.agent, m.value)}>
                      <div className="font-medium truncate">{m.label}</div>
                      <div className="flex items-center gap-1.5 text-xs text-muted"><ProviderMark agent={m.agent} size={12} />{NAMES[m.agent]}{"sub" in m && m.sub ? ` · ${m.sub}` : ""}</div>
                    </button>
                    {i < 9 && <kbd className="text-[11px] text-muted border border-line rounded px-1">Ctrl+{i + 1}</kbd>}
                    <button className={`cursor-pointer p-1 ${stars.includes(k) ? "text-warn" : "text-muted"}`} aria-label={stars.includes(k) ? "Unstar" : "Star"} onClick={() => toggleStar(k)}>
                      <Star size={14} fill={stars.includes(k) ? "currentColor" : "none"} />
                    </button>
                  </li>
                );
              })}
              {typed && !shown.some((m) => m.value === typed) && (
                <li><button className="w-full text-left rounded-lg px-2 py-2 cursor-pointer hover:bg-raised flex items-center gap-2" onClick={() => choose(target, typed)}>
                  <ProviderMark agent={target} size={14} />Use "{typed}" with {NAMES[target]}
                </button></li>
              )}
            </ul>
            {tab === "delta" && !delta.data && <p className="px-3 pb-2 text-xs text-muted">Asking delta for its models…</p>}
            {tab === "delta" && delta.data && "error" in delta.data && <p className="px-3 pb-2 text-xs text-danger">{delta.data.error}</p>}
            {tab === "delta" && delta.data && "providers" in delta.data && delta.data.providers.length > 0 && <DeltaKey providers={delta.data.providers} saved={delta.reload} />}
          </div>
        </div>
      )}
    </div>
  );
}
