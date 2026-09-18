/* ============================================================
   Mobile Agent — PC Edition · frontend application
   ------------------------------------------------------------
   Vanilla ES module — no build step. Talks to the local server
   (JSON + SSE). Renders markdown with the vendored marked build,
   sanitised through an allowlist pass.
   ============================================================ */

import { ICONS } from "./icons.js";

/* ------------------------------------------------------------------ */
/* Tiny helpers                                                        */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (key === "html") el.innerHTML = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return el;
};

function icon(name, size = 16, stroke = 1.75) {
  const nodes = ICONS[name];
  if (!nodes) return document.createComment(`missing icon ${name}`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", stroke);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of nodes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

function fmtTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------ */
/* Global state                                                        */
/* ------------------------------------------------------------------ */

const state = {
  bootstrap: null,        // /api/bootstrap payload
  conversations: [],
  config: null,
  skills: [],
  providers: [],
  memory: "",
  platform: null,
  current: null,          // current conversation (full record)
  route: { name: "home" },
  running: false,         // run active in current conversation
  attachments: [],        // [{path}]
  searchQuery: "",
  modelMenuOpen: false,
  customModels: {},       // providerId → [models] fetched from endpoints
};

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function toast(message, tone = "info", ms = 3600) {
  const el = h("div", { class: `toast${tone === "error" ? " is-error" : tone === "ok" ? " is-ok" : ""}` },
    tone === "error" ? icon("circle-alert", 15) : tone === "ok" ? icon("check", 15) : icon("zap", 15),
    h("span", {}, message));
  $("#toasts").append(el);
  setTimeout(() => el.remove(), ms);
}

/* ------------------------------------------------------------------ */
/* Markdown (marked + allowlist sanitiser)                             */
/* ------------------------------------------------------------------ */

function initMarked() {
  if (!window.marked) return null;
  const marked = window.marked;
  const renderer = new marked.Renderer();

  // marked v13+ renderer methods receive token objects.
  renderer.code = (token) => {
    const code = token?.text ?? "";
    const language = String(token?.lang || "text").split(/\s/)[0];
    const id = `cb-${Math.random().toString(36).slice(2, 9)}`;
    return (
      `<div class="codeblock"><div class="codeblock-head">` +
      `<span class="codeblock-lang">${escapeHtml(language)}</span>` +
      `<button type="button" class="btn btn-quiet btn-sm" data-copy-code="${id}" aria-label="Copy code">` +
      `${icon("copy", 12).outerHTML}<span>Copy</span></button></div>` +
      `<pre id="${id}">${escapeHtml(code)}</pre></div>`
    );
  };

  marked.use({ renderer, gfm: true, breaks: true });
  return marked;
}

let markedParser = null;

/** Render markdown to safe HTML. */
function renderMarkdown(text) {
  if (!markedParser) markedParser = initMarked();
  if (!markedParser) return escapeHtml(text);
  const raw = markedParser.parse(text ?? "");
  const doc = new DOMParser().parseFromString(raw, "text/html");
  // Allowlist pass: strip scripts/iframes/event handlers/javascript: URLs.
  for (const el of [...doc.querySelectorAll("script,style,iframe,object,embed,form,link,meta")]) {
    el.remove();
  }
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.toLowerCase().trim();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      if ((name === "href" || name === "src") && value.startsWith("javascript:")) {
        el.setAttribute(name, "#");
      }
    }
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }
  return doc.body.innerHTML;
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function parseRoute() {
  const hash = location.hash.slice(1) || "/";
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "c" && parts[1]) return { name: "chat", id: parts[1] };
  if (parts[0] === "settings") return { name: "settings", section: parts[1] || "providers" };
  if (parts[0] === "terminal") return { name: "terminal" };
  return { name: "home" };
}

async function navigate() {
  state.route = parseRoute();
  state.modelMenuOpen = false;
  closeModelMenu();
  const view = $("#view");

  if (state.route.name === "chat") {
    await openConversation(state.route.id);
  } else if (state.route.name === "settings") {
    await renderSettings(state.route.section);
  } else if (state.route.name === "terminal") {
    renderTerminal();
  } else {
    state.current = null;
    renderHome();
  }

  renderSidebar();
  renderTopbar();
  updateComposer();
  syncNavActive();
}

function syncNavActive() {
  const active = state.route.name === "terminal" ? "terminal"
    : state.route.name === "settings" ? "settings"
    : state.route.name === "settings" && state.route.section === "skills" ? "skills"
    : null;
  $$(".side-nav-item").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.nav === active);
  });
}

window.addEventListener("hashchange", navigate);

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

function groupLabel(ts, pinned) {
  if (pinned) return "Pinned";
  const date = new Date(ts);
  const today = new Date();
  const isSameDay = date.toDateString() === today.toDateString();
  if (isSameDay) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return "Earlier";
}

function renderSidebar() {
  const list = $("#conversation-list");
  list.innerHTML = "";

  const query = state.searchQuery.toLowerCase();
  const visible = state.conversations.filter((c) =>
    !query || (c.title || "untitled").toLowerCase().includes(query),
  );

  if (!visible.length) {
    list.append(h("div", { class: "convo-empty" },
      query ? "No chats match your search." : "No chats yet. Start one above."));
    return;
  }

  let lastGroup = null;
  for (const convo of visible) {
    const group = groupLabel(convo.updatedAt, convo.pinned);
    if (group !== lastGroup) {
      list.append(h("div", { class: "convo-group-label" }, group));
      lastGroup = group;
    }
    const item = h("button", {
      class: `convo-item${state.current?.id === convo.id ? " is-active" : ""}${convo.pinned ? " is-pinned" : ""}`,
      onclick: () => { location.hash = `#/c/${convo.id}`; },
      title: convo.title || "Untitled chat",
    },
      convo.pinned
        ? h("span", { class: "convo-pin", title: "Pinned" }, icon("pin", 12))
        : h("span", { class: "convo-pin", style: "opacity:0" }, icon("pin", 12)),
      h("span", { class: "convo-title" }, convo.title || "Untitled chat"),
      h("span", { class: "convo-meta" }, `${convo.messageCount}`),
    );

    // Pin / delete on hover — right side quick actions.
    const actions = h("span", { class: "convo-actions" });
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const pinBtn = h("button", {
        class: "btn btn-ghost btn-sm",
        onclick: async (ev) => {
          ev.stopPropagation();
          await api(`/api/conversations/${convo.id}`, { method: "PATCH", body: { pinned: !convo.pinned } });
          await refreshBootstrap();
          renderSidebar();
        },
      }, icon("pin", 12), convo.pinned ? "Unpin" : "Pin");
      const delBtn = h("button", {
        class: "btn btn-danger btn-sm",
        onclick: async (ev) => {
          ev.stopPropagation();
          if (!confirm("Delete this chat? This cannot be undone.")) return;
          await api(`/api/conversations/${convo.id}`, { method: "DELETE" });
          if (state.current?.id === convo.id) location.hash = "#/";
          await refreshBootstrap();
          renderSidebar();
        },
      }, icon("trash-2", 12), "Delete");
      const pop = h("div", { class: "model-menu", style: "position:fixed;display:block;left:" + (e.clientX - 120) + "px;top:" + (e.clientY + 6) + "px;min-width:150px" },
        pinBtn, delBtn);
      document.body.append(pop);
      const close = (ev2) => {
        if (!pop.contains(ev2.target)) { pop.remove(); document.removeEventListener("click", close); }
      };
      setTimeout(() => document.addEventListener("click", close), 0);
    });
    list.append(item);
  }
}

