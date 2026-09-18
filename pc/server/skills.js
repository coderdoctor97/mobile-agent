/**
 * pc/server/skills.js
 * ------------------------------------------------------------
 * Skills live in <repo>/skills/<slug>/SKILL.md — the project's skill
 * dictionary. The directory already ships with two cloned from
 * GitHub (hallmark + impeccable); users can add more through the
 * UI's GitHub importer, exactly like the mobile app's skill import.
 *
 * A skill is a markdown file with YAML frontmatter:
 *   ---
 *   name: hallmark
 *   description: Anti-AI-slop design skill …
 *   ---
 *   … instructions the agent follows …
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { SKILLS_DIR, getConfig } from "./store.js";

const MAX_SKILL_BYTES = 400_000;

export function parseSkillMarkdown(markdown, sourcePath = null) {
  let name = null;
  let description = null;
  let body = markdown;

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (match) {
    body = match[2];
    for (const line of match[1].split("\n")) {
      const nm = /^\s*name:\s*(.+)$/i.exec(line);
      if (nm) name = nm[1].trim().replace(/^["']|["']$/g, "");
      const dm = /^\s*description:\s*(.+)$/i.exec(line);
      if (dm) description = dm[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  const slug = path.basename(path.dirname(sourcePath ?? "x/skill.md")) || name || "skill";
  const firstHeading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? null;

  return {
    slug,
    name: name || firstHeading || slug,
    description: description || null,
    instructions: body.trim(),
  };
}

/** Candidate SKILL.md locations inside a skill directory (repo clones nest them). */
function skillFileCandidates(slug) {
  return [
    path.join(SKILLS_DIR, slug, "SKILL.md"),
    path.join(SKILLS_DIR, slug, "skills", slug, "SKILL.md"),
    path.join(SKILLS_DIR, slug, "skill", "SKILL.md"),
    path.join(SKILLS_DIR, slug, "skill", "SKILL.src.md"),
  ];
}

async function findSkillFile(slug) {
  for (const candidate of skillFileCandidates(slug)) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile() && stat.size <= MAX_SKILL_BYTES) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function listSkills() {
  const skills = [];
  let entries = [];
  try {
    entries = await fsp.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillFile = await findSkillFile(entry.name);
    if (!skillFile) continue;
    try {
      const stat = await fsp.stat(skillFile);
      const markdown = await fsp.readFile(skillFile, "utf8");
      const parsed = parseSkillMarkdown(markdown, skillFile);
      skills.push({
        slug: entry.name,
        name: parsed.name,
        description: parsed.description,
        sizeBytes: stat.size,
        enabled: getConfig().enabledSkills.includes(entry.name),
      });
    } catch {
      // unreadable — skip
    }
  }
  return skills.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Load a skill's instructions for the system prompt. For repos cloned
 * from GitHub (like hallmark/impeccable) the SKILL.md may live one
 * level down (e.g. hallmark/skills/hallmark/SKILL.md) — resolve that.
 */
export async function loadSkillForPrompt(slug, { forTool = false } = {}) {
  const skillFile = await findSkillFile(slug);
  if (!skillFile) return null;
  const markdown = await fsp.readFile(skillFile, "utf8");
  const parsed = parseSkillMarkdown(markdown, skillFile);
  return parsed.instructions;
}

/** Build the skills block for the system prompt (enabled skills only). */
export async function buildSkillsPrompt() {
  const enabled = getConfig().enabledSkills;
  if (!enabled.length) return "";
  const blocks = [];
  for (const slug of enabled) {
    const instructions = await loadSkillForPrompt(slug);
    if (!instructions) continue;
    blocks.push(
      `### Skill: ${slug}\n\nThe user has enabled the "${slug}" skill. When the task falls inside its scope, follow these instructions:\n\n${instructions}`,
    );
  }
  if (!blocks.length) return "";
  return `## Enabled skills\n\n${blocks.join("\n\n---\n\n")}`;
}

/* ------------------------------------------------------------------ */
/* GitHub import (mobile app parity: fetch SKILL.md + referenced files) */
/* ------------------------------------------------------------------ */

export function githubBlobToRaw(url) {
  return (
    url
      .replace("https://github.com", "https://raw.githubusercontent.com")
      .replace("/blob/", "/")
      // strip #L12 line anchors
      .replace(/#L\d+(-L\d+)?$/, "")
  );
}

async function fetchText(url, maxBytes = MAX_SKILL_BYTES) {
  const res = await fetch(url, {
    headers: { Accept: "*/*", "User-Agent": "mobile-agent-pc-skill-importer" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const text = await res.text();
  if (text.length > maxBytes) throw new Error(`File too large: ${url}`);
  return text;
}

/**
 * Import a skill from a GitHub URL pointing at a SKILL.md blob
 * (or a repo tree URL — we try common layouts).
 * Returns the created slug.
 */
export async function importSkillFromGithub(sourceUrl) {
  const raw = githubBlobToRaw(sourceUrl.trim());
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i.exec(raw);
  if (!match) throw new Error("Provide a GitHub URL to a SKILL.md file or its repository.");
  const [, owner, repo, branch, filePath] = match;

  let markdown = null;
  let usedPath = filePath;

  if (/SKILL(\.src)?\.md$/i.test(filePath)) {
    markdown = await fetchText(raw);
  } else {
    // Try common skill layouts inside the repo.
    for (const candidate of [
      "SKILL.md",
      "skills/SKILL.md",
      `skills/${repo}/SKILL.md`,
      "skill/SKILL.md",
    ]) {
      try {
        markdown = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${candidate}`);
        usedPath = candidate;
        break;
      } catch {
        continue;
      }
    }
  }

  if (!markdown) {
    throw new Error(
      `Could not find a SKILL.md in ${owner}/${repo}. Point the URL directly at the SKILL.md file.`,
    );
  }

  const parsed = parseSkillMarkdown(markdown, usedPath);
  let slug = (parsed.name || repo)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) slug = repo.toLowerCase();

  const dir = path.join(SKILLS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), markdown, "utf8");

  // Pull referenced reference files when they sit next to SKILL.md.
  const dirPath = path.dirname(usedPath);
  const refMatches = [...markdown.matchAll(/\]\(([^)#\s]+\.md)\)/g)].map((m) => m[1]);
  const refs = [...new Set(refMatches)].filter((r) => !/^[a-z]+:\/\//i.test(r)).slice(0, 20);
  let imported = 0;
  for (const ref of refs) {
    const refRemote = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dirPath}/${ref}`;
    const localDir = path.join(dir, path.dirname(ref));
    try {
      const content = await fetchText(refRemote, 200_000);
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, path.basename(ref)), content, "utf8");
      imported += 1;
    } catch {
      // optional reference — ignore failures
    }
  }

  return { slug, name: parsed.name, description: parsed.description, referencedFiles: imported };
}
