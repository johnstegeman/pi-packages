// Structure contract for the shipped workflow formula
// (docs/superpowers/specs/2026-10-09-wrap-up-instead-of-filing-deferred-minors-design.md).
// The formula is read through the shared `parseFormulaSteps` (extensions/formula-parse.mjs), the
// one parser for the small TOML subset the formula uses — shared with the widget and the
// widget/formula coupling test so a syntax change cannot break one reader silently.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isWrapUpStep } from "../extensions/beads-molecule-widget.mjs";
import { parseFormulaSteps } from "../extensions/formula-parse.mjs";

const src = readFileSync(new URL("../formulas/superpowers-workflow.formula.toml", import.meta.url), "utf8");
const steps = parseFormulaSteps(src);
const byId = new Map(steps.map((s) => [s.id, s]));
const needsOf = (id) => byId.get(id)?.needs ?? [];

assert.ok(byId.has("wrap-up"), "the formula declares a wrap-up step");
assert.deepEqual(needsOf("wrap-up"), ["implement"], "wrap-up runs after implement");
assert.deepEqual(needsOf("verify"), ["wrap-up"], "verify runs after wrap-up");
assert.deepEqual(needsOf("implement"), ["spec-approved"], "implement still runs after spec approval");
assert.deepEqual(needsOf("finish"), ["smoke-test-approved"], "finish still runs after the smoke gate");
assert.deepEqual(
  steps.map((s) => s.id),
  steps.map((s) => s.id).filter((id, i, all) => all.indexOf(id) === i),
  "step ids are unique",
);

// The widget matches the wrap-up step by title, so the shipped title is the coupling. Rewording
// it must fail here rather than silently revert the widget to reporting "finishing" early.
assert.ok(
  isWrapUpStep(byId.get("wrap-up").title),
  `isWrapUpStep recognises the shipped wrap-up title: ${JSON.stringify(byId.get("wrap-up").title)}`,
);

console.log("workflow-formula: all assertions passed");
