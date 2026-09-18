/**
 * Mock OpenAI-compatible provider for E2E testing the PC wrapper.
 * Behavior by turn:
 *   1st call → tool_call: run_command {command: "echo hello-from-mock"}
 *   2nd call → tool_call: write_file {path: "pc-test-notes/hello.txt", content: ...}
 *   3rd call → tool_call: ask_question {question: "What should the file say?"}
 *   4th call → tool_call: read_file {path: "pc-test-notes/hello.txt"}
 *   5th call → final text answer.
 */
import http from "node:http";

const PORT = 9911;
let callCount = 0;

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-agent-model" }] }));
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      callCount += 1;
      const n = callCount;
      const id = `chatcmpl-mock${n}`;
      const created = Math.floor(Date.now() / 1000);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const send = (obj) => res.write(sseChunk(obj));

      const header = (delta) => ({
        id, object: "chat.completion.chunk", created, model: "mock-agent-model",
        choices: [{ index: 0, delta, finish_reason: null }],
      });
      const finish = (reason) => ({
        id, object: "chat.completion.chunk", created, model: "mock-agent-model",
        choices: [{ index: 0, delta: {}, finish_reason: reason }],
      });

      // 200ms of "thinking" text first so we exercise text-delta
      send(header({ role: "assistant", content: "" }));
      const words = ["Working", " on", " it", "…", "\n\n"];
      let wi = 0;
      const wordTimer = setInterval(() => {
        if (wi < words.length) {
          send(header({ content: words[wi] }));
          wi += 1;
          return;
        }
        clearInterval(wordTimer);

        if (n === 1) {
          send(header({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "run_command", arguments: "" } }] }));
          send(header({ tool_calls: [{ index: 0, function: { arguments: '{"command":"echo hello-from-mock"}' } }] }));
          send(finish("tool_calls"));
        } else if (n === 2) {
          send(header({ tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "write_file", arguments: "" } }] }));
          send(header({ tool_calls: [{ index: 0, function: { arguments: '{"path":"pc-test-notes/hello.txt","content":"mock wrote this"}' } }] }));
          send(finish("tool_calls"));
        } else if (n === 3) {
          send(header({ tool_calls: [{ index: 0, id: "call_3", type: "function", function: { name: "ask_question", arguments: "" } }] }));
          send(header({ tool_calls: [{ index: 0, function: { arguments: '{"question":"Name the project?","options":["mobile-agent","other"]}' } }] }));
          send(finish("tool_calls"));
        } else if (n === 4) {
          send(header({ tool_calls: [{ index: 0, id: "call_4", type: "function", function: { name: "read_file", arguments: "" } }] }));
          send(header({ tool_calls: [{ index: 0, function: { arguments: '{"path":"pc-test-notes/hello.txt"}' } }] }));
          send(finish("tool_calls"));
        } else {
          send(header({ content: "All done. The command printed `hello-from-mock`, and the file says: mock wrote this." }));
          send(finish("stop"));
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }, 60);
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock provider on http://127.0.0.1:${PORT}`));
