// Structural contract test for the Superpowers skill/prompt set
// (docs/superpowers/specs/2026-09-11-superpowers-skill-prompt-contradictions-design.md).
// Plain node, no dependencies.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const skillFiles = () => walk(join(root, "skills")).filter((f) => f.endsWith(".md"));

const ALLOWED_PHASES = new Set(["brainstorming", "development", ""]);

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
    console.error(`\nskills-contract: ${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nskills-contract: all assertions passed");
}

test("set_phase uses only the canonical vocabulary", () => {
  const re = /set_phase\(\{\s*phase:\s*"([^"]*)"\s*\}\)/g;
  const offenders = [];
  for (const f of skillFiles()) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(re)) {
      if (!ALLOWED_PHASES.has(m[1])) offenders.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the SDD prompt set emits one aligned phase", () => {
  const dir = join(root, "skills", "subagent-driven-development");
  const files = ["implementer-prompt.md", "re-review-prompt.md", "task-reviewer-prompt.md"];
  const phases = files.map((f) => {
    const src = readFileSync(join(dir, f), "utf8");
    const m = src.match(/set_phase\(\{\s*phase:\s*"([^"]*)"\s*\}\)/);
    assert.ok(m, `${f} must emit set_phase`);
    return m[1];
  });
  assert.deepEqual([...new Set(phases)], ["development"]);
});

run();
