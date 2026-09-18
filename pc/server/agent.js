/**
 * pc/server/agent.js
 * ------------------------------------------------------------
 * The agent runtime for the PC wrapper. Structurally mirrors the
 * mobile app's runtime (src/modules/runtime): an AI-SDK streamText
 * loop with tool execution, permission gates that pause the run for
 * user approval (the desktop equivalent of the app's
 * "waiting_for_approval" state), streamed to the web UI over SSE.
 */
import os from "node:os";

import { streamText } from "ai";

import {
  getConfig,
  getConversation,
  appendMessages,
  updateConversation,
  maybeTitle,
  readMemory,
  uid,
} from "./store.js";
import { resolveModel } from "./providers.js";
import { createTools, IS_WINDOWS, workspaceRoot } from "./tools.js";
import { buildSkillsPrompt } from "./skills.js";

/* ------------------------------------------------------------------ */
/* Run registry + permission gates                                     */
/* ------------------------------------------------------------------ */

/** @type {Map<string, ActiveRun>} */
export const activeRuns = new Map();

/**
 * @typedef {{
 *   conversationId: string,
 *   controller: AbortController,
 *   emit: (event: object) => void,
 *   waiters: Set<{ id: string, kind: string, resolve: Function, reject: Function }>,
 * }} ActiveRun
 */

/** Resolve a pending approval / question from the HTTP API. */
export function resolveGate(conversationId, gateId, decision) {
  const run = activeRuns.get(conversationId);
  if (!run) return { ok: false, error: "No active run for this conversation." };
  const waiter = [...run.waiters].find((w) => w.id === gateId);
  if (!waiter) return { ok: false, error: "Unknown or already-resolved request." };
  run.waiters.delete(waiter);
  waiter.resolve(decision);
  return { ok: true };
}

const GATE_TIMEOUT_MS = 10 * 60 * 1000; // approvals expire after 10 minutes

/**
 * Create the permission gate for a run. Tools call:
 *   await gate("shell", { command })     → true (or throws when denied)
 *   await gate("question", {...})        → the user's answer string
 */
function createRunGate(run) {
  const permissions = () => getConfig().permissions;

  async function gate(kind, payload = {}) {
    if (run.controller.signal.aborted) {
      throw new Error("Run was stopped.");
    }

    if (kind === "question") {
      const request = {
        id: uid("q_"),
        type: "question",
        question: payload.question,
        options: payload.options ?? [],
        allowText: payload.allowText !== false,
      };
      const answer = await waitForGate(run, request, (value) =>
        typeof value === "string" && value.trim() ? value.trim() : "(no answer provided)",
      );
      return answer;
    }

    const mode = permissions()[kind] ?? "ask";

    if (mode === "deny") {
      throw new Error(
        `Permission "${kind}" is set to deny. The user can change this in Settings → Permissions.`,
      );
    }

    if (mode === "allow") return true;

    const request = {
      id: uid("a_"),
      type: "approval",
      kind,
      payload,
    };
    const decision = await waitForGate(run, request, (value) => value === true);
    if (!decision) {
      const err = new Error("The user denied this action.");
      err.code = "APPROVAL_DENIED";
      throw err;
    }
    return true;
  }

  return gate;
}

function waitForGate(run, request, normalize) {
  return new Promise((resolve, reject) => {
    const waiter = {
      id: request.id,
      kind: request.type,
      resolve: (value) => {
        clearTimeout(timer);
        run.waiters.delete(waiter);
        resolve(normalize(value));
      },
      reject: (err) => {
        clearTimeout(timer);
        run.waiters.delete(waiter);
        reject(err);
      },
    };
    const timer = setTimeout(() => {
      run.waiters.delete(waiter);
      reject(new Error("Approval timed out after 10 minutes of inactivity."));
    }, GATE_TIMEOUT_MS);
    run.waiters.add(waiter);
    run.emit({ type: request.type, conversationId: run.conversationId, request });
  });
}

/* ------------------------------------------------------------------ */
/* System prompt                                                       */
/* ------------------------------------------------------------------ */

export const AGENTS = {
  build: {
    id: "build",
    name: "Build",
    description: "The default agent. Executes tasks with all tools and permissions.",
  },
  plan: {
    id: "plan",
    name: "Plan",
    description: "Research and present plans without making any changes. Read-only.",
  },
};

const PLAN_MODE_PROMPT = [
  "You are in Plan mode. You may research, inspect, and analyze, but you must NOT make any changes.",
  "Never create, write, edit, delete, move, or rename files. Never run commands that modify state.",
  "Your mutating tools are disabled — attempting a change is impossible. Investigate the relevant topic and present a clear, step-by-step plan.",
  "Structure your plan with the specific steps involved, why each step is needed, and any risks or trade-offs you noticed.",
  "End by telling the user to switch to the Build agent when they are ready for you to make the changes.",
].join("\n");

