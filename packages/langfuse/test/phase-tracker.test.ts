import assert from "node:assert/strict";
import test from "node:test";

import { applyPhaseUpdate, buildPhaseMetadata, buildPhaseTags, setPhase } from "../src/phase.js";

test("non-empty string is retained", () => {
  assert.equal(applyPhaseUpdate(null, "brainstorming"), "brainstorming");
});

test("non-empty string with surrounding whitespace is retained verbatim", () => {
  assert.equal(applyPhaseUpdate(null, "  development  "), "  development  ");
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
  setPhase(null);
  setPhase("development");
  assert.deepEqual(buildPhaseMetadata(), { superpowers_phase: "development" });
  setPhase(null);
});

test("buildPhaseMetadata returns {} when cleared", () => {
  setPhase(null);
  assert.deepEqual(buildPhaseMetadata(), {});
  setPhase(null);
});

test("buildPhaseTags namespaces the retained phase", () => {
  setPhase(null);
  setPhase("development");
  assert.deepEqual(buildPhaseTags(), ["phase:development"]);
  setPhase(null);
});

test("buildPhaseTags is empty when the phase is cleared", () => {
  setPhase("development");
  assert.equal(setPhase("  "), null);
  assert.deepEqual(buildPhaseTags(), []);
  setPhase(null);
});

test("setPhase returns the replacement phase", () => {
  assert.equal(setPhase("brainstorming"), "brainstorming");
  assert.equal(setPhase("development"), "development");
  assert.equal(setPhase(null), null);
});
