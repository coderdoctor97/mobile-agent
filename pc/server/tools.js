/**
 * pc/server/tools.js
 * ------------------------------------------------------------
 * Built-in PC tools for the agent. This is the desktop twin of the
 * mobile app's src/modules/tools/built-in — but instead of a sandboxed
 * Android workspace it gives the agent real access to the local
 * system: shell commands, files under a workspace root, persistent
 * memory, skills, todos and subagents.
 *
 * Every tool routes through a permission gate before executing
 * (see agent.js `guardTool`): "ask" pauses the run until the user
 * approves in the web UI, exactly like the mobile app's
 * waiting_for_approval status.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getConfig, readMemory, writeMemory } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const IS_WINDOWS = process.platform === "win32";

/* ------------------------------------------------------------------ */
/* Path helpers                                                        */
/* ------------------------------------------------------------------ */

export function workspaceRoot() {
  const root = getConfig().workspaceRoot || os.homedir();
  return path.resolve(root);
}

/** Resolve a user/model-supplied path inside the workspace root. */
export function resolveInWorkspace(inputPath) {
  const root = workspaceRoot();
  const abs = path.resolve(root, inputPath ?? ".");
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path "${inputPath}" escapes the workspace root (${root}). Use absolute paths only via the shell tool.`,
    );
  }
  return abs;
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs",
  ".php", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd",
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".sql", ".graphql", ".gql", ".env", ".gitignore", ".editorconfig",
  ".xml", ".svg", ".csv", ".tsv", ".log", ".diff", ".patch", ".lock",
]);

export function isProbablyText(p, peek = true) {
  const ext = path.extname(p).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (ext === "" && peek) {
    // No extension: peek at the first bytes for binary content.
    try {
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(1024);
      const bytes = fs.readSync(fd, buf, 0, 1024, 0);
      fs.closeSync(fd);
      return !buf.subarray(0, bytes).includes(0);
    } catch {
      return false;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

const MAX_OUTPUT_BYTES = 256 * 1024;

export function runShellCommand(command, { cwd, timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve) => {
    const shell = IS_WINDOWS
      ? { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] }
      : { file: "/bin/sh", args: ["-c", command] };

    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn(shell.file, shell.args, {
      cwd: cwd || workspaceRoot(),
      env: { ...process.env, ...(env ?? {}), PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (chunk, prev) => {
      const text = chunk.toString("utf8");
      return prev.length + text.length > MAX_OUTPUT_BYTES
        ? prev + text.slice(0, MAX_OUTPUT_BYTES - prev.length) + "\n…[output truncated]"
        : prev + text;
    };

    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (c) => (stdout = append(c, stdout)));
    child.stderr.on("data", (c) => (stderr = append(c, stderr)));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ command, stdout, stderr: `${stderr}${err.message}`, exitCode: -1, timedOut: killed });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command,
        stdout,
        stderr,
        exitCode: code ?? -1,
        timedOut: killed,
        truncated: stdout.length >= MAX_OUTPUT_BYTES || stderr.length >= MAX_OUTPUT_BYTES,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Tool factory                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the tool set for a run.
 *
 * @param {object} ctx
 * @param {(event: object) => void} ctx.emit   push an SSE frame to the client
 * @param {Awaited<ReturnType<typeof import("./agent.js").createRunGate>>} ctx.gate
 * @param {object} ctx.conversation
 * @param {string} ctx.agentMode  "build" | "plan" | "general"
 */
export async function createTools(ctx) {
  const { z } = await import("zod");
  const { tool } = await import("ai");
  const { emit, gate, conversation, agentMode } = ctx;
  const root = workspaceRoot();

  // Plan mode: read-only. General subagents: read-only + research.
  const readOnly = agentMode !== "build";

  const summarize = (value) => {
    try {
      const s = JSON.stringify(value);
      return s.length > 240 ? `${s.slice(0, 237)}…` : s;
    } catch {
      return String(value);
    }
  };

  const record = (toolName, status, inputSummary, extra = {}) => {
    emit({ type: "tool-record", toolName, status, inputSummary, ...extra });
  };

  /* ------------------------- shell ------------------------- */

  const runCommand = tool({
    description:
      "Run a shell command on the user's computer and return stdout/stderr. " +
      (IS_WINDOWS
        ? "Commands run through cmd.exe. For PowerShell features call powershell -NoProfile -Command \"…\" explicitly."
        : "Commands run through /bin/sh (bash-compatible)."),
    inputSchema: z.object({
      command: z.string().min(1).describe("The shell command to run."),
      timeoutSeconds: z.number().int().min(1).max(600).optional(),
    }),
    execute: async ({ command, timeoutSeconds }) => {
      if (readOnly) throw new Error("Plan mode is read-only; shell commands are disabled.");
      await gate("shell", { command });
      record("run_command", "running", { command });
      const result = await runShellCommand(command, {
        timeoutMs: (timeoutSeconds ?? 120) * 1000,
      });
      record("run_command", result.exitCode === 0 ? "completed" : "failed", { command }, {
        exitCode: result.exitCode,
      });
      const out = [];
      if (result.stdout) out.push(result.stdout);
      if (result.stderr) out.push(`[stderr]\n${result.stderr}`);
      if (!out.length) out.push("(no output)");
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        output: out.join("\n"),
      };
    },
  });

  /* ------------------------- filesystem ------------------------- */

  const readFile = tool({
    description:
      "Read a text file from the workspace. Returns content with line numbers (format: lineno→text). Use offset/limit to page through large files.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Path relative to the workspace root (or absolute if inside it)."),
      offset: z.number().int().min(1).optional().describe("1-based line to start from."),
      limit: z.number().int().min(1).max(2000).optional().describe("Max lines to return (default 400)."),
    }),
    execute: async ({ path: p, offset, limit }) => {
      await gate("fsRead", { path: p });
      const abs = resolveInWorkspace(p);
      if (!isProbablyText(abs)) {
        return { error: `"${p}" looks like a binary file. Use the shell tool for binaries.` };
      }
      const stat = statSafe(abs);
      if (!stat?.isFile()) return { error: `No file found at "${p}".` };
      const raw = await fsp.readFile(abs, "utf8");
      const lines = raw.split("\n");
      const start = (offset ?? 1) - 1;
      const count = limit ?? 400;
      const slice = lines.slice(start, start + count).map((line, i) => `${start + i + 1}→${line}`);
      return {
        path: p,
        totalLines: lines.length,
        returnedLines: slice.length,
        truncated: start + count < lines.length,
        content: slice.join("\n"),
      };
    },
  });

  const writeFile = tool({
    description:
      "Create or overwrite a text file in the workspace. Parent directories are created. Existing content is replaced.",
    inputSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
    execute: async ({ path: p, content }) => {
      if (readOnly) throw new Error("Plan mode is read-only; writing files is disabled.");
      await gate("fsWrite", { path: p, bytes: content.length });
      const abs = resolveInWorkspace(p);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, "utf8");
      record("write_file", "completed", { path: p, bytes: content.length });
      return { path: p, bytes: content.length, written: true };
    },
  });

  const editFile = tool({
    description:
      "Edit a text file with exact search/replace. The oldString must match the file exactly once unless replaceAll is true. Read the file first.",
    inputSchema: z.object({
      path: z.string().min(1),
      oldString: z.string().min(1),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    execute: async ({ path: p, oldString, newString, replaceAll }) => {
      if (readOnly) throw new Error("Plan mode is read-only; editing files is disabled.");
      await gate("fsWrite", { path: p, edit: oldString.slice(0, 80) });
      const abs = resolveInWorkspace(p);
      const raw = await fsp.readFile(abs, "utf8");
      const count = raw.split(oldString).length - 1;
      if (count === 0) return { error: "oldString not found in file.", matches: 0 };
      if (count > 1 && !replaceAll) {
        return { error: `oldString appears ${count} times. Make it unique or pass replaceAll.`, matches: count };
      }
      const next = replaceAll
        ? raw.split(oldString).join(newString)
        : raw.replace(oldString, newString);
      await fsp.writeFile(abs, next, "utf8");
      record("edit_file", "completed", { path: p, replacements: replaceAll ? count : 1 });
      return { path: p, replacements: replaceAll ? count : 1, edited: true };
    },
  });

  const listDir = tool({
    description:
      "List a directory in the workspace: names, type, size, modified time. Use this to explore before reading.",
    inputSchema: z.object({
      path: z.string().optional().describe("Directory relative to workspace root. Defaults to the root."),
    }),
    execute: async ({ path: p = "." }) => {
      await gate("fsRead", { path: p });
      const abs = resolveInWorkspace(p);
      const stat = statSafe(abs);
      if (!stat?.isDirectory()) return { error: `"${p}" is not a directory.` };
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".gitignore") continue;
        let size = null;
        let mtime = null;
        try {
          const s = await fsp.stat(path.join(abs, entry.name));
          size = s.size;
          mtime = s.mtimeMs;
        } catch {}
        items.push({ name: entry.name, type: entry.isDirectory() ? "dir" : "file", size, mtime });
      }
      items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      return { path: p || ".", entries: items.slice(0, 500), total: items.length };
    },
  });

  const globFiles = tool({
    description: "Find files in the workspace matching glob patterns (e.g. **/*.ts, src/**).",
    inputSchema: z.object({
      pattern: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    execute: async ({ pattern, limit = 200 }) => {
      await gate("fsRead", { pattern });
      const { glob } = await import("./glob.js");
      const matches = await glob(pattern, { cwd: root, limit: limit + 1 });
      return {
        pattern,
        files: matches.slice(0, limit).map((m) => m.split(path.sep).join("/")),
        truncated: matches.length > limit,
        total: matches.length,
      };
    },
  });

  const grepContent = tool({
    description:
      "Search file contents in the workspace with a regular expression. Returns matching lines with file:line. Prefer this over reading many files.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("ECMAScript regular expression."),
      path: z.string().optional().describe("Directory or file to search. Defaults to workspace root."),
      include: z.string().optional().describe("Glob filter for files, e.g. *.py"),
      maxResults: z.number().int().min(1).max(500).optional(),
    }),
    execute: async ({ pattern, path: p = ".", include, maxResults = 100 }) => {
      await gate("fsRead", { pattern, path: p });
      const { grep } = await import("./grep.js");
      const target = resolveInWorkspace(p);
      const results = await grep(pattern, target, { include, maxResults: maxResults + 1 });
      return {
        pattern,
        matches: results.slice(0, maxResults),
        truncated: results.length > maxResults,
        total: results.length,
      };
    },
  });

  /* ------------------------- todos ------------------------- */

  const todos = tool({
    description:
      "Maintain a task list for long-running work. Call with the full updated list each time (write, not patch). Statuses: pending | in_progress | completed.",
    inputSchema: z.object({
      todos: z.array(
        z.object({
          content: z.string().min(1),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      ),
    }),
    execute: async ({ todos: next }) => {
      emit({ type: "todos", todos: next, conversationId: conversation.id });
      return { ok: true, count: next.length };
    },
  });

  /* ------------------------- ask user ------------------------- */

  const askQuestion = tool({
    description:
      "Ask the user a question and wait for their answer. Use when you genuinely need input to proceed — not for confirmations (the approval gate handles those).",
    inputSchema: z.object({
      question: z.string().min(1),
      options: z.array(z.string()).optional().describe("Up to 4 short suggested answers."),
      allowText: z.boolean().optional().default(true),
    }),
    execute: async ({ question, options, allowText }) => {
      const answer = await gate("question", { question, options, allowText });
      return { answer };
    },
  });

  /* ------------------------- subagent ------------------------- */

  const task = tool({
    description:
      "Delegate a research task to a general-purpose subagent. The subagent is read-only (list/read/search) and cannot ask the user questions. Use it for multi-step investigation you don't need to see inline.",
    inputSchema: z.object({
      description: z.string().min(1).describe("One-line description of the task."),
      prompt: z.string().min(1).describe("Full instructions for the subagent, including where to look."),
    }),
    execute: async ({ description, prompt }) => {
      const { runSubagent } = await import("./subagent.js");
      emit({ type: "subagent-start", description, conversationId: conversation.id });
      try {
        const result = await runSubagent({ description, prompt, parentMode: agentMode });
        emit({ type: "subagent-end", description, conversationId: conversation.id });
        return { summary: result };
      } catch (err) {
        emit({ type: "subagent-end", description, conversationId: conversation.id });
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  /* ------------------------- skills ------------------------- */

  const listSkills = tool({
    description: "List skills installed in the agent's skills directory.",
    inputSchema: z.object({}),
    execute: async () => {
      const { listSkills } = await import("./skills.js");
      return { skills: (await listSkills()).map((s) => ({ slug: s.slug, name: s.name, description: s.description })) };
    },
  });

  const readSkill = tool({
    description:
      "Load a skill's full instructions (SKILL.md plus optional reference files) so you can follow them. Use before doing work the skill covers.",
    inputSchema: z.object({
      slug: z.string().min(1).describe("Skill slug from listSkills, e.g. hallmark or impeccable."),
    }),
    execute: async ({ slug }) => {
      const { loadSkillForPrompt } = await import("./skills.js");
      const loaded = await loadSkillForPrompt(slug, { forTool: true });
      if (!loaded) return { error: `Skill "${slug}" not found.` };
      return { slug, instructions: loaded };
    },
  });

  /* ------------------------- memory ------------------------- */

  const readMemoryTool = tool({
    description: "Read the agent's persistent memory (facts about the user, preferences, ongoing projects).",
    inputSchema: z.object({}),
    execute: async () => ({ memory: readMemory() || "(memory is empty)" }),
  });

  const writeMemoryTool = tool({
    description:
      "Write to persistent memory. Provide the FULL memory content — this replaces the file. Keep it compact (under ~4KB), factual, and organised under headings like User, Preferences, Projects.",
    inputSchema: z.object({
      memory: z.string().min(1),
    }),
    execute: async ({ memory }) => {
      await gate("memory", { bytes: memory.length });
      writeMemory(memory);
      return { ok: true, bytes: memory.length };
    },
  });

  const tools = {
    run_command: runCommand,
    read_file: readFile,
    write_file: writeFile,
    edit_file: editFile,
    list_dir: listDir,
    glob: globFiles,
    grep: grepContent,
    todos,
    ask_question: askQuestion,
    task,
    list_skills: listSkills,
    read_skill: readSkill,
    read_memory: readMemoryTool,
    write_memory: writeMemoryTool,
  };

  if (readOnly) {
    // Plan mode keeps research tools only.
    return {
      read_file: readFile,
      list_dir: listDir,
      glob: globFiles,
      grep: grepContent,
      todos,
      ask_question: askQuestion,
      task,
      list_skills: listSkills,
      read_skill: readSkill,
      read_memory: readMemoryTool,
    };
  }

  return tools;
}