async function buildSystemPrompt(agentMode) {
  const root = workspaceRoot();
  const config = getConfig();
  const memory = readMemory().trim();

  const osLine = IS_WINDOWS
    ? `Windows (${os.release()})`
    : `${os.type()} ${os.release()}`;
  const shellLine = IS_WINDOWS
    ? "cmd.exe (call `powershell -NoProfile -Command \"…\"` for PowerShell features)"
    : "/bin/sh (POSIX)";

  const sections = [];

  sections.push(
    [
      "You are Mobile Agent, an AI agent running as a local web tool on the user's computer.",
      `Host: ${osLine} · shell: ${shellLine} · node ${process.versions.node}`,
      `Workspace root (file tools): ${root}`,
      `Current date: ${new Date().toISOString().slice(0, 10)}`,
      "",
      "You have direct access to the local system:",
      "- run_command executes real shell commands on this machine.",
      "- read_file / write_file / edit_file / list_dir / glob / grep operate on real files under the workspace root.",
      "- read_memory / write_memory maintain persistent memory across conversations.",
      "- task delegates read-only research to a subagent.",
      "- ask_question asks the user when you genuinely need their input.",
      "",
      "Working principles:",
      "- Be an agent, not a search engine: do the work with tools instead of only describing it.",
      "- Prefer the least destructive action. Ask before anything irreversible (deleting, overwriting, system settings).",
      "- Verify your work: after writing or changing something, read it back or test it.",
      "- Keep answers tight and concrete. Use file paths and command output, not vague references.",
      "- When a task touches a subject covered by an enabled skill, follow that skill's instructions.",
    ].join("\n"),
  );

  if (memory) {
    sections.push(`## Memory\n\n${memory}`);
  }

  const skillsPrompt = await buildSkillsPrompt();
  if (skillsPrompt) {
    sections.push(skillsPrompt);
  }

  if (agentMode === "plan") {
    sections.push(PLAN_MODE_PROMPT);
  }

  return sections.join("\n\n---\n\n");
}

/* ------------------------------------------------------------------ */
/* Message conversion (stored → AI SDK ModelMessage[])                 */
/* ------------------------------------------------------------------ */

/**
 * Stored assistant content is a flat array of parts in ai@7 shape:
 * {type:'text'} | {type:'reasoning'} | {type:'tool-call'} | {type:'tool-result'}.
 * The SDK wants tool results in a follow-up `tool` message, so we split.
 */
export function storedToModelMessages(messages) {
  const out = [];

  for (const message of messages) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : flattenParts(message.content);
      if (content) out.push({ role: "user", content });
      continue;
    }
    if (message.role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      if (!parts.length) continue;

      const assistantParts = [];
      const toolResults = [];

      for (const part of parts) {
        if (part?.type === "tool-result") {
          toolResults.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: normalizeToolOutput(part.output),
          });
        } else if (part?.type === "tool-call") {
          assistantParts.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input ?? part.args ?? {},
          });
        } else if (part?.type === "text") {
          if (part.text?.trim()) assistantParts.push({ type: "text", text: part.text });
        } else if (part?.type === "reasoning") {
          // Reasoning from previous runs is not replayed to the model.
        }
      }

      if (assistantParts.length) {
        out.push({
          role: "assistant",
          content: assistantParts.length === 1 && assistantParts[0].type === "text"
            ? assistantParts[0].text
            : assistantParts,
        });
      }
      if (toolResults.length) {
        out.push({ role: "tool", content: toolResults });
      }
      continue;
    }
  }

  return out;
}

function flattenParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p?.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function normalizeToolOutput(output) {
  if (output === null || output === undefined) return { type: "text", value: "" };
  if (typeof output === "string") return { type: "text", value: output };
  if (typeof output === "object" && output.type && ("value" in output || output.type === "execution-denied")) {
    return output;
  }
  return { type: "json", value: output };
}

/* ------------------------------------------------------------------ */
/* The run loop                                                        */
/* ------------------------------------------------------------------ */

/**
 * Start an agent run for a conversation.
 *
 * @param {object} input
 * @param {string} input.conversationId
 * @param {string} input.userMessage
 * @param {{path:string}[]} [input.attachments] workspace files referenced by the user
 * @param {string} [input.providerId]  override defaults
 * @param {string} [input.modelId]
 * @param {string} [input.agent]  build | plan
 * @param {(event:object)=>void} input.emit  SSE emitter
 */
