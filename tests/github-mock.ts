import { createServer, type Server } from "node:http";

// A tiny stand-in for the GitHub REST API, enough for Rivet's PR flow.
export type MockPr = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  mergeable_state: string;
  head: { sha: string; ref: string };
  base: string;
  title: string;
  body: string;
  requested_reviewers: unknown[];
};

export type MockGitHub = {
  api: string;
  prs: MockPr[];
  checks: Record<string, { id: number; status: string; conclusion: string | null }[]>;
  annotations: Record<number, { path: string }[]>;
  reviews: Record<number, { user: { login: string }; state: string }[]>;
  comments: Record<number, { commit_id: string; path: string; line: number | null; body: string }[]>;
  requests: string[];
  close(): Promise<void>;
};

export async function mockGitHub(repo = "o/r"): Promise<MockGitHub> {
  const state: Omit<MockGitHub, "api" | "close"> = { prs: [], checks: {}, annotations: {}, reviews: {}, comments: {}, requests: [] };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      state.requests.push(`${req.method} ${req.url}`);
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== "Bearer t0ken") return send(401, { message: "bad credentials" });
      const path = (req.url ?? "").replace(`/repos/${repo}`, "").split("?")[0]!;
      let m: RegExpExecArray | null;
      if (req.method === "POST" && path === "/pulls") {
        const input = JSON.parse(body);
        const pr: MockPr = {
          number: state.prs.length + 1, state: "open", merged: false, draft: false, mergeable_state: "unknown",
          head: { sha: "sha1", ref: input.head }, base: input.base, title: input.title, body: input.body, requested_reviewers: [],
        };
        state.prs.push(pr);
        return send(201, { ...pr, html_url: `https://github.com/${repo}/pull/${pr.number}` });
      }
      if ((m = /^\/pulls\/(\d+)$/.exec(path))) {
        const pr = state.prs.find((p) => p.number === Number(m![1]));
        return pr ? send(200, { ...pr, html_url: `https://github.com/${repo}/pull/${pr.number}` }) : send(404, {});
      }
      if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(path))) return send(200, state.reviews[Number(m[1])] ?? []);
      if ((m = /^\/pulls\/(\d+)\/comments$/.exec(path))) return send(200, state.comments[Number(m[1])] ?? []);
      if ((m = /^\/commits\/([^/]+)\/check-runs$/.exec(path))) return send(200, { check_runs: state.checks[m[1]!] ?? [] });
      if ((m = /^\/commits\/([^/]+)\/status$/.exec(path))) return send(200, { state: "pending", statuses: [] });
      if ((m = /^\/check-runs\/(\d+)\/annotations$/.exec(path))) return send(200, state.annotations[Number(m[1])] ?? []);
      send(404, { message: "not mocked" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return Object.assign(state, {
    api: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}
