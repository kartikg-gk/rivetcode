import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline";

// Rivet's own prompt: slash commands typed here run Rivet directly, with no agent involved.
// A <run> left out means the last session started from this prompt.
type Command = {
  name: string;
  args: string;
  about: string;
  // The rivet command line, or an error to show. run: the session asked about.
  build(words: string[], rest: string): string[] | { error: string };
  // Its first word is a run id.
  takesRun?: boolean;
};

const needs = (what: string) => ({ error: `needs ${what}` });

export const COMMANDS: Command[] = [
  { name: "claude", args: "", about: "open Claude beside this prompt", build: () => ["console-open", "claude"] },
  { name: "codex", args: "", about: "open Codex beside this prompt", build: () => ["console-open", "codex"] },
  { name: "worker", args: "<task>", about: "start a worker on a task in its own worktree", build: (_w, rest) => (rest ? ["spawn", rest] : needs("a task")) },
  { name: "orchestrator", args: "<what you want>", about: "start an agent that splits work into workers", build: (_w, rest) => (rest ? ["orchestrator", rest] : needs("what you want")) },
  { name: "status", args: "[run]", about: "list sessions, or show one", build: (w) => ["status", ...w.slice(0, 1)] },
  { name: "read", args: "[run]", about: "what a session was told, did and said", takesRun: true, build: (w) => ["read", w[0]!, "--activity"] },
  { name: "open", args: "[run]", about: "open a session's pane", takesRun: true, build: (w) => ["console-pane", w[0]!] },
  { name: "send", args: "[run] <text>", about: "message a session", takesRun: true,
    build: (w) => (w.length > 1 ? ["send", "--session", `${w[0]}-agent`, "--message", w.slice(1).join(" ")] : needs("a message")) },
  { name: "answer", args: "[run] yes|always|no [note]", about: "answer a session's permission question", takesRun: true,
    build: (w) => (["yes", "always", "no"].includes(w[1] ?? "") ? ["answer", w[0]!, w[1]!, ...(w.length > 2 ? ["--note", w.slice(2).join(" ")] : [])] : needs("yes, always or no")) },
  { name: "stop", args: "[run]", about: "stop a session", takesRun: true, build: (w) => ["stop", w[0]!] },
  { name: "resume", args: "[run]", about: "continue a stopped or escalated session", takesRun: true, build: (w) => ["resume", w[0]!] },
  { name: "switch", args: "[run] claude|codex", about: "hand a worker to the other agent", takesRun: true,
    build: (w) => (w[1] === "claude" || w[1] === "codex" ? ["switch", w[0]!, w[1]] : needs("claude or codex")) },
  { name: "fork", args: "[run]", about: "branch a chat into a new session", takesRun: true, build: (w) => ["fork", w[0]!] },
  { name: "rollback", args: "[run] [turns]", about: "go back in a chat; files stay as they are", takesRun: true, build: (w) => ["rollback", w[0]!, "--turns", w[1] ?? "1"] },
  { name: "search", args: "<words>", about: "search every session's history", build: (_w, rest) => (rest ? ["search", rest] : needs("words to search for")) },
  { name: "pr", args: "[run]", about: "push a worker's branch and open its pull request", takesRun: true, build: (w) => ["pr", w[0]!] },
  { name: "doctor", args: "", about: "check what Rivet needs on this machine", build: () => ["doctor"] },
  { name: "quit", args: "", about: "leave this prompt; sessions keep running", build: () => [] },
];

export function matching(line: string): Command[] {
  if (!line.startsWith("/") || /\s/.test(line)) return [];
  const typed = line.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(typed));
}

const looksLikeRun = (word: string | undefined) => !!word && /^r[a-z0-9]{8,}$/.test(word);

// A typed line as a rivet command line. Run ids may be left out; the first matching name
// wins, so /st is /status.
export function parseLine(line: string, lastRun?: string): { argv: string[] } | { quit: true } | { error: string } | { none: true } {
  const text = line.trim();
  if (!text) return { none: true };
  if (!text.startsWith("/")) return { error: "commands start with /; type / to see them" };
  const [head, ...words] = text.split(/\s+/);
  const command = matching(head!)[0];
  if (!command) return { error: `no command ${head}; type / to see them` };
  if (command.name === "quit") return { quit: true };
  const rest = text.slice(head!.length).trim();
  let args = words;
  if (command.takesRun && !looksLikeRun(words[0])) {
    if (!lastRun) return { error: `/${command.name} needs a run id (see /status)` };
    args = [lastRun, ...words];
  }
  const built = command.build(args, rest);
  if (!Array.isArray(built)) return { error: `/${command.name} ${built.error}` };
  return { argv: built };
}

export function menuLines(line: string, width: number): string[] {
  return matching(line).map((c) => `  /${c.name}${c.args ? ` ${c.args}` : ""}  ${c.about}`.slice(0, Math.max(20, width - 1)));
}

export type ConsoleIo = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  // Runs one rivet command line; what it prints may name a new session.
  run(argv: string[], started: (runId: string) => void): Promise<void>;
};

const DIM = "\x1b[2m";
const PLAIN = "\x1b[0m";

export async function runConsole(io: ConsoleIo): Promise<number> {
  const { input, output } = io;
  let lastRun: string | undefined;
  const completer = (line: string): [string[], string] => {
    const top = matching(line)[0];
    return [top ? [`/${top.name} `] : [], line];
  };
  const rl = createInterface({ input, output, prompt: "rivet> ", completer, terminal: true });
  emitKeypressEvents(input, rl);
  // The menu under the line: drawn with new lines so it also works at the screen's bottom.
  const draw = () => {
    const lines = menuLines(rl.line, output.columns ?? 80);
    let out = "\x1b[s\x1b[J\x1b[u";
    if (lines.length) {
      const col = rl.getCursorPos().cols + 1;
      out = `\x1b[J\n${DIM}${lines.join("\n")}${PLAIN}\x1b[${lines.length}A\x1b[${col}G`;
    }
    output.write(out);
  };
  const onKey = () => { setImmediate(draw); };
  input.on("keypress", onKey);
  output.write(`Rivet. Type / for commands, Tab completes, /quit leaves.\n`);
  rl.prompt();
  await new Promise<void>((resolve) => {
    let busy = false;
    rl.on("close", resolve);
    rl.on("line", (line) => {
      if (busy) return;
      output.write("\x1b[J");
      const parsed = parseLine(line, lastRun);
      if ("quit" in parsed) { rl.close(); return; }
      if ("none" in parsed) { rl.prompt(); return; }
      if ("error" in parsed) { output.write(`${parsed.error}\n`); rl.prompt(); return; }
      busy = true;
      rl.pause();
      void io.run(parsed.argv, (id) => { lastRun = id; })
        .catch((e: Error) => { output.write(`${e.message}\n`); })
        .finally(() => { busy = false; rl.resume(); rl.prompt(); });
    });
  });
  input.off("keypress", onKey);
  output.write("Sessions keep running; rivet status lists them.\n");
  return 0;
}
