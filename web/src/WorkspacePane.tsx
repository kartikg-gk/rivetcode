import { useState } from "react";
import { api, runPath } from "./api";
import { act, useLive } from "./state";
import { TerminalPane } from "./TerminalPane";

type Listing = { entries: { name: string; kind: string }[]; next: string | null };
type OpenFile = { path: string; text: string; version: string | null };

export function WorkspacePane({ id }: { id: string }) {
  const [directory, setDirectory] = useState("");
  const [cursor, setCursor] = useState("");
  const [file, setFile] = useState<OpenFile>();
  const [dirty, setDirty] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const listing = useLive(() => api<Listing>("GET", runPath(id, "/files?path=" + encodeURIComponent(directory) + "&after=" + encodeURIComponent(cursor))), [id, directory, cursor]);
  const shell = useLive(() => api<{ alive: boolean }>("GET", runPath(id, "/shell")), [id]);
  const path = (name: string) => directory ? directory + "/" + name : name;
  const canLeave = () => !dirty || window.confirm("Discard unsaved file edits?");
  const perform = (work: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    void act(work, message).finally(() => setBusy(false));
  };
  return <div className="grid gap-3 p-3">
    <h3>Workspace files</h3>
    {listing.error && <p role="alert">{listing.error}</p>}
    <div className="flex gap-2 items-center">
      <button className="btn" disabled={busy || !directory} onClick={() => {
        if (canLeave()) { setDirectory(directory.split("/").slice(0, -1).join("/")); setCursor(""); setFile(undefined); setDirty(false); }
      }}>Up</button>
      <code className="break-all">/{directory}</code>
      <button className="btn" disabled={busy} onClick={() => listing.reload()}>Refresh files</button>
    </div>
    <ul className="max-h-56 overflow-auto">
      {listing.data?.entries.map(entry => <li key={entry.name}>
        <button className="cursor-pointer py-1 text-left break-all" disabled={busy || entry.kind === "link"} onClick={() => {
          if (!canLeave()) return;
          if (entry.kind === "directory") { setDirectory(path(entry.name)); setCursor(""); setFile(undefined); setDirty(false); return; }
          perform(async () => {
            const opened = await api<{ text: string; version: string }>("GET", runPath(id, "/file?path=" + encodeURIComponent(path(entry.name))));
            setFile({ ...opened, path: path(entry.name) }); setDirty(false);
          });
        }}>{entry.kind === "directory" ? "▸ " : ""}{entry.name}{entry.kind === "link" ? " (link)" : ""}</button>
      </li>)}
    </ul>
    {listing.data?.next && <button className="btn" onClick={() => setCursor(listing.data!.next!)}>Next files</button>}
    {cursor && <button className="btn" onClick={() => setCursor("")}>First files</button>}
    <label className="label">New file name<input className="field" value={name} onChange={event => setName(event.target.value)} /></label>
    <button className="btn" disabled={busy || !name.trim()} onClick={() => {
      if (canLeave()) { setFile({ path: path(name.trim()), text: "", version: null }); setDirty(true); }
    }}>New file</button>
    {file && <>
      <label className="label">{file.path}{dirty ? " •" : ""}<textarea className="field mono min-h-64" aria-label="File contents" disabled={busy} value={file.text} onChange={event => { setFile({ ...file, text: event.target.value }); setDirty(true); }} /></label>
      <button className="btn" disabled={busy || !dirty} onClick={() => perform(async () => {
        const saved = await api<{ version: string }>("PUT", runPath(id, "/file?path=" + encodeURIComponent(file.path)), { text: file.text, version: file.version });
        setFile({ ...file, version: saved.version }); setDirty(false); listing.reload();
      }, "File saved")}>Save file</button>
    </>}
    <h3>Workspace shell</h3>
    {shell.error && <p role="alert">{shell.error}</p>}
    <button className="btn" disabled={busy} onClick={() => perform(async () => {
      await api(shell.data?.alive ? "DELETE" : "POST", runPath(id, "/shell"), {}); shell.reload();
    })}>{shell.data?.alive ? "Stop shell" : "Start shell"}</button>
    {shell.data?.alive && <div className="h-80 min-h-0"><TerminalPane id={id} session="shell" /></div>}
  </div>;
}
