import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Local models served by Ollama. Through its OpenAI-style endpoint, which delta uses, a model
// runs with whatever context its own settings give it (4096 tokens unless set), and Ollama
// drops the start of a longer prompt without saying so. Rivet runs delta on a copy of the
// model with a larger context (a copy shares the original's weights, so it costs no disk)
// and tells delta that size, so delta compacts before the model loses anything.

export const LOCAL_CONTEXT = 32_768;

type Fetch = typeof fetch;
type Shown = { capabilities?: string[]; model_info?: Record<string, unknown>; parameters?: string };

export function ollamaBase(env: Record<string, string | undefined>): string {
  const host = env.OLLAMA_HOST?.trim();
  if (!host) return "http://127.0.0.1:11434";
  const url = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return url.replace(/\/+$/, "").replace(/\/\/0\.0\.0\.0(?=[:/]|$)/, "//127.0.0.1");
}

async function call<T>(base: string, path: string, body: unknown, f: Fetch): Promise<T> {
  const r = await f(base + path, body === undefined ? { signal: AbortSignal.timeout(10_000) }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const text = await r.text();
  if (!r.ok) {
    let said = text;
    try { said = String((JSON.parse(text) as { error?: unknown }).error ?? text); } catch { /* plain text */ }
    throw new Error(`Ollama ${path}: ${said.trim() || r.status}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const show = (base: string, model: string, f: Fetch) => call<Shown>(base, "/api/show", { model }, f);

// The context the model was trained for, when Ollama reports it.
function trained(s: Shown): number | undefined {
  for (const [k, v] of Object.entries(s.model_info ?? {})) if (k.endsWith(".context_length") && typeof v === "number" && v > 0) return v;
  return undefined;
}

// The context the model's own settings give it, when they set one.
function configured(s: Shown): number | undefined {
  const m = /^num_ctx\s+(\d+)/m.exec(s.parameters ?? "");
  return m ? Number(m[1]) : undefined;
}

// Rivet's copies are named after the model they copy, under rivet/.
export function copyName(model: string, window: number): string {
  return `rivet/${model.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}:${Math.round(window / 1024)}k`;
}

// The models pulled into Ollama that can call tools (delta's work is all tool calls); Rivet's
// own copies are left out. Empty when Ollama is not running.
export async function ollamaModels(env: Record<string, string | undefined>, f: Fetch = fetch): Promise<string[]> {
  const base = ollamaBase(env);
  let names: string[];
  try { names = ((await call<{ models?: { name?: string }[] }>(base, "/api/tags", undefined, f)).models ?? []).map((m) => m.name ?? "").filter((n) => n && !n.startsWith("rivet/")); }
  catch { return []; }
  const usable = await Promise.all(names.map(async (n) => {
    try { return (await show(base, n, f)).capabilities?.includes("tools") ? n : null; } catch { return null; }
  }));
  return usable.filter((n): n is string => n !== null).sort();
}

// The model delta should run and the context it has. A model whose own settings already give
// it enough context runs as it is; any other runs as a copy with a larger one.
export async function localModel(model: string, env: Record<string, string | undefined>, f: Fetch = fetch): Promise<{ model: string; window: number }> {
  const base = ollamaBase(env);
  const original = await show(base, model, f);
  const want = Math.min(LOCAL_CONTEXT, trained(original) ?? LOCAL_CONTEXT);
  const own = configured(original);
  if (own !== undefined && own >= want) return { model, window: own };
  const copy = copyName(model, want);
  const existing = await show(base, copy, f).catch(() => null);
  if (!existing || configured(existing) !== want) await call(base, "/api/create", { model: copy, from: model, parameters: { num_ctx: want }, stream: false }, f);
  return { model: copy, window: want };
}

// Delta reads a model's context from its catalog file. Rivet hands it a copy of the user's own
// catalog with this model added, so delta's other settings are kept.
export function catalogWith(dir: string, model: string, window: number, env: Record<string, string | undefined>): string {
  const own = env.DELTA_CATALOG || join(env.DELTA_HOME || join(homedir(), ".delta"), "catalog.toml");
  const before = existsSync(own) ? readFileSync(own, "utf8") : "";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "catalog.toml");
  writeFileSync(file, `${before}${before && !before.endsWith("\n") ? "\n" : ""}\n[[models]]\nprovider = "ollama"\nid = ${JSON.stringify(model)}\ncontext_window = ${window}\n`);
  return file;
}