/* ------------------------------------------------------------------ */
/* Topbar                                                              */
/* ------------------------------------------------------------------ */

function renderTopbar() {
  const title = $("#topbar-title");
  const actions = $("#topbar-actions");
  actions.innerHTML = "";

  if (state.route.name === "chat" && state.current) {
    title.textContent = state.current.title || "New chat";
    if (state.current.pinned) {
      title.prepend(icon("pin", 12));
    }
  } else if (state.route.name === "terminal") {
    title.textContent = "Terminal";
  } else if (state.route.name === "settings") {
    title.textContent = "Settings";
  } else {
    title.innerHTML = '<span class="title-placeholder">New chat</span>';
  }

  // Agent mode switch
  const agent = state.current?.agent || state.config?.defaults?.agent || "build";
  $$("#agent-switch button").forEach((btn) => {
    const isActive = state.route.name === "chat" && btn.dataset.agent === agent;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", isActive);
  });
  $("#agent-switch").style.visibility = state.route.name === "chat" ? "visible" : "hidden";
}

$("#agent-switch").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || !state.current) return;
  await api(`/api/conversations/${state.current.id}`, {
    method: "PATCH", body: { agent: btn.dataset.agent },
  });
  state.current.agent = btn.dataset.agent;
  renderTopbar();
  toast(`Switched to ${btn.dataset.agent === "plan" ? "Plan (read-only)" : "Build"} mode`, "ok", 2200);
});

/* ------------------------------------------------------------------ */
/* Status footer                                                       */
/* ------------------------------------------------------------------ */

function setStatus(busy, text) {
  $("#status-dot").classList.toggle("is-busy", busy);
  $("#status-text").textContent = text;
}

function renderFooter() {
  const defaults = state.config?.defaults;
  const provider = state.providers.find((p) => p.id === defaults?.providerId);
  $("#foot-model").textContent = defaults?.modelId
    ? `${provider?.label ?? defaults.providerId} · ${defaults.modelId}`
    : "no model selected";
  $("#foot-workspace").textContent = state.platform?.workspaceRoot ?? "";
}

/* ------------------------------------------------------------------ */
/* Home / empty state                                                  */
/* ------------------------------------------------------------------ */

const EXAMPLES = [
  { verb: "files", text: "Find the 10 largest folders in my home directory and show their sizes" },
  { verb: "shell", text: "Check which programs start with Windows and summarize what each does" },
  { verb: "build", text: "Make a small Python script that renames all my screenshots to a date-based name" },
  { verb: "explain", text: "Read my package.json and explain what this project does" },
];

