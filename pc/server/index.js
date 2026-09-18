/**
 * pc/server/index.js
 * ------------------------------------------------------------
 * Local web server for Mobile Agent — PC Edition.
 * Serves the web UI and the JSON/SSE API the UI talks to.
 * Zero frameworks: node:http only, so `npm install` stays fast and
 * native-free on Windows.
 *
 * Usage:  node server/index.js [--port 8787] [--host 0.0.0.0] [--open]
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  initStore,
  getConfig,
  saveConfig,
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  readMemory,
  writeMemory,
  DATA_DIR,
  PC_ROOT,
} from "./store.js";
import {
  describeProviders,
  fetchRemoteModels,
  getProviderDef,
} from "./providers.js";
import { listSkills, importSkillFromGithub } from "./skills.js";
import {
  startRun,
  stopRun,
  resolveGate,
  isRunActive,
  AGENTS,
} from "./agent.js";
import { runShellCommand, workspaceRoot } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(PC_ROOT, "public");

/* ------------------------------------------------------------------ */
/* CLI args                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  // Default to localhost: this server can execute shell commands, so it must
  // not be reachable from the network unless the user opts in with --host.
  const args = { port: 8787, host: "127.0.0.1", open: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") args.port = Number(argv[++i]);
    else if (arg === "--host") args.host = argv[++i];
    else if (arg === "--open") args.open = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node server/index.js [--port 8787] [--host 0.0.0.0] [--open]");
      console.log("  --host 0.0.0.0  listen on all interfaces (share on your LAN — know what you are doing)");
      process.exit(0);
    }
  }
  if (process.env.PORT) args.port = Number(process.env.PORT);
  if (process.env.HOST) args.host = process.env.HOST;
  return args;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

/** Redact API keys before they reach the browser. */
function publicConfig() {
  const config = getConfig();
  const providers = {};
  for (const [id, value] of Object.entries(config.providers ?? {})) {
    providers[id] = {
      baseUrl: value.baseUrl ?? "",
      hasKey: !!value.apiKey,
      keyPreview: value.apiKey ? `${value.apiKey.slice(0, 7)}…${value.apiKey.slice(-4)}` : null,
    };
  }
  return {
    providers,
    defaults: config.defaults,
    permissions: config.permissions,
    workspaceRoot: config.workspaceRoot,
    enabledSkills: config.enabledSkills,
    maxToolSteps: config.maxToolSteps,
  };
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  /* ---------------------------- health ---------------------------- */
  if (route === "GET /api/health") {
    return sendJson(res, 200, { ok: true, version: "1.0.0", platform: process.platform });
  }

  /* --------------------------- bootstrap --------------------------- */
  if (route === "GET /api/bootstrap") {
    return sendJson(res, 200, {
      providers: describeProviders(),
      conversations: listConversations(),
      config: publicConfig(),
      skills: await listSkills(),
      memory: readMemory(),
      agents: Object.values(AGENTS),
      platform: {
        os: process.platform,
        release: os.release(),
        hostname: os.hostname(),
        node: process.versions.node,
        workspaceRoot: workspaceRoot(),
        isWindows: process.platform === "win32",
      },
    });
  }

  /* -------------------------- settings ----------------------------- */
  if (route === "GET /api/settings") {
    return sendJson(res, 200, publicConfig());
  }

  if (route === "PUT /api/settings" || route === "POST /api/settings") {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: "Invalid JSON body." });

    const patch = {};

    if (body.providers && typeof body.providers === "object") {
      const current = getConfig().providers;
      const next = { ...current };
      for (const [id, value] of Object.entries(body.providers)) {
        const def = getProviderDef(id);
        if (!def) continue;
        const prev = current[id] ?? {};
        next[id] = {
          apiKey: typeof value.apiKey === "string" && value.apiKey.trim()
            ? value.apiKey.trim()
            : prev.apiKey ?? null,
          baseUrl: typeof value.baseUrl === "string" ? value.baseUrl.trim() : prev.baseUrl ?? "",
        };
        if (value.clearKey) next[id].apiKey = null;
      }
      patch.providers = next;
    }

    if (body.defaults) patch.defaults = body.defaults;
    if (body.permissions) patch.permissions = body.permissions;
    if (typeof body.workspaceRoot === "string" && body.workspaceRoot.trim()) {
      const root = path.resolve(body.workspaceRoot.trim());
      try {
        const stat = fs.statSync(root);
        if (!stat.isDirectory()) throw new Error("not a directory");
        patch.workspaceRoot = root;
      } catch {
        return sendJson(res, 400, { error: `Not a usable directory: ${root}` });
      }
    }
    if (Array.isArray(body.enabledSkills)) patch.enabledSkills = body.enabledSkills.map(String);
    if (Number.isFinite(body.maxToolSteps)) {
      patch.maxToolSteps = Math.min(200, Math.max(4, Math.floor(body.maxToolSteps)));
    }

    const saved = saveConfig(patch);
    return sendJson(res, 200, {
      ok: true,
      config: {
        ...publicConfig(),
        workspaceRoot: saved.workspaceRoot,
      },
    });
  }

  /* ---------------------- provider model list ---------------------- */
  const modelsMatch = /^\/api\/providers\/([a-z0-9-]+)\/models$/.exec(url.pathname);
  if (req.method === "POST" && modelsMatch) {
    try {
      const models = await fetchRemoteModels(modelsMatch[1]);
      return sendJson(res, 200, { models });
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /* ------------------------- conversations ------------------------- */
  if (route === "POST /api/conversations") {
    const body = await readBody(req).catch(() => ({}));
    const conversation = createConversation({
      agent: body?.agent ?? getConfig().defaults.agent,
    });
    return sendJson(res, 201, conversation);
  }

  const convMatch = /^\/api\/conversations\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
  if (convMatch) {
    const id = convMatch[1];
    if (req.method === "GET") {
      const conversation = getConversation(id);
      if (!conversation) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, { ...conversation, active: isRunActive(id) });
    }
    if (req.method === "PATCH" || req.method === "PUT") {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: "Invalid JSON body." });
      const patch = {};
      if (typeof body.title === "string") patch.title = body.title.slice(0, 200);
      if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
      if (typeof body.agent === "string" && AGENTS[body.agent]) patch.agent = body.agent;
      const updated = updateConversation(id, patch);
      if (!updated) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, updated);
    }
    if (req.method === "DELETE") {
      const ok = deleteConversation(id);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
  }

  /* ----------------------------- chat ------------------------------ */
  if (route === "POST /api/chat") {
    const body = await readBody(req);
    if (!body?.conversationId || typeof body.message !== "string" || !body.message.trim()) {
      return sendJson(res, 400, { error: "conversationId and message are required." });
    }
    if (isRunActive(body.conversationId)) {
      return sendJson(res, 409, { error: "A run is already active in this conversation." });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":connected\n\n");

    const emit = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client gone */
      }
    };

    const heartbeat = setInterval(() => {
      try {
        res.write(":ping\n\n");
      } catch {}
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      // Client disconnect stops the run (like closing the app).
      stopRun(body.conversationId);
    });

    try {
      await startRun({
        conversationId: body.conversationId,
        userMessage: body.message,
        attachments: Array.isArray(body.attachments)
          ? body.attachments.filter((a) => typeof a?.path === "string").slice(0, 10)
          : [],
        providerId: body.providerId ?? null,
        modelId: body.modelId ?? null,
        agent: body.agent ?? null,
        emit,
      });
    } catch (err) {
      emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
      emit({ type: "done", conversationId: body.conversationId });
    } finally {
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {}
    }
    return;
  }

  /* --------------------------- run control ------------------------- */
  const stopMatch = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/stop$/.exec(url.pathname);
  if (req.method === "POST" && stopMatch) {
    const ok = stopRun(stopMatch[1]);
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  /* ------------------------ approvals/answers ---------------------- */
  if (route === "POST /api/gate") {
    const body = await readBody(req);
    if (!body?.conversationId || !body?.gateId) {
      return sendJson(res, 400, { error: "conversationId and gateId are required." });
    }
    const result = resolveGate(body.conversationId, body.gateId, body.decision);
    return sendJson(res, result.ok ? 200 : 404, result);
  }

  /* ----------------------------- skills ---------------------------- */
  if (route === "GET /api/skills") {
    return sendJson(res, 200, { skills: await listSkills() });
  }

  if (route === "POST /api/skills/import") {
    const body = await readBody(req);
    if (typeof body?.url !== "string") {
      return sendJson(res, 400, { error: "url is required." });
    }
    try {
      const imported = await importSkillFromGithub(body.url);
      return sendJson(res, 201, { ...imported, skills: await listSkills() });
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const skillToggle = /^\/api\/skills\/([a-zA-Z0-9_-]+)\/toggle$/.exec(url.pathname);
  if (req.method === "POST" && skillToggle) {
    const body = await readBody(req).catch(() => ({}));
    const slug = skillToggle[1];
    const enabled = body?.enabled === true;
    const current = new Set(getConfig().enabledSkills);
    if (enabled) current.add(slug);
    else current.delete(slug);
    saveConfig({ enabledSkills: [...current] });
    return sendJson(res, 200, { ok: true, enabledSkills: [...current], skills: await listSkills() });
  }

  /* ----------------------------- memory ---------------------------- */
  if (route === "GET /api/memory") {
    return sendJson(res, 200, { memory: readMemory() });
  }
  if (route === "PUT /api/memory" || route === "POST /api/memory") {
    const body = await readBody(req);
    if (typeof body?.memory !== "string") return sendJson(res, 400, { error: "memory is required." });
    return sendJson(res, 200, { memory: writeMemory(body.memory) });
  }

  /* ---------------------------- terminal --------------------------- */
  if (route === "POST /api/terminal") {
    const body = await readBody(req);
    if (typeof body?.command !== "string" || !body.command.trim()) {
      return sendJson(res, 400, { error: "command is required." });
    }
    const command = body.command.trim();
    const timeoutSeconds = Math.min(300, Math.max(1, Number(body.timeoutSeconds) || 120));
    const result = await runShellCommand(command, { timeoutMs: timeoutSeconds * 1000 });
    // Keep a short local history for the UI.
    try {
      const histFile = path.join(DATA_DIR, "terminal-history.json");
      const hist = JSON.parse(await fsp.readFile(histFile, "utf8").catch(() => "[]"));
      hist.push({ command, at: Date.now(), exitCode: result.exitCode });
      while (hist.length > 100) hist.shift();
      await fsp.writeFile(histFile, JSON.stringify(hist, null, 2), "utf8");
    } catch {}
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: `No route for ${route}` });
}

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    const ext = path.extname(filePath).toLowerCase();
    const cacheable = ext === ".woff2" || ext === ".woff" || pathname.startsWith("/vendor/");
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": cacheable ? "public, max-age=86400" : "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const args = parseArgs(process.argv);

initStore();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (err) {
    console.error(`[error] ${req.method} ${url.pathname}:`, err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    } else {
      try {
        res.end();
      } catch {}
    }
  }
});

server.listen(args.port, args.host, () => {
  const displayHost = args.host === "0.0.0.0" || args.host === "::" ? "localhost" : args.host;
  const url = `http://${displayHost}:${args.port}`;
  console.log("");
  console.log("  Mobile Agent — PC Edition");
  console.log(`  Serving on  http://${args.host}:${args.port}`);
  console.log(`  Open        ${url}`);
  console.log(`  Workspace   ${workspaceRoot()}`);
  console.log("");
  if (args.open) {
    import("node:child_process")
      .then(({ exec }) => {
        const cmd =
          process.platform === "win32" ? `start "" "${url}"`
          : process.platform === "darwin" ? `open "${url}"`
          : `xdg-open "${url}"`;
        exec(cmd, () => {});
      })
      .catch(() => {});
  }
});
