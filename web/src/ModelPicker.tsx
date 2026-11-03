import { ChevronDown, Search, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// Claude takes these names; Codex's list is its own, so a name is typed there.
export const MODELS: Record<string, { label: string; value: string }[]> = {
  claude: [
    { label: "Claude Opus", value: "opus" }, { label: "Claude Sonnet", value: "sonnet" },
    { label: "Claude Fable", value: "fable" }, { label: "Claude Haiku", value: "haiku" },
  ],
  codex: [{ label: "Codex default", value: "" }],
};
const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

export function ProviderMark({ agent, size = 16 }: { agent: string; size?: number }) {
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

export function ModelPicker({ agent, model, pick }: { agent: string; model: string; pick(agent: string, model: string): void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<string>(agent);
  const [stars, setStars] = useState(loadStars);
  const box = useRef<HTMLDivElement>(null);
  const all = Object.entries(MODELS).flatMap(([a, list]) => list.map((m) => ({ ...m, agent: a })));
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
                      <div className="flex items-center gap-1.5 text-xs text-muted"><ProviderMark agent={m.agent} size={12} />{NAMES[m.agent]}</div>
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
          </div>
        </div>
      )}
    </div>
  );
}
