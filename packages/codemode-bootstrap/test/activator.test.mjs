import assert from "node:assert/strict";
const { default: codemodeBootstrap } = await import("../index.ts");

function harness({ registered = ["read", "bash"], active = ["read", "bash"], throwOn = null } = {}) {
  const calls = [];
  const handlers = {};
  let current = [...active];
  const pi = {
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
    getAllTools: () => { if (throwOn === "getAllTools") throw new Error("nope"); return registered.map((name) => ({ name })); },
    getActiveTools: () => { if (throwOn === "getActiveTools") throw new Error("nope"); return [...current]; },
    setActiveTools: (names) => { if (throwOn === "setActiveTools") throw new Error("nope"); current = [...names]; calls.push([...names]); },
  };
  codemodeBootstrap(pi);
  return { handlers, calls, start: () => handlers.session_start[0]({}, {}) };
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.error(`FAIL - ${name}\n${e.stack ?? e}`); }
}

test("registers a session_start handler", () => {
  const h = harness();
  assert.equal(typeof h.handlers.session_start?.[0], "function");
});

test("activates codemode when registered but inactive", () => {
  const h = harness({ registered: ["read", "bash", "codemode"], active: ["read", "bash"] });
  h.start();
  assert.deepEqual(h.calls, [["read", "bash", "codemode"]]);
});

test("does not activate when codemode is already active", () => {
  const h = harness({ registered: ["read", "codemode"], active: ["read", "codemode"] });
  h.start();
  assert.deepEqual(h.calls, []);
});

test("does not activate when the host did not register codemode", () => {
  const h = harness({ registered: ["read", "bash"], active: ["read"] });
  h.start();
  assert.deepEqual(h.calls, []);
});

test("never removes or reorders the active tools", () => {
  const h = harness({ registered: ["read", "bash", "codemode", "edit"], active: ["bash", "read"] });
  h.start();
  assert.deepEqual(h.calls, [["bash", "read", "codemode"]]);
});

test("is idempotent across repeated session_start", () => {
  const h = harness({ registered: ["read", "codemode"], active: ["read"] });
  h.start();
  h.start();
  assert.equal(h.calls.length, 1);
});

test("no-ops when the tool APIs throw", () => {
  for (const which of ["getAllTools", "getActiveTools", "setActiveTools"]) {
    const h = harness({ registered: ["read", "codemode"], active: ["read"], throwOn: which });
    h.start();
  }
});

test("no-ops when the tool APIs are missing", () => {
  const handlers = {};
  codemodeBootstrap({ on: (ev, fn) => { handlers[ev] = fn; } });
  handlers.session_start({}, {});
});

if (failures) { console.error(`\nactivator: ${failures} test(s) failed`); process.exit(1); }
console.log("\nactivator: all assertions passed");
