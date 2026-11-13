import { useState } from "react";
import { Check, Copy, RefreshCw, TriangleAlert, X } from "lucide-react";
import { api } from "./api";
import { repoName, useApp, useLive } from "./state";

type AgentSetup = { agent: string; name: string; installed: boolean; path?: string; version?: string; loggedIn: boolean | null; problem?: string; install: string; login: string; docs: string };
type Setup = { agents: AgentSetup[]; ollama: { running: boolean; models: string[]; install: string; pull: string; docs: string }; ready: boolean };

const WELCOMED = "rivet.welcomed";
export function welcomed(): boolean {
  try { return localStorage.getItem(WELCOMED) === "1"; } catch { return true; }
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-2 py-1">
      <code className="mono text-xs flex-1 min-w-0 break-all">{text}</code>
      <button className="icon shrink-0" aria-label={`Copy ${text}`} title="Copy" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function Status({ ok, warn, text }: { ok: boolean; warn?: boolean; text: string }) {
  const Icon = ok ? Check : warn ? TriangleAlert : X;
  return <span className={`inline-flex items-center gap-1 text-xs ${ok ? "text-ok" : warn ? "text-warn" : "text-danger"}`}><Icon size={13} />{text}</span>;
}

// One card per way to run work: each says whether it is ready and, if not, what to run.
export function ProviderCards() {
  const [nonce, setNonce] = useState(0);
  const { data, error } = useLive(() => api<Setup>("GET", `/setup${nonce ? "?refresh=1" : ""}`), [nonce]);
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{data ? (data.ready ? "Ready to start a thread." : "Set up at least one agent to start.") : error ?? "Checking this machine…"}</span>
        <button className="btn text-xs inline-flex items-center gap-1" onClick={() => setNonce(nonce + 1)}><RefreshCw size={13} /> Check again</button>
      </div>
      {data?.agents.map((a) => (
        <section key={a.agent} className="rounded-xl border border-line bg-panel p-3 grid gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{a.name}</span>
            {a.version && <span className="text-xs text-muted">{a.version}</span>}
            <span className="ml-auto">
              {!a.installed ? <Status ok={false} text="not installed" />
                : a.loggedIn === false ? <Status ok={false} warn text="not logged in" />
                : a.loggedIn === null ? <Status ok warn text="installed (login not checked)" />
                : <Status ok text="ready" />}
            </span>
          </div>
          {!a.installed && <><p className="text-xs text-muted">Install it in a terminal, then check again:</p><Command text={a.install} /></>}
          {a.installed && a.loggedIn === false && <><p className="text-xs text-muted">Log in once in a terminal, then check again:</p><Command text={a.login} /></>}
          {a.installed && a.path && <p className="text-xs text-muted break-all">Found at {a.path}</p>}
          {!a.installed && <p className="text-xs text-muted">Installed somewhere unusual? Start Rivet with RIVET_{a.agent.toUpperCase()}_BIN set to its path. <a className="underline" href={a.docs} target="_blank" rel="noreferrer noopener">Setup guide</a></p>}
        </section>
      ))}
      {data && (
        <section className="rounded-xl border border-line bg-panel p-3 grid gap-2">
          <div className="flex items-center gap-2">
            <span className="font-medium">Local models (Ollama)</span>
            <span className="text-xs text-muted">optional, runs on your machine</span>
            <span className="ml-auto">{data.ollama.models.length ? <Status ok text={`${data.ollama.models.length} model${data.ollama.models.length === 1 ? "" : "s"}`} /> : data.ollama.running ? <Status ok={false} warn text="no models with tools" /> : <Status ok={false} warn text="not running" />}</span>
          </div>
          {!data.ollama.running && <p className="text-xs text-muted">Install and start <a className="underline" href={data.ollama.install} target="_blank" rel="noreferrer noopener">Ollama</a>, then pull a model:</p>}
          {!data.ollama.models.length && <Command text={data.ollama.pull} />}
          {data.ollama.models.length > 0 && <p className="text-xs text-muted">{data.ollama.models.join(", ")}</p>}
        </section>
      )}
    </div>
  );
}

// First run: what is ready on this machine, then a project folder.
export function Welcome({ done }: { done(): void }) {
  const { repo, set } = useApp();
  const [folder, setFolder] = useState(repo);
  const finish = () => {
    const next = folder.trim();
    if (next) { try { localStorage.setItem("rivet.repo", next); } catch { /* optional */ } set({ repo: next }); }
    try { localStorage.setItem(WELCOMED, "1"); } catch { /* optional */ }
    done();
  };
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6 grid gap-6">
        <header className="grid gap-1">
          <h1 className="text-2xl font-medium">Welcome to Rivet</h1>
          <p className="text-muted">Rivet runs coding agents on your computer, each in its own copy of your project, and shows their work here. It uses the agents you already have, with their own logins.</p>
        </header>
        <div className="grid gap-2"><h2 className="font-medium">1. Agents on this machine</h2><ProviderCards /></div>
        <div className="grid gap-2">
          <h2 className="font-medium">2. A project</h2>
          <label className="label"><span>Git repository folder</span>
            <input className="field" placeholder={navigator.platform.startsWith("Win") ? "C:\\code\\my-project" : "~/code/my-project"} value={folder} onChange={(e) => setFolder(e.target.value)} /></label>
          <p className="text-xs text-muted">Tip: running <code className="mono">rivet ./my-project</code> in a terminal opens Rivet on that folder.</p>
        </div>
        <div className="flex gap-2 justify-end">
          <button className="btn" onClick={finish}>Skip for now</button>
          <button className="btn btn-primary" disabled={!folder.trim()} onClick={finish}>{folder.trim() ? `Start in ${repoName(folder.trim())}` : "Choose a folder"}</button>
        </div>
      </div>
    </div>
  );
}