function renderHome() {
  const view = $("#view");
  const config = state.config;
  const hasModel = !!(config?.defaults?.providerId && config?.defaults?.modelId);
  const anyProviderReady = state.providers.some((p) => p.configured);

  const steps = [
    {
      done: anyProviderReady,
      title: "Connect a model",
      desc: "Add an API key, or point at Ollama / LM Studio running on this machine.",
      href: "#/settings/providers",
      cta: "Open providers",
    },
    {
      done: hasModel,
      title: "Pick a default model",
      desc: "Choose from your provider's catalogue in the composer below.",
      href: "#/settings/defaults",
      cta: "Defaults",
    },
    {
      done: false,
      title: "Give it real work",
      desc: "The agent can run commands, read and edit files, and remember things between chats.",
      href: null,
      cta: null,
    },
  ];

  view.innerHTML = "";
  view.append(
    h("div", { class: "home" },
      h("div", { class: "home-head" },
        h("h1", { class: "home-title" }, "An agent with hands on this machine."),
        h("p", { class: "home-sub" },
          "Mobile Agent, wrapped for the desktop. It runs as a local web tool on port " +
          (location.port || "8787") +
          " — chats, shell commands, file edits and memory all stay on this computer."),
      ),
      h("div", { class: "setup-steps" },
        steps.map((step) =>
          h("a", {
            class: `setup-step${step.done ? " is-done" : ""}`,
            href: step.href || "#",
            onclick: step.href ? null : (e) => { e.preventDefault(); $("#composer-input").focus(); },
          },
            h("span", { class: "step-state" }, icon("check", 12)),
            h("span", { class: "step-copy" },
              h("span", { class: "step-title" }, step.title),
              h("span", { class: "step-desc" }, step.desc),
            ),
            step.cta ? h("span", { class: "step-cta" }, icon("chevron-right", 15)) : null,
          ),
        ),
      ),
      h("div", { class: "example-grid" },
        EXAMPLES.map((ex) =>
          h("button", {
            class: "example-card",
            onclick: () => {
              $("#composer-input").value = ex.text;
              updateComposer();
              $("#composer-input").focus();
            },
          },
            h("span", { class: "example-verb" }, ex.verb),
            h("span", {}, ex.text),
          ),
        ),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Chat view                                                           */
/* ------------------------------------------------------------------ */

async function openConversation(id) {
  try {
    state.current = await api(`/api/conversations/${id}`);
  } catch {
    location.hash = "#/";
    return;
  }
  state.running = !!state.current.active;
  state.attachments = [];

  const view = $("#view");
  view.innerHTML = "";
  const inner = h("div", { class: "transcript-inner", id: "transcript-inner" });

  if (!state.current.messages.length) {
    inner.append(emptyThread());
  } else {
    for (const message of state.current.messages) {
      inner.append(renderMessage(message));
    }
  }

  view.append(inner);
  requestAnimationFrame(() => { view.scrollTop = view.scrollHeight; });
  trackScroll();
}

function emptyThread() {
  return h("div", { class: "home", style: "padding-top: 56px" },
    h("div", { class: "home-head" },
      h("h1", { class: "home-title", style: "font-size: var(--fs-24)" }, "What should this agent do?"),
      h("p", { class: "home-sub", style: "font-size: var(--fs-14)" },
        "It can run shell commands, read and edit files in " +
        (state.platform?.workspaceRoot ?? "your workspace") + ", keep notes in memory, and follow skills."),
    ),
    h("div", { class: "example-grid" },
      EXAMPLES.slice(0, 4).map((ex) =>
        h("button", {
          class: "example-card",
          onclick: () => { $("#composer-input").value = ex.text; updateComposer(); },
        },
          h("span", { class: "example-verb" }, ex.verb),
          h("span", {}, ex.text),
        ),
      ),
    ),
  );
}

/* ------- rendering a stored message ------- */

function renderMessage(message) {
  if (message.role === "user") {
    return renderUserMessage(message);
  }
  if (message.role === "assistant") {
    return renderAssistantMessage(message);
  }
  return h("div");
}

function renderUserMessage(message) {
  const text = typeof message.content === "string"
    ? message.content
    : (message.content ?? []).filter((p) => p?.type === "text").map((p) => p.text).join("\n");

  return h("div", { class: "msg-user", dataset: { id: message.id } },
    h("div", { class: "msg-eyebrow" }, "you", h("span", { style: "opacity:.6" }, fmtTime(message.createdAt))),
    h("div", { class: "msg-body" }, text),
  );
}

function renderAssistantMessage(message) {
  const wrap = h("div", { class: "msg-assistant", dataset: { id: message.id } });
  const parts = Array.isArray(message.content) ? message.content : [];

  // Coalesce consecutive same-type parts (the stream stores one part per delta).
  const merged = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (part?.type === "text" && last?.type === "text") {
      last.text += part.text;
    } else if (part?.type === "reasoning" && last?.type === "reasoning") {
      last.text += part.text;
    } else {
      merged.push({ ...part });
    }
  }

  for (const part of merged) {
    if (part?.type === "reasoning" && part.text?.trim()) {
      wrap.append(renderReasoning(part.text));
    } else if (part?.type === "text" && part.text?.trim()) {
      wrap.append(h("div", { class: "msg-body md", html: renderMarkdown(part.text) }));
    } else if (part?.type === "tool-call") {
      // result part follows separately in the stored array
      const result = merged.find(
        (p) => p?.type === "tool-result" && p.toolCallId === part.toolCallId,
      );
      wrap.append(renderToolCard(part, result));
    }
  }

  if (message.error) {
    wrap.append(h("div", { class: "msg-error" },
      icon("triangle-alert", 15),
      h("div", {},
        h("div", { class: "msg-error-title" }, "The model run hit an error"),
        h("div", {}, message.error),
      ),
    ));
  }

  const meta = [];
  if (message.model) meta.push(message.model);
  if (message.agent) meta.push(message.agent);
  meta.push(fmtTime(message.createdAt));
  if (parts.filter((p) => p?.type === "tool-call").length) {
    meta.push(`${parts.filter((p) => p?.type === "tool-call").length} tool calls`);
  }
  wrap.append(h("div", { class: "msg-meta" }, meta.join(" · ")));

  return wrap;
}

function renderReasoning(text) {
  const preview = text.split("\n")[0].slice(0, 120);
  return h("details", { class: "reasoning" },
    h("summary", {}, icon("brain", 13), "Thinking", h("span", { style: "opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, preview)),
    h("div", { class: "reasoning-body" }, text),
  );
}

/* ------- tool cards ------- */

const TOOL_LABELS = {
  run_command: { icon: "terminal", label: (i) => i.command ? i.command : "" },
  read_file: { icon: "file", label: (i) => i.path ?? "" },
  write_file: { icon: "pencil", label: (i) => i.path ?? "" },
  edit_file: { icon: "pencil", label: (i) => i.path ?? "" },
  list_dir: { icon: "folder", label: (i) => i.path ?? "." },
  glob: { icon: "search", label: (i) => i.pattern ?? "" },
  grep: { icon: "search", label: (i) => i.pattern ?? "" },
  todos: { icon: "list-todo", label: () => "task list" },
  ask_question: { icon: "message-square", label: (i) => i.question ?? "" },
  task: { icon: "bot", label: (i) => i.description ?? "" },
  list_skills: { icon: "book-open", label: () => "skills" },
  read_skill: { icon: "book-open", label: (i) => i.slug ?? "" },
  read_memory: { icon: "memory-stick", label: () => "memory" },
  write_memory: { icon: "memory-stick", label: () => "memory" },
};

function summarizeToolInput(toolName, input) {
  const config = TOOL_LABELS[toolName];
  if (config?.label) {
    try { return config.label(input ?? {}) || toolName; } catch { /* fall through */ }
  }
  return toolName;
}

function toolStatus(result) {
  if (!result) return { cls: "is-running", icon: "loader", text: "running" };
  const output = result.output;
  const denied = output?.type === "execution-denied";
  const errored = denied
    || (output && typeof output === "object" && "error" in output && output.error)
    || (result.isError === true);
  if (errored) return { cls: "is-error", icon: "circle-x", text: denied ? "denied" : "error" };
  return { cls: "is-ok", icon: "check", text: "done" };
}

function prettyOutput(output) {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;
  if (output.type === "text") return output.value;
  if (output.type === "execution-denied") return `Denied: ${output.reason ?? "user denied this tool call"}`;
  if (output.type === "json" || "value" in output) {
    const value = output.value;
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(output, null, 2);
}

function renderToolCard(call, result) {
  const status = toolStatus(result);
  const card = h("div", { class: `tool-card ${status.cls}`, dataset: { callId: call.toolCallId } });

  const head = h("button", { class: "tool-head", onclick: () => card.classList.toggle("is-open") },
    h("span", { class: "tool-status" }, icon(status.icon, 14)),
    h("span", { class: "tool-name" }, call.toolName),
    h("span", { class: "tool-summary" }, summarizeToolInput(call.toolName, call.input)),
    h("span", { class: "tool-chevron" }, icon("chevron-right", 14)),
  );

  const inputBlock = h("div", { class: "tool-section" },
    h("div", { class: "tool-section-label" }, "input"),
    h("div", { class: "tool-io" }, JSON.stringify(call.input ?? {}, null, 2)),
  );

  const outputBlock = result
    ? h("div", { class: "tool-section" },
        h("div", { class: "tool-section-label" }, "output"),
        h("div", { class: `tool-io${status.cls === "is-error" ? " is-error" : ""}` }, prettyOutput(result.output)),
      )
    : h("div", { class: "tool-section" },
        h("div", { class: "tool-section-label" }, "output"),
        h("div", { class: "tool-io", style: "color:var(--ink-3)" }, "waiting…"),
      );

  const body = h("div", { class: "tool-body" }, inputBlock, outputBlock);
  // Open failed + shell cards by default so problems are visible.
  if (status.cls === "is-error" || call.toolName === "run_command") card.classList.add("is-open");

  card.append(head, body);
  return card;
}

/* ------------------------------------------------------------------ */
/* Sending messages / SSE run                                          */
/* ------------------------------------------------------------------ */

function updateComposer() {
  const input = $("#composer-input");
  const send = $("#composer-send");
  const wrap = $("#composer-wrap");

  const chatish = ["chat", "home"].includes(state.route.name);
  wrap.style.display = chatish ? "" : "none";

  if (state.route.name === "chat") {
    const agent = state.current?.agent || "build";
    input.placeholder = agent === "plan"
      ? "Ask for a plan — this mode is read-only…"
      : "Ask your agent to do something on this computer…";
  }

  const hasText = input.value.trim().length > 0;
  if (state.running) {
    send.classList.add("is-stop");
    send.setAttribute("aria-label", "Stop run");
    send.disabled = false;
    $("#send-icon").style.opacity = "0.25";
  } else {
    send.classList.remove("is-stop");
    send.setAttribute("aria-label", "Send message");
    send.disabled = !hasText;
    $("#send-icon").style.opacity = "1";
  }
  autosize();
}

function autosize() {
  const input = $("#composer-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

let stickToBottom = true;
let scrollTracked = false;

function trackScroll() {
  if (scrollTracked) return;
  scrollTracked = true;
  const view = $("#view");
  if (!view) return;
  view.addEventListener("scroll", () => {
    const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 120;
    stickToBottom = nearBottom;
  }, { passive: true });
}

function scrollIfNeeded() {
  if (!stickToBottom) return;
  const view = $("#view");
  view.scrollTop = view.scrollHeight;
}

async function sendMessage() {
  const input = $("#composer-input");
  const text = input.value.trim();
  if (!text || state.running) return;

  let conversation = state.current;
  if (!conversation || state.route.name !== "chat") {
    conversation = await api("/api/conversations", { method: "POST", body: {} });
    state.conversations.unshift({ ...conversation, messageCount: 0 });
    location.hash = `#/c/${conversation.id}`;
    await new Promise((r) => setTimeout(r, 50)); // let navigate() attach the view
    state.current = conversation;
  }

  const userMessage = {
    id: `local_${Date.now()}`,
    role: "user",
    content: text,
    createdAt: Date.now(),
    attachments: state.attachments.map((a) => a.path),
  };

  // optimistic render
  const inner = $("#transcript-inner");
  const empty = inner?.querySelector(".home");
  if (empty) empty.remove();
  inner.append(renderUserMessage(userMessage));
  stickToBottom = true;
  scrollIfNeeded();

  input.value = "";
  const attachments = [...state.attachments];
  state.attachments = [];
  renderAttachments();
  updateComposer();

  await streamRun(conversation.id, text, attachments);
}

async function streamRun(conversationId, message, attachments) {
  state.running = true;
  updateComposer();
  setStatus(true, "agent working");
  $("#run-banner").classList.add("is-active");
  $("#composer-box").classList.add("is-disabled");

  const view = $("#view");
  const inner = $("#transcript-inner");
  stickToBottom = true;

  // Live assistant message scaffold
  const liveWrap = h("div", { class: "msg-assistant" });
  const liveText = h("div", { class: "msg-body md stream-caret" });
  let textBuffer = "";
  let reasoningBuffer = "";
  let liveReasoning = null;
  const toolCards = new Map(); // toolCallId → card element
  let renderTimer = null;

  const flushText = () => {
    liveText.innerHTML = renderMarkdown(textBuffer);
    scrollIfNeeded();
  };

  const ensureLive = () => {
    if (!liveWrap.isConnected) inner.append(liveWrap);
  };

  const addToolCard = (part) => {
    ensureLive();
    const card = renderToolCard({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }, null);
    toolCards.set(part.toolCallId, card);
    liveWrap.insertBefore(card, liveText.isConnected ? liveText : null);
    scrollIfNeeded();
  };

  const finishToolCard = (part) => {
    const card = toolCards.get(part.toolCallId);
    if (!card) return;
    const status = toolStatus(part);
    card.className = `tool-card ${status.cls}`;
    const statusEl = card.querySelector(".tool-status");
    if (statusEl) {
      statusEl.innerHTML = "";
      statusEl.append(icon(status.icon, 14));
    }
    const ioBlocks = card.querySelectorAll(".tool-io");
    const out = ioBlocks[1];
    if (out) {
      out.className = `tool-io${status.cls === "is-error" ? " is-error" : ""}`;
      out.textContent = prettyOutput(part.output);
    }
    scrollIfNeeded();
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        message,
        attachments,
        agent: state.current?.agent ?? null,
      }),
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
      throw new Error(err.error);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        let event;
        try { event = JSON.parse(dataLine.slice(6)); } catch { continue; }

        switch (event.type) {
          case "text-delta": {
            ensureLive();
            if (!liveText.isConnected && event.delta) liveWrap.append(liveText);
            textBuffer += event.delta;
            if (!renderTimer) {
              renderTimer = setTimeout(() => { renderTimer = null; flushText(); }, 120);
            }
            break;
          }
          case "reasoning-delta": {
            reasoningBuffer += event.delta;
            if (!liveReasoning) {
              ensureLive();
              liveReasoning = renderReasoning(reasoningBuffer);
              liveWrap.append(liveReasoning);
            } else {
              const body = liveReasoning.querySelector(".reasoning-body");
              if (body) body.textContent = reasoningBuffer;
            }
            scrollIfNeeded();
            break;
          }
          case "tool-call": {
            addToolCard(event);
            break;
          }
          case "tool-result": {
            finishToolCard(event);
            break;
          }
          case "approval": {
            ensureLive();
            liveWrap.append(renderApprovalCard(event, conversationId));
            scrollIfNeeded();
            break;
          }
          case "question": {
            ensureLive();
            liveWrap.append(renderQuestionCard(event, conversationId));
            scrollIfNeeded();
            break;
          }
          case "todos": {
            let todoCard = $("#live-todos");
            if (!todoCard) {
              todoCard = h("div", { class: "todo-card", id: "live-todos" });
              liveWrap.append(todoCard);
            }
            renderTodos(todoCard, event.todos);
            scrollIfNeeded();
            break;
          }
          case "subagent-start": {
            ensureLive();
            const sub = h("div", { class: "tool-card is-running", dataset: { sub: event.description } },
              h("div", { class: "tool-head" },
                h("span", { class: "tool-status" }, icon("bot", 14)),
                h("span", { class: "tool-name" }, "subagent"),
                h("span", { class: "tool-summary" }, event.description),
              ),
            );
            liveWrap.insertBefore(sub, liveText.isConnected ? liveText : null);
            scrollIfNeeded();
            break;
          }
          case "error": {
            ensureLive();
            liveWrap.append(h("div", { class: "msg-error" },
              icon("triangle-alert", 15),
              h("div", {},
                h("div", { class: "msg-error-title" }, "Something went wrong"),
                h("div", {}, event.error),
              ),
            ));
            scrollIfNeeded();
            break;
          }
          case "conversation-titled": {
            state.current.title = event.title;
            renderTopbar();
            break;
          }
          case "run-end":
          case "done":
            break;
          default:
            break;
        }
      }
    }
  } catch (err) {
    const innerNow = $("#transcript-inner");
    innerNow?.append(h("div", { class: "msg-error" },
      icon("triangle-alert", 15),
      h("div", {},
        h("div", { class: "msg-error-title" }, "Could not run the agent"),
        h("div", {}, err instanceof Error ? err.message : String(err)),
      ),
    ));
  } finally {
    if (renderTimer) { clearTimeout(renderTimer); }
    flushText();
    liveText.classList.remove("stream-caret");
    // Replace the live scaffold with the persisted record (source of truth).
    try {
      const fresh = await api(`/api/conversations/${conversationId}`);
      if (state.current?.id === conversationId) {
        state.current = fresh;
        if (state.route.name === "chat") {
          openConversation(conversationId);
        }
      }
    } catch { /* keep the live render */ }
    state.running = false;
    $("#run-banner").classList.remove("is-active");
    $("#composer-box").classList.remove("is-disabled");
    setStatus(false, "local · idle");
    updateComposer();
    await refreshBootstrap();
    renderSidebar();
    renderFooter();
  }
}

function renderTodos(container, todos) {
  container.innerHTML = "";
  container.append(h("div", { class: "todo-title" }, "Task list"));
  for (const todo of todos ?? []) {
    container.append(h("div", {
      class: `todo-item${todo.status === "completed" ? " is-completed" : ""}${todo.status === "in_progress" ? " is-in-progress" : ""}`,
    },
      h("span", { class: "todo-mark" }, icon("check", 10)),
      h("span", { class: "todo-text" }, todo.content),
    ));
  }
}

/* ------- approval & question cards ------- */

function renderApprovalCard(event, conversationId) {
  const { request } = event;
  const kindLabels = {
    shell: "Run a command",
    fsWrite: "Change a file",
    fsRead: "Read the filesystem",
    memory: "Update memory",
  };
  const payload = request.payload ?? {};

  let detail = "";
  if (request.kind === "shell") detail = payload.command ?? "";
  else if (payload.path) detail = `${payload.path}${payload.edit ? `\n\nreplace: ${payload.edit}…` : ""}`;
  else detail = JSON.stringify(payload, null, 2);

  const alwaysAllow = h("label", { class: "gate-check" },
    h("input", { type: "checkbox" }),
    `Always allow ${request.kind === "shell" ? "commands" : request.kind === "fsWrite" ? "file writes" : "this"}`,
  );

  const resolve = async (decision) => {
    card.classList.add("is-resolved");
    actions.replaceWith(h("div", { class: "msg-meta" }, decision ? "approved" : "denied"));
    try {
      if (decision && alwaysAllow.querySelector("input").checked) {
        const res = await api("/api/settings", { method: "PUT", body: { permissions: { [request.kind]: "allow" } } });
        state.config = res.config;
        toast(`"${request.kind}" is now always allowed (Settings → Permissions to revert)`, "ok");
      }
      await api("/api/gate", {
        method: "POST",
        body: { conversationId, gateId: request.id, decision },
      });
    } catch (err) {
      toast(err.message, "error");
    }
  };

  const actions = h("div", { class: "gate-actions" },
    h("button", { class: "btn btn-primary btn-sm", onclick: () => resolve(true) }, icon("check", 13), "Approve"),
    h("button", { class: "btn btn-danger btn-sm", onclick: () => resolve(false) }, icon("ban", 13), "Deny"),
    alwaysAllow,
  );

  const card = h("div", { class: "gate-card" },
    h("div", { class: "gate-label" }, icon("shield-check", 13), "approval needed"),
    h("div", { class: "gate-title" }, kindLabels[request.kind] ?? `Allow ${request.kind}?`),
    h("div", { class: "gate-command" }, detail),
    actions,
  );
  return card;
}

function renderQuestionCard(event, conversationId) {
  const { request } = event;
  const card = h("div", { class: "gate-card", "data-kind": "question" });

  const submit = async (answer) => {
    card.classList.add("is-resolved");
    card.querySelectorAll(".gate-actions, .gate-options, .gate-answer").forEach((el) => el.remove());
    card.append(h("div", { class: "msg-meta" }, `answered: ${answer}`));
    try {
      await api("/api/gate", {
        method: "POST",
        body: { conversationId, gateId: request.id, decision: answer },
      });
    } catch (err) {
      toast(err.message, "error");
    }
  };

  const parts = [
    h("div", { class: "gate-label" }, icon("message-square", 13), "the agent asks"),
    h("div", { class: "gate-title" }, request.question),
  ];

  if (request.options?.length) {
    parts.push(h("div", { class: "gate-options" },
      request.options.map((opt) =>
        h("button", { class: "gate-option", onclick: () => submit(opt) }, opt),
      ),
    ));
  }
  if (request.allowText !== false) {
    const input = h("input", { class: "input", placeholder: "Type an answer…", "aria-label": "Your answer" });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) submit(input.value.trim());
    });
    parts.push(h("div", { class: "gate-answer" }, input,
      h("button", { class: "btn btn-ghost btn-sm", onclick: () => input.value.trim() && submit(input.value.trim()) }, "Reply"),
    ));
  }
  card.append(...parts);
  return card;
}

/* ------------------------------------------------------------------ */
/* Composer events                                                     */
/* ------------------------------------------------------------------ */

$("#composer-send").addEventListener("click", () => {
  if (state.running) {
    if (state.current) api(`/api/runs/${state.current.id}/stop`, { method: "POST" }).catch(() => {});
  } else {
    sendMessage();
  }
});

$("#composer-input").addEventListener("input", updateComposer);
$("#composer-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$("#btn-new-chat").addEventListener("click", () => { location.hash = "#/"; });

$("#search").addEventListener("input", (e) => {
  state.searchQuery = e.target.value;
  renderSidebar();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (state.modelMenuOpen) closeModelMenu();
    else if (state.running && state.current) {
      api(`/api/runs/${state.current.id}/stop`, { method: "POST" }).catch(() => {});
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    location.hash = "#/";
    $("#composer-input").focus();
  }
});

/* ------- attachments ------- */

function renderAttachments() {
  const wrapEl = $("#attachments");
  wrapEl.innerHTML = "";
  for (const [i, att] of state.attachments.entries()) {
    wrapEl.append(h("span", { class: "attachment-chip" },
      icon("file", 12),
      h("span", {}, att.path),
      h("button", {
        "aria-label": `Remove ${att.path}`,
        onclick: () => { state.attachments.splice(i, 1); renderAttachments(); },
      }, icon("x", 11)),
    ));
  }
}

$("#btn-attach").addEventListener("click", () => {
  const value = prompt("Path of a file in the workspace to attach (relative to the workspace root):");
  if (!value?.trim()) return;
  state.attachments.push({ path: value.trim() });
  renderAttachments();
});

/* ------------------------------------------------------------------ */
/* Model picker                                                        */
/* ------------------------------------------------------------------ */

function closeModelMenu() {
  $("#model-menu")?.classList.remove("is-open");
  state.modelMenuOpen = false;
}

async function buildModelMenu() {
  const menu = $("#model-menu");
  menu.innerHTML = "";
  const groups = new Map();

  for (const provider of state.providers) {
    const models = [
      ...(state.customModels[provider.id] ?? []),
      ...provider.suggestedModels,
    ].filter((m, i, arr) => arr.indexOf(m) === i);
    if (!models.length && !provider.configured && provider.requiresKey) continue;
    groups.set(provider.id, { provider, models });
  }

  for (const { provider, models } of groups.values()) {
    menu.append(h("div", { class: "model-menu-group" }, provider.label));
    for (const model of models) {
      menu.append(h("button", {
        class: `model-menu-item${provider.id === state.config.defaults.providerId && model === state.config.defaults.modelId ? " is-active" : ""}${provider.configured ? "" : " is-unready"}`,
        onclick: async () => {
          await api("/api/settings", {
            method: "PUT",
            body: { defaults: { providerId: provider.id, modelId: model } },
          });
          state.config.defaults = { ...state.config.defaults, providerId: provider.id, modelId: model };
          renderFooter();
          updateModelChip();
          closeModelMenu();
          toast(`Default model: ${provider.label} · ${model}`, "ok", 2400);
        },
      },
        h("span", { class: "menu-model" }, model),
        provider.configured
          ? h("span", { class: "menu-ready", title: "Ready" }, icon("check", 13))
          : h("span", { class: "menu-ready", title: "Needs setup", style: "color:var(--ink-3)" }, icon("key", 12)),
      ));
    }
  }

  // Custom model id input
  const providerSelect = h("select", { class: "input", "aria-label": "Provider" },
    state.providers.map((p) => h("option", { value: p.id }, p.label)),
  );
  providerSelect.value = state.config.defaults.providerId ?? state.providers[0]?.id ?? "";
  const modelInput = h("input", { class: "input input-mono", placeholder: "model id, e.g. gpt-5.2", "aria-label": "Model id" });
  modelInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !modelInput.value.trim()) return;
    await api("/api/settings", {
      method: "PUT",
      body: { defaults: { providerId: providerSelect.value, modelId: modelInput.value.trim() } },
    });
    state.config.defaults = { ...state.config.defaults, providerId: providerSelect.value, modelId: modelInput.value.trim() };
    renderFooter();
    updateModelChip();
    closeModelMenu();
  });
  menu.append(h("div", { class: "model-menu-custom" }, providerSelect, modelInput));
}

