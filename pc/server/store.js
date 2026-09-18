/**
 * pc/server/store.js
 * ------------------------------------------------------------
 * Tiny JSON-file persistence layer for the PC wrapper.
 *
 * Design notes:
 * - Zero dependencies, zero native modules → painless `npm install`
 *   on Windows (the mobile app uses expo-sqlite; for the desktop
 *   wrapper plain JSON keeps setup friction at zero).
 * - One file per conversation + a single config file + a memory
 *   markdown file, all under <repo>/pc/data/.
 * - Writes are atomic (tmp file + rename) so a crash never leaves
 *   a half-written conversation behind.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PC_ROOT = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(PC_ROOT, "..");
export const DATA_DIR = path.join(PC_ROOT, "data");
export const CONVERSATIONS_DIR = path.join(DATA_DIR, "conversations");
export const SKILLS_DIR = path.join(REPO_ROOT, "skills");

export function uid(prefix = "") {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

/**
 * Default configuration. `providers` mirrors the mobile app's provider
 * catalogue (anthropic / openai / google / xai / openrouter / ollama /
 * any OpenAI-compatible endpoint such as LM Studio).
 */
export const DEFAULT_CONFIG = {
  version: 1,
  // Per-provider credentials & endpoints. shape:
  //   { [providerId]: { apiKey, baseUrl, enabled } }
  providers: {},
  // Which provider/model the composer uses unless overridden per chat.
  defaults: {
    providerId: null,
    modelId: null,
    agent: "build",
  },
  // Tool permission gates: "ask" | "allow" | "deny".
  permissions: {
    shell: "ask",
    fsWrite: "ask",
    fsRead: "allow",
  },
  // Root directory the agent's file tools operate in.
  workspaceRoot: os.homedir(),
  // Skills (by slug) that get injected into the system prompt.
  enabledSkills: [],
  // Cap kept intentionally small — the system prompt has a budget.
  maxToolSteps: 60,
};

const CONFIG_FILE = path.join(DATA_DIR, "config.json");

let configCache = null;

export function getConfig() {
  if (configCache) return configCache;
  const stored = readJson(CONFIG_FILE, {});
  configCache = { ...DEFAULT_CONFIG, ...stored };
  // Deep-merge the nested maps so new keys appear after upgrades.
  configCache.permissions = { ...DEFAULT_CONFIG.permissions, ...(stored.permissions ?? {}) };
  configCache.defaults = { ...DEFAULT_CONFIG.defaults, ...(stored.defaults ?? {}) };
  return configCache;
}

export function saveConfig(patch) {
  const next = { ...getConfig(), ...patch };
  next.permissions = { ...getConfig().permissions, ...(patch.permissions ?? {}) };
  next.defaults = { ...getConfig().defaults, ...(patch.defaults ?? {}) };
  atomicWriteJson(CONFIG_FILE, next);
  configCache = next;
  return next;
}

/* ------------------------------------------------------------------ */
/* Secrets helpers                                                     */
/* ------------------------------------------------------------------ */

export function getProviderConfig(providerId) {
  return getConfig().providers[providerId] ?? null;
}

export function getProviderApiKey(providerId) {
  return getProviderConfig(providerId)?.apiKey?.trim() || null;
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

function conversationFile(id) {
  // Ids are generated locally, but never trust them on the path.
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid conversation id");
  return path.join(CONVERSATIONS_DIR, `${id}.json`);
}

export function createConversation({ title = null, agent = null } = {}) {
  ensureDir(CONVERSATIONS_DIR);
  const now = Date.now();
  const conversation = {
    id: uid("c_"),
    title,
    agent: agent ?? getConfig().defaults.agent,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    messages: [],
  };
  atomicWriteJson(conversationFile(conversation.id), conversation);
  return conversation;
}

export function listConversations() {
  ensureDir(CONVERSATIONS_DIR);
  const items = [];
  for (const entry of fs.readdirSync(CONVERSATIONS_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const conv = readJson(path.join(CONVERSATIONS_DIR, entry), null);
    if (!conv?.id) continue;
    items.push({
      id: conv.id,
      title: conv.title,
      agent: conv.agent,
      pinned: !!conv.pinned,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
    });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getConversation(id) {
  return readJson(conversationFile(id), null);
}

export function updateConversation(id, patch) {
  const conv = getConversation(id);
  if (!conv) return null;
  const next = { ...conv, ...patch, id: conv.id, updatedAt: Date.now() };
  atomicWriteJson(conversationFile(id), next);
  return next;
}

export function deleteConversation(id) {
  try {
    fs.unlinkSync(conversationFile(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Append messages to a conversation. Messages that were streamed in
 * get persisted once at natural checkpoints to keep disk churn low.
 */
export function appendMessages(id, messages) {
  const conv = getConversation(id);
  if (!conv) return null;
  conv.messages.push(...messages);
  conv.updatedAt = Date.now();
  atomicWriteJson(conversationFile(id), conv);
  return conv;
}

export function replaceMessages(id, messages) {
  const conv = getConversation(id);
  if (!conv) return null;
  conv.messages = messages;
  conv.updatedAt = Date.now();
  atomicWriteJson(conversationFile(id), conv);
  return conv;
}

/** Derive a chat title from the first user message (mobile app parity). */
export function maybeTitle(conversation) {
  if (conversation.title) return conversation.title;
  const firstUser = conversation.messages.find((m) => m.role === "user");
  if (!firstUser) return null;
  const text =
    typeof firstUser.content === "string"
      ? firstUser.content
      : (firstUser.content ?? [])
          .filter((p) => p?.type === "text")
          .map((p) => p.text)
          .join(" ");
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > 64 ? `${trimmed.slice(0, 61)}…` : trimmed;
}

/* ------------------------------------------------------------------ */
/* Memory (persistent, shared across chats — mobile app parity)        */
/* ------------------------------------------------------------------ */

const MEMORY_FILE = path.join(DATA_DIR, "memory.md");

export function readMemory() {
  try {
    return fs.readFileSync(MEMORY_FILE, "utf8");
  } catch {
    return "";
  }
}

export function writeMemory(text) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(MEMORY_FILE, text ?? "", "utf8");
  return readMemory();
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

export function initStore() {
  ensureDir(DATA_DIR);
  ensureDir(CONVERSATIONS_DIR);
  if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(MEMORY_FILE, "", "utf8");
  }
  getConfig();
}
