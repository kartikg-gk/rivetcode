import { describe, expect, it } from "vitest";
import { capDelegatedPermission } from "../src/scheduler/scheduler.js";

describe("delegated permissions", () => {
  it("keeps a read-only parent read-only across providers", () => {
    expect(capDelegatedPermission("claude", "read-only", "codex", "bypass-permissions")).toBe("read-only");
  });
  it("does not treat a Codex default child as restricted", () => {
    expect(capDelegatedPermission("codex", "accept-edits", "codex", "default")).toBe("accept-edits");
  });
  it("preserves stricter requests and caps broader same-provider requests", () => {
    expect(capDelegatedPermission("claude", "accept-edits", "claude", "default")).toBe("default");
    expect(capDelegatedPermission("claude", "default", "claude", "auto")).toBe("default");
  });
});
