/**
 * E2E test for the PC wrapper against a mock provider.
 *
 * Usage:
 *   node server/index.js --port 8791 &        # the app under test
 *   node test/mock-provider.mjs &             # fake OpenAI-compatible backend
 *   BASE=http://localhost:8791 node test/e2e.mjs
 * 1. configures the "custom" OpenAI-compatible provider → mock
 * 2. sets defaults (provider=custom, model=mock-agent-model)
 * 3. sets permissions shell=ask, fsWrite=ask (exercise approvals)
 * 4. creates a conversation, POSTs /api/chat, reads SSE
 * 5. approves shell + fsWrite gates, answers the question gate
 * 6. asserts the final conversation contents + the written file
 */
const BASE = process.env.BASE ?? "http://localhost:8791";

const j = async (path, options = {}) => {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${data.error}`);
  return data;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- setup ---
await j("/api/settings", {
  method: "PUT",
  body: {
    providers: { custom: { baseUrl: "http://127.0.0.1:9911/v1", apiKey: "test" } },
    defaults: { providerId: "custom", modelId: "mock-agent-model" },
    permissions: { shell: "ask", fsWrite: "ask" },
  },
});
console.log("✓ configured mock provider");

// warm provider models cache (also tests fetchRemoteModels)
const models = await j("/api/providers/custom/models", { method: "POST" });
console.log("✓ fetched remote models:", models.models);

const convo = await j("/api/conversations", { method: "POST", body: { agent: "build" } });
console.log("✓ conversation created:", convo.id);

// --- stream the run ---
const events = [];
const gates = [];

const runPromise = (async () => {
  const res = await fetch(BASE + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: convo.id, message: "Run the mock workflow." }),
  });
  if (!res.ok || !res.body) throw new Error("chat stream failed: " + res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      events.push(ev.type);
      if (ev.type === "approval" || ev.type === "question") {
        gates.push(ev);
        // respond asynchronously
        setTimeout(async () => {
          const decision =
            ev.type === "approval" ? true : "mobile-agent";
          await j("/api/gate", {
            method: "POST",
            body: { conversationId: convo.id, gateId: ev.request.id, decision },
          });
        }, 150);
      }
    }
  }
})();

// safety timeout
await Promise.race([runPromise, sleep(60000).then(() => { throw new Error("timeout"); })]);

console.log("✓ run finished. events:", events.join(" > "));

// --- assertions ---
const final = await j(`/api/conversations/${convo.id}`);
const parts = final.messages.flatMap((m) => m.content ?? []);

const hasUser = final.messages.some((m) => m.role === "user" && String(m.content).includes("mock workflow"));
const toolCalls = parts.filter((p) => p.type === "tool-call").map((p) => p.toolName);
const toolResults = parts.filter((p) => p.type === "tool-result");
const finalText = parts.filter((p) => p.type === "text").map((p) => p.text).join("");

console.log("  tool calls:", toolCalls.join(", "));
console.log("  final text:", finalText.slice(0, 120));

if (!hasUser) throw new Error("user message missing");
if (!toolCalls.includes("run_command")) throw new Error("run_command missing");
if (!toolCalls.includes("write_file")) throw new Error("write_file missing");
if (!toolCalls.includes("ask_question")) throw new Error("ask_question missing");
if (!toolCalls.includes("read_file")) throw new Error("read_file missing");
if (!finalText.includes("hello-from-mock")) throw new Error("final answer missing command output");
if (gates.filter((g) => g.type === "approval").length !== 2) throw new Error("expected 2 approval gates");
if (gates.filter((g) => g.type === "question").length !== 1) throw new Error("expected 1 question gate");

// check the shell actually ran + file was written
const shellResult = toolResults.find((r) => r.toolName === "run_command");
if (!JSON.stringify(shellResult.output).includes("hello-from-mock")) throw new Error("shell output missing");
const readFileResult = toolResults.find((r) => r.toolName === "read_file");
if (!JSON.stringify(readFileResult.output).includes("mock wrote this")) throw new Error("read_file did not see written content");

// stop endpoint (no active run → 404 is fine)
const stop = await fetch(BASE + `/api/runs/${convo.id}/stop`, { method: "POST" });
if (stop.status !== 404) throw new Error("stop on inactive run should 404, got " + stop.status);

// terminal endpoint
const term = await j("/api/terminal", { method: "POST", body: { command: "echo terminal-ok" } });
if (!term.stdout.includes("terminal-ok")) throw new Error("terminal failed");
console.log("✓ terminal works, exit", term.exitCode);

// skills
const skills = await j("/api/skills");
const slugs = skills.skills.map((s) => s.slug);
if (!slugs.includes("hallmark") || !slugs.includes("impeccable")) throw new Error("bundled skills missing: " + slugs.join(","));
await j("/api/skills/hallmark/toggle", { method: "POST", body: { enabled: true } });
console.log("✓ skills:", slugs.join(", "), "| hallmark enabled");

// title derived
if (!final.title || !final.title.includes("mock workflow")) throw new Error("title not derived: " + final.title);
console.log("✓ title derived:", final.title);

console.log("\nALL E2E CHECKS PASSED");
process.exit(0);
