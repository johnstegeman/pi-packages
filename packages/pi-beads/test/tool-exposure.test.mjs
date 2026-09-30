// Guards the code-mode exposure of the beads tool surface.
// Design: docs/superpowers/specs/2026-09-30-codemode-adoption-design.md
import assert from "node:assert/strict";

const mod = await import("../src/index.ts");
const {
  default: piBeadsLean,
  BEADS_NAMESPACE,
  BEADS_CODEMODE_TOOLS,
  BEADS_DEFERRED_TOOLS,
  BEADS_TOOL_EXPOSURE,
} = mod;

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
  for (const t of tools) assert.deepEqual(t.namespace, BEADS_NAMESPACE, t.name);
});

test("the codemode set is exactly the 12 hot-path tools", () => {
  const got = tools.filter((t) => t.exposure === "codemode").map((t) => t.name).sort();
  assert.deepEqual(got, [...BEADS_CODEMODE_TOOLS].sort());
});

test("the deferred set is exactly the 11 long-tail tools", () => {
  const got = tools.filter((t) => t.exposure === "deferred").map((t) => t.name).sort();
  assert.deepEqual(got, [...BEADS_DEFERRED_TOOLS].sort());
});

test("BEADS_TOOL_EXPOSURE covers exactly the registered tools", () => {
  assert.deepEqual(Object.keys(BEADS_TOOL_EXPOSURE).sort(), [...byName.keys()].sort());
});

if (failures) { console.error(`\ntool-exposure: ${failures} test(s) failed`); process.exit(1); }
console.log("\ntool-exposure: all assertions passed");
