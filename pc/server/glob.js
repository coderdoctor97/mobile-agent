/**
 * pc/server/glob.js — minimal dependency-free glob for the file tools.
 * Supports **, * and ? plus brace expansion of simple lists.
 */
import fsp from "node:fs/promises";
import path from "node:path";

function globToRegExp(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match across separators (and the separator itself)
        i += 2;
        if (pattern[i] === "/") i += 1;
        re += "(?:.*\\/)?";
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i += 1;
      } else {
        const options = pattern.slice(i + 1, end).split(",").map(escapeSegment).join("|");
        re += `(?:${options})`;
        i = end + 1;
      }
    } else {
      re += escapeSegment(ch);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

function escapeSegment(ch) {
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", "dist", "build",
  "out", "target", ".venv", "venv", "__pycache__", ".cache", ".mypy_cache",
  ".turbo", "coverage", ".pytest_cache", ".idea", ".vs", "$RECYCLE.BIN",
  "System Volume Information",
]);

export async function glob(pattern, { cwd, limit = 500 } = {}) {
  const re = globToRegExp(pattern.replace(/\\/g, "/"));
  const results = [];

  async function walk(dir, depth) {
    if (results.length >= limit || depth > 12) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const rel = path.relative(cwd, path.join(dir, entry.name)).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (re.test(rel)) results.push(rel);
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (re.test(rel)) {
        results.push(rel);
      }
    }
  }

  // Absolute-pattern support: pattern may itself be under cwd
  await walk(cwd, 0);
  return results;
}
