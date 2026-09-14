// Structural guard: the beads tool surface is documented everywhere it is
// enumerated (pi-packages-3iej.7 M23/M24). Drift between the toolMap and the
// docs is a red test, not a future bug report.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..");

const src = readFileSync(join(pkgRoot, "src", "index.ts"), "utf8");
const tools = [...src.matchAll(/^\s*\w+:\s*"(beads_[a-z_]+)"/gm)].map((m) => m[1]);

const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
const piTools = readFileSync(
  join(repoRoot, "packages", "pi-superpowers-plus", "skills", "using-superpowers", "references", "pi-tools.md"),
  "utf8",
);
const skill = readFileSync(join(pkgRoot, "skills", "beads", "SKILL.md"), "utf8");

const WORKFLOW_CRITICAL = [
  "beads_create_list",
  "beads_reopen",
  "beads_gate_create",
  "beads_gate_resolve",
  "beads_mol_pour",
  "beads_mol_show",
  "beads_mol_current",
  "beads_mol_ready",
  "beads_promote",
];

const missing = (haystack, names) => names.filter((n) => !new RegExp(`\\b${n}\\b`).test(haystack));

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}\n${e.stack ?? e}`);
  }
}

test("toolMap exposes the expected 23 tools", () => {
  assert.equal(tools.length, 23, `src/index.ts toolMap has ${tools.length} tools`);
});
test("pi-beads README enumerates every tool", () => {
  assert.deepEqual(missing(readme, tools), [], "tools missing from README");
});
test("pi-tools.md enumerates every tool and SubagentWorkflow", () => {
  assert.deepEqual(missing(piTools, tools), [], "tools missing from pi-tools.md");
  assert.ok(piTools.includes("SubagentWorkflow"), "pi-tools.md must list SubagentWorkflow");
});
test("beads SKILL.md surfaces the workflow-critical tools", () => {
  assert.deepEqual(missing(skill, WORKFLOW_CRITICAL), [], "workflow-critical tools missing from SKILL.md");
});

if (failures) {
  console.error(`\ntool-surface: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("\ntool-surface: all assertions passed");
