/**
 * pc/server/grep.js — dependency-free content search with ECMAScript regex.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { isProbablyText } from "./tools.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", "dist", "build",
  "out", "target", ".venv", "venv", "__pycache__", ".cache", ".mypy_cache",
  ".turbo", "coverage", ".pytest_cache", ".idea", ".vs", "$RECYCLE.BIN",
  "System Volume Information",
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function grep(pattern, target, { include = null, maxResults = 100 } = {}) {
  let re;
  try {
    re = new RegExp(pattern, "m");
  } catch (err) {
    throw new Error(`Invalid regular expression: ${err.message}`);
  }

  const includeRe = include ? new RegExp(`^${include.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`, "i") : null;
  const matches = [];

  async function searchFile(file, relPath) {
    if (matches.length >= maxResults) return;
    if (includeRe && !includeRe.test(path.basename(relPath))) return;
    if (!isProbablyText(file)) return;
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      return;
    }
    if (stat.size > MAX_FILE_BYTES) return;
    let content;
    try {
      content = await fsp.readFile(file, "utf8");
    } catch {
      return;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        matches.push({
          file: relPath,
          line: i + 1,
          text: lines[i].length > 300 ? `${lines[i].slice(0, 300)}…` : lines[i],
        });
        if (matches.length >= maxResults) return;
      }
    }
  }

  async function walk(dir, depth) {
    if (matches.length >= maxResults || depth > 10) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".github")) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(target, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        await searchFile(full, rel);
      }
    }
  }

  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) return matches;
  if (stat.isFile()) {
    await searchFile(target, path.basename(target));
  } else {
    await walk(target, 0);
  }
  return matches;
}
