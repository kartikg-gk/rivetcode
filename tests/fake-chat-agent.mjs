// A stand-in for an agent's chat protocol in tests: "acp" speaks the Agent Client Protocol
// (as Claude's adapter does), "codex" speaks Codex's app-server. Each prompt is answered
// with "echo: <text>" and one command; words in it script the rest:
//   ASK  - ask permission for "npm publish" first     RIVET - ask for "rivet status" (allowed)
//   SLOW - take 3 s, so a message can steer or interrupt it
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";

const protocol = process.argv[2];
const acp = protocol === "acp";
const out = (m) => process.stdout.write(JSON.stringify(acp ? { jsonrpc: "2.0", ...m } : m) + "\n");
let nextId = 100;
const asked = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; asked.set(id, resolve); out({ id, method, params }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let active = null; // { id, steered: [], cancelled }
let turns = 0;
let threadId = "th1";

async function partialReplyObserved(t) {
  const gate = process.env.RIVET_TEST_STREAM_GATE;
  if (!gate || t.id !== "turn-1") return sleep(200);
  // Let the integration reader prove it saw partial output before completing it.
  const deadline = Date.now() + 15000;
  while (!existsSync(gate)) {
    if (Date.now() > deadline) throw new Error("partial reply was not observed");
    await sleep(25);
  }
}

function update(u) { out({ method: "session/update", params: { sessionId: "s1", update: u } }); }

async function turn(text, finish) {
  const t = { id: `turn-${++turns}`, steered: [], cancelled: false };
  active = t;
  if (!acp && text.includes("LIMITFAIL")) {
    out({ method: "turn/started", params: { threadId: "th1", turn: { id: t.id, status: "inProgress" } } });
    out({ method: "turn/completed", params: { threadId: "th1", turn: { id: t.id, status: "failed", error: { message: "You've hit your usage limit." } } } });
    active = null;
    return finish(false);
  }
  if (!acp) out({ method: "turn/started", params: { threadId, turn: { id: t.id, status: "inProgress" } } });
  const command = text.includes("RIVET") ? "rivet status" : text.includes("ASK") ? "npm publish" : null;
  let allowed = true;
  if (command) {
    const answer = acp
      ? await ask("session/request_permission", { sessionId: "s1", toolCall: { toolCallId: "tc0", name: "Bash", rawInput: { command }, title: command, kind: "execute" },
        options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" }] })
      : await ask("item/commandExecution/requestApproval", { threadId, turnId: t.id, itemId: "c0", command: `powershell -Command '${command}'`, commandActions: [{ type: "unknown", command }] });
    allowed = acp ? answer.outcome?.optionId !== "no" : answer.decision !== "decline";
    if (!acp) out({ method: "serverRequest/resolved", params: { threadId, requestId: 100 + 0 } });
  }
  if (process.env.RIVET_TEST_STREAM_GATE && ["SLOW work", "SLOW long job"].includes(text)) {
    // Keep the intended turn open until the reader sends its steer or interrupt.
    const deadline = Date.now() + 15000;
    while (text === "SLOW work" ? t.steered.length === 0 && !t.cancelled : !t.cancelled) {
      if (Date.now() > deadline) throw new Error("turn control was not received");
      await sleep(25);
    }
  } else if (text.includes("SLOW")) for (let i = 0; i < (text.includes("DRAIN_TIMEOUT") ? 300 : 30) && !t.cancelled; i++) await sleep(100);
  const said = `echo: ${text}${t.steered.length ? ` + ${t.steered.join(" + ")}` : ""}${allowed ? "" : " (declined)"}`;
  if (acp) {
    update({ sessionUpdate: "tool_call", toolCallId: `tc${turns}`, title: "Terminal", kind: "execute", status: "pending", rawInput: {}, _meta: { claudeCode: { toolName: "Bash" } } });
    update({ sessionUpdate: "tool_call_update", toolCallId: `tc${turns}`, rawInput: { command: "ls" }, _meta: { claudeCode: { toolName: "Bash" } } });
    update({ sessionUpdate: "tool_call_update", toolCallId: `tc${turns}`, status: "completed", rawOutput: "a.txt" });
    update({ sessionUpdate: "agent_message_chunk", messageId: `m${turns}`, content: { type: "text", text: said.slice(0, 6) } });
    await partialReplyObserved(t);
    update({ sessionUpdate: "agent_message_chunk", messageId: `m${turns}`, content: { type: "text", text: said.slice(6) } });
    update({ sessionUpdate: "usage_update", used: 1000 * turns, size: 200000 });
  } else {
    out({ method: "item/started", params: { threadId, turnId: t.id, item: { type: "commandExecution", id: `c${turns}`, command: "ls", commandActions: [{ command: "ls" }], status: "inProgress" } } });
    out({ method: "item/completed", params: { threadId, turnId: t.id, item: { type: "commandExecution", id: `c${turns}`, command: "ls", commandActions: [{ command: "ls" }], status: "completed", aggregatedOutput: "a.txt" } } });
    out({ method: "item/agentMessage/delta", params: { threadId, turnId: t.id, itemId: `m${turns}`, delta: said.slice(0, 6) } });
    await partialReplyObserved(t);
    out({ method: "item/agentMessage/delta", params: { threadId, turnId: t.id, itemId: `m${turns}`, delta: said.slice(6) } });
    out({ method: "item/completed", params: { threadId, turnId: t.id, item: { type: "agentMessage", id: `m${turns}`, text: said } } });
    out({ method: "thread/tokenUsage/updated", params: { threadId, turnId: t.id, tokenUsage: { total: { totalTokens: 150 * turns, inputTokens: 100 * turns, cachedInputTokens: 40 * turns, outputTokens: 50 * turns }, last: { totalTokens: 1000 * turns }, modelContextWindow: 200000 } } });
    out({ method: "turn/completed", params: { threadId, turn: { id: t.id, status: t.cancelled ? "interrupted" : "completed" } } });
  }
  active = null;
  finish(t.cancelled);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === undefined) { asked.get(m.id)?.(m.result ?? {}); asked.delete(m.id); return; }
  const reply = (result) => out({ id: m.id, result });
  const p = m.params ?? {};
  if (process.env.RIVET_TEST_MCP === "1" && ["session/new", "session/resume", "thread/start", "thread/resume"].includes(m.method)) {
    const server = acp ? p.mcpServers?.find((s) => s.name === "rivet") : p.config?.mcp_servers?.rivet;
    const session = acp ? server?.env?.find((e) => e.name === "RIVET_SESSION_ID")?.value : server?.env?.RIVET_SESSION_ID;
    if (!server?.command || server.args?.at(-1) !== "mcp" || session !== "r1-agent") return out({ id: m.id, error: { code: -1, message: "missing Rivet MCP registration" } });
  }
  switch (m.method) {
    case "initialize": return reply(acp ? { protocolVersion: 1, agentCapabilities: { loadSession:process.env.RIVET_TEST_LOAD==="1", sessionCapabilities: process.env.RIVET_TEST_NO_RESUME ? {} : { resume: {} } } } : { userAgent: "fake" });
    case "model/list": return reply({data:[{id:p.cursor?"model-b":"model-a",displayName:p.cursor?"Model B":"Model A"}],nextCursor:p.cursor?null:"page-two"});
    case "account/rateLimits/read":
      if(process.env.RIVET_TEST_NO_QUOTA)return out({id:m.id,error:{code:-32601,message:"quota unavailable"}});
      return reply({rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:1800000000}}});
    case "thread/compact/start": return reply({});
    case "initialized": return;
    case "session/new":
      reply({ sessionId: "s1", models:{availableModels:[{modelId:"claude-fixture",name:"Claude Fixture"}]} });
      if(process.env.RIVET_TEST_COMPACT==="1")update({sessionUpdate:"available_commands_update",availableCommands:[{name:"compact"}]});return;
    case "session/load":
      update({sessionUpdate:"user_message_chunk",content:{type:"text",text:"recover me"}});
      update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"recovered answer"}});
      return reply({});
    case "session/resume": return reply({});
    case "session/set_config_option": return reply({ configOptions: [] });
    case "session/prompt": return void turn(p.prompt[0].text, (cancelled) => reply({ stopReason: cancelled ? "cancelled" : "end_turn", usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 30, cachedWriteTokens: 10, totalTokens: 150 } }));
    case "_session/steering": if (active) { active.steered.push(p.prompt[0].text); return reply({ outcome: "injected" }); } return reply({ outcome: "promptRequired" });
    case "session/cancel": if (active) active.cancelled = true; return;
    case "thread/read": return reply({thread:{id:threadId,turns:process.env.RIVET_TEST_HISTORY === "1" ? [{id:"recovered-turn",status:"completed",items:[{type:"userMessage",id:"recovered-user",content:[{type:"text",text:"recover me"}]},{type:"agentMessage",id:"recovered-answer",text:"recovered answer"}]}] : []}});
    case "thread/start": return reply({ thread: { id: "th1" } });
    case "thread/fork":
      if (process.env.RIVET_TEST_NO_FORK) return out({ id: m.id, error: { code: -32601, message: "unsupported fork" } });
      if (!p.lastTurnId) return out({ id: m.id, error: { code: -32600, message: "missing stable anchor" } });
      threadId = "forked-" + p.threadId; return reply({ thread: { id: threadId } });
    case "thread/resume": threadId = p.threadId; return reply({ thread: { id: p.threadId } });
    case "turn/start": { reply({ turn: { id: `turn-${turns + 1}`, status: "inProgress" } }); return void turn(p.input[0].text, () => {}); }
    case "turn/steer": if (active) { active.steered.push(p.input[0].text); return reply({ turnId: active.id }); } return out({ id: m.id, error: { code: -1, message: "no active turn" } });
    case "turn/interrupt": if (active) active.cancelled = true; return reply({});
    default: return out({ id: m.id, error: { code: -32601, message: "unknown" } });
  }
});