function updateModelChip() {
  const { providerId, modelId } = state.config?.defaults ?? {};
  $("#model-chip-value").textContent = modelId ? `${providerId}/${modelId}` : "Select model";
}

$("#model-chip").addEventListener("click", async (e) => {
  e.stopPropagation();
  const menu = $("#model-menu");
  if (state.modelMenuOpen) { closeModelMenu(); return; }
  await buildModelMenu();
  menu.classList.add("is-open");
  state.modelMenuOpen = true;
});

document.addEventListener("click", (e) => {
  if (state.modelMenuOpen && !$("#model-picker").contains(e.target)) closeModelMenu();
});

/* code copy buttons (event delegation for rendered markdown) */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy-code]");
  if (!btn) return;
  const pre = document.getElementById(btn.dataset.copyCode);
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent).then(() => {
    const label = btn.querySelector("span");
    if (label) {
      label.textContent = "Copied";
      setTimeout(() => (label.textContent = "Copy"), 1400);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Settings view                                                       */
/* ------------------------------------------------------------------ */

const SETTINGS_SECTIONS = [
  { id: "providers", label: "Providers", icon: "key" },
  { id: "defaults", label: "Model & run", icon: "cpu" },
  { id: "permissions", label: "Permissions", icon: "shield-check" },
  { id: "skills", label: "Skills", icon: "book-open" },
  { id: "memory", label: "Memory", icon: "memory-stick" },
  { id: "workspace", label: "Workspace", icon: "folder" },
  { id: "about", label: "About", icon: "zap" },
];

async function renderSettings(section) {
  await refreshBootstrap();
  const view = $("#view");
  view.innerHTML = "";

  const body = h("div", { class: "settings-body" });

  const layout = h("div", { class: "settings-layout" },
    h("nav", { class: "settings-nav", "aria-label": "Settings sections" },
      SETTINGS_SECTIONS.map((s) =>
        h("a", { href: `#/settings/${s.id}`, class: s.id === section ? "is-active" : "" },
          icon(s.icon, 14), s.label),
      ),
    ),
    body,
  );

  view.append(layout);

  switch (section) {
    case "providers": renderProvidersSettings(body); break;
    case "defaults": renderDefaultsSettings(body); break;
    case "permissions": renderPermissionsSettings(body); break;
    case "skills": await renderSkillsSettings(body); break;
    case "memory": renderMemorySettings(body); break;
    case "workspace": renderWorkspaceSettings(body); break;
    default: renderAboutSettings(body);
  }
}

/* ------- providers ------- */

function renderProvidersSettings(body) {
  body.append(
    h("div", { class: "page-head" },
      h("h1", { class: "page-title" }, "Providers"),
      h("p", { class: "page-desc" },
        "Keys are stored locally in pc/data/config.json and only sent to the provider you configure. " +
        "Local runtimes (Ollama, LM Studio) need no key — just a running server."),
    ),
  );

  for (const provider of state.providers) {
    const stored = state.config.providers[provider.id] ?? {};
    const keyInput = h("input", {
      class: "input input-mono",
      type: "password",
      placeholder: provider.requiresKey ? (provider.keyHint ?? "API key") : "API key (usually not needed)",
      value: "",
      autocomplete: "off",
      "aria-label": `${provider.label} API key`,
    });
    const baseUrlInput = h("input", {
      class: "input input-mono",
      type: "text",
      placeholder: provider.defaultBaseUrl || "http://localhost:1234/v1",
      value: stored.baseUrl ?? "",
      "aria-label": `${provider.label} base URL`,
    });

    const stateBadge = h("span", {
      class: `provider-state${provider.configured ? " is-ready" : provider.hasKey ? " is-keyed" : " is-off"}`,
    }, provider.configured ? "ready" : provider.hasKey ? "needs model" : "not set up");

    const saveBtn = h("button", { class: "btn btn-ghost btn-sm" }, "Save");
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      const patch = { baseUrl: baseUrlInput.value };
      if (keyInput.value.trim()) patch.apiKey = keyInput.value.trim();
      try {
        const res = await api("/api/settings", {
          method: "PUT",
          body: { providers: { [provider.id]: patch } },
        });
        state.config = res.config;
        state.providers = (await api("/api/bootstrap")).providers;
        toast(`${provider.label} saved`, "ok");
        renderSettings("providers");
      } catch (err) {
        toast(err.message, "error");
        saveBtn.disabled = false;
      }
    });

    const fields = [];
    if (provider.requiresKey || provider.id === "openrouter" || provider.id === "custom") {
      fields.push(h("div", { class: "field" }, h("span", { class: "field-label" }, "API key"), keyInput));
    }
    fields.push(h("div", { class: "field" }, h("span", { class: "field-label" },
      provider.family === "ollama" || provider.family === "openaiCompatible" ? "Server URL" : "Base URL"), baseUrlInput));

    const actions = h("div", { class: "gate-actions" }, saveBtn);
    if (provider.docs) {
      actions.append(h("a", {
        class: "btn btn-quiet btn-sm",
        href: provider.docs, target: "_blank", rel: "noopener noreferrer",
      }, icon("external-link", 12), "Get a key"));
    }
    if (provider.family === "ollama" || provider.family === "openaiCompatible") {
      const fetchBtn = h("button", { class: "btn btn-quiet btn-sm" }, icon("refresh-cw", 12), "Fetch models");
      fetchBtn.addEventListener("click", async () => {
        fetchBtn.disabled = true;
        try {
          // save current base url first so the fetch uses it
          const patch = { baseUrl: baseUrlInput.value };
          if (keyInput.value.trim()) patch.apiKey = keyInput.value.trim();
          const res = await api("/api/settings", { method: "PUT", body: { providers: { [provider.id]: patch } } });
          state.config = res.config;
          const { models } = await api(`/api/providers/${provider.id}/models`, { method: "POST" });
          state.customModels[provider.id] = models;
          toast(`Found ${models.length} model${models.length === 1 ? "" : "s"} on ${provider.label}`, "ok");
        } catch (err) {
          toast(err.message, "error");
        }
        fetchBtn.disabled = false;
      });
      actions.append(fetchBtn);
    }

    body.append(h("div", { class: "provider-card" },
      h("div", { class: "provider-row" },
        h("div", {},
          h("div", { class: "provider-name" }, provider.label),
          h("div", { class: "provider-desc" },
            provider.family === "ollama" ? "Runs models fully on this machine — private and offline."
            : provider.family === "openaiCompatible" ? "Any OpenAI-compatible endpoint."
            : `${provider.suggestedModels.slice(0, 2).join(", ")}${provider.suggestedModels.length > 2 ? ", …" : ""}`),
        ),
        stateBadge,
      ),
      h("div", { class: "provider-fields" }, fields),
      actions,
    ));
  }
}

/* ------- defaults ------- */

function renderDefaultsSettings(body) {
  const defaults = state.config.defaults;

  const providerSelect = h("select", { class: "input", "aria-label": "Default provider" },
    state.providers.map((p) => h("option", { value: p.id, selected: p.id === defaults.providerId }, p.label)),
  );
  const modelInput = h("input", {
    class: "input input-mono",
    value: defaults.modelId ?? "",
    placeholder: "model id",
    "aria-label": "Default model id",
  });
  const stepsInput = h("input", {
    class: "input input-mono", type: "number", min: "4", max: "200",
    value: String(state.config.maxToolSteps ?? 60),
    "aria-label": "Maximum tool steps",
  });

  const save = async () => {
    try {
      const res = await api("/api/settings", {
        method: "PUT",
        body: {
          defaults: { providerId: providerSelect.value, modelId: modelInput.value.trim() },
          maxToolSteps: Number(stepsInput.value),
        },
      });
      state.config = res.config;
      renderFooter();
      updateModelChip();
      toast("Defaults saved", "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  };
  modelInput.addEventListener("keydown", (e) => e.key === "Enter" && save());
  const saveBtn = h("button", { class: "btn btn-primary btn-sm", onclick: save }, "Save defaults");

  const suggested = h("div", { class: "gate-options", style: "max-width:420px" });
  const refreshSuggested = () => {
    suggested.innerHTML = "";
    const provider = state.providers.find((p) => p.id === providerSelect.value);
    const models = [...(state.customModels[provider?.id] ?? []), ...(provider?.suggestedModels ?? [])]
      .filter((m, i, arr) => arr.indexOf(m) === i);
    if (!models.length) {
      suggested.append(h("div", { class: "section-desc" },
        provider?.family === "ollama" || provider?.family === "openaiCompatible"
          ? "No models found yet — use “Fetch models” on the Providers page."
          : "Type a model id above."));
      return;
    }
    for (const model of models) {
      suggested.append(h("button", {
        class: "gate-option",
        onclick: () => { modelInput.value = model; },
      }, model));
    }
  };
  providerSelect.addEventListener("change", refreshSuggested);
  refreshSuggested();

  body.append(
    h("div", { class: "page-head" },
      h("h1", { class: "page-title" }, "Model & run"),
      h("p", { class: "page-desc" }, "The model new chats use by default, and how many tool steps a run may take before stopping."),
    ),
    h("div", { class: "page-section" },
      h("h2", { class: "section-title" }, "Default model"),
      h("div", { class: "provider-fields" },
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Provider"), providerSelect),
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Model id"), modelInput),
      ),
      suggested,
      h("div", {}, saveBtn),
    ),
    h("div", { class: "page-section" },
      h("h2", { class: "section-title" }, "Run limits"),
      h("div", { class: "field", style: "max-width:240px" },
        h("span", { class: "field-label" }, "Max tool steps per run"),
        stepsInput,
      ),
      h("p", { class: "section-desc" }, "One step is one model call (which may contain several tool calls). When the limit is hit the run stops mid-task — raise it for long jobs."),
    ),
  );
}

/* ------- permissions ------- */

function renderPermissionsSettings(body) {
  const rows = [
    {
      key: "shell",
      title: "Shell commands",
      desc: "The agent runs real commands on this computer (cmd.exe / sh).",
    },
    {
      key: "fsWrite",
      title: "File writes & edits",
      desc: "Creating, overwriting and editing files inside the workspace root.",
    },
    {
      key: "fsRead",
      title: "File reads",
      desc: "Reading files and listing directories inside the workspace root.",
    },
  ];

  body.append(
    h("div", { class: "page-head" },
      h("h1", { class: "page-title" }, "Permissions"),
      h("p", { class: "page-desc" },
        "“Ask” pauses the agent and shows you exactly what it wants to do — the same approval flow as the mobile app. “Allow” skips the prompt for that category; “Deny” blocks it entirely."),
    ),
  );

  for (const row of rows) {
    const current = state.config.permissions[row.key] ?? "ask";
    const seg = h("div", { class: "segmented", role: "group", "aria-label": row.title });
    for (const mode of ["ask", "allow", "deny"]) {
      const btn = h("button", { class: mode === current ? "is-active" : "", "data-tone": mode === "allow" ? "accent" : "" },
        mode === "ask" ? "Ask" : mode === "allow" ? "Allow" : "Deny");
      btn.addEventListener("click", async () => {
        const res = await api("/api/settings", { method: "PUT", body: { permissions: { [row.key]: mode } } });
        state.config = res.config;
        seg.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        toast(`${row.title}: ${mode}`, "ok", 2000);
      });
      seg.append(btn);
    }
    body.append(h("div", { class: "perm-row" },
      h("div", { class: "perm-copy" },
        h("span", { class: "perm-title" }, icon(row.key === "shell" ? "terminal" : row.key === "fsWrite" ? "pencil" : "file", 14), row.title),
        h("span", { class: "perm-desc" }, row.desc),
      ),
      seg,
    ));
  }
}

/* ------- skills ------- */

async function renderSkillsSettings(body) {
  body.append(
    h("div", { class: "page-head" },
      h("h1", { class: "page-title" }, "Skills"),
      h("p", { class: "page-desc" },
        "Skills are instruction packs in the project's skills/ directory. Enabled skills are loaded into the agent's system prompt, so it can follow them when a task calls for it. The directory already ships with hallmark (anti-AI-slop design) and impeccable (frontend polish), cloned from GitHub."),
    ),
  );

  const list = h("div", { class: "settings-body" });
  for (const skill of state.skills) {
    const toggle = h("button", {
      class: "toggle",
      role: "switch",
      "aria-checked": String(skill.enabled),
      "aria-label": `Enable ${skill.name}`,
    });
    toggle.addEventListener("click", async () => {
      const res = await api(`/api/skills/${skill.slug}/toggle`, { method: "POST", body: { enabled: !skill.enabled } });
      state.skills = res.skills;
      state.config.enabledSkills = res.enabledSkills;
      toggle.setAttribute("aria-checked", String(!skill.enabled));
      if (!skill.enabled) {
        toast(`"${skill.name}" is now active in every new run`, "ok", 2600);
      }
    });

    list.append(h("div", { class: "skill-card" },
      h("div", { class: "skill-head" },
        h("span", { class: "skill-name" }, skill.slug),
        h("span", { class: "skill-meta" }, fmtBytes(skill.sizeBytes)),
        toggle,
      ),
      h("div", { class: "skill-desc" }, skill.description || "No description in SKILL.md frontmatter."),
    ));
  }

  // GitHub import
  const importInput = h("input", {
    class: "input input-mono",
    placeholder: "https://github.com/<owner>/<repo>/blob/main/SKILL.md",
    "aria-label": "GitHub URL of a skill",
  });
  const importBtn = h("button", { class: "btn btn-primary btn-sm" }, icon("link", 13), "Import");
  importBtn.addEventListener("click", async () => {
    const url = importInput.value.trim();
    if (!url) return;
    importBtn.disabled = true;
    importBtn.prepend(h("span", { class: "btn-spinner" }));
    try {
      const res = await api("/api/skills/import", { method: "POST", body: { url } });
      state.skills = res.skills;
      toast(`Imported "${res.name}" (${res.referencedFiles} reference files)`, "ok");
      renderSettings("skills");
    } catch (err) {
      toast(err.message, "error");
      importBtn.disabled = false;
      importBtn.querySelector(".btn-spinner")?.remove();
    }
  });

  body.append(list,
    h("div", { class: "page-section" },
      h("h2", { class: "section-title" }, "Import from GitHub"),
      h("p", { class: "section-desc" },
        "Paste a URL to a SKILL.md file (or its repository). The importer also pulls the markdown files the skill references."),
      h("div", { class: "gate-answer" }, importInput, importBtn),
    ),
  );
}

/* ------- memory ------- */

function renderMemorySettings(body) {
  const textarea = h("textarea", { class: "input input-mono", "aria-label": "Agent memory", spellcheck: "false" });
  textarea.value = state.memory;
  const save = async () => {
    try {
      const res = await api("/api/memory", { method: "PUT", body: { memory: textarea.value } });
      state.memory = res.memory;
      toast("Memory saved", "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  };
  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); }
  });

  body.append(
    h("div", { class: "page-head" },
      h("h1", { class: "page-title" }, "Memory"),
      h("p", { class: "page-desc" },
        "A markdown note the agent carries into every conversation. It reads and writes this file itself through the read_memory / write_memory tools — facts about you, preferences, ongoing projects."),
    ),
    h("div", { class: "page-section" },
      textarea,
      h("div", { class: "gate-actions" },
        h("button", { class: "btn btn-primary btn-sm", onclick: save }, "Save memory"),
        h("span", { class: "section-desc" }, fmtBytes(new Blob([textarea.value]).size)),
      ),
    ),
  );
}

/* ------- workspace ------- */

function renderWorkspaceSettings(body) {
  const input = h("input", {
    class: "input input-mono",
    value: state.config.workspaceRoot ?? "",
    "aria-label": "Workspace root",
  });
  const save = async () => {
    try {
      const res = await api("/api/settings", { method: "PUT", body: { workspaceRoot: input.value } });
      state.config = res.config;
      state.platform.workspaceRoot = res.config.workspaceRoot;
      renderFooter();
      toast("Workspace updated", "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && save());

  body.append(
    h("div", { class: "page-head" },
      h("h1", { class: "page-title" }, "Workspace"),
      h("p", { class: "page-desc" },
        "The root directory for the agent's file tools (read, write, edit, list, search). Shell commands are not limited to this folder — they can reach the whole machine, gated by the approval prompt."),
    ),
    h("div", { class: "page-section" },
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Workspace root"), input),
      h("div", {}, h("button", { class: "btn btn-primary btn-sm", onclick: save }, "Save")),
      h("p", { class: "section-desc" }, `Home directory: ${state.platform?.isWindows ? "%USERPROFILE%" : "~"} · current: ${state.config.workspaceRoot}`),
    ),
  );
}

/* ------- about ------- */

function renderAboutSettings(body) {
  body.append(
    h("div", { class: "page-head" },
      h("h1", { class: "page-title" }, "About"),
      h("p", { class: "page-desc" }, "The desktop companion of the Mobile Agent Android app — same agent loop, same skills system, aimed at a keyboard and a real filesystem."),
    ),
    h("div", { class: "page-section" },
      h("h2", { class: "section-title" }, "This machine"),
      h("div", { class: "tool-io", style: "max-height:none" },
        `os        ${state.platform?.os} ${state.platform?.release}\n` +
        `host      ${state.platform?.hostname}\n` +
        `node      ${state.platform?.node}\n` +
        `server    http://localhost:${location.port}\n` +
        `workspace ${state.platform?.workspaceRoot}\n` +
        `skills    ${state.skills.length} installed (${state.config.enabledSkills.length} enabled)`),
    ),
    h("div", { class: "page-section" },
      h("h2", { class: "section-title" }, "How it works"),
      h("p", { class: "section-desc" },
        "A Node.js server (this page's host) runs the agent loop with the Vercel AI SDK — the same engine as the mobile app. " +
        "Your keys and chats stay in pc/data/. Every mutating action pauses for your approval unless you allow the category in Permissions."),
      h("p", { class: "section-desc" },
        "Stop the server by closing the console window or pressing Ctrl+C. Start it again with start.bat at the repository root."),
    ),
    h("div", { class: "page-section" },
      h("h2", { class: "section-title" }, "Keyboard"),
      h("div", { class: "tool-io", style: "max-height:none" },
        "Enter        send message\n" +
        "Shift+Enter  newline\n" +
        "Esc          stop the running agent\n" +
        "Ctrl+K       new chat"),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Terminal view                                                       */
/* ------------------------------------------------------------------ */

function renderTerminal() {
  const view = $("#view");
  view.innerHTML = "";

  const screen = h("div", { class: "term-screen", "aria-live": "polite" });
  screen.append(h("div", { class: "term-empty" },
    "Commands run in the workspace, one at a time. This is your direct line — no approvals, no model in between."));

  const input = h("input", {
    "aria-label": "Terminal command",
    placeholder: "dir / echo hello / Get-Process …",
    autocomplete: "off",
    spellcheck: "false",
  });
  const history = [];
  let historyIndex = -1;

  const run = async () => {
    const command = input.value.trim();
    if (!command) return;
    input.value = "";
    history.push(command);
    historyIndex = history.length;

    screen.append(h("div", { class: "term-line is-command" }, command));
    const pending = h("div", { class: "term-line", style: "color:var(--ink-3)" }, "…");
    screen.append(pending);
    screen.scrollTop = screen.scrollHeight;

    try {
      const res = await api("/api/terminal", { method: "POST", body: { command } });
      pending.remove();
      if (res.stdout) screen.append(h("div", { class: "term-line" }, res.stdout.replace(/\n$/, "")));
      if (res.stderr) screen.append(h("div", { class: "term-line is-error" }, res.stderr.replace(/\n$/, "")));
      if (!res.stdout && !res.stderr) screen.append(h("div", { class: "term-line", style: "color:var(--ink-3)" }, "(no output)"));
      screen.append(h("div", { class: `term-exit ${res.exitCode === 0 ? "is-ok" : "is-bad"}` },
        `exit ${res.exitCode}${res.timedOut ? " · timed out" : ""} · ${new Date().toLocaleTimeString()}`));
    } catch (err) {
      pending.remove();
      screen.append(h("div", { class: "term-line is-error" }, err.message));
    }
    screen.scrollTop = screen.scrollHeight;
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
    if (e.key === "ArrowUp" && historyIndex > 0) {
      historyIndex -= 1;
      input.value = history[historyIndex];
      e.preventDefault();
    }
    if (e.key === "ArrowDown") {
      historyIndex = Math.min(history.length, historyIndex + 1);
      input.value = history[historyIndex] ?? "";
      e.preventDefault();
    }
  });

  view.append(
    h("div", { class: "terminal" },
      h("div", { class: "page-head", style: "margin-bottom:0" },
        h("h1", { class: "page-title" }, "Terminal"),
        h("p", { class: "page-desc" },
          "A quick command line into this machine — handy for checking what the agent did, or doing it yourself."),
      ),
      h("div", { class: "term-meta" }, icon("folder", 12), state.platform?.workspaceRoot ?? ""),
      screen,
      h("div", { class: "term-input-row" },
        h("span", { class: "term-prompt", "aria-hidden": "true" }, "❯"),
        input,
      ),
    ),
  );
  input.focus();
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

async function refreshBootstrap() {
  const data = await api("/api/bootstrap");
  state.bootstrap = data;
  state.conversations = data.conversations;
  state.config = data.config;
  state.skills = data.skills;
  state.providers = data.providers;
  state.memory = data.memory;
  state.platform = data.platform;
}

async function init() {
  try {
    await refreshBootstrap();
  } catch (err) {
    $("#view").append(h("div", { class: "loading-view" },
      h("div", { class: "msg-error" }, icon("triangle-alert", 15),
        `Could not reach the local server: ${err.message}`)));
    return;
  }
  renderFooter();
  updateModelChip();
  setStatus(false, "local · idle");
  await navigate();
  updateComposer();
}

init();
