import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectRepoLocalShadow, FORMULA_FILENAME, seedFormula } from "./formula-seed.mjs";

/**
 * Warn when a repo-local formula at bd search path #2 shadows the packaged one seeded at path #3.
 * bd takes the FIRST hit, so a stale `<checkout-root>/.beads/formulas/` copy silently wins while our
 * user-level symlink still looks correct — this is the only place that silence gets broken. The
 * checkout root is resolved the way bd does it: `git rev-parse --git-common-dir` names the PRIMARY
 * checkout's git dir even from a linked worktree, and its dirname is the root bd reads. Advisory
 * only: never throws, never writes, and a missing git/exec/git-repo is a silent no-op.
 */
export async function warnOnRepoLocalShadow({ exec, cwd, sourcePath, warn = console.warn }) {
  try {
    if (typeof exec !== "function") return; // loaded without a pi api: nothing to resolve with
    const r = await exec("git", ["rev-parse", "--git-common-dir"], { cwd });
    if (r?.code !== 0 || !r.stdout?.trim()) return; // not a git repo: no checkout root to check
    // --git-common-dir is ".git" (relative) in a primary checkout and an absolute path in a worktree.
    const root = path.dirname(path.resolve(cwd, r.stdout.trim()));
    const shadow = await detectRepoLocalShadow(root, sourcePath);
    if (!shadow) return;
    warn(
      `[pi-superpowers-plus] repo-local formula shadows the packaged one: ${shadow.path} differs from ${shadow.sourcePath}; bd reads the repo-local copy. Remove it, or symlink it to the packaged formula, to track the package.`,
    );
  } catch {
    // advisory check: a failure here must never surface as a startup error
  }
}

// Auto-seeds the bundled superpowers-workflow formula into user-level ~/.beads/formulas/
// (bd formula search path #3) as a symlink into this installed package, so every beads project
// finds it with zero per-project setup. Runs before session_start; a failed seed is a silent
// no-op (never a startup error). The shadow check below is the one thing that must be visible:
// a repo-local copy at search path #2 outranks the seed, and nothing else reports that.
export default function formulaSeed(pi?: ExtensionAPI) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const source = path.join(here, "..", "formulas", FORMULA_FILENAME);
  if (!existsSync(source)) return; // no bundled formula in this copy — nothing to seed

  const targetDir = path.join(os.homedir(), ".beads", "formulas");
  void seedFormula(source, targetDir).then(({ action }) => {
    if (action === "linked" || action === "relinked") {
      console.log(`[pi-superpowers-plus] seeded formula symlink: ${targetDir}/${FORMULA_FILENAME}`);
    }
  });

  void warnOnRepoLocalShadow({ exec: pi?.exec, cwd: process.cwd(), sourcePath: source });
}
