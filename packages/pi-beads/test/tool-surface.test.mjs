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

// --- tool surfaces vs the schemas -------------------------------------------
const piBeadsLean = (await import("../src/index.ts")).default;
const registeredTools = [];
piBeadsLean({
  events: { emit: () => {} },
  on: () => {},
  registerTool: (t) => registeredTools.push(t),
  registerCommand: () => {},
});
const propsOf = (name) =>
  Object.keys(registeredTools.find((t) => t.name === name)?.parameters?.properties ?? {});

// Fields that exist only on beads_create. There is no update counterpart, so passing one
// to beads_update is dropped on a direct call (pi strips undeclared arguments) and
// rejected by the tool's own guard from a script - which is why the asymmetry is
// declared here rather than discovered later.
const CREATE_ONLY = ["repo", "design", "ephemeral"];

// Create fields whose update counterpart is a different name rather than absent. `labels`
// is one comma-separated string on create; update splits it into `addLabels`/
// `removeLabels`. Naming it here keeps CREATE_ONLY honest (labels IS updatable) while still
// forcing the asymmetry to be declared instead of discovered.
const RENAMED_ON_UPDATE = { labels: ["addLabels", "removeLabels"] };

test("beads_update covers every beads_create field or declares it create-only", () => {
  const create = propsOf("beads_create");
  const update = propsOf("beads_update");
  const covered = (k) =>
    update.includes(k) ||
    CREATE_ONLY.includes(k) ||
    (RENAMED_ON_UPDATE[k]?.every((u) => update.includes(u)) ?? false);
  assert.deepEqual(
    create.filter((k) => !covered(k)),
    [],
    "beads_create fields with no beads_update counterpart and no CREATE_ONLY entry",
  );
});

test("CREATE_ONLY is not a hiding place: those fields really are create-only", () => {
  const update = propsOf("beads_update");
  assert.deepEqual(CREATE_ONLY.filter((k) => update.includes(k)), [], "a CREATE_ONLY field is also on beads_update");
});

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
test("beads_ready docs state the template exclusion", () => {
  const readyRow = (doc) => doc.split("\n").find((l) => /^\|\s*`beads_ready/.test(l)) ?? "";
  for (const [name, doc] of [["README.md", readme], ["skills/beads/SKILL.md", skill]]) {
    const row = readyRow(doc);
    assert.match(row, /template protos are excluded/i, `${name} beads_ready row must state the template exclusion`);
  }
});

if (failures) {
  console.error(`\ntool-surface: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("\ntool-surface: all assertions passed");
