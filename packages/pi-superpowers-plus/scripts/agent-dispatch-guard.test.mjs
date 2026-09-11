// Structural regression test for the fail-closed dispatch contract
// (docs/superpowers/specs/2026-09-11-fail-closed-agent-dispatch-design.md):
// every subagent_type / agentType literal shipped in skills/ must resolve to a
// template in agent-templates/ (or be a pi built-in), and the config-examples/
// files must carry fallbackSubagent: "none" + strictAgentFiles: true and stay
// byte-identical (they differ only by install location).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const BUILTIN_TYPES = new Set(["general-purpose", "Explore", "Plan"]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function dispatchNames() {
  const names = new Set();
  for (const file of walk(join(root, "skills"))) {
    if (!/\.(md|js)$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/subagent_type:\s*"([a-z0-9_-]+)"/g)) names.add(m[1]);
    for (const m of src.matchAll(/agentType:\s*'([a-z0-9_-]+)'/g)) names.add(m[1]);
  }
  return names;
}

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}
async function run() {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failures++;
      console.error(`FAIL - ${name}\n${e.stack ?? e}`);
    }
  }
  if (failures) {
    console.error(`\nagent-dispatch-guard: ${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nagent-dispatch-guard: all assertions passed");
}

test("every skill dispatch name resolves to a shipped template or built-in", () => {
  const names = dispatchNames();
  const unbacked = [...names].filter((n) => !BUILTIN_TYPES.has(n));
  assert.ok(unbacked.length > 0, "expected at least one dispatch name to check");
  for (const name of unbacked) {
    const tpl = join(root, "agent-templates", `${name}.md`);
    assert.ok(statSync(tpl).isFile(), `no agent-templates/${name}.md for dispatch name "${name}"`);
  }
});

test("the SDD and dispatch agent names are covered by templates", () => {
  for (const name of ["implementer", "task-reviewer", "code-reviewer", "worker"]) {
    assert.ok(statSync(join(root, "agent-templates", `${name}.md`)).isFile(), `missing ${name}.md`);
  }
});

test("config-examples parse, carry the fail-closed settings, and are byte-identical", () => {
  const files = ["subagents.global.json", "subagents.project.json"].map((f) =>
    readFileSync(join(root, "config-examples", f), "utf8"),
  );
  assert.equal(files[0], files[1], "global and project examples must stay byte-identical");
  for (const src of files) {
    assert.deepEqual(JSON.parse(src), { fallbackSubagent: "none", strictAgentFiles: true });
  }
});

run();
