import assert from "node:assert/strict";
import { createPhaseLifecycle, PHASE_CLEAR } from "../extensions/set-phase.mjs";

const handlers = new Map();
const emitted = [];
const on = (event, handler) => {
  handlers.set(event, handler);
};
const emit = (channel, data) => {
  emitted.push([channel, data]);
};

createPhaseLifecycle({ emit, on });

assert.ok(handlers.has("session_start"), "registers a session_start handler");
assert.ok(handlers.has("session_shutdown"), "registers a session_shutdown handler");

handlers.get("session_start")();
assert.deepEqual(emitted.at(-1), ["superpowers:phase", { phase: PHASE_CLEAR }], "clears on session_start");

handlers.get("session_shutdown")();
assert.deepEqual(emitted.at(-1), ["superpowers:phase", { phase: PHASE_CLEAR }], "clears on session_shutdown");
assert.equal(emitted.length, 2, "exactly one clear per boundary event");
assert.equal(PHASE_CLEAR, "", "the clear value is the empty string");

console.log("set-phase: all assertions passed");
