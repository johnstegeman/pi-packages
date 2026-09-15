// Structural regression test for the named-agents + @handle recovery contract
// (docs/superpowers/specs/2026-09-11-named-agents-handle-recovery-design.md).
// Guards the documented convention in SKILL.md + implementer-prompt.md: the
// canonical handle scheme, the byte-equal `name:` line across the two files,
// and the load-bearing recovery boundaries. The handle/recovery detail now
// lives in reference/dispatch-implementer.md and reference/recovery.md, which
// SKILL.md read-gates, so the guard follows the moved text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, "..");
const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const dispatch = readFileSync(join(skillDir, "reference", "dispatch-implementer.md"), "utf8");
const recovery = readFileSync(join(skillDir, "reference", "recovery.md"), "utf8");
const docs = `${skill}\n${dispatch}\n${recovery}`;
const prompt = readFileSync(join(skillDir, "implementer-prompt.md"), "utf8");

const NAME_LINE = 'name: "task-<sanitized-task-id>-impl"';

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
async function run() {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { failures++; console.error(`FAIL - ${name}\n${e.stack ?? e}`); }
  }
  if (failures) { console.error(`\nnamed-agents: ${failures} test(s) failed`); process.exit(1); }
  console.log("\nnamed-agents: all assertions passed");
}

test("transform rule documented in the handle reference", () => {
  assert.match(docs, /with every "\." replaced by "-"/);
  assert.match(docs, /task-pi-packages-l8x9-2-impl/);
});

test("name line present exactly once, byte-equal across both files", () => {
  const fromSkill = dispatch.match(/name: "task-[^"]+"/g) ?? [];
  const fromPrompt = prompt.match(/name: "task-[^"]+"/g) ?? [];
  assert.equal(fromSkill.length, 1, `dispatch-implementer.md name-line count ${fromSkill.length}`);
  assert.equal(fromPrompt.length, 1, `implementer-prompt.md name-line count ${fromPrompt.length}`);
  assert.equal(fromSkill[0], NAME_LINE, "dispatch-implementer.md name line matches the contract");
  assert.equal(fromPrompt[0], NAME_LINE, "implementer-prompt.md name line matches the contract");
  assert.equal(fromSkill[0], fromPrompt[0], "name line byte-identical across both files");
});

test("recovery section: session-scoped boundary", () => {
  assert.match(docs, /forgotten on `\/new`/);
});

test("recovery section: run_in_background on resume nuance", () => {
  assert.match(docs, /run_in_background/);
  assert.match(docs, /background slot/);
});

test("recovery section: absent-extension caveat", () => {
  assert.match(docs, /ledger remains the sole recovery path/);
});

run();
