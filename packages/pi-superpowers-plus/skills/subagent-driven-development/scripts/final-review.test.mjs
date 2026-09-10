// Structural regression test for scripts/final-review.js. The script cannot be
// executed outside a live pi session (bare top-level return in a vm sandbox),
// so this guards its source shape: meta literal, schemas, stages, envelope,
// and the sandbox-forbidden globals.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "final-review.js");
const src = readFileSync(scriptPath, "utf8");

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
async function run() {
  for (const [name, fn] of tests) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { failures++; console.error(`FAIL - ${name}\n${e.stack ?? e}`); }
  }
  if (failures) { console.error(`\nfinal-review: ${failures} test(s) failed`); process.exit(1); }
  console.log("\nfinal-review: all assertions passed");
}

test("meta: pure literal with name/description/phases", () => {
  assert.match(src, /export const meta = \{\n\s*name: 'sdd-final-review'/);
  assert.match(src, /description: 'Parallel dimension review/);
  assert.match(src, /phases: \[\{ title: 'Find' \}, \{ title: 'Verify' \}\]/);
});

test("FINDINGS_SCHEMA: file/severity/description required", () => {
  assert.match(src, /const FINDINGS_SCHEMA = \{/);
  assert.match(src, /file: \{ type: 'string' \}/);
  assert.match(src, /severity: \{ enum: \['critical', 'important', 'minor'\] \}/);
  assert.match(src, /required: \['file', 'severity', 'description'\]/);
});

test("VERDICT_SCHEMA: isReal/reason required", () => {
  assert.match(src, /const VERDICT_SCHEMA = \{/);
  assert.match(src, /isReal: \{ type: 'boolean' \}/);
  assert.match(src, /reason: \{ type: 'string' \}/);
  assert.match(src, /required: \['isReal', 'reason'\]/);
});

test("stages: two parallel( calls + filter(Boolean) + dedupe", () => {
  assert.equal((src.match(/await parallel\(/g) ?? []).length, 2);
  assert.match(src, /\.filter\(Boolean\)/);
  assert.match(src, /function dedupe\(/);
});

test("defensive args normalization present", () => {
  assert.match(src, /typeof args === 'string'/);
});

test("return envelope keys", () => {
  assert.match(src, /base: ARGS\.base, head: ARGS\.head, dimensions: DIMENSIONS, findings,/);
});

test("no sandbox-forbidden globals", () => {
  for (const forbidden of ["Date.now(", "Math.random(", "eval(", "new Date"]) {
    assert.ok(!src.includes(forbidden), `forbidden global present: ${forbidden}`);
  }
});

run();
