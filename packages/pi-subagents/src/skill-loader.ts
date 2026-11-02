/**
 * skill-loader.ts — Preload named skills.
 *
 * Roots, in precedence order:
 *   - <cwd>/.pi/skills           (project, Pi's standard)
 *   - <cwd>/.agents/skills       (project, cross-tool Agent Skills spec — https://agentskills.io)
 *   - getAgentDir()/skills       (user, default ~/.pi/agent/skills — Pi's standard)
 *   - ~/.agents/skills           (user, cross-tool Agent Skills spec)
 *   - ~/.pi/skills               (legacy global, pre-Pi)
 *
 * Layout per root:
 *   - <root>/<name>.md            (flat file at the top level)
 *   - <root>/.../<name>/SKILL.md  (directory skill, may be nested — Pi's standard)
 *
 * Recursion skips dotfile entries and node_modules. A directory that itself contains
 * SKILL.md is a skill — we don't descend into it (Pi: skills don't nest).
 *
 * Symlinks are rejected for security (deviation from Pi, which follows them).
 */

import type { Dirent } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSymlink, isUnsafeName, safeReadFile } from "./memory.js";

export interface PreloadedSkill {
  name: string;
  content: string;
}

export function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[] {
  return skillNames.map((name) => ({ name, content: loadSkillContent(name, cwd) }));
}

/**
 * Where a named skill lives, or undefined when nothing loads under it.
 *
 * The same discovery `preloadSkills()` does, stopping one step earlier: a flat
 * `<root>/<name>.md` is that file, and a directory skill is the path pi loads
 * for `--skill <path>` (the directory, not its `SKILL.md`). A pane child is told
 * its skills by path — the in-process path preloads their text into the prompt
 * instead — so this is the one place both carriers agree on which file a name
 * means.
 */
export function findSkillPath(name: string, cwd: string): string | undefined {
  // A name that could escape the roots is not a name a skill can have;
  // `preloadSkills()` reports it rather than resolving it.
  if (isUnsafeName(name)) return undefined;
  for (const root of skillRoots(cwd)) {
    const found = findInRoot(root, name);
    if (found !== undefined) return found.path;
  }
  return undefined;
}

/**
 * The roots a skill is looked up in, in precedence order. Shared so a skill's
 * content and its path can never be discovered from different places.
 */
function skillRoots(cwd: string): string[] {
  return [
    join(cwd, ".pi", "skills"), // project — Pi standard
    join(cwd, ".agents", "skills"), // project — Agent Skills spec
    join(getAgentDir(), "skills"), // user — Pi standard
    join(homedir(), ".agents", "skills"), // user — Agent Skills spec
    join(homedir(), ".pi", "skills"), // legacy global, pre-Pi
  ];
}

function loadSkillContent(name: string, cwd: string): string {
  if (isUnsafeName(name)) {
    return `(Skill "${name}" skipped: name contains path traversal characters)`;
  }
  for (const root of skillRoots(cwd)) {
    const found = findInRoot(root, name);
    if (found !== undefined) return found.content;
  }
  return `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`;
}

/** A skill's path and its content: the path is what a `--skill` flag takes. */
function findInRoot(root: string, name: string): { path: string; content: string } | undefined {
  if (isSymlink(root)) return undefined; // reject symlinked roots entirely
  const flatPath = join(root, `${name}.md`);
  const flatContent = safeReadFile(flatPath)?.trim();
  if (flatContent !== undefined) return { path: flatPath, content: flatContent };
  return findSkillDirectory(root, name);
}

/** BFS under `root` for a directory named `name` containing `SKILL.md`. Pi-conforming filters. */
function findSkillDirectory(root: string, name: string): { path: string; content: string } | undefined {
  if (!existsSync(root)) return undefined;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    // Deterministic byte-order traversal — locale-independent.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      // Symlinked dirs already filtered by entry.isDirectory() — Dirent uses lstat semantics.
      const path = join(current, entry.name);
      const skillMd = join(path, "SKILL.md");
      const isSkillDir = existsSync(skillMd);

      if (isSkillDir) {
        if (entry.name === name) {
          const content = safeReadFile(skillMd)?.trim();
          if (content !== undefined) return { path, content };
        }
        continue; // Pi rule: skills don't nest — don't descend into a skill dir
      }

      queue.push(path);
    }
  }
  return undefined;
}
