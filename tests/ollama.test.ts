import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogWith, copyName, localModel, ollamaBase, ollamaModels } from "../src/chat/ollama.js";

type Model = { capabilities?: string[]; context?: number; numCtx?: number };

// An Ollama that knows the given models and records what it was asked to create.
function fakeOllama(models: Record<string, Model>, opts: { down?: boolean } = {}) {
  const created: Record<string, unknown>[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    if (opts.down) throw new Error("connect ECONNREFUSED");
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status });
    if (path === "/api/tags") return json(200, { models: Object.keys(models).map((name) => ({ name })) });
    if (path === "/api/show") {
      const m = models[String(body.model)];
      if (!m) return json(404, { error: `model '${String(body.model)}' not found` });
      return json(200, { capabilities: m.capabilities ?? ["completion"], model_info: m.context ? { "qwen3.context_length": m.context } : {},
        ...(m.numCtx ? { parameters: `temperature 0.6\nnum_ctx ${m.numCtx}` } : {}) });
    }
    if (path === "/api/create") {
      created.push(body);
      const params = body.parameters as { num_ctx: number };
      models[String(body.model)] = { ...models[String(body.from)], numCtx: params.num_ctx };
      return json(200, { status: "success" });
    }
    return json(404, { error: "no route" });
  }) as typeof fetch;
  return { f, created };
}

describe("Ollama's address", () => {
  it("defaults to the local server and follows OLLAMA_HOST", () => {
    expect(ollamaBase({})).toBe("http://127.0.0.1:11434");
    expect(ollamaBase({ OLLAMA_HOST: "0.0.0.0:11500" })).toBe("http://127.0.0.1:11500");
    expect(ollamaBase({ OLLAMA_HOST: "https://box.lan:443/" })).toBe("https://box.lan:443");
  });
});

describe("local models offered to delta", () => {
  it("are the pulled models that can call tools, without Rivet's copies", async () => {
    const { f } = fakeOllama({
      "qwen3:4b": { capabilities: ["completion", "tools"] },
      "smollm:latest": { capabilities: ["completion"] },
      "rivet/qwen3-4b:32k": { capabilities: ["completion", "tools"] },
      "llama3.2:3b": { capabilities: ["completion", "tools"] },
    });
    expect(await ollamaModels({}, f)).toEqual(["llama3.2:3b", "qwen3:4b"]);
  });

  it("are none when Ollama is not running", async () => {
    expect(await ollamaModels({}, fakeOllama({}, { down: true }).f)).toEqual([]);
  });
});

describe("a local model's context", () => {
  it("is raised on a copy of the model, capped by what it was trained for", async () => {
    const { f, created } = fakeOllama({ "qwen3:4b": { capabilities: ["tools"], context: 40_960 } });
    expect(await localModel("qwen3:4b", {}, f)).toEqual({ model: "rivet/qwen3-4b:32k", window: 32_768 });
    expect(created).toEqual([{ model: "rivet/qwen3-4b:32k", from: "qwen3:4b", parameters: { num_ctx: 32_768 }, stream: false }]);
    // The copy is made once.
    await localModel("qwen3:4b", {}, f);
    expect(created).toHaveLength(1);
  });

  it("is the trained size when that is smaller", async () => {
    const { f } = fakeOllama({ "tiny:1b": { context: 8_192 } });
    expect(await localModel("tiny:1b", {}, f)).toEqual({ model: "rivet/tiny-1b:8k", window: 8_192 });
  });

  it("is left alone when the model's own settings give it enough", async () => {
    const { f, created } = fakeOllama({ "mine:latest": { context: 131_072, numCtx: 65_536 } });
    expect(await localModel("mine:latest", {}, f)).toEqual({ model: "mine:latest", window: 65_536 });
    expect(created).toEqual([]);
  });

  it("fails with Ollama's own reason for an unknown model", async () => {
    await expect(localModel("nope", {}, fakeOllama({}).f)).rejects.toThrow("model 'nope' not found");
  });

  it("names copies safely", () => {
    expect(copyName("hf.co/User/Some_Model-GGUF:Q4_K_M", 32_768)).toBe("rivet/hf.co-user-some_model-gguf-q4_k_m:32k");
  });
});

describe("the catalog delta is given", () => {
  it("keeps the user's own catalog and adds the local model's context", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-catalog-"));
    const own = join(dir, "own.toml");
    writeFileSync(own, '[providers.together]\nbase_url = "https://x/v1"');
    const file = catalogWith(join(dir, "session"), "rivet/qwen3-4b:32k", 32_768, { DELTA_CATALOG: own });
    expect(readFileSync(file, "utf8")).toBe('[providers.together]\nbase_url = "https://x/v1"\n\n[[models]]\nprovider = "ollama"\nid = "rivet/qwen3-4b:32k"\ncontext_window = 32768\n');
  });

  it("is just the local model when the user has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "rivet-catalog-"));
    const file = catalogWith(dir, "qwen3:4b", 8_192, { DELTA_HOME: join(dir, "nohome") });
    expect(readFileSync(file, "utf8")).toBe('\n[[models]]\nprovider = "ollama"\nid = "qwen3:4b"\ncontext_window = 8192\n');
  });
});
