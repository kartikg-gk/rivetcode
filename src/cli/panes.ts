// How to show several sessions side by side, each pane running "rivet attach <session>".
export type PanesPlan =
  | { kind: "wt"; file: string; args: string[] }
  | { kind: "tmux"; steps: string[][] }
  | { kind: "print"; lines: string[] };

// One more session in the shared "rivet" window: its first tab, or a split beside the others.
// cmd /k keeps a pane open after the session ends, so what it said can still be read.
// beside: already inside Windows Terminal, so the pane joins the window this runs in.
export function addPaneArgs(rivet: string, session: { id: string; title: string }, first: boolean, beside = false): string[] {
  return ["-w", beside ? "0" : "rivet", ...(first && !beside ? ["new-tab"] : ["split-pane", "-V"]), "--title", session.title, "cmd", "/k", rivet, "attach", session.id];
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function panesPlan(o: {
  platform: NodeJS.Platform;
  rivet: string;
  runId: string;
  sessions: { id: string; title: string }[];
  have(tool: "wt" | "tmux"): boolean;
  beside?: boolean;
}): PanesPlan {
  const { sessions } = o;
  if (o.platform === "win32" && o.have("wt")) {
    // One Windows Terminal window: the first session in a tab, the rest split beside it.
    const args = ["-w", o.beside ? "0" : "new"];
    sessions.forEach((s, i) => {
      if (i > 0) args.push(";", "split-pane", i % 2 === 1 ? "-V" : "-H");
      else if (o.beside) args.push("split-pane", "-V");
      else args.push("new-tab");
      args.push("--title", s.title, "cmd", "/k", o.rivet, "attach", s.id);
    });
    return { kind: "wt", file: "wt", args };
  }
  if (o.platform !== "win32" && o.have("tmux")) {
    const name = `rivet-${o.runId}`;
    const attach = (id: string) => `${shellQuote(o.rivet)} attach ${shellQuote(id)}`;
    const steps: string[][] = [["new-session", "-d", "-s", name, "-n", "agents", attach(sessions[0]!.id)]];
    for (const s of sessions.slice(1)) steps.push(["split-window", "-t", name, attach(s.id)], ["select-layout", "-t", name, "tiled"]);
    steps.push(["attach-session", "-t", name]);
    return { kind: "tmux", steps };
  }
  return { kind: "print", lines: sessions.map((s) => `${o.rivet} attach ${s.id}    # ${s.title}`) };
}
