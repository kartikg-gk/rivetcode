import { describe, expect, it } from "vitest";
import { addPaneArgs, panesPlan } from "../src/cli/panes.js";

const sessions = [{ id: "r1-root.1", title: "api" }, { id: "r1-root.2", title: "ui" }, { id: "r1-root.3", title: "docs" }];

describe("addPaneArgs", () => {
  it("opens the first session as the shared window's tab and splits the next beside it", () => {
    const s = { id: "r1-agent", title: "worker x" };
    expect(addPaneArgs("rivet.cmd", s, true)).toEqual(["-w", "rivet", "new-tab", "--title", "worker x", "cmd", "/k", "rivet.cmd", "attach", "r1-agent"]);
    expect(addPaneArgs("rivet.cmd", s, false).slice(0, 4)).toEqual(["-w", "rivet", "split-pane", "-V"]);
  });
});

describe("panesPlan", () => {
  it("splits one Windows Terminal window", () => {
    expect(panesPlan({ platform: "win32", rivet: "C:\\r\\rivet.cmd", runId: "r1", sessions, have: () => true })).toEqual({
      kind: "wt", file: "wt", args: [
        "-w", "new", "new-tab", "--title", "api", "cmd", "/k", "C:\\r\\rivet.cmd", "attach", "r1-root.1",
        ";", "split-pane", "-V", "--title", "ui", "cmd", "/k", "C:\\r\\rivet.cmd", "attach", "r1-root.2",
        ";", "split-pane", "-H", "--title", "docs", "cmd", "/k", "C:\\r\\rivet.cmd", "attach", "r1-root.3",
      ],
    });
  });

  it("tiles a tmux session elsewhere", () => {
    const plan = panesPlan({ platform: "linux", rivet: "/opt/rivet", runId: "r1", sessions: sessions.slice(0, 2), have: (t) => t === "tmux" });
    expect(plan).toEqual({ kind: "tmux", steps: [
      ["new-session", "-d", "-s", "rivet-r1", "-n", "agents", "'/opt/rivet' attach 'r1-root.1'"],
      ["split-window", "-t", "rivet-r1", "'/opt/rivet' attach 'r1-root.2'"],
      ["select-layout", "-t", "rivet-r1", "tiled"],
      ["attach-session", "-t", "rivet-r1"],
    ] });
  });

  it("prints the attach commands when no multiplexer is around", () => {
    expect(panesPlan({ platform: "linux", rivet: "rivet", runId: "r1", sessions: sessions.slice(0, 1), have: () => false }))
      .toEqual({ kind: "print", lines: ["rivet attach r1-root.1    # api"] });
  });
});
