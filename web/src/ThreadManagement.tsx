import { useEffect, useRef, useState } from "react";
import { api, runPath, type RunDetail } from "./api";
import { act, useLive } from "./state";

type Project = { id: string; repo: string; title: string; instructions: string; scripts: { id: string; command: string }[] };
type Links = { primary: { number: number; url: string } | null; linked: { number: number; url: string; status?: string }[] };

export function ThreadManagement({ detail }: { detail: RunDetail }) {
  const { id, project } = detail.run;
  const projectPath = `/projects/${encodeURIComponent(project)}`;
  const metadata = useLive(() => api<{ project: Project }>("GET", projectPath), [project]);
  const environment = useLive(() => api<{ instructions: string }>("GET", "/environment-preferences"), []);
  const execution = useLive(() => api<{ scripts: Project["scripts"]; running: { id: string; alive: boolean; output: string; exitCode: number | null } | null }>("GET", runPath(id, "/scripts")), [id]);
  const children = useLive(() => api<{ children: { id: string; label: string; status: string; canCancel: boolean }[] }>("GET", runPath(id, "/stop-subagent")), [id]);
  const links = useLive(() => api<Links>("GET", runPath(id, "/linked-prs")), [id]);
  useEffect(() => {
    if (!execution.data?.running?.alive) return;
    const timer = setInterval(() => execution.reload(), 1000);
    return () => clearInterval(timer);
  }, [id, execution.data?.running?.alive]);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [scripts, setScripts] = useState("");
  const [environmentText, setEnvironmentText] = useState("");
  const [repository, setRepository] = useState("");
  const [tasks, setTasks] = useState("");
  const [child, setChild] = useState("");
  const [number, setNumber] = useState("");
  const [guide, setGuide] = useState("");
  const [busy, setBusy] = useState(false);
  const loadedProject = useRef("");
  const loadedEnvironment = useRef(false);
  useEffect(() => {
    if (!metadata.data || loadedProject.current === project) return;
    loadedProject.current = project;
    setTitle(metadata.data.project.title);
    setInstructions(metadata.data.project.instructions);
    setScripts(metadata.data.project.scripts.map(script => `${script.id}=${script.command}`).join("\n"));
  }, [metadata.data, project]);
  useEffect(() => { if (environment.data && !loadedEnvironment.current) { loadedEnvironment.current = true; setEnvironmentText(environment.data.instructions); } }, [environment.data]);
  const perform = (operation: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    void act(operation, message).finally(() => setBusy(false));
  };
  const prNumber = () => {
    const value = Number(number);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Enter a positive pull request number");
    return value;
  };
  return <div className="grid gap-4 p-3">
    {[metadata.error, environment.error, links.error].filter(Boolean).map((error, index) => <p key={index} role="alert">{error}</p>)}
    <fieldset disabled={busy} className="grid gap-3">
      <legend>Project preferences</legend>
      <label className="label">Independent threads, one task per line<textarea className="field" value={tasks} onChange={event => setTasks(event.target.value)} /></label>
      <button className="btn" disabled={!tasks.trim()} onClick={() => perform(async () => {
        await api("POST", runPath(id, "/threads"), { tasks: tasks.split(/\r?\n/).filter(task => task.trim()).map(task => ({ task })) });
        setTasks("");
      }, "Independent threads created")}>Create threads</button>
      <label className="label">Title<input className="field" value={title} maxLength={100} onChange={event => setTitle(event.target.value)} /></label>
      <label className="label">Instructions<textarea className="field" value={instructions} maxLength={8000} onChange={event => setInstructions(event.target.value)} /></label>
      <label className="label">Saved scripts, one id=command per line<textarea className="field" value={scripts} onChange={event => setScripts(event.target.value)} /></label>
      <button className="btn" disabled={!metadata.data} onClick={() => perform(() => api("PATCH", projectPath, {
        title, instructions, scripts: scripts.split(/\r?\n/).filter(line => line.trim()).map(line => {
          const separator = line.indexOf("=");
          if (separator < 1) throw new Error("Each script needs id=command");
          return { id: line.slice(0, separator).trim(), command: line.slice(separator + 1).trim() };
        }),
      }), "Project saved")}>Save project</button>
      <button className="btn btn-danger" onClick={() => {
        if (window.confirm(`Delete Rivet records and settings for ${project}? Stop its sessions first.`)) perform(() => api("DELETE", projectPath, { confirm: project }), "Project deleted");
      }}>Delete project records</button>
      <h3>Run saved scripts</h3>
      {execution.error && <p role="alert">{execution.error}</p>}
      {execution.data?.scripts.map(script => <button key={script.id} className="btn" disabled={execution.data?.running?.alive} onClick={() => {
        if (window.confirm("Run " + script.id + " in this checkout?\n" + script.command)) perform(() => api("POST", runPath(id, "/scripts/" + encodeURIComponent(script.id)), { confirm: script.id }), "Script started");
      }}>{script.id}</button>)}
      {execution.data?.running && <>
        <p>{execution.data.running.id}: {execution.data.running.alive ? "Running" : "Exited " + execution.data.running.exitCode}</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{execution.data.running.output}</pre>
        <button className="btn" disabled={!execution.data.running.alive} onClick={() => perform(() => api("DELETE", runPath(id, "/scripts")), "Script stopped")}>Stop script</button>
        <button className="btn" onClick={() => execution.reload()}>Refresh output</button>
      </>}
      <label className="label">Register another repository<input className="field" value={repository} onChange={event => setRepository(event.target.value)} /></label>
      <button className="btn" onClick={() => perform(() => api("POST", "/projects", { repo: repository }), "Project registered")}>Register repository</button>
      <label className="label">Environment instructions<textarea className="field" maxLength={8000} value={environmentText} onChange={event => setEnvironmentText(event.target.value)} /></label>
      <button className="btn" disabled={!environment.data} onClick={() => perform(() => api("PUT", "/environment-preferences", { instructions: environmentText }), "Environment saved")}>Save environment</button>
      {detail.run.node.agent === "claude" && <>
        <label className="label">Sub-agent<select className="field" value={child} onChange={event => setChild(event.target.value)}>
          <option value="">Choose a sub-agent</option>
          {children.data?.children.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
        {children.error && <p role="alert">{children.error}</p>}
        <button className="btn" disabled={!detail.live || !children.data?.children.find(item => item.id === child)?.canCancel} onClick={() => perform(() => api("POST", runPath(id, "/stop-subagent"), { id: child }), "Stop requested")}>Stop sub-agent</button>
      </>}
      <h3>Pull requests</h3>
      {links.data?.primary && <p>Primary PR #{links.data.primary.number}</p>}
      {links.data?.linked.map(link => <div key={link.number}>PR #{link.number} {link.status}
        <button className="btn" onClick={() => perform(() => api("DELETE", runPath(id, `/linked-prs/${link.number}`)), "Link removed")}>Remove link</button>
      </div>)}
      <label className="label">Pull request number<input className="field" type="number" min={1} value={number} onChange={event => setNumber(event.target.value)} /></label>
      <button className="btn" onClick={() => perform(() => api("POST", runPath(id, "/linked-prs"), { number: prNumber() }), "PR linked")}>Add PR link</button>
      <label className="label">Review guide<textarea className="field" maxLength={16000} value={guide} onChange={event => setGuide(event.target.value)} /></label>
      <button className="btn" onClick={() => perform(async () => {
        const result = await api<{ text: string }>("GET", runPath(id, `/pr-guides/${prNumber()}`));
        setGuide(result.text);
      })}>Read guide</button>
      <button className="btn" onClick={() => perform(() => api("PUT", runPath(id, "/pr-guides"), { guides: [{ number: prNumber(), text: guide }] }), "Guide saved")}>Save guide</button>
    </fieldset>
  </div>;
}
