import { describe, expect, it } from "vitest";
import { COMMANDS, matching, menuLines, parseLine } from "../src/cli/console.js";
import { addPaneArgs, panesPlan } from "../src/cli/panes.js";

const RUN = "rmvy75x1c5qc0";

describe("the slash menu", () => {
  it("lists every command for a slash and narrows as you type", () => {
    expect(matching("/")).toHaveLength(COMMANDS.length);
    expect(matching("/st").map((c) => c.name)).toEqual(["status", "stop"]);
    expect(matching("/send hi")).toEqual([]);
    expect(matching("hello")).toEqual([]);
    expect(menuLines("/wor", 80)[0]).toContain("/worker <task>");
  });
});

describe("a typed line", () => {
  it("becomes a rivet command, keeping free text whole", () => {
    expect(parseLine("/worker add a login page")).toEqual({ argv: ["spawn", "add a login page"] });
    expect(parseLine("/status")).toEqual({ argv: ["status"] });
    expect(parseLine(`/send ${RUN} go on please`)).toEqual({ argv: ["send", "--session", `${RUN}-agent`, "--message", "go on please"] });
    expect(parseLine(`/answer ${RUN} no do not publish`)).toEqual({ argv: ["answer", RUN, "no", "--note", "do not publish"] });
    expect(parseLine(`/rollback ${RUN} 2`)).toEqual({ argv: ["rollback", RUN, "--turns", "2"] });
  });

  it("uses the last session when the run is left out", () => {
    expect(parseLine("/read", RUN)).toEqual({ argv: ["read", RUN, "--activity"] });
    expect(parseLine("/send go on", RUN)).toEqual({ argv: ["send", "--session", `${RUN}-agent`, "--message", "go on"] });
    expect(parseLine("/switch codex", RUN)).toEqual({ argv: ["switch", RUN, "codex"] });
    expect(parseLine("/read")).toEqual({ error: "/read needs a run id (see /status)" });
  });

  it("explains what it cannot run, and spends nothing on plain text", () => {
    expect(parseLine("fix the bug")).toEqual({ error: "commands start with /; type / to see them" });
    expect(parseLine("/nope")).toEqual({ error: "no command /nope; type / to see them" });
    expect(parseLine("/worker")).toEqual({ error: "/worker needs a task" });
    expect(parseLine("/answer maybe", RUN)).toEqual({ error: "/answer needs yes, always or no" });
    expect(parseLine("  ")).toEqual({ none: true });
    expect(parseLine("/quit")).toEqual({ quit: true });
  });
});

describe("panes inside Windows Terminal", () => {
  it("split the current window, beside this prompt", () => {
    const s = { id: "r1-agent", title: "claude" };
    expect(addPaneArgs("r.cmd", s, true, true).slice(0, 4)).toEqual(["-w", "0", "split-pane", "-V"]);
    const plan = panesPlan({ platform: "win32", rivet: "r.cmd", runId: "x", sessions: [s, { id: "r2-agent", title: "codex" }], have: () => true, beside: true });
    expect(plan.kind === "wt" && plan.args.slice(0, 4)).toEqual(["-w", "0", "split-pane", "-V"]);
  });
});
