/**
 * pc/server/subagent.js
 * ------------------------------------------------------------
 * Read-only research subagent (the PC twin of the mobile app's
 * general subagent). Runs a nested generateText with a restricted,
 * read-only toolset — no approvals, no mutations, no follow-up
 * questions — and returns a summary for the primary agent.
 */
import { streamText, tool } from "ai";
import { z } from "zod";

import { getConfig } from "./store.js";
import { resolveModel } from "./providers.js";
import { resolveInWorkspace, isProbablyText } from "./tools.js";
import fsp from "node:fs/promises";

const SUBAGENT_SYSTEM = [
  "You are a read-only research subagent inside Mobile Agent (PC).",
  "You cannot modify anything and you cannot ask the user questions.",
  "Investigate the task with the file tools available and return a dense,",
  "well-organised summary: what you found, file paths, relevant snippets,",
  "and anything that needs follow-up. Be concise and factual.",
].join(" ");

function buildSubagentTools() {
  const read = async (p, offset, limit) => {
    const abs = resolveInWorkspace(p);
    if (!isProbablyText(abs)) return { error: `"${p}" looks binary.` };
    const raw = await fsp.readFile(abs, "utf8").catch(() => null);
    if (raw === null) return { error: `No file found at "${p}".` };
    const lines = raw.split("\n");
    const start = (offset ?? 1) - 1;
    const count = limit ?? 300;
    const slice = lines.slice(start, start + count).map((line, i) => `${start + i + 1}→${line}`);
    return {
      path: p,
      totalLines: lines.length,
      truncated: start + count < lines.length,
      content: slice.join("\n"),
    };
  };

  return {
    read_file: tool({
      description: "Read a text file (read-only).",
      inputSchema: z.object({
        path: z.string().min(1),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      execute: async ({ path: p, offset, limit }) => read(p, offset, limit),
    }),
    list_dir: tool({
      description: "List a directory (read-only).",
      inputSchema: z.object({
        path: z.string().optional(),
      }),
      execute: async ({ path: p = "." }) => {
        const abs = resolveInWorkspace(p);
        const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => null);
        if (!entries) return { error: `Cannot read "${p}".` };
        return {
          path: p,
          entries: entries
            .filter((e) => !e.name.startsWith("."))
            .slice(0, 400)
            .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })),
        };
      },
    }),
    grep: tool({
      description: "Search file contents with a regular expression (read-only).",
      inputSchema: z.object({
        pattern: z.string().min(1),
        path: z.string().optional(),
        include: z.string().optional(),
        maxResults: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ pattern, path: p = ".", include, maxResults = 60 }) => {
        const { grep } = await import("./grep.js");
        const target = resolveInWorkspace(p);
        const matches = await grep(pattern, target, { include, maxResults });
        return { pattern, matches, total: matches.length };
      },
    }),
    glob: tool({
      description: "Find files matching a glob pattern (read-only).",
      inputSchema: z.object({
        pattern: z.string().min(1),
        limit: z.number().int().min(1).max(300).optional(),
      }),
      execute: async ({ pattern, limit = 200 }) => {
        const { glob } = await import("./glob.js");
        const files = await glob(pattern, { cwd: resolveInWorkspace("."), limit });
        return { pattern, files, total: files.length };
      },
    }),
  };
}

export async function runSubagent({ description, prompt, parentMode }) {
  const config = getConfig();
  const providerId = config.defaults.providerId;
  const modelId = config.defaults.modelId;
  if (!providerId || !modelId) {
    return "Subagent could not run: no default model configured.";
  }

  const model = resolveModel(providerId, modelId);

  // Stream (like the mobile app's driver) so providers that only
  // support streaming responses work too; collect the text.
  let text = "";
  const toolNames = new Set();
  const result = streamText({
    model,
    system: SUBAGENT_SYSTEM,
    prompt: `Task: ${description}\n\n${prompt}`,
    tools: buildSubagentTools(),
    stopWhen: ({ steps }) => steps.length >= 12,
    abortSignal: AbortSignal.timeout(300_000),
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      text += part.text;
    } else if (part.type === "tool-call") {
      toolNames.add(part.toolName);
    }
  }

  const toolNotes = toolNames.size
    ? `\n\n[Used tool(s): ${[...toolNames].join(", ")}]`
    : "";

  return `${text || "(no output)"}${toolNotes}`;
}
