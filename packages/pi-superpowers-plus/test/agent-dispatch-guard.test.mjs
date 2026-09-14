// Structural regression test for the fail-closed dispatch contract
// (docs/superpowers/specs/2026-09-11-fail-closed-agent-dispatch-design.md):
// every subagent_type / agentType literal shipped in skills/ must resolve to a
// template in agent-templates/ (or be a pi built-in), and the config-examples/
// files must carry the fail-closed settings (fallbackSubagent: "none", strictAgentFiles: true) plus the
// recommended toolDescriptionMode: "compact" and stay byte-identical (they differ only by install location).
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
  for (const name of ["implementer", "task-reviewer", "code-reviewer", "worker", "verifier"]) {
    assert.ok(statSync(join(root, "agent-templates", `${name}.md`)).isFile(), `missing ${name}.md`);
  }
});

test("config-examples parse, carry the fail-closed settings, and are byte-identical", () => {
  const files = ["subagents.global.json", "subagents.project.json"].map((f) =>
    readFileSync(join(root, "config-examples", f), "utf8"),
  );
  assert.equal(files[0], files[1], "global and project examples must stay byte-identical");
  for (const src of files) {
    assert.deepEqual(JSON.parse(src), {
      fallbackSubagent: "none",
      strictAgentFiles: true,
      toolDescriptionMode: "compact",
      scopeModels: true,
    });
  }
});
test("task-reviewer and code-reviewer opt into narrow nested delegation; implementer/worker do not", () => {
  const fm = (name) => readFileSync(join(root, "agent-templates", name), "utf8").split("---")[1] ?? "";
  for (const name of ["task-reviewer.md", "code-reviewer.md"]) {
    const m = fm(name).match(/^allowed_subagents:(.*)$/m);
    assert.ok(m, `${name} must declare allowed_subagents`);
    assert.equal(m[1].trim(), "Explore", "the allowlist must be exactly Explore");
  }
  for (const name of ["implementer.md", "worker.md"]) {
    assert.ok(!/allowed_subagents:/.test(fm(name)), `${name} must not declare allowed_subagents`);
  }
});

test("the SDD task-reviewer prompt references the nested-lookup path", () => {
  const src = readFileSync(join(root, "skills", "subagent-driven-development", "task-reviewer-prompt.md"), "utf8");
  assert.match(src, /nested `Explore` child/i, "task-reviewer-prompt.md must document the nested Explore lookup");
  assert.match(
    src,
    /nested `Agent` tool is available, report the item as `⚠️`/,
    "task-reviewer-prompt.md must keep the graceful-degradation fallback",
  );
});

test("the SDD re-review prompt documents the nested-lookup path", () => {
  const src = readFileSync(join(root, "skills", "subagent-driven-development", "re-review-prompt.md"), "utf8");
  assert.match(src, /nested `Explore` child/i, "re-review-prompt.md must document the nested Explore lookup");
  assert.match(
    src,
    /no nested `Agent` tool is available/i,
    "re-review-prompt.md must keep the graceful-degradation fallback",
  );
});

test("reviewer templates pin thinking: medium + a finite max_turns", () => {
  const fm = (name) => readFileSync(join(root, "agent-templates", name), "utf8").split("---")[1] ?? "";
  for (const name of ["task-reviewer.md", "code-reviewer.md", "verifier.md"]) {
    assert.match(fm(name), /^thinking: medium$/m, `${name} must pin thinking: medium`);
    const m = fm(name).match(/^max_turns: (\d+)$/m);
    assert.ok(m, `${name} must pin a numeric max_turns`);
    assert.ok(Number(m[1]) > 0, `${name} max_turns must be positive`);
  }
});

test("final-review refuters dispatch the read-only verifier type", () => {
  const src = readFileSync(join(root, "skills", "subagent-driven-development", "scripts", "final-review.js"), "utf8");
  assert.match(src, /agentType: 'verifier'/);
  assert.ok(
    !src.includes("agentType: 'general-purpose', label: 'verify:'"),
    "the refuter must not be the write-capable general-purpose agent",
  );
});

test("nested-lookup claim is conditional on direct dispatch in all four files", () => {
  const files = [
    join(root, "agent-templates", "task-reviewer.md"),
    join(root, "agent-templates", "code-reviewer.md"),
    join(root, "skills", "subagent-driven-development", "task-reviewer-prompt.md"),
    join(root, "skills", "subagent-driven-development", "re-review-prompt.md"),
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /nested `Explore` child/i, `${f} must keep the Explore capability`);
    assert.match(
      src,
      /Under `SubagentWorkflow` the nested `Agent` tool is not available/,
      `${f} must state the SubagentWorkflow caveat`,
    );
  }
});

run();
