import { randomBytes } from "node:crypto";

export type CleanupResult = { removed: string[]; kept: string[]; detached?: boolean };
export type CleanupJob = { id: string; runId: string; state: "queued" | "running" | "completed" | "failed"; result?: CleanupResult; error?: { status: number; message: string } };

// The HTTP request schedules work; the daemon retains ownership until it finishes.
export function cleanupQueue(work: (runId: string) => Promise<CleanupResult>) {
  const jobs = new Map<string, CleanupJob>();
  const pending = new Set<Promise<void>>();
  let closed = false;
  return {
    submit(runId: string): CleanupJob {
      if (closed) throw new Error("cleanup queue is shutting down");
      const existing = [...jobs.values()].find((j) => j.runId === runId && ["queued", "running"].includes(j.state));
      if (existing) return { ...existing };
      for (const [id, job] of jobs) if (jobs.size >= 100 && ["completed", "failed"].includes(job.state)) jobs.delete(id);
      const job: CleanupJob = { id: randomBytes(12).toString("hex"), runId, state: "queued" };
      jobs.set(job.id, job);
      const task = Promise.resolve().then(async () => {
        job.state = "running";
        try { job.result = await work(runId); job.state = "completed"; }
        catch (e) {
          const status = e && typeof e === "object" && "status" in e && typeof e.status === "number" ? e.status : 500;
          job.error = { status, message: e instanceof Error ? e.message : "cleanup failed" }; job.state = "failed";
        }
      }).finally(() => pending.delete(task));
      pending.add(task);
      return { ...job };
    },
    get(id: string): CleanupJob | undefined { const job = jobs.get(id); return job ? { ...job } : undefined; },
    async close() { closed = true; await Promise.all([...pending]); },
  };
}
