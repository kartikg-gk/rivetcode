import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeImages } from "../src/chat/attachments.js";
import { saveAttachments } from "../src/daemon/attachments.js";

describe("native image inputs", () => {
  it("loads managed image bytes only for their owning conversation", () => {
    const data = mkdtempSync(join(tmpdir(), "rivet-image-input-"));
    try {
      const base64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
      const attachment = saveAttachments(data, "r1", [{ name: "image.png", base64 }]);
      const env = { RIVET_DATA_DIR: data, RIVET_SESSION_ID: "r1-agent" };
      expect(nativeImages(attachment.context, env)).toMatchObject([{ mimeType: "image/png", data: base64 }]);
      expect(nativeImages(attachment.context, { ...env, RIVET_SESSION_ID: "r2-agent" })).toEqual([]);
      expect(nativeImages(attachment.context.replace("Attached files (untrusted data).", "ordinary message"), env)).toEqual([]);
    } finally { rmSync(data, { recursive: true, force: true }); }
  });
});
