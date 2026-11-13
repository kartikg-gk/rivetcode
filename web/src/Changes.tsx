import { api, runPath } from "./api";
import { useLive } from "./state";

type FileChange = { path: string; added: number; removed: number; binary: boolean };
type Diff = { available: boolean; diff: string; stat: string; files: FileChange[]; untracked: string[]; cut: boolean };
export type Turn = { itemId: string; position: number; text: string; files: number; added: number; removed: number };

// A unified diff cut into one piece per file, keyed by the file's new path.
function byFile(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let lines: string[] | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const at = line.lastIndexOf(" b/");
      lines = [];
      out.set(at >= 0 ? line.slice(at + 3) : line, lines);
      continue;
    }
    // The header lines say again what the summary already shows.
    if (!lines || /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) continue;
    lines.push(line);
  }
  return out;
}

const counts = (added: number, removed: number) => <span className="shrink-0 tabular-nums"><span className="diff-add">+{added}</span> <span className="diff-del">−{removed}</span></span>;

// What a session changed: everything since its base, or one turn of a chat.
export function Changes({ id, turns, turn, setTurn }: { id: string; turns: Turn[]; turn: string | null; setTurn: (t: string | null) => void }) {
  const { data, error } = useLive(() => api<Diff>("GET", runPath(id, "/diff" + (turn ? "?turn=" + encodeURIComponent(turn) : ""))), [id, turn]);
  const files = data?.files ?? [];
  const pieces = byFile(data?.diff ?? "");
  const added = files.reduce((n, f) => n + f.added, 0), removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="p-3 grid gap-3 text-xs">
      {turns.length > 0 && (
        <select aria-label="Which changes" className="field text-xs" value={turn ?? ""} onChange={(e) => setTurn(e.target.value || null)}>
          <option value="">All changes since its base</option>
          {turns.map((t, i) => <option key={t.itemId} value={t.itemId}>Turn {i + 1}: {t.text.split("\n")[0]!.slice(0, 60)} ({t.files} {t.files === 1 ? "file" : "files"})</option>)}
        </select>
      )}
      {error && <p className="text-danger">{error}</p>}
      {!data && !error && <p className="text-muted">Loading…</p>}
      {data && !data.available && <p className="text-muted">This run's worktree has been removed.</p>}
      {data?.available && files.length === 0 && data.untracked.length === 0 && <p className="text-muted">{turn ? "This turn changed no files." : "No changes from its base yet."}</p>}
      {files.length > 0 && <div className="flex justify-between text-muted"><span>{files.length} {files.length === 1 ? "file" : "files"} changed</span>{counts(added, removed)}</div>}
      {files.map((f) => (
        <details key={f.path} open={files.length <= 6} className="border border-line rounded-lg">
          <summary className="cursor-pointer px-2 py-1.5 flex gap-2 items-center bg-raised rounded-t-lg">
            <span className="mono truncate min-w-0 mr-auto">{f.path}</span>{f.binary ? <span className="text-muted">binary</span> : counts(f.added, f.removed)}
          </summary>
          <pre className="mono overflow-x-auto p-2">{(pieces.get(f.path.replace(/^.*\{.* => (.*)\}.*$/, "$1")) ?? pieces.get(f.path) ?? []).map((l, i) => (
            <div key={i} className={l.startsWith("@@") ? "diff-hunk" : l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : ""}>{l || " "}</div>
          ))}</pre>
        </details>
      ))}
      {data && data.untracked.length > 0 && <div><div className="font-medium">New, not yet added</div><pre className="mono whitespace-pre-wrap">{data.untracked.join("\n")}</pre></div>}
      {data?.cut && <p className="text-warn">Too long to show in full.</p>}
    </div>
  );
}
