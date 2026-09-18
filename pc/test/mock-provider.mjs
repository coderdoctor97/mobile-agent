/**
 * Mock OpenAI-compatible provider for E2E testing and demos.
 * Stateless per conversation: a request without tool history starts the
 * scripted sequence from the top.
 *
 *   1st call → run_command  {command: "echo hello-from-mock"}
 *   2nd call → write_file   {path: "pc-test-notes/hello.txt", …}
 *   3rd call → ask_question {question: "Name the project?"}
 *   4th call → read_file    {path: "pc-test-notes/hello.txt"}
 *   5th call → final text answer.
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 9911);
let turn = 0;

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
      // A fresh conversation (no tool results replayed) restarts the script.
      const hasToolHistory = body.includes('"tool"') || body.includes('"role":"tool"');
      if (!hasToolHistory) turn = 0;
      turn += 1;
      const n = turn;
      const id = `chatcmpl-mock${n}`;
      const created = Math.floor(Date.now() / 1000);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const header = (delta) => ({
        id, object: "chat.completion.chunk", created, model: "mock-agent-model",
        choices: [{ index: 0, delta, finish_reason: null }],
      });
      const finish = (reason) => ({
        id, object: "chat.completion.chunk", created, model: "mock-agent-model",
        choices: [{ index: 0, delta: {}, finish_reason: reason }],
      });

      send(header({ role: "assistant", content: "" }));
      const words = ["Working", " on", " it", "…"];
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