export async function startRun(input) {
  const {
    conversationId,
    userMessage,
    attachments = [],
    providerId,
    modelId,
    agent,
    emit,
  } = input;

  const conversation = getConversation(conversationId);
  if (!conversation) throw new Error("Conversation not found.");

  const config = getConfig();
  const resolvedProvider = providerId || config.defaults.providerId;
  const resolvedModel = modelId || config.defaults.modelId;
  const agentMode = agent || conversation.agent || "build";

  if (!resolvedProvider || !resolvedModel) {
    throw new Error(
      "No model configured yet. Open Settings → Providers, add a key (or point at Ollama), and pick a model.",
    );
  }

  /** @type {ActiveRun} */
  const run = {
    conversationId,
    controller: new AbortController(),
    emit,
    waiters: new Set(),
  };
  if (activeRuns.has(conversationId)) {
    throw new Error("A run is already active in this conversation.");
  }
  activeRuns.set(conversationId, run);

  const gate = createRunGate(run);
  const model = resolveModel(resolvedProvider, resolvedModel);

  // ----- persist the user message --------------------------------
  const attachmentNote = attachments.length
    ? `\n\n[Attached workspace files]\n${attachments.map((a) => `- ${a.path}`).join("\n")}`
    : "";
  const userRecord = {
    id: uid("m_"),
    role: "user",
    content: userMessage + attachmentNote,
    createdAt: Date.now(),
    attachments: attachments.map((a) => a.path),
  };
  appendMessages(conversationId, [userRecord]);

  emit({
    type: "run-start",
    conversationId,
    message: userRecord,
    provider: resolvedProvider,
    model: resolvedModel,
    agent: agentMode,
  });

  // ----- build the prompt ----------------------------------------
  const history = getConversation(conversationId).messages;
  const modelMessages = storedToModelMessages(history);
  const system = await buildSystemPrompt(agentMode);
  const tools = await createTools({ emit, gate, conversation, agentMode });

  // The last user message is already in history via appendMessages.

  const assistantParts = [];
  let sawError = null;

  try {
    const result = streamText({
      model,
      system,
      messages: modelMessages,
      tools,
      abortSignal: run.controller.signal,
      stopWhen: ({ steps }) => steps.length >= (config.maxToolSteps ?? 60),
      onError: ({ error }) => {
        sawError = error;
      },
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta": {
          assistantParts.push({ type: "text", text: part.text });
          emit({
            type: "text-delta",
            conversationId,
            delta: part.text,
          });
          break;
        }
        case "reasoning-delta": {
          const last = assistantParts[assistantParts.length - 1];
          if (last?.type === "reasoning") {
            last.text += part.text;
          } else {
            assistantParts.push({ type: "reasoning", text: part.text });
          }
          emit({ type: "reasoning-delta", conversationId, delta: part.text });
          break;
        }
        case "tool-call": {
          assistantParts.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          emit({
            type: "tool-call",
            conversationId,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          break;
        }
        case "tool-result": {
          assistantParts.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
          });
          emit({
            type: "tool-result",
            conversationId,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
          });
          break;
        }
        case "step-start": {
          emit({ type: "step-start", conversationId });
          break;
        }
        case "step-end": {
          emit({ type: "step-end", conversationId, step: part.stepNumber ?? null });
          break;
        }
        case "error": {
          sawError = part.error;
          emit({ type: "stream-error", conversationId, error: String(part.error?.message ?? part.error) });
          break;
        }
        default:
          break;
      }
    }

    // If the run aborted, surface it cleanly.
    if (run.controller.signal.aborted) {
      emit({ type: "run-end", conversationId, reason: "aborted" });
    } else if (sawError && !assistantParts.some((p) => p.type === "text")) {
      // Nothing useful was produced — report the provider error.
      const message = sawError?.message ?? String(sawError);
      emit({ type: "error", conversationId, error: message });
    } else {
      emit({ type: "run-end", conversationId, reason: "completed" });
    }
  } catch (err) {
    if (run.controller.signal.aborted || err?.name === "AbortError" || err?.code === "APPROVAL_TIMEOUT") {
      emit({ type: "run-end", conversationId, reason: "aborted" });
    } else {
      sawError = err;
      emit({
        type: "error",
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    // ----- persist the assistant turn ----------------------------
    const trimmed = assistantParts.filter(
      (p) =>
        (p.type === "text" && p.text?.trim()) ||
        (p.type === "reasoning" && p.text?.trim()) ||
        p.type === "tool-call" ||
        p.type === "tool-result",
    );

    if (trimmed.length) {
      appendMessages(conversationId, [
        {
          id: uid("m_"),
          role: "assistant",
          content: trimmed,
          createdAt: Date.now(),
          error: sawError ? String(sawError?.message ?? sawError) : null,
          model: `${resolvedProvider}/${resolvedModel}`,
          agent: agentMode,
        },
      ]);
    }

    const updated = getConversation(conversationId);
    if (updated) {
      const title = maybeTitle(updated);
      if (title && title !== updated.title) {
        updateConversation(conversationId, { title });
        emit({ type: "conversation-titled", conversationId, title });
      }
    }

    activeRuns.delete(conversationId);
    emit({ type: "done", conversationId });
  }
}

/** Abort an active run (Stop button). */
export function stopRun(conversationId) {
  const run = activeRuns.get(conversationId);
  if (!run) return false;
  run.controller.abort();
  // Release any pending approvals/questions as "stopped".
  for (const waiter of [...run.waiters]) {
    waiter.reject(new Error("Run was stopped."));
  }
  return true;
}

export function isRunActive(conversationId) {
  return activeRuns.has(conversationId);
}
