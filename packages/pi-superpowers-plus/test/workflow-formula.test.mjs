// Structure contract for the shipped workflow formula
// (docs/superpowers/specs/2026-10-09-wrap-up-instead-of-filing-deferred-minors-design.md).
// Plain node, no dependencies: the formula is parsed line-by-line because the package ships no
// TOML parser, and this test only reads step ids, titles, and their `needs` edges.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isWrapUpStep } from "../extensions/beads-molecule-widget.mjs";

const src = readFileSync(new URL("../formulas/superpowers-workflow.formula.toml", import.meta.url), "utf8");

/** Parse `[[steps]]` blocks into `{ id, title, needs }`. `[steps.gate]` blocks are not steps. */
function parseSteps(text) {
  const steps = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "[[steps]]") {
      cur = { id: null, title: "", needs: [] };
      steps.push(cur);
      continue;
    }
    if (line.startsWith("[steps.gate]")) {
      cur = null;
      continue;
    }
    if (!cur) continue;
    const id = line.match(/^id\s*=\s*"([^"]+)"/);
    if (id) cur.id = id[1];
    const title = line.match(/^title\s*=\s*"([^"]*)"/);
    if (title) cur.title = title[1];
    const needs = line.match(/^needs\s*=\s*\[(.*)\]/);
    if (needs) cur.needs = [...needs[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }
  return steps.filter((s) => s.id);
}

const steps = parseSteps(src);
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
