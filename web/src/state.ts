import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { ApiError, onChanged, type RunRow } from "./api";

export type Field = { name: string; label: string; value?: string; type?: "text" | "number" | "textarea" | "select" | "check"; options?: string[]; hint?: string };
export type Ask = { title: string; note?: string; fields?: Field[]; danger?: boolean; confirm: string; run(values: Record<string, string>): Promise<unknown> };
export type Screen = "new" | "tasks" | "search" | "routines" | "snippets" | "settings" | "health" | "radar" | null;

type State = {
  runs: RunRow[]; selected: string | null; beside: string | null; screen: Screen; ask: Ask | null; palette: boolean;
  toast: { text: string; bad: boolean } | null; repo: string;
  set(p: Partial<State>): void;
};

const params = new URLSearchParams(location.search);
function savedRepo(): string {
  const given = params.get("repo");
  try {
    if (given) localStorage.setItem("rivet.repo", given);
    return given ?? localStorage.getItem("rivet.repo") ?? "";
  } catch { return given ?? ""; }
}

export const useApp = create<State>((set) => ({
  runs: [], selected: params.get("run"), beside: null, screen: null, ask: null, palette: false, toast: null, repo: savedRepo(),
  set: (p) => set(p),
}));

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, bad = false): void {
  useApp.getState().set({ toast: { text, bad } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => useApp.getState().set({ toast: null }), bad ? 9000 : 3500);
}

// Runs an action and reports how it went; returns false when it failed.
export async function act(work: () => Promise<unknown>, done?: string): Promise<boolean> {
  try {
    await work();
    if (done) toast(done);
    return true;
  } catch (e) {
    toast(e instanceof ApiError || e instanceof Error ? e.message : "that did not work", true);
    return false;
  }
}

// Data that follows the daemon: fetched now, and again whenever stored state moves.
// A fetch in flight is followed by one more, so the last change is never missed.
export function useLive<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | undefined; reload(): void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const latest = useRef(load);
  latest.current = load;
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let closed = false; let busy = false; let again = false;
    setData(undefined);
    setError(undefined);
    const run = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        const value = await latest.current();
        if (!closed) { setData(value); setError(undefined); }
      } catch (e) {
        if (!closed) setError((e as Error).message);
      }
      busy = false;
      if (again && !closed) { again = false; void run(); }
    };
    reload.current = () => { void run(); };
    void run();
    const off = onChanged(() => { void run(); });
    return () => { closed = true; off(); };
  }, deps);
  return { data, error, reload: () => reload.current() };
}

export const runLabel = (r: { id: string; name: string; task: string }) => r.name || r.task.split("\n")[0]?.slice(0, 60) || r.id;
export const ago = (at: string | undefined) => {
  if (!at) return "";
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
export const repoName = (repo: string) => repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
