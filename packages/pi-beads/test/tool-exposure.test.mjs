// Guards the code-mode exposure of the beads tool surface.
// Design: docs/superpowers/specs/2026-09-30-codemode-adoption-design.md
//
// The expected exposure policy below is written out as literals on purpose: the
// arrays in src/index.ts are what the registrations read, so deriving the
// expectation from them would let a tool silently move between the two sets.
// The policy (12 inline codemode entries / 11 deferred) is a hard budget, so the
// test pins it independently.
import assert from "node:assert/strict";

const mod = await import("../src/index.ts");
const { default: piBeadsLean, BEADS_TOOL_EXPOSURE } = mod;

const EXPECTED_NAMESPACE = {
  name: "beads",
  description: "Beads issue tracker — umbrella aggregate across all repos",
};

const EXPECTED_CODEMODE = [
  "beads_ready",
  "beads_list",
  "beads_show",
  "beads_deps",
  "beads_create",
  "beads_create_list",
  "beads_update",
  "beads_close",
  "beads_comment",
  "beads_comments",
  "beads_dep",
  "beads_undep",
];

const EXPECTED_DEFERRED = [
  "beads_reopen",
  "beads_promote",
  "beads_gate_create",
  "beads_gate_resolve",
  "beads_mol_pour",
  "beads_mol_show",
  "beads_mol_current",
  "beads_mol_ready",
  "beads_memories",
  "beads_stale",
  "beads_lint",
];

const tools = [];
piBeadsLean({
  events: { emit: () => {} },
  on: () => {},
  registerTool: (t) => tools.push(t),
  registerCommand: () => {},
});
const byName = new Map(tools.map((t) => [t.name, t]));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.error(`FAIL - ${name}\n${e.stack ?? e}`); }
}

test("registers 23 tools", () => {
  assert.equal(tools.length, 23, `registered ${tools.length}`);
});

test("no beads tool is left with direct exposure", () => {
  const direct = tools.filter((t) => t.exposure !== "codemode" && t.exposure !== "deferred");
  assert.deepEqual(direct.map((t) => t.name), []);
});

test("every beads tool carries the beads namespace", () => {
  for (const t of tools) assert.deepEqual(t.namespace, EXPECTED_NAMESPACE, t.name);
});

test("the codemode set is exactly the 12 hot-path tools", () => {
  const got = tools.filter((t) => t.exposure === "codemode").map((t) => t.name).sort();
  assert.deepEqual(got, [...EXPECTED_CODEMODE].sort());
});

test("the deferred set is exactly the 11 long-tail tools", () => {
  const got = tools.filter((t) => t.exposure === "deferred").map((t) => t.name).sort();
  assert.deepEqual(got, [...EXPECTED_DEFERRED].sort());
});

test("BEADS_TOOL_EXPOSURE covers exactly the registered tools", () => {
  assert.deepEqual(Object.keys(BEADS_TOOL_EXPOSURE).sort(), [...byName.keys()].sort());
});

if (failures) { console.error(`\ntool-exposure: ${failures} test(s) failed`); process.exit(1); }
console.log("\ntool-exposure: all assertions passed");
