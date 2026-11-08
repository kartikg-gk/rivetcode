import { TerminalPane } from "./TerminalPane";
import { WorkspacePane } from "./WorkspacePane";
import { AttachmentPreview } from "./AttachmentPreview";
import { ThreadManagement } from "./ThreadManagement";
import { ArrowUp, Clock, KeyRound, FileDiff, GitBranch, Info, ListTree, MoreHorizontal, Pencil, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import { send, sessionActions, type Action } from "./actions";
import { api, runPath, type Item, type Page, type RunDetail } from "./api";
import { act, repoName, runLabel, toast, useApp, useLive } from "./state";

const SIDE_TABS = ["files", "management", "details", "changes", "terminal", "events", "raw", "branches", "provider"] as const;
type Side = (typeof SIDE_TABS)[number];

// The whole history, then only what can have changed: from the first reply still being written.
function useTimeline(id: string, activity: boolean, session: string) {
  const [items, setItems] = useState<Item[]>([]);
  const known = useRef<Item[]>([]);
  const q = (after: number) => `/timeline?after=${after}&limit=100&charLimit=50000&session=${session}${activity ? "&view=activity" : ""}`;
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

function Entry({ item, id, task, canEdit, canFork }: { item: Item; id: string; task?: string; canEdit: boolean; canFork: boolean }) {
  const [full, setFull] = useState<string>();
  const set = useApp((s) => s.set);
  const text = full ?? item.text;
  const showAll = () => void act(async () => {
    let out = item.text; let offset = item.nextChar ?? null;
    while (offset !== null) {
      const page = await api<Page>("GET", runPath(id, `/timeline?item=${item.position}&startChar=${offset}&charLimit=50000`));
      out += page.items[0]!.text; offset = page.items[0]!.nextChar ?? null;
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
      <details className="text-[13px]">
        <summary className="cursor-pointer text-muted truncate">{WHO[item.kind]}{item.tool ? ` · ${item.tool}` : ""} · {text.split("\n")[0]?.slice(0, 100)}</summary>
        <pre className="mono whitespace-pre-wrap break-words mt-1 text-xs max-h-96 overflow-y-auto">{text}</pre>
      </details>
    );
  }
  const mine = item.kind === "message" || item.kind === "prompt";
  return (
    <article className={`group grid gap-1 ${mine ? "rounded-2xl bg-raised px-4 py-2.5 ml-auto max-w-[85%]" : ""}`}>
      <header className="flex items-center gap-2 text-xs text-muted h-4">
        {item.streaming && <span className="text-accent">writing…</span>}
        <span className="ml-auto flex gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          {canEdit && mine && <button className="cursor-pointer inline-flex items-center gap-1" onClick={edit}><Pencil size={11} /> Edit</button>}
          {canFork && <button className="cursor-pointer" onClick={fork}>Fork here</button>}
        </span>
      </header>
      {/* Agent text is data: markdown renders without raw HTML. */}
      {mine ? <div className="whitespace-pre-wrap break-words">{item.kind === "prompt" && task && text.includes(task) ? task : text}</div>
        : <div className="prose-agent"><Markdown components={{ a: (p) => <a href={p.href} target="_blank" rel="noreferrer noopener">{p.children}</a> }}>{text}</Markdown></div>}
      {item.nextChar != null && full === undefined && <button className="btn justify-self-start text-xs" onClick={showAll}>Show all ({item.cut?.length} characters)</button>}
    </article>
  );
}

function Question({ id, request }: { id: string; request: NonNullable<RunDetail["pendingRequest"]> }) {
  const [note, setNote] = useState("");
  const answer = (choice: string) => void act(() => api("POST", runPath(id, "/answer"), { choice, ...(note ? { note } : {}) }), "answered");
  return (
    <section role="alert" className="border border-warn rounded-2xl p-3 grid gap-2 mx-4 mt-2 max-w-3xl w-[calc(100%-2rem)] self-center">
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

// The value goes straight to the daemon, which writes it to a file only the agent's session
// can use; it is never shown again, recorded, or put in the conversation.
function SecretCard({ id, request }: { id: string; request: NonNullable<RunDetail["secretRequest"]> }) {
  const [value, setValue] = useState("");
  const [account, setAccount] = useState("");
  const [reference, setReference] = useState("");
  const answer = (refuse: boolean) => void act(async () => {
    await api("POST", runPath(id, "/secret"), refuse ? { id: request.id, refuse: true } : { id: request.id, value });
    setValue("");
  }, refuse ? "refused" : "given privately");
  return (
    <form role="alert" className="border border-accent rounded-2xl p-3 grid gap-2 mx-4 mt-2 max-w-3xl w-[calc(100%-2rem)] self-center" onSubmit={(e) => { e.preventDefault(); if (value) answer(false); }}>
      <div className="font-medium flex items-center gap-2"><KeyRound size={15} />The agent asks for a secret: {request.name}</div>
      {request.why && <p className="text-sm text-muted whitespace-pre-wrap">{request.why}</p>}
      <input type="password" autoComplete="off" spellCheck={false} aria-label={`Value for ${request.name}`} className="field" placeholder="Paste the value" value={value} onChange={(e) => setValue(e.target.value)} />
      <label className="label">1Password account<input className="field" value={account} onChange={event => setAccount(event.target.value)} /></label>
      <label className="label">Secret reference<input className="field" placeholder="op://vault/item/field" value={reference} onChange={event => setReference(event.target.value)} /></label>
      <button type="button" className="btn" disabled={!account || !reference} onClick={() => void act(() => api("POST", runPath(id, "/secret"), {
        id: request.id, vault: { provider: "onepassword", account, reference }, refresh: true,
      }), "Given privately from 1Password")}>Read from 1Password</button>
      <p className="text-xs text-muted">The agent gets a file path, never the value. The file is deleted when this session ends.</p>
      <div className="flex gap-2"><button className="btn btn-primary" disabled={!value}>Give privately</button><button type="button" className="btn btn-danger" onClick={() => answer(true)}>Refuse</button></div>
    </form>
  );
}

// Messages sent while the agent was busy wait here until they go out, and can still change.
function Waiting({ id }: { id: string }) {
  const set = useApp((s) => s.set);
  const path = `/sessions/${encodeURIComponent(id)}-agent/queue`;
  const { data } = useLive(() => api<{ messages: { id: number; message: string; mode: string }[] }>("GET", path), [id]);
  if (!data?.messages.length) return null;
  return (
    <ul className="mx-4 mt-2 max-w-3xl w-[calc(100%-2rem)] self-center grid gap-1" aria-label="Waiting messages">
      {data.messages.map((m) => (
        <li key={m.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-1.5 text-sm">
          <Clock size={13} className="text-muted shrink-0" /><span className="truncate flex-1">{m.message}</span>
          <button className="text-xs text-muted cursor-pointer hover:text-fg" onClick={() => set({ ask: {
            title: "Edit waiting message", confirm: "Save", fields: [{ name: "message", label: "Message", type: "textarea", value: m.message }],
            run: (v) => api("PATCH", `${path}/${m.id}`, { message: v.message }),
          } })}>Edit</button>
          <button className="text-xs cursor-pointer" onClick={() => void act(() => api("PATCH", `${path}/${m.id}`, { mode: "steer" }), "Promoted to steering")}>Steer now</button>
          <button className="text-xs text-danger cursor-pointer" onClick={() => void act(() => api("DELETE", `${path}/${m.id}`), "cancelled")}>Cancel</button>
        </li>
      ))}
    </ul>
  );
}

function Composer({ id, actions, openSide }: { id: string; actions: Action[]; openSide(t: Side): void }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState("steer");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  useEffect(() => { setFiles([]); }, [id]);
  const [pick, setPick] = useState(0);
  const set = useApp((s) => s.set);
  const extra: Action[] = useMemo(() => [
    ...SIDE_TABS.map((t) => ({ id: t, label: t, about: `show ${t}`, run: () => openSide(t) })),
    { id: "worker", label: "worker", about: "start a new worker", args: "", run: () => set({ screen: "new" }) },
    { id: "search", label: "search", about: "search every session's history", run: () => set({ screen: "search" }) },
    { id: "snippets", label: "snippets", about: "saved prompts and commands", run: () => set({ screen: "snippets" }) },
    { id: "radar", label: "radar", about: "conflicts between workers", run: () => set({ screen: "radar" }) },
    { id: "doctor", label: "doctor", about: "check what Rivet needs on this machine", run: () => set({ screen: "health" }) },
  ], []);
  const all = [...actions, ...extra];
  const head = text.startsWith("/") ? text.slice(1).split(/\s/)[0]!.toLowerCase() : null;
  const menu = head !== null && !/\s/.test(text) ? all.filter((a) => a.id.startsWith(head)) : [];
  const submit = () => {
    const value = text.trim();
    if (sending || (!value && !files.length)) return;
    if (value.startsWith("/")) {
      const found = all.find((a) => a.id === head) ?? menu[pick];
      if (!found) { toast(`no command /${head}; type / to see them`, true); return; }
      setText("");
      found.run(value.slice(head!.length + 1));
      return;
    }
    void act(async () => {
      setSending(true);
      let delivery: string;
      try { delivery = await send(id, value, mode, files); } finally { setSending(false); }
      setText("");
      setFiles([]);
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
    <div className="px-4 pb-4 pt-2 relative w-full max-w-3xl mx-auto">
      {menu.length > 0 && (
        <ul role="listbox" aria-label="Commands" className="absolute bottom-full left-4 right-4 mb-1 max-h-72 overflow-y-auto rounded-lg border border-line bg-panel shadow-lg z-20">
          {menu.map((a, i) => (
            <li key={a.id} role="option" aria-selected={i === pick % menu.length}>
              <button className={`w-full text-left px-3 py-1.5 cursor-pointer flex gap-3 hover:bg-raised ${i === pick % menu.length ? "bg-raised" : ""}`} onClick={() => { setText(""); a.run(""); }}>
                <span className="mono shrink-0">/{a.id}{a.args ? ` ${a.args}` : ""}</span><span className="text-muted truncate">{a.about}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.map((file, index) => <AttachmentPreview key={index} file={file} useText={preview => setText(current => current + "\n\n" + preview)} />)}
      <div className="composer">
        <textarea aria-label="Message to this session" rows={2} className="w-full bg-transparent resize-none outline-none px-1" placeholder="Send a follow-up, or / for commands"
          value={text} onChange={(e) => { setText(e.target.value); setPick(0); }} onKeyDown={key} />
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted flex items-center gap-1">
            <select aria-label="When to deliver" className="bg-transparent outline-none cursor-pointer py-1" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="steer">as soon as it can take it</option><option value="queue">once idle</option><option value="interrupt">stop its turn first</option>
            </select>
          </label>
          <label className="cursor-pointer text-xs text-muted">
            Attach files
            <input type="file" multiple className="sr-only" aria-label="Attach files" disabled={sending} onChange={event => {
              const next = [...files, ...Array.from(event.target.files ?? [])];
              event.target.value = "";
              if (next.length > 3 || next.reduce((size, file) => size + file.size, 0) > 512 * 1024) { toast("Attach up to three files totaling 512 KiB", true); return; }
              setFiles(next);
            }} />
          </label>
          {files.map((file, index) => <button key={index} type="button" disabled={sending} className="truncate max-w-32 text-xs" title={"Remove " + file.name} onClick={() => setFiles(files.filter((_, i) => i !== index))}>{file.name} ×</button>)}
          <button className="send ml-auto" aria-label="Send" disabled={sending || (!text.trim() && !files.length)} onClick={submit}><ArrowUp size={17} /></button>
        </div>
      </div>
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
      <Fact k="Mode" v={n.runMode ?? "terminal"} />
      <Fact k="Attempts" v={n.attempts} />
      <Fact k="Branch" v={<code className="mono">{n.branch}</code>} />
      <Fact k="Base" v={d.run.base} />
      <Fact k="Worktree" v={<code className="mono text-xs">{n.worktree}</code>} />
      <Fact k="Issue" v={d.run.issue ? `#${d.run.issue}` : undefined} />
      <Fact k="Pull request" v={d.pr ? <a className="text-accent underline" target="_blank" rel="noreferrer noopener" href={d.pr.url}>#{d.pr.number}{n.prStatus ? ` · ${n.prStatus}` : ""}</a> : undefined} />
      <Fact k="On merge" v={d.endOnMerge ? "end the run" : "keep it"} />
      <Fact k="Tokens" v={c ? `${c.input.toLocaleString()} in, ${c.output.toLocaleString()} out, ${c.cached.toLocaleString()} cached` : d.usage.conversations ? `${d.usage.inputEquivalent.toLocaleString()} input-equivalent` : undefined} />
      <Fact k="Context" v={c?.contextUsed && c.contextWindow ? `${Math.round(100 * c.contextUsed / c.contextWindow)}% of ${c.contextWindow.toLocaleString()}` : undefined} />
      <Fact k={d.fork?.independent ? "Workspace from" : "Fork of"} v={d.fork ? `${d.fork.sourceRun} at #${d.fork.position} (${d.fork.strategy}${d.fork.detached ? ", detached" : ""})` : undefined} />
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
  const activity = picked ?? (!!d && d.run.node.runMode !== "chat");
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
  // Opening a session reads what was new in it.
  const unread = useApp((s) => s.runs.find((r) => r.id === id)?.organization.unread);
  useEffect(() => { if (unread) void api("PATCH", runPath(id, "/organization"), { unread: false }).catch(() => {}); }, [id, unread]);
  const org = useApp((s) => s.runs.find((r) => r.id === id)?.organization);
  const actions = useMemo(() => sessionActions(id, d), [id, d?.run.node.runMode, d?.run.role, d?.endOnMerge, d?.run.node.agent, d?.run.name, org?.pinnedAt, org?.snoozedUntil]);
  if (error) return (
    <div className="flex-1 grid place-items-center p-6 text-center"><div className="grid gap-2 justify-items-center"><p>{error}</p><button className="btn" onClick={() => set({ selected: null })}>Back</button></div></div>
  );
  const chat = d?.run.node.runMode === "chat";
  return (
    <div className="flex-1 flex min-w-0 min-h-0">
      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="topbar relative">
          {d && <span className="text-muted shrink-0 max-sm:hidden">{repoName(d.run.repo)}</span>}
          {d && <span className="text-muted shrink-0 max-sm:hidden">/</span>}
          <h2 className="font-medium truncate min-w-0">{d ? runLabel({ id, name: d.run.name, task: d.run.task }) : id}</h2>
          <span className="text-xs text-muted shrink-0 truncate ml-1 mr-auto">{d ? `${d.run.node.agent} · ${d.run.node.activity && d.live ? d.run.node.activity : d.run.node.status}` : ""}</span>
          <button className={`icon ${activity ? "text-fg bg-raised" : ""}`} title="Show tool steps" aria-label="Show tool steps" aria-pressed={activity} onClick={() => setActivity(!activity)}><ListTree size={16} /></button>
          <select aria-label="Which agent's record" className="bg-transparent text-xs text-muted outline-none cursor-pointer" value={session} onChange={(e) => setSession(e.target.value)}>
            <option value="agent">agent</option><option value="review">reviewer</option><option value="partner">partner</option>
          </select>
          {([["changes", "Changes", FileDiff], ["terminal", "Terminal", SquareTerminal], ["details", "Details", Info]] as const).map(([t, label, Icon]) => (
            <button key={t} className={`icon ${side === t ? "text-fg bg-raised" : ""}`} title={label} aria-label={label} aria-pressed={side === t} onClick={() => setSide(side === t ? null : t)}><Icon size={16} /></button>
          ))}
          <button className="icon" aria-label="Session actions" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={15} /></button>
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
        <div ref={list} onScroll={(e) => { const t = e.currentTarget; stuck.current = t.scrollHeight - t.scrollTop - t.clientHeight < 60; }} className="flex-1 overflow-y-auto" aria-live="off"><div className="w-full max-w-3xl mx-auto p-4 grid grid-cols-[minmax(0,1fr)] gap-4 content-start">
          {readError && <p className="text-danger">{readError}</p>}
          {items.length === 0 && !readError && <p className="text-muted">Nothing recorded yet.</p>}
          {items.map((i) => <Entry key={`${i.position}-${i.at}`} item={i} id={id} task={d?.run.task} canEdit={chat && session === "agent"} canFork={session === "agent"} />)}
        </div></div>
        {d?.secretRequest && <SecretCard key={d.secretRequest.id} id={id} request={d.secretRequest} />}
        {d?.pendingRequest && <Question id={id} request={d.pendingRequest} />}
        <Waiting id={id} />
        <Composer id={id} actions={actions} openSide={(t) => setSide(t)} />
        {d?.run.node.branch && <div className="text-xs text-muted pb-2 -mt-2 flex justify-center items-center gap-1 truncate"><GitBranch size={12} />{d.run.node.branch}</div>}
      </section>
      {side && (
        <aside className="w-[46%] max-w-[760px] min-w-[320px] border-l border-line bg-panel flex flex-col min-h-0 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(92vw,560px)]">
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line flex-wrap">
            {SIDE_TABS.map((t) => <button key={t} onClick={() => setSide(t)} className={`px-2 py-0.5 rounded cursor-pointer capitalize text-[13px] ${side === t ? "bg-raised" : "text-muted"}`}>{t}</button>)}
            <button className="ml-auto cursor-pointer text-muted" aria-label="Close panel" onClick={() => setSide(null)}><X size={15} /></button>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            {side === "files" && <WorkspacePane id={id} />}
            {side === "management" && d && <ThreadManagement detail={d} />}
            {side === "details" && d && <>
              <Details d={d} />
              {d.run.sharedWorkspace && !["busy", "approval"].includes(d.run.node.activity ?? "") && !d.fork?.detached && (
                <button className="btn" onClick={() => void act(() => api("POST", runPath(id, "/move-to-worktree"), {}), "Moved to a new worktree")}>
                  Move to a new worktree
                </button>
              )}
            </>}
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

