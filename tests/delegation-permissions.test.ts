import { describe, expect, it } from "vitest";
import { capDelegatedPermission } from "../src/scheduler/scheduler.js";

describe("delegated permissions", () => {
  it("lets another agent work at the parent level, never broader", () => {
    expect(capDelegatedPermission("claude", "edits", "delta", "edits")).toBe("edits");
    expect(capDelegatedPermission("delta", "edits", "claude", "auto")).toBe("edits");
    expect(capDelegatedPermission("claude", "default", "codex", "default")).toBe("read-only");
    expect(capDelegatedPermission("claude", "edits", "codex", "default")).toBe("edits");
  });
  it("keeps a read-only parent read-only across providers", () => {
    expect(capDelegatedPermission("claude", "read-only", "codex", "full")).toBe("read-only");
  });
  it("does not treat a Codex default child as restricted", () => {
    expect(capDelegatedPermission("codex", "edits", "codex", "default")).toBe("edits");
  });
  it("preserves stricter requests and caps broader same-provider requests", () => {
    expect(capDelegatedPermission("claude", "edits", "claude", "default")).toBe("default");
    expect(capDelegatedPermission("claude", "default", "claude", "auto")).toBe("default");
  });
});
