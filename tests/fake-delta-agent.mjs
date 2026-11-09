// Speaks delta's JSON-lines protocol (--mode rpc) well enough for Rivet's tests: each prompt
// is echoed back, one containing CRASH exits the way delta does when it breaks, one containing
// REFUSED ends with the model provider's error, and one containing RUN first asks to run a
// command and waits for the answer.
import { createInterface } from "node:readline";

const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const respond = (r, data = null) => send({ type: "response", command: r.type, success: true, id: r.id, data });
let approval = null;
let hostCall = null;

async function turn(message) {
  send({ type: "agent_start" });
  if (message.includes("CRASH")) { process.stderr.write("Traceback (most recent call last):\nopenai.APIConnectionError: Connection error.\n"); process.exit(1); }
  if (message.includes("REFUSED")) {
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "ollama request failed with status 500: out-of-memory" } });
    send({ type: "agent_end" });
    send({ type: "agent_settled", outcome: "failed", state: {} });
    return;
  }
  if (message.includes("RUN")) {
    send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash", args: { command: "npm publish" } });
    const allowed = await new Promise((resolve) => {
      approval = { id: "approval-1", resolve };
      send({ type: "approval_requested", approvalId: "approval-1", tool: "Bash", preview: JSON.stringify({ command: "npm publish" }) });
    });
    send({ type: "approval_resolved", approvalId: "approval-1", allow: allowed });
    send({ type: "tool_execution_end", toolCallId: "call-1", toolName: "Bash", result: { content: [{ type: "text", text: allowed ? "published" : "denied" }] }, isError: !allowed });
  }
  let told = "";
  if (message.includes("TOOL")) {
    const output = await new Promise((resolve) => {
      hostCall = resolve;
      send({ type: "host_tool_call", callId: "h1", name: "rivet_status", arguments: {} });
    });
    told = ` tool said: ${output.slice(0, 1)}`;
  }
  const reply = `echo: ${message.split("\n")[0]}${told}`;
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  send({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: reply.slice(0, 4) }] } });
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }], usage: { totalTokens: 12, input: 10, output: 2, cacheRead: 0 } } });
  send({ type: "agent_end" });
  send({ type: "agent_settled", outcome: "completed", state: {} });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.type === "get_state") respond(r, { sessionId: "fake-delta", sessionFile: "/sessions/fake-delta.jsonl" });
  else if (r.type === "get_session_stats") respond(r, { contextUsage: { tokens: 12, contextWindow: 1000 } });
  else if (r.type === "prompt") { respond(r); void turn(r.message); }
  else if (r.type === "respond_to_approval") { respond(r); approval?.resolve(r.allow); approval = null; }
  else if (r.type === "respond_to_host_tool") { respond(r); hostCall?.(r.isError ? `!${r.output}` : r.output); hostCall = null; }
  else if (r.type === "shutdown") { respond(r); process.exit(0); }
  else respond(r);
});
