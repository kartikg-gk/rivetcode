import { describe, expect, it } from "vitest";
import { panesPlan } from "../src/cli/panes.js";

const sessions = [{ id: "r1-root.1", title: "api" }, { id: "r1-root.2", title: "ui" }, { id: "r1-root.3", title: "docs" }];

describe("panesPlan", () => {
  it("splits one Windows Terminal window", () => {
    expect(panesPlan({ platform: "win32", rivet: "C:\\r\\rivet.cmd", runId: "r1", sessions, have: () => true })).toEqual({
      kind: "wt", file: "wt", args: [
        "-w", "new", "new-tab", "--title", "api", "C:\\r\\rivet.cmd", "attach", "r1-root.1",
        ";", "split-pane", "-V", "--title", "ui", "C:\\r\\rivet.cmd", "attach", "r1-root.2",
        ";", "split-pane", "-H", "--title", "docs", "C:\\r\\rivet.cmd", "attach", "r1-root.3",
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
