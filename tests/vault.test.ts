import { describe, expect, it } from "vitest";
import { vaultResolver } from "../src/daemon/vault.js";

describe("vault references", () => {
  it("caches one read per account/reference until refresh", async () => {
    let reads = 0;
    const vault = vaultResolver({ onepassword: async ({ account }) => `${account}-${++reads}` });
    const reference = { provider: "onepassword", account: "private", reference: "op://vault/item/field" };
    expect(await Promise.all([vault.read(reference), vault.read(reference)])).toEqual(["private-1", "private-1"]);
    expect(await vault.read({ ...reference, account: "work" })).toBe("work-2");
    vault.invalidate();
    expect(await vault.read(reference)).toBe("private-3");
  });

  it("rejects unknown providers without invoking a reader", async () => {
    await expect(vaultResolver({}).read({ provider: "unknown", account: "a", reference: "b" })).rejects.toThrow("Unsupported vault provider");
  });
});
