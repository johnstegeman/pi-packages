// formula-seed.mjs — pure, dependency-free seeding of a workflow formula into a target dir.
// Never throws; every failure maps to a "skipped-*" action.
import { lstat, mkdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

export const FORMULA_FILENAME = "superpowers-workflow.formula.toml";

export async function seedFormula(sourcePath, targetDir) {
  const target = join(targetDir, FORMULA_FILENAME);
  try {
    // source must exist (symlinking a missing source would create a dangling link we don't want)
    await lstat(sourcePath);
  } catch {
    return { action: "skipped-error", target };
  }
  try {
    await mkdir(targetDir, { recursive: true });
  } catch {
    return { action: "skipped-unwritable", target };
  }
  try {
    const st = await lstat(target).catch(() => null);
    if (!st) {
      // absent -> create our symlink
      await symlink(sourcePath, target);
      return { action: "linked", target };
    }
    if (!st.isSymbolicLink()) {
      // a real file a user placed here -> never touch
      return { action: "skipped-user-file", target };
    }
    // it IS a symlink: check where it points
    const currentLink = await readlink(target);
    const currentTarget = await realpath(target).catch(() => null); // resolves only if not dangling
    if (currentTarget !== null) {
      const sourceReal = await realpath(sourcePath); // source exists (checked above)
      if (currentTarget === sourceReal) return { action: "already-linked", target };
      return { action: "skipped-foreign", target };
    }
    // dangling (realpath failed) -> recreate to point at source
    if (currentLink !== sourcePath) {
      await import("node:fs/promises").then(({ unlink }) => unlink(target));
      await symlink(sourcePath, target);
    }
    return { action: "relinked", target };
  } catch {
    return { action: "skipped-error", target };
  }
}

// bd resolves formulas from three search paths and the FIRST hit wins:
//   1. <resolved-beads-dir>/formulas/   2. <checkout-root>/.beads/formulas/   3. ~/.beads/formulas/
// seedFormula() maintains path #3, but a hand-placed real file (or a foreign symlink) at path #2
// silently shadows it: bd keeps reading the stale repo-local copy while our seed looks healthy.
// This helper makes that shadow detectable (read-only — it never touches the repo-local path) so
// the extension can say so out loud. A missing, dangling, or unreadable file is simply "no shadow":
// every failure maps to null, never an error.
export async function detectRepoLocalShadow(projectRoot, sourcePath) {
  const repoPath = join(projectRoot, ".beads", "formulas", FORMULA_FILENAME);
  try {
    const st = await lstat(repoPath);
    if (st.isDirectory()) return null; // a directory is not a formula file bd would read
    // Compare bytes: "identical" is a content check, not a path/realpath identity check.
    const [repoBytes, sourceBytes] = await Promise.all([readFile(repoPath), readFile(sourcePath)]);
    if (repoBytes.equals(sourceBytes)) return null; // same content -> nothing to warn about
    return { path: repoPath, sourcePath, kind: st.isSymbolicLink() ? "symlink" : "file" };
  } catch {
    // absent, dangling symlink, unreadable, or no bundled source -> not a shadow we can report
    return null;
  }
}
