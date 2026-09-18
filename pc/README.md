# Mobile Agent — PC Edition

The desktop companion of the [Mobile Agent](../README.md) Android app: the same
agent loop, provider catalogue, skills system and permission gates — wrapped as
a **local web tool** that runs on your PC and has real access to your system.

```
┌──────────┬──────────────────────────────────────────┐
│ chats    │  What should this agent do?              │
│ ──────── │                                          │
│ Terminal │  ▸ run_command   echo hello   ✓ done     │
│ Skills   │  ▸ write_file    notes.txt    ✓ done     │
│ Settings │  All done — the file says hello.         │
│ ──────── │  ┌────────────────────────────────────┐  │
│ ● local  │  │ Ask your agent to do something…    │  │
└──────────┴──┴────────────────────────────────────┴──┘
```

## Quick start (Windows)

1. **`setup.bat`** — checks Node.js 20+, installs dependencies (pure-JS, no
   native builds), creates the data directory.
2. **`start.bat`** — starts the server on `http://localhost:8787` and opens
   your browser. Close the console window to stop the agent.

On Linux / macOS use `./setup.sh` and `./start.sh` instead. A different port:
`start.bat 3000`.

Then open **Settings → Providers**, add a key (Anthropic / OpenAI / Google /
xAI / OpenRouter) — or skip keys entirely and point it at
[Ollama](https://ollama.com) or LM Studio running on the same machine — pick a
model in the composer, and start asking.

## What it can do

- **Chat with an agent that acts** — streams answers, runs tools step by step,
  shows every tool call, input and output inline.
- **Run commands on your computer** — `cmd.exe` on Windows (`powershell -Command …`
  works too), `/bin/sh` elsewhere. Output, exit codes and timeouts are handled.
- **Read, write and edit files** — under a workspace root you choose
  (default: your home directory), with paging reads, exact-match edits, glob
  and regex content search.
- **Ask before it acts** — shell commands and file writes pause for your
  approval (mobile app parity). Allow per action or per category.
- **Build / Plan modes** — Build executes; Plan is read-only and produces a
  plan you can hand back to Build.
- **Subagents** — `task` delegates read-only research to a general subagent.
- **Skills** — instruction packs in `../skills/`. The repo ships with
  [hallmark](https://github.com/Nutlope/hallmark) (anti-AI-slop design) and
  [impeccable](https://github.com/pbakaus/impeccable) (frontend polish) —
  enable them and the agent designs like they teach. Import more from any
  GitHub `SKILL.md` URL.
- **Persistent memory** — a markdown note the agent carries into every chat
  and edits itself via its memory tools.
- **Terminal page** — your own direct command line into the workspace, no
  model in between.

## Architecture

```
pc/
  server/            Node.js (no frameworks, no native deps)
    index.js         HTTP + SSE API + static hosting
    agent.js         AI-SDK run loop, permission gates, streaming
    providers.js     anthropic · openai · google · xai · openrouter ·
                     ollama · LM Studio · any OpenAI-compatible endpoint
    tools.js         run_command, read/write/edit_file, list_dir, glob,
                     grep, todos, ask_question, task, skills, memory
    subagent.js      read-only research subagent (streamText)
    skills.js        skills loader + GitHub importer
    store.js         JSON persistence (atomic writes) in pc/data/
  public/            the web UI (vanilla ES modules, no build step)
    styles.css       locked token design system (see ../DESIGN.md)
    app.js           views, SSE client, markdown renderer
    fonts/           Geist + Geist Mono (bundled, OFL)
  data/              your chats, config (incl. API keys), memory —
                     git-ignored, machine-local
../skills/           the project's skill dictionary (hallmark, impeccable, …)
```

The agent engine is the same Vercel AI SDK (`ai@7`) the mobile app uses, so
provider behavior matches the phone.

## Security notes

- The server binds **localhost only** by default — this is a tool that can
  execute shell commands, so it stays off your network unless you explicitly
  share it (`start.bat` → edit to add `--host 0.0.0.0`; know what you are
  doing). Don't expose the port to untrusted networks.
- API keys live in `pc/data/config.json` (git-ignored). Only provider ids and
  key previews ever reach the browser.
- File tools are jailed to the workspace root. Shell commands are not — that's
  the point — but every command passes the approval gate unless you set
  *Permissions → Shell commands → Allow*.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Port | `start.bat <port>` / `--port` | `8787` |
| Workspace root | Settings → Workspace | your home directory |
| Default model | Settings → Model & run | — |
| Permissions | Settings → Permissions | shell **ask** · writes **ask** · reads allow |
| Max tool steps | Settings → Model & run | 60 |

## Roadmap

- MCP server support (the mobile app has it; the wrapper's provider stack is
  ready for `@ai-sdk/mcp`)
- Scheduled jobs (cron-style, like the mobile app's scheduler)
- Image attachments to the model

## Tests

`pc/test/` contains an end-to-end suite that runs the full agent loop against
a mock OpenAI-compatible provider — streaming, tool calls, approval gates,
question gates, persistence and title derivation, plus the terminal and
skills endpoints.

```bash
# terminal 1
cd pc && node server/index.js --port 8791
# terminal 2
node test/mock-provider.mjs
# terminal 3
BASE=http://localhost:8791 npm test
```

## License

MIT, like the rest of the repository. Geist fonts are SIL OFL © Vercel;
icons are Lucide (ISC); markdown rendering by marked (MIT).
