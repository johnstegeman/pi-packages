import assert from "node:assert/strict";
import test from "node:test";

import { applyPhaseUpdate, buildPhaseMetadata, setPhase } from "../src/phase.js";

test("non-empty string is retained", () => {
  assert.equal(applyPhaseUpdate(null, "brainstorming"), "brainstorming");
});

test("empty string clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", ""), null);
});

test("null clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", null), null);
});

test("undefined clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", undefined), null);
});

test("whitespace-only string clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", "  "), null);
});

test("retained value is replaced by a new non-empty phase", () => {
  assert.equal(applyPhaseUpdate("old", "new"), "new");
});

test("buildPhaseMetadata returns the phase fragment when retained", () => {
  setPhase("development");
  assert.deepEqual(buildPhaseMetadata(), { superpowers_phase: "development" });
});

test("buildPhaseMetadata returns {} when cleared", () => {
  setPhase(null);
  assert.deepEqual(buildPhaseMetadata(), {});
});
