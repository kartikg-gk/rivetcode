import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveActivity } from "../src/cli/activity.js";
import { runCli, type CliIo } from "../src/cli/commands.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { openStore } from "../src/store.js";
import { buildTree } from "../src/tree.js";
import { makeDataDir, removeRepo } from "./helpers.js";

describe("deriveActivity (Claude Code)", () => {
  it.each([
    ["user-prompt-submit", {}, "active"],
    ["pre-tool-use", {}, "active"],
    ["post-tool-use", {}, "active"],
    ["post-tool-use-failure", {}, "active"],
    ["permission-request", {}, "blocked"],
    ["stop", {}, "idle"],
    ["notification", { notification_type: "idle_prompt" }, "idle"],
    ["notification", { notification_type: "agent_completed" }, "idle"],
    ["notification", { notification_type: "agent_needs_input" }, "waiting_input"],
    ["notification", { notification_type: "permission_prompt" }, "blocked"],
    ["notification", { notification_type: "other" }, null],
    ["session-end", { reason: "logout" }, "exited"],
    ["session-end", {}, "exited"],
    ["session-end", { reason: "clear" }, null],
    ["session-end", { reason: "resume" }, null],
    ["session-start", {}, null],
    ["subagent-stop", {}, null],
  ])("%s %j -> %s", (event, payload, state) => {
    expect(deriveActivity("claude-code", event, payload)).toBe(state);
  });

  it("knows no states for an unknown agent", () => {
    expect(deriveActivity("other", "stop", {})).toBeNull();
  });
});

let data: string;
let runFile: string;
let daemon: Daemon | undefined;
let out: string[];
let err: string[];

beforeEach(async () => {
  data = await makeDataDir();
  runFile = join(data, "running.json");
  out = [];
  err = [];
  const store = openStore(data);
  store.saveRun({
    id: "r1", project: "proj", repo: join(data, "repo"), base: "main", task: "t", createdAt: new Date().toISOString(),
    nodes: buildTree({
      runId: "r1", project: "proj", dataDir: data, defaultAgent: "claude",
      plan: { title: "root", prompt: "root", children: [{ title: "leaf", prompt: "leaf" }] },
    }),
  });
  store.close();
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await removeRepo(data);
});

function io(env: Record<string, string>, stdin = ""): CliIo {
  return {
    env: { RIVET_DATA_DIR: data, RIVET_RUN_FILE: runFile, ...env },
    cwd: data,
    readStdin: async () => stdin,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
}

function query(sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(data, "rivet.db"));
  try { return db.prepare(sql).all() as Record<string, unknown>[]; }
  finally { db.close(); }
}

async function up(): Promise<void> {
  daemon = await startDaemon({ data, runFile, port: 0 });
}

describe("rivet hooks", () => {
  it("posts the derived state and the agent's own session id", async () => {
    await up();
    const code = await runCli(["hooks", "claude-code", "permission-request"],
      io({ RIVET_SESSION_ID: "r1-root.1" }, JSON.stringify({ session_id: "conv-9" })));
    expect(code).toBe(0);
    expect(query("SELECT activity, agent_session_id FROM nodes WHERE id = 'root.1'")).toEqual([
      { activity: "blocked", agent_session_id: "conv-9" },
    ]);
  });

  it("does nothing outside a Rivet session", async () => {
    let read = false;
    const code = await runCli(["hooks", "claude-code", "stop"], {
      ...io({}), env: { RIVET_DATA_DIR: data, RIVET_RUN_FILE: runFile }, readStdin: async () => { read = true; return ""; },
    });
    expect(code).toBe(0);
    expect(read).toBe(false);
  });

  it("exits 0 and logs when the daemon is down", async () => {
    const code = await runCli(["hooks", "claude-code", "stop"], io({ RIVET_SESSION_ID: "r1-root.1" }, "{}"));
    expect(code).toBe(0);
    const log = await readFile(join(data, "hooks.log"), "utf8");
    expect(log).toMatch(/claude-code stop r1-root\.1 .*not running/);
  });

  it("tolerates a payload that is not JSON", async () => {
    await up();
    expect(await runCli(["hooks", "claude-code", "stop"], io({ RIVET_SESSION_ID: "r1-root.1" }, "garbage"))).toBe(0);
    expect(query("SELECT activity FROM nodes WHERE id = 'root.1'")).toEqual([{ activity: "idle" }]);
  });

  it("keeps the hook log under 1 MiB", async () => {
    await writeFile(join(data, "hooks.log"), "x".repeat(1024 * 1024 + 10));
    await runCli(["hooks", "claude-code", "stop"], io({ RIVET_SESSION_ID: "r1-root.1" }, "{}"));
    const log = await readFile(join(data, "hooks.log"), "utf8");
    expect(log.length).toBeLessThan(1024);
  });

  it("is a usage error without agent and event", async () => {
    expect(await runCli(["hooks", "claude-code"], io({ RIVET_SESSION_ID: "r1-root.1" }))).toBe(2);
  });
});

