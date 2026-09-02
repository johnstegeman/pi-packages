// formula-seed.mjs — pure, dependency-free seeding of a workflow formula into a target dir.
// Never throws; every failure maps to a "skipped-*" action.
import { mkdir, symlink, readlink, lstat, realpath } from "node:fs/promises";
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
    const currentTarget = (await realpath(target).catch(() => null)); // resolves only if not dangling
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
