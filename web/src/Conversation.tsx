import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { MoreHorizontal, Pencil, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import { send, sessionActions, type Action } from "./actions";
import { api, openTerminal, runPath, type Item, type Page, type RunDetail } from "./api";
import { act, runLabel, toast, useApp, useLive } from "./state";

const SIDE_TABS = ["details", "changes", "terminal", "events", "raw", "branches", "provider"] as const;
type Side = (typeof SIDE_TABS)[number];

// The whole history, then only what can have changed: from the first reply still being written.
function useTimeline(id: string, activity: boolean, session: string) {
  const [items, setItems] = useState<Item[]>([]);
  const known = useRef<Item[]>([]);
  const q = (after: number) => `/timeline?after=${after}&limit=100&maxChars=50000&session=${session}${activity ? "&view=activity" : ""}`;
  const { error, reload } = useLive(async () => {
    const anchor = known.current.find((i) => i.streaming) ?? known.current.at(-1);
    let after = anchor ? anchor.position - 1 : 0;
    let page = await api<Page>("GET", runPath(id, q(after)));
    // A rollback, an edit or a restored branch replaces the history; start again.
    if (anchor && (page.items[0]?.position !== anchor.position || page.items[0].at !== anchor.at)) {
      known.current = []; after = 0;
      page = await api<Page>("GET", runPath(id, q(0)));
    }
    const merged = known.current.filter((i) => i.position <= after);
    for (;;) {
      merged.push(...page.items);
      if (page.next === undefined || merged.length >= 3000) break;
      page = await api<Page>("GET", runPath(id, q(page.next)));
    }
    known.current = merged;
    setItems(merged);
  }, [id, activity, session]);
  useEffect(() => () => { known.current = []; }, [id, activity, session]);
  return { items, error, reload };
}

const WHO: Record<string, string> = { prompt: "Task", message: "You", assistant: "Agent", tool: "Tool", result: "Result", event: "Event" };

function Entry({ item, id, canEdit, canFork }: { item: Item; id: string; canEdit: boolean; canFork: boolean }) {
  const [full, setFull] = useState<string>();
  const set = useApp((s) => s.set);
  const text = full ?? item.text;
  const showAll = () => void act(async () => {
    let out = item.text; let offset = item.nextTextOffset ?? null;
    while (offset !== null) {
      const page = await api<Page>("GET", runPath(id, `/timeline?item=${item.position}&textOffset=${offset}&maxChars=50000`));
      out += page.items[0]!.text; offset = page.items[0]!.nextTextOffset ?? null;
    }
    setFull(out);
  });
  const edit = () => set({ ask: {
    title: "Edit this message", note: "Continues on a new branch from here. Files are not restored; the old branch is kept.", confirm: "Send", danger: true,
    fields: [{ name: "message", label: "Message", type: "textarea", value: text }],
    run: (v) => api("POST", runPath(id, "/edit"), { at: item.position, message: v.message }),
  } });
  const fork = () => void act(async () => {
    const r = await api<{ runId?: string; id?: string }>("POST", runPath(id, "/fork"), { at: item.position });
    const next = r.runId ?? r.id;
    if (next) set({ selected: next });
  }, "forked");
  if (item.kind === "tool" || item.kind === "result" || item.kind === "event") {
    return (
      <details className="border-l-2 border-line pl-3 text-[13px]">
        <summary className="cursor-pointer text-muted truncate">{WHO[item.kind]}{item.tool ? ` · ${item.tool}` : ""} · {text.split("\n")[0]?.slice(0, 100)}</summary>
        <pre className="mono whitespace-pre-wrap break-words mt-1 text-xs max-h-96 overflow-y-auto">{text}</pre>
      </details>
    );
  }
  const mine = item.kind === "message" || item.kind === "prompt";
  return (
    <article className={`group grid gap-1 ${mine ? "rounded-lg bg-raised px-3 py-2" : ""}`}>
      <header className="flex items-center gap-2 text-xs text-muted">
        <span className="font-medium">{WHO[item.kind] ?? item.kind}</span><span>#{item.position}</span>
        {item.streaming && <span className="text-accent">writing…</span>}
        <span className="ml-auto flex gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          {canEdit && mine && <button className="cursor-pointer inline-flex items-center gap-1" onClick={edit}><Pencil size={11} /> Edit</button>}
          {canFork && <button className="cursor-pointer" onClick={fork}>Fork here</button>}
        </span>
      </header>
      {/* Agent text is data: markdown renders without raw HTML. */}
      {mine ? <div className="whitespace-pre-wrap break-words">{text}</div>
        : <div className="prose-agent"><Markdown components={{ a: (p) => <a href={p.href} target="_blank" rel="noreferrer noopener">{p.children}</a> }}>{text}</Markdown></div>}
      {item.nextTextOffset != null && full === undefined && <button className="btn justify-self-start text-xs" onClick={showAll}>Show all ({item.cut?.length} characters)</button>}
    </article>
  );
}

function Question({ id, request }: { id: string; request: NonNullable<RunDetail["pendingRequest"]> }) {
  const [note, setNote] = useState("");
  const answer = (choice: string) => void act(() => api("POST", runPath(id, "/answer"), { choice, ...(note ? { note } : {}) }), "answered");
  return (
    <section role="alert" className="border border-warn rounded-lg p-3 grid gap-2 m-3 mb-0">
      <div className="font-medium">The agent is asking to use {request.tool}</div>
      {request.detail && <pre className="mono text-xs whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{request.detail}</pre>}
      <input className="field" placeholder="Note to the agent (optional)" aria-label="Note to the agent" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={() => answer("yes")}>Allow once</button>
        <button className="btn" onClick={() => answer("always")}>Always allow</button>
        <button className="btn btn-danger" onClick={() => answer("no")}>Refuse</button>
      </div>
    </section>
  );
}

function Composer({ id, actions, openSide }: { id: string; actions: Action[]; openSide(t: Side): void }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState("steer");
  const [pick, setPick] = useState(0);
  const set = useApp((s) => s.set);
  const extra: Action[] = useMemo(() => [
    ...SIDE_TABS.map((t) => ({ id: t, label: t, about: `show ${t}`, run: () => openSide(t) })),
    { id: "worker", label: "worker", about: "start a new worker", args: "", run: () => set({ screen: "new" }) },
    { id: "search", label: "search", about: "search every session's history", run: () => set({ screen: "search" }) },
    { id: "cues", label: "cues", about: "saved prompts and commands", run: () => set({ screen: "cues" }) },
    { id: "radar", label: "radar", about: "conflicts between workers", run: () => set({ screen: "radar" }) },
    { id: "doctor", label: "doctor", about: "check what Rivet needs on this machine", run: () => set({ screen: "health" }) },
  ], []);
  const all = [...actions, ...extra];
  const head = text.startsWith("/") ? text.slice(1).split(/\s/)[0]!.toLowerCase() : null;
  const menu = head !== null && !/\s/.test(text) ? all.filter((a) => a.id.startsWith(head)) : [];
  const submit = () => {
    const value = text.trim();
    if (!value) return;
    if (value.startsWith("/")) {
      const found = all.find((a) => a.id === head) ?? menu[pick];
      if (!found) { toast(`no command /${head}; type / to see them`, true); return; }
      setText("");
      found.run(value.slice(head!.length + 1));
      return;
    }
    void act(async () => {
      const delivery = await send(id, value, mode);
      setText("");
      if (delivery !== "now") toast({ "when-idle": "queued until it is idle", "turn-end": "delivered when this turn ends", "next-launch": "delivered at its next start", "after-answer": "delivered after its question is answered", interrupted: "interrupted and sent" }[delivery] ?? delivery);
    });
  };
  const key = (e: KeyboardEvent) => {
    if (menu.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setPick((pick + 1) % menu.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPick((pick - 1 + menu.length) % menu.length); return; }
      if (e.key === "Tab") { e.preventDefault(); setText(`/${menu[pick]?.id ?? menu[0]!.id} `); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };
  return (
    <div className="p-3 relative">
      {menu.length > 0 && (
        <ul role="listbox" aria-label="Commands" className="absolute bottom-full left-3 right-3 mb-1 max-h-72 overflow-y-auto rounded-lg border border-line bg-panel shadow-lg z-20">
          {menu.map((a, i) => (
            <li key={a.id} role="option" aria-selected={i === pick % menu.length}>
              <button className={`w-full text-left px-3 py-1.5 cursor-pointer flex gap-3 hover:bg-raised ${i === pick % menu.length ? "bg-raised" : ""}`} onClick={() => { setText(""); a.run(""); }}>
                <span className="mono shrink-0">/{a.id}{a.args ? ` ${a.args}` : ""}</span><span className="text-muted truncate">{a.about}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-lg border border-line bg-panel p-2 grid gap-2">
        <textarea aria-label="Message to this session" rows={2} className="w-full bg-transparent resize-y outline-none" placeholder="Message this session, or / for commands"
          value={text} onChange={(e) => { setText(e.target.value); setPick(0); }} onKeyDown={key} />
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted flex items-center gap-1">Deliver
            <select className="field py-0.5 w-auto" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="steer">as soon as it can take it</option><option value="queue">once idle</option><option value="interrupt">stop its turn first</option>
            </select>
          </label>
          <button className="btn btn-primary ml-auto" disabled={!text.trim()} onClick={submit}><Send size={14} /> Send</button>
        </div>
      </div>
    </div>
  );
}

function TerminalPane({ id, session }: { id: string; session: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string>();
  useEffect(() => {
    setNote(undefined);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const term = new Terminal({ fontSize: 13, convertEol: false, theme: dark ? { background: "#101416" } : { background: "#ffffff", foreground: "#1a1f23", cursor: "#1a1f23" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    const link = openTerminal(`${id}-${session}`, (m) => {
      if (m.type === "output") term.write(m.data);
      else if (m.type === "exit") setNote("This terminal has ended.");
      else if (m.type === "error") setNote(m.error);
    });
    const resize = () => { try { fit.fit(); link.resize(term.cols, term.rows); } catch { /* hidden */ } };
    const typing = term.onData((d) => link.input(d));
    const seen = new ResizeObserver(resize);
    seen.observe(host.current!);
    resize();
    return () => { seen.disconnect(); typing.dispose(); link.close(); term.dispose(); };
  }, [id, session]);
  return (
    <div className="h-full flex flex-col min-h-0">
      {note && <p className="p-2 text-sm text-muted">{note}</p>}
      <div ref={host} className="flex-1 min-h-0 p-1" aria-label="Terminal" />
    </div>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return v === undefined || v === "" || v === null ? null : <div className="grid grid-cols-[110px_1fr] gap-2"><dt className="text-muted">{k}</dt><dd className="break-words min-w-0">{v}</dd></div>;
}

function Details({ d }: { d: RunDetail }) {
  const n = d.run.node;
  const c = d.chatUsage;
  return (
    <dl className="p-3 grid gap-1.5 text-[13px]">
      <Fact k="Status" v={`${n.status}${n.activity ? ` · ${n.activity}` : ""}${d.live ? "" : " · not running"}`} />
      <Fact k="Summary" v={n.summary} />
      <Fact k="Role" v={d.run.role} />
      <Fact k="Agent" v={`${n.agent}${d.run.model ? ` (${d.run.model})` : ""}`} />
      <Fact k="Mode" v={n.sessionMode ?? "terminal"} />
      <Fact k="Attempts" v={n.attempts} />
      <Fact k="Branch" v={<code className="mono">{n.branch}</code>} />
      <Fact k="Base" v={d.run.base} />
      <Fact k="Worktree" v={<code className="mono text-xs">{n.worktree}</code>} />
      <Fact k="Issue" v={d.run.issue ? `#${d.run.issue}` : undefined} />
      <Fact k="Pull request" v={d.pr ? <a className="text-accent underline" target="_blank" rel="noreferrer noopener" href={d.pr.url}>#{d.pr.number}{n.prStatus ? ` · ${n.prStatus}` : ""}</a> : undefined} />
      <Fact k="On merge" v={d.terminateOnPrMerge ? "end the run" : "keep it"} />
      <Fact k="Tokens" v={c ? `${c.input.toLocaleString()} in, ${c.output.toLocaleString()} out, ${c.cached.toLocaleString()} cached` : d.usage.conversations ? `${d.usage.inputEquivalent.toLocaleString()} input-equivalent` : undefined} />
      <Fact k="Context" v={c?.contextUsed && c.contextWindow ? `${Math.round(100 * c.contextUsed / c.contextWindow)}% of ${c.contextWindow.toLocaleString()}` : undefined} />
      <Fact k="Fork of" v={d.fork ? `${d.fork.sourceRun} at #${d.fork.position} (${d.fork.strategy}${d.fork.detached ? ", detached" : ""})` : undefined} />
      <Fact k="Limits" v={d.run.spec ? <code className="mono text-xs">{JSON.stringify(d.run.spec)}</code> : undefined} />
      <Fact k="Task" v={<span className="whitespace-pre-wrap">{d.run.task}</span>} />
      {d.reviews.length > 0 && <Fact k="Reviews" v={d.reviews.map((r) => <div key={r.id}>{r.verdict ?? r.status ?? "running"} · {r.sha.slice(0, 7)} · {r.trigger}{r.summary ? ` · ${r.summary}` : ""}</div>)} />}
    </dl>
  );
}

function Changes({ id }: { id: string }) {
  const { data, error } = useLive(() => api<{ available: boolean; diff: string; stat: string; untracked: string[]; cut: boolean }>("GET", runPath(id, "/diff")), [id]);
  if (error) return <p className="p-3 text-danger">{error}</p>;
  if (!data) return <p className="p-3 text-muted">Loading…</p>;
  if (!data.available) return <p className="p-3 text-muted">This run's worktree has been removed.</p>;
  if (!data.diff && data.untracked.length === 0) return <p className="p-3 text-muted">No changes from its base yet.</p>;
  return (
    <div className="p-3 grid gap-3 text-xs">
      {data.untracked.length > 0 && <div><div className="font-medium">New, not yet added</div><pre className="mono whitespace-pre-wrap">{data.untracked.join("\n")}</pre></div>}
      <pre className="mono whitespace-pre-wrap text-muted">{data.stat}</pre>
      <pre className="mono overflow-x-auto">{data.diff.split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("diff ") ? "diff-file mt-3" : l.startsWith("@@") ? "diff-hunk" : l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : ""}>{l || " "}</div>
      ))}</pre>
      {data.cut && <p className="text-warn">Too long to show in full.</p>}
    </div>
  );
}

function Lines({ id, tail, field }: { id: string; tail: string; field: string }) {
  const { data, error } = useLive(() => api<Record<string, unknown[]>>("GET", runPath(id, tail)), [id, tail]);
  if (error) return <p className="p-3 text-muted">{error}</p>;
  const rows = data?.[field] ?? [];
  return rows.length === 0 ? <p className="p-3 text-muted">{data ? "Nothing recorded." : "Loading…"}</p>
    : <pre className="mono p-3 text-xs whitespace-pre-wrap break-words">{rows.map((r) => JSON.stringify(r)).join("\n")}</pre>;
}

function Branches({ id }: { id: string }) {
  const branches = useLive(() => api<{ branches: { id: string; parent: string | null; active?: boolean; agent?: string; strategy?: string }[] }>("GET", runPath(id, "/branches")), [id]);
  const transfers = useLive(() => api<{ transfers: { id: string; sourceRun: string; targetRun: string; through: number; delivery: string }[] }>("GET", runPath(id, "/transfers")), [id]);
  return (
    <div className="p-3 grid gap-3 text-[13px]">
      <h3 className="font-medium">Conversation branches</h3>
      {branches.error && <p className="text-muted">{branches.error}</p>}
      {branches.data?.branches.length === 0 && <p className="text-muted">Only one line so far.</p>}
      {branches.data?.branches.map((b) => (
        <div key={b.id} className="flex items-center gap-2">
          <code className="mono text-xs truncate flex-1">{b.id}</code><span className="text-muted">{b.agent}</span>
          {b.active ? <span className="text-accent">current</span>
            : <button className="btn" onClick={() => void act(() => api("POST", runPath(id, "/branches"), { branch: b.id }), "branch restored")}>Restore</button>}
        </div>
      ))}
      <h3 className="font-medium">Context transfers</h3>
      {transfers.data?.transfers.length === 0 && <p className="text-muted">None.</p>}
      {transfers.data?.transfers.map((t) => <div key={t.id}>{t.sourceRun} to {t.targetRun} through #{t.through}: {t.delivery}</div>)}
    </div>
  );
}

function Provider({ id }: { id: string }) {
  const [data, setData] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="p-3 grid gap-2">
      <p className="text-muted text-[13px]">Asks the agent for its current models, capabilities and quota. Starts the agent's protocol briefly.</p>
      <button className="btn justify-self-start" disabled={busy} onClick={() => { setBusy(true); void act(async () => setData(await api("GET", runPath(id, "/provider")))).finally(() => setBusy(false)); }}>{busy ? "Asking…" : "Ask the agent"}</button>
      {data !== undefined && <pre className="mono text-xs whitespace-pre-wrap break-words">{JSON.stringify(data, null, 2)}</pre>}
    </div>
  );
}

export function Conversation({ id }: { id: string }) {
  const { data: d, error } = useLive(() => api<RunDetail>("GET", runPath(id)), [id]);
  // A terminal session records its steps but few words, so its steps show unless turned off.
  const [picked, setActivity] = useState<boolean | null>(null);
  const activity = picked ?? (!!d && d.run.node.sessionMode !== "chat");
  const [session, setSession] = useState("agent");
  const [side, setSide] = useState<Side | null>(null);
  const [menu, setMenu] = useState(false);
  const { set } = useApp();
  const { items, error: readError } = useTimeline(id, activity, session);
  const list = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    if (d?.terminal) setSide((s) => s ?? "terminal");
  }, [d?.terminal]);
  useEffect(() => { if (stuck.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [items]);
  const actions = useMemo(() => sessionActions(id, d), [id, d?.run.node.sessionMode, d?.run.role, d?.terminateOnPrMerge, d?.run.node.agent, d?.run.name]);
  if (error) return (
    <div className="flex-1 grid place-items-center p-6 text-center"><div className="grid gap-2 justify-items-center"><p>{error}</p><button className="btn" onClick={() => set({ selected: null })}>Back</button></div></div>
  );
  const chat = d?.run.node.sessionMode === "chat";
  return (
    <div className="flex-1 flex min-w-0 min-h-0">
      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="px-3 py-2 border-b border-line flex items-center gap-2 flex-wrap relative">
          <div className="min-w-0 flex-1">
            <h2 className="font-medium truncate">{d ? runLabel({ id, name: d.run.name, task: d.run.task }) : id}</h2>
            <div className="text-xs text-muted truncate">{d ? `${d.run.role} · ${d.run.node.agent} · ${d.run.node.status}${d.run.node.activity ? ` · ${d.run.node.activity}` : ""}` : "Loading…"}</div>
          </div>
          <label className="text-xs text-muted flex items-center gap-1"><input type="checkbox" checked={activity} onChange={(e) => setActivity(e.target.checked)} /> Tools</label>
          <select aria-label="Which agent's record" className="field py-0.5 w-auto text-xs" value={session} onChange={(e) => setSession(e.target.value)}>
            <option value="agent">agent</option><option value="review">reviewer</option><option value="partner">partner</option>
          </select>
          <select aria-label="Side panel" className="field py-0.5 w-auto text-xs" value={side ?? ""} onChange={(e) => setSide((e.target.value || null) as Side | null)}>
            <option value="">no panel</option>{SIDE_TABS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="btn" aria-label="Session actions" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={15} /></button>
          {menu && (
            <ul className="absolute right-3 top-full mt-1 z-30 w-72 rounded-lg border border-line bg-panel shadow-lg py-1 max-h-[70vh] overflow-y-auto">
              {actions.map((a) => (
                <li key={a.id}><button title={a.about} className="w-full text-left px-3 py-1.5 cursor-pointer hover:bg-raised" onClick={() => { setMenu(false); a.run(""); }}>
                  <div>{a.label}</div><div className="text-xs text-muted truncate">{a.about}</div>
                </button></li>
              ))}
            </ul>
          )}
        </header>
        {d && !chat && d.run.node.agent === "claude" && <p className="px-3 py-1 text-xs text-muted border-b border-line">In a terminal, only Claude's last reply per turn is recorded, and none if it reports done first. The terminal panel has everything while it runs.</p>}
        <div ref={list} onScroll={(e) => { const t = e.currentTarget; stuck.current = t.scrollHeight - t.scrollTop - t.clientHeight < 60; }} className="flex-1 overflow-y-auto p-4 grid grid-cols-[minmax(0,1fr)] gap-4 content-start" aria-live="off">
          {readError && <p className="text-danger">{readError}</p>}
          {items.length === 0 && !readError && <p className="text-muted">Nothing recorded yet.</p>}
          {items.map((i) => <Entry key={`${i.position}-${i.at}`} item={i} id={id} canEdit={chat && session === "agent"} canFork={session === "agent"} />)}
        </div>
        {d?.pendingRequest && <Question id={id} request={d.pendingRequest} />}
        <Composer id={id} actions={actions} openSide={(t) => setSide(t)} />
      </section>
      {side && (
        <aside className="w-[46%] max-w-[760px] min-w-[320px] border-l border-line bg-panel flex flex-col min-h-0 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(92vw,560px)]">
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line flex-wrap">
            {SIDE_TABS.map((t) => <button key={t} onClick={() => setSide(t)} className={`px-2 py-0.5 rounded cursor-pointer capitalize text-[13px] ${side === t ? "bg-raised" : "text-muted"}`}>{t}</button>)}
            <button className="ml-auto cursor-pointer text-muted" aria-label="Close panel" onClick={() => setSide(null)}><X size={15} /></button>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            {side === "details" && d && <Details d={d} />}
            {side === "changes" && <Changes id={id} />}
            {side === "terminal" && <TerminalPane id={id} session={session} />}
            {side === "events" && <Lines id={id} tail="/events?limit=500" field="events" />}
            {side === "raw" && <Lines id={id} tail="/provider-events?limit=500" field="lines" />}
            {side === "branches" && <Branches id={id} />}
            {side === "provider" && <Provider id={id} />}
          </div>
        </aside>
      )}
    </div>
  );
}