describe("rivet report", () => {
  it("records a structured report for the current session", async () => {
    await up();
    expect(await runCli(["report", "--done", "--note", "login works"], io({ RIVET_SESSION_ID: "r1-root.1" }))).toBe(0);
    expect(query("SELECT node_id, kind, message FROM reports")).toEqual([
      { node_id: "root.1", kind: "done", message: "login works" },
    ]);
  });

  it.each([
    [["report", "--note", "x"]],
    [["report", "--done"]],
    [["report", "--done", "--stuck", "--note", "x"]],
    [["report", "--done", "--note", "y".repeat(1001)]],
    [["report", "free text"]],
  ])("rejects %j as a usage error", async (argv) => {
    expect(await runCli(argv, io({ RIVET_SESSION_ID: "r1-root.1" }))).toBe(2);
  });

  it("needs RIVET_SESSION_ID", async () => {
    expect(await runCli(["report", "--stuck", "--note", "x"], io({}))).toBe(2);
    expect(err.join("\n")).toMatch(/RIVET_SESSION_ID/);
  });

  it("fails clearly when the daemon is down", async () => {
    expect(await runCli(["report", "--stuck", "--note", "x"], io({ RIVET_SESSION_ID: "r1-root.1" }))).toBe(1);
    expect(err.join("\n")).toMatch(/daemon is not running/);
  });
});

describe("rivet send", () => {
  it("queues a message from the current session", async () => {
    await up();
    expect(await runCli(["send", "--session", "r1-root.1", "--message", "rebase please"], io({ RIVET_SESSION_ID: "r1-root" }))).toBe(0);
    expect(query("SELECT node_id, from_session, message FROM outbox")).toEqual([
      { node_id: "root.1", from_session: "r1-root", message: "rebase please" },
    ]);
  });

  it("requires --session and --message", async () => {
    expect(await runCli(["send", "--message", "x"], io({}))).toBe(2);
    expect(await runCli(["send", "--session", "r1-root.1"], io({}))).toBe(2);
  });

  it("reports a daemon error", async () => {
    await up();
    expect(await runCli(["send", "--session", "r1-nope", "--message", "x"], io({}))).toBe(1);
    expect(err.join("\n")).toMatch(/unknown session/);
  });
});

describe("rivet (top level)", () => {
  it("prints usage for no or unknown commands", async () => {
    expect(await runCli([], io({}))).toBe(2);
    expect(await runCli(["fly"], io({}))).toBe(2);
    expect(err.join("\n")).toMatch(/usage: rivet/);
  });

  it("daemon status reports a running daemon and its absence", async () => {
    expect(await runCli(["daemon", "status"], io({}))).toBe(1);
    await up();
    expect(await runCli(["daemon", "status"], io({}))).toBe(0);
    expect(out.join("\n")).toMatch(/running \(pid \d+, port \d+\)/);
    expect(existsSync(runFile)).toBe(true);
  });
});

