// Structural regression test for scripts/wave-parallel.js. The script cannot be
// executed outside a live pi session (bare top-level return in a vm sandbox),
// so this guards its source shape: meta literal, args normalization, the
// pipeline(implement → review) shape, IMPLEMENT_RESULT/REVIEW schemas, the
// gate-conditional, the non-done short-circuit, the file-scoped review package
// build (HEAD resolved by the child), the envelope, and the sandbox-forbidden
// globals.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "wave-parallel.js");
const src = readFileSync(scriptPath, "utf8");

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
async function run() {
  for (const [name, fn] of tests) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { failures++; console.error(`FAIL - ${name}\n${e.stack ?? e}`); }
  }
  if (failures) { console.error(`\nwave-parallel: ${failures} test(s) failed`); process.exit(1); }
  console.log("\nwave-parallel: all assertions passed");
}

test("meta: pure literal with name/description/phases", () => {
  assert.match(src, /export const meta = \{\n\s*name: 'sdd-wave-parallel'/);
  assert.match(src, /description: 'Wave-parallel implementation/);
  assert.match(src, /phases: \[\{ title: 'Implement' \}, \{ title: 'Review' \}\]/);
});

test("args normalization + empty-wave degradation", () => {
  assert.match(src, /typeof args === 'string'/);
  assert.match(src, /const WAVE = Array\.isArray\(ARGS\.wave\) \? ARGS\.wave : \[\]/);
});

test("IMPLEMENT_RESULT_SCHEMA: status enum + required reportFile", () => {
  assert.match(src, /const IMPLEMENT_RESULT_SCHEMA = \{/);
  assert.match(src, /status: \{ enum: \['done', 'done_with_concerns', 'needs_context', 'blocked'\] \}/);
  assert.match(src, /required: \['status', 'reportFile'\]/);
});

test("REVIEW_SCHEMA: specCompliant + severity enum + issues required", () => {
  assert.match(src, /const REVIEW_SCHEMA = \{/);
  assert.match(src, /specCompliant: \{ type: 'boolean' \}/);
  assert.match(src, /severity: \{ enum: \['critical', 'important', 'minor'\] \}/);
  assert.match(src, /required: \['severity', 'file', 'description'\]/);
});

test("gate is conditional on item.gate (spread) + gate-failed mapping", () => {
  assert.match(src, /\.\.\.\(item\.gate \? \{ gate: item\.gate \} : \{\}\)/);
  assert.match(src, /'gate-failed'/);
});

test("implement stage: labelled per task, implementer agentType, no declared gate branch", () => {
  assert.match(src, /label: 'implement:' \+ item\.taskBeadId/);
  assert.match(src, /agentType: 'implementer'/);
  assert.match(src, /There is no declared gate;/);
});

test("short-circuit: review stage skips non-done statuses", () => {
  assert.match(src, /prev\.status !== 'done' && prev\.status !== 'done_with_concerns'/);
  assert.match(src, /skipped: true, reason: prev\.status/);
});

test("review stage: file-scoped package, HEAD resolved by the child", () => {
  assert.match(src, /git rev-parse HEAD/);
  assert.match(src, /item\.files \?\? \[\]\)\.join\(' '\)/);
  assert.match(src, /agentType: 'task-reviewer'/);
});

test("envelope: per-task entries keyed by taskBeadId, degraded when any non-done", () => {
  assert.match(src, /const wave = results\.map\(\(r, i\) =>/);
  assert.match(src, /taskBeadId: WAVE\[i\]\?\.taskBeadId \?\? 'unknown'/);
  assert.match(src, /const degraded = wave\.some\(/);
  assert.match(src, /return \{ wave, degraded \}/);
});

test("implementer discipline: shared-branch commit rules present", () => {
  assert.match(src, /index\.lock/);
  assert.match(src, /Never merge, rebase, or push\./);
  assert.match(src, /git add <your files>/);
});

test("no sandbox-forbidden globals", () => {
  for (const forbidden of ["Date.now(", "Math.random(", "eval(", "new Date"]) {
    assert.ok(!src.includes(forbidden), `forbidden global present: ${forbidden}`);
  }
});

run();
