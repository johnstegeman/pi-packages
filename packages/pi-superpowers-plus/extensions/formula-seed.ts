import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORMULA_FILENAME, seedFormula } from "./formula-seed.mjs";

// Auto-seeds the bundled superpowers-workflow formula into user-level ~/.beads/formulas/
// (bd formula search path #3) as a symlink into this installed package, so every beads project
// finds it with zero per-project setup. Runs before session_start; a failed seed is a silent
// no-op (never a startup error).
export default function formulaSeed() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const source = path.join(here, "..", "formulas", FORMULA_FILENAME);
  if (!existsSync(source)) return; // no bundled formula in this copy — nothing to seed

  const targetDir = path.join(os.homedir(), ".beads", "formulas");
  void seedFormula(source, targetDir).then(({ action }) => {
    if (action === "linked" || action === "relinked") {
      console.log(`[pi-superpowers-plus] seeded formula symlink: ${targetDir}/${FORMULA_FILENAME}`);
    }
  });
}