describe("run, status, resume, clean, project", () => {
  let repo: string;
  beforeEach(async () => {
    const { makeRepo } = await import("./helpers.js");
    repo = await makeRepo();
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    const { waitForTrash } = await import("../src/worktree.js");
    await waitForTrash();
    await removeRepo(repo);
  });

  const inRepo = (env: Record<string, string> = {}): CliIo => ({ ...io(env), cwd: repo });

  async function waitForRoot(runId: string, status: string): Promise<void> {
    const end = Date.now() + 20_000;
    for (;;) {
      out = [];
      await runCli(["status", runId], inRepo());
      if (out.join("\n").includes(`root  ${status}`) || out[0]?.includes(`root: ${status}`)) return;
      if (Date.now() > end) throw new Error(out.join("\n"));
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("runs a plan file end to end and shows the tree", async () => {
    daemon = await startDaemon({ data, runFile, port: 0 });
    const plan = join(data, "plan.json");
    await writeFile(plan, JSON.stringify({
      title: "root", prompt: "r", children: [
        { title: "add a", prompt: JSON.stringify({ files: { "a.txt": "a" }, commit: "a" }), agent: "fake" },
        { title: "add b", prompt: JSON.stringify({ files: { "b.txt": "b" }, commit: "b" }), agent: "fake" },
      ],
    }));
    expect(await runCli(["run", "--plan", plan, "add", "two", "files"], inRepo())).toBe(0);
    const runId = /run (r\w+) started/.exec(out.join("\n"))![1]!;
    await waitForRoot(runId, "done");
    expect(out.join("\n")).toMatch(/root\.1 +add a +done/);
    out = [];
    expect(await runCli(["status"], inRepo())).toBe(0);
    expect(out.join("\n")).toMatch(new RegExp(`${runId} +done +add two files`));
    out = [];
    expect(await runCli(["clean", runId], inRepo())).toBe(0);
    expect(out.join("\n")).toMatch(/removed 3 worktrees/);
  });

  it("sets and shows project settings for the repo it runs in", async () => {
    daemon = await startDaemon({ data, runFile, port: 0 });
    expect(await runCli(["project", "set", "check", "npm run typecheck"], inRepo())).toBe(0);
    out = [];
    expect(await runCli(["project", "get"], inRepo())).toBe(0);
    expect(out.join("\n")).toMatch(/check += npm run typecheck/);
    expect(await runCli(["project", "unset", "check"], inRepo())).toBe(0);
    expect(await runCli(["project", "set", "colour", "red"], inRepo())).toBe(1);
  });

  it("run needs a readable plan and a task", async () => {
    daemon = await startDaemon({ data, runFile, port: 0 });
    expect(await runCli(["run", "--plan", join(data, "missing.json"), "task"], inRepo())).toBe(1);
    expect(await runCli(["run"], inRepo())).toBe(2);
    expect(await runCli(["plan"], inRepo())).toBe(2);
    expect(await runCli(["resume"], inRepo())).toBe(2);
    expect(await runCli(["resume", "r404"], inRepo())).toBe(1);
  });
});

describe("planning from the CLI", () => {
  let repo: string;
  beforeEach(async () => {
    const { makeRepo } = await import("./helpers.js");
    repo = await makeRepo();
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    const { waitForTrash } = await import("../src/worktree.js");
    await waitForTrash();
    await removeRepo(repo);
  });

  const plan = {
    title: "root", prompt: "r", children: [
      { title: "a", prompt: JSON.stringify({ files: { "a.txt": "a" }, commit: "a" }), agent: "fake", files: ["a.txt"] },
    ],
  };
  const withPlanner = (answers: string[], ask?: string): CliIo => ({
    ...io({}), cwd: repo,
    planner: () => async () => answers.shift() ?? "",
    ...(ask !== undefined ? { ask: async () => ask } : {}),
  });

  it("plan previews the tree and saves it", async () => {
    expect(await runCli(["plan", "add", "a"], withPlanner([JSON.stringify(plan)]))).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/root root +\(integrates\)/);
    expect(text).toMatch(/root\.1 a +\(leaf, fake\) +files: a\.txt/);
    const saved = /plan saved to (.+)/.exec(text)![1]!;
    expect(JSON.parse(await readFile(saved, "utf8"))).toEqual(plan);
  });

  it("run without a plan asks, and starts on yes", async () => {
    daemon = await startDaemon({ data, runFile, port: 0 });
    expect(await runCli(["run", "add", "a"], withPlanner([JSON.stringify(plan)], "y"))).toBe(0);
    expect(out.join("\n")).toMatch(/run r\w+ started/);
  });

  it("edit and no do not start; no terminal needs --yes", async () => {
    daemon = await startDaemon({ data, runFile, port: 0 });
    expect(await runCli(["run", "t"], withPlanner([JSON.stringify(plan)], "e"))).toBe(0);
    expect(out.join("\n")).toMatch(/edit .*plan-\d+\.json, then: rivet run --plan/);
    expect(await runCli(["run", "t"], withPlanner([JSON.stringify(plan)], "n"))).toBe(0);
    expect(await runCli(["run", "t"], withPlanner([JSON.stringify(plan)]))).toBe(1);
    expect(out.join("\n")).not.toMatch(/started/);
    expect(await runCli(["run", "--yes", "t"], withPlanner([JSON.stringify(plan)]))).toBe(0);
    expect(out.join("\n")).toMatch(/started/);
  });

  it("warns when planned files overlap a run in flight", async () => {
    daemon = await startDaemon({ data, runFile, port: 0 });
    const busy = { title: "root", prompt: "r", children: [
      { title: "busy", prompt: JSON.stringify({ stayFor: 60_000 }), agent: "fake", files: ["a.txt"] },
    ] };
    expect(await runCli(["run", "--yes", "first"], withPlanner([JSON.stringify(busy)]))).toBe(0);
    out = [];
    expect(await runCli(["plan", "second"], withPlanner([JSON.stringify(plan)]))).toBe(0);
    expect(out.join("\n")).toMatch(/warning: a\.txt overlaps a\.txt \(run r\w+, root\.1\)/);
  });

  it("reports a plan that stays invalid", async () => {
    expect(await runCli(["plan", "t"], withPlanner(["nonsense", "still nonsense"]))).toBe(1);
    expect(err.join("\n")).toMatch(/still invalid after one fix attempt/);
  });
});

describe("attach and panes", () => {
  let repo: string;
  beforeEach(async () => {
    const { makeRepo } = await import("./helpers.js");
    repo = await makeRepo();
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    const { waitForTrash } = await import("../src/worktree.js");
    await waitForTrash();
    await removeRepo(repo);
  });

  it("streams a session's screen until it ends", async () => {
    daemon = await startDaemon({ data, runFile, port: 0 });
    const planFile = join(data, "p.json");
    await writeFile(planFile, JSON.stringify({ title: "solo", agent: "fake", prompt: JSON.stringify({ files: { "x.txt": "x" }, stayFor: 300 }) }));
    const raw: string[] = [];
    const cli: CliIo = { ...io({}), cwd: repo, raw: (c) => raw.push(c) };
    expect(await runCli(["run", "--plan", planFile, "solo"], cli)).toBe(0);
    const runId = /run (r\w+) started/.exec(out.join("\n"))![1]!;
    expect(await runCli(["attach", `${runId}-root`], cli)).toBe(0);
    expect(raw.join("")).toContain("wrote x.txt");
    expect(err.join("\n")).toMatch(/session .* ended/);
  });

  it("attach and panes explain what is missing", async () => {
    daemon = await startDaemon({ data, runFile, port: 0 });
    expect(await runCli(["attach"], io({}))).toBe(2);
    expect(await runCli(["attach", "r1-root.1"], io({}))).toBe(1);
    expect(err.join("\n")).toMatch(/has not been started/);
    expect(await runCli(["panes", "r1"], io({}))).toBe(1);
    expect(out.join("\n")).toMatch(/no agent of run r1 is running/);
  });
});
