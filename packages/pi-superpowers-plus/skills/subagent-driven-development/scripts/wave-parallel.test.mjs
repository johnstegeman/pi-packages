// Structural regression test for scripts/wave-parallel.js. The script cannot be
// executed outside a live pi session (bare top-level return in a vm sandbox),
// so this guards its source shape: meta literal, args normalization, the
// pipeline(implement → review) shape, IMPLEMENT_RESULT/REVIEW schemas, the
// gate-conditional, the non-done short-circuit, the fail-closed shape guard
// (invalid-args), the quoted file-scoped review package build (HEAD resolved
// by the child), the envelope, the sandbox-forbidden globals — plus a live
// review-package scoping check against the spec commits in history.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

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
  // every interpolated path is single-quoted (reviewPackage, taskBeadId, base,
  // each file) so spaces cannot split the child's bash command
  assert.match(src, /\.map\(\(f\) => "'" \+ f \+ "'"\)\.join\(' '\)/);
  assert.match(src, /agentType: 'task-reviewer'/);
});

test("fail-closed shape guard: invalid-args before any dispatch, non-empty taskBeadId and files, no quotes in file paths", () => {
  assert.match(src, /status: 'invalid-args'/);
  assert.match(src, /reason: 'bad item shape: '/);
  assert.match(src, /item\.taskBeadId\.length === 0/);
  assert.match(src, /item\.files\.length === 0/);
  assert.match(src, /f\.includes\("'"\)/);
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

test("script parses as valid JS (vm: runtime wrapper compile)", () => {
  // Bare `node --check` is not a valid parse gate for this format: the
  // pi-subagents loader strips the `export ` keyword (extractMeta) and then
  // compiles the body inside its async wrapper via new vm.Script, where the
  // canonical top-level `return` envelope is legal — the platform's own
  // example workflow scripts fail `node --check` for the same reason. Mirror
  // the loader's compile here so a syntax error (like the unescaped quote
  // that broke final-review.js in a live run) fails this test instead.
  const metaAt = src.indexOf("export const meta");
  const body = src.slice(0, metaAt) + "      " + src.slice(metaAt + 6);
  assert.doesNotThrow(() => {
    new Script("(async () => {\n" + body + "\n})()", { filename: scriptPath });
  }, "script must compile under the runtime's async wrapper");
});


const reviewPackagePath = join(dirname(fileURLToPath(import.meta.url)), "review-package");

test("review-package scoping check: literal pathspecs keep the diff file-scoped; '--' with no paths fails loud", () => {
  // The two spec commits (ffc7028..2b263e2) are in history on this branch and
  // touch only the wave-parallel design doc, so a file-scoped diff must contain
  // exactly one '^diff --git' line. Pathspecs resolve against the cwd, so run
  // review-package from the repo root (5 levels up from this test file),
  // mirroring how the review child invokes it (bash from the repo root).
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
  const scopedOut = "/tmp/wpscoped.diff";
  const emptyOut = "/tmp/wpscoped.empty.diff";
  try {
    const scoped = spawnSync("bash", [reviewPackagePath, "slug", "ffc7028", "2b263e2", scopedOut, "--", "docs/superpowers/specs/2026-09-10-wave-parallel-implementation-design.md"], { encoding: "utf8", cwd: repoRoot });
    assert.equal(scoped.status, 0, "scoped review-package must exit 0: " + scoped.stdout + scoped.stderr);
    const scopedText = readFileSync(scopedOut, "utf8");
    assert.equal((scopedText.match(/^diff --git/gm) ?? []).length, 1, "scoped diff must contain exactly one '^diff --git' line (the design doc)");

    const empty = spawnSync("bash", [reviewPackagePath, "slug", "ffc7028", "2b263e2", emptyOut, "--"], { encoding: "utf8", cwd: repoRoot });
    assert.notEqual(empty.status, 0, "'--' with no paths must exit non-zero");
    assert.match(empty.stderr, /'--' given with no paths/);
  } finally {
    rmSync(scopedOut, { force: true });
    rmSync(emptyOut, { force: true });
  }
});
run();
