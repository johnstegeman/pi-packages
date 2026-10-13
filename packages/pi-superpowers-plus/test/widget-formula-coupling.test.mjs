// Cross-file contract for the molecule widget (docs/superpowers/specs/2026-09-03-step-labels-at-pour-design.md).
//
// The widget resolves its phase-view rows by the `step:<key>` labels `bd mol pour` stamps, so the
// keys it maps must exist in the shipped formula. Pinned here against
// formulas/superpowers-workflow.formula.toml so a step rename or removal fails loudly instead of
// silently emptying the widget's phase view — which is exactly what the 2026-10-13 brainstorming
// re-base did to it (explore/clarify/approaches/design -> conversation/playback) before this file
// existed. Plain node, no dependencies: the formula is read through the shared `parseFormulaSteps`
// (extensions/formula-parse.mjs), the one parser for the small TOML subset the formula uses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BRAINSTORM_VIEW,
  FINISH_VIEW,
  GATE_TO_REVIEW_STEP,
  isWrapUpStep,
  moleculeWidgetLines,
  phaseFor,
  topicFor,
  topicPrefix,
  waitingReviewStep,
} from "../extensions/beads-molecule-widget.mjs";
import { parseFormulaSteps } from "../extensions/formula-parse.mjs";

const FORMULA_SRC = readFileSync(new URL("../formulas/superpowers-workflow.formula.toml", import.meta.url), "utf8");

const FORMULA = parseFormulaSteps(FORMULA_SRC);
const KEYS = FORMULA.map((s) => s.id);
const byKey = new Map(FORMULA.map((s) => [s.id, s]));
const TOPIC = "Superpowers widget changes";
const titleOf = (key) => byKey.get(key).title.replace("{{topic}}", TOPIC);

// ---------- every key the widget maps is declared by the shipped formula ----------
const mapped = [...BRAINSTORM_VIEW, ...FINISH_VIEW, ...Object.values(GATE_TO_REVIEW_STEP)];
const missing = mapped.filter((key) => !byKey.has(key));
assert.deepEqual(missing, [], `the widget maps step keys the shipped formula does not declare: ${missing}`);

// The views are the formula's own order, not a second list that can drift out of it.
assert.deepEqual(
  BRAINSTORM_VIEW,
  KEYS.slice(0, KEYS.indexOf("implement")),
  "brainstorm view = every formula step before implement",
);
assert.deepEqual(
  FINISH_VIEW,
  KEYS.slice(KEYS.indexOf("wrap-up") + 1),
  "finish view = every formula step after wrap-up",
);

// The gate labels the widget keys off are exactly the formula's gated steps, and each label maps
// to that gated step's own id. Both directions, so a newly gated formula step with no widget
// mapping fails here, and so does a swapped value.
const gatedSteps = FORMULA.filter((s) => s.gated);
assert.deepEqual(
  Object.keys(GATE_TO_REVIEW_STEP).sort(),
  gatedSteps.map((s) => `step:gate-${s.id}`).sort(),
  "the widget maps exactly the formula's gated steps, no more and no fewer",
);
for (const s of gatedSteps) {
  assert.equal(
    GATE_TO_REVIEW_STEP[`step:gate-${s.id}`],
    s.id,
    `gate label step:gate-${s.id} maps to its own review step`,
  );
}

// ---------- a real poured-molecule shape resolves end to end ----------
const step = (key, over = {}) => ({
  id: `mol-w.${key}`,
  title: titleOf(key),
  labels: [`step:${key}`],
  status: "open",
  issue_type: "task",
  created_at: "",
  step_status: "pending",
  is_current: false,
  ...over,
});
const gate = (label) => ({
  id: `mol-w.${label}`,
  title: "Gate: human",
  labels: [label],
  status: "open",
  issue_type: "gate",
  created_at: "",
  step_status: "ready",
  is_current: false,
});

const poured = {
  molecule_id: "mol-w",
  molecule_title: "superpowers-workflow",
  current_step: { id: "mol-w.conversation", title: titleOf("conversation"), issue_type: "task", status: "in_progress" },
  next_step: null,
  doneCount: 0,
  total: FORMULA.length,
  steps: [
    ...KEYS.map((key) =>
      step(key, key === "conversation" ? { status: "in_progress", step_status: "current", is_current: true } : {}),
    ),
    ...Object.keys(GATE_TO_REVIEW_STEP).map(gate),
  ],
};

assert.ok(
  topicPrefix(FORMULA_SRC).length > 0,
  "the shipped formula's conversation step carries a {{topic}} placeholder",
);
assert.ok(
  titleOf("conversation").startsWith(topicPrefix(FORMULA_SRC)),
  "the derived topic prefix is the conversation title's literal prefix",
);
assert.equal(topicFor(poured), TOPIC, "topicFor resolves the topic from the poured conversation step");
assert.equal(phaseFor(poured), "brainstorming", "a fresh pour is in the brainstorming phase");

const lines = moleculeWidgetLines(poured, 200);
assert.ok(lines[0].includes(TOPIC), `header carries the topic: ${lines[0]}`);
for (const key of BRAINSTORM_VIEW) {
  assert.ok(
    lines.some((l) => l.includes(titleOf(key))),
    `brainstorm row ${key} resolves and renders: ${lines.join(" | ")}`,
  );
}
for (const key of FINISH_VIEW) {
  assert.ok(!lines.some((l) => l.includes(titleOf(key))), `finish row ${key} stays out of the brainstorming view`);
}

// ---------- each gate associates with the review step it blocks ----------
for (const [label, reviewKey] of Object.entries(GATE_TO_REVIEW_STEP)) {
  const chainKeys = BRAINSTORM_VIEW.includes(reviewKey) ? BRAINSTORM_VIEW : FINISH_VIEW;
  const chain = chainKeys.map((key) =>
    key === reviewKey
      ? step(key, { status: "open", step_status: "ready" })
      : step(key, { status: "closed", step_status: "done" }),
  );
  const state = { ...poured, current_step: null, steps: [...chain, gate(label)] };
  assert.equal(
    waitingReviewStep(state, chain),
    chain.find((s) => s.labels[0] === `step:${reviewKey}`),
    `${label} associates with the ${reviewKey} review step`,
  );
}

// ---------- the title-matched parts are pinned to the shipped titles too ----------
assert.ok(
  isWrapUpStep(byKey.get("wrap-up").title),
  `isWrapUpStep recognises the shipped wrap-up title: ${JSON.stringify(byKey.get("wrap-up").title)}`,
);

const withImplement = (stepStatus, wrapUpStatus = "pending") => ({
  ...poured,
  steps: [
    step("implement", { status: stepStatus === "done" ? "closed" : "open", step_status: stepStatus }),
    step("wrap-up", { status: wrapUpStatus === "done" ? "closed" : "open", step_status: wrapUpStatus }),
  ],
});
assert.equal(phaseFor(withImplement("ready")), "implementing", "implement ready -> implementing");
assert.equal(phaseFor(withImplement("done")), "implementing", "implement done, wrap-up outstanding -> implementing");
assert.equal(phaseFor(withImplement("done", "done")), "finishing", "wrap-up done -> finishing");

const finishing = {
  ...poured,
  current_step: null,
  steps: [
    step("implement", { status: "closed", step_status: "done" }),
    step("wrap-up", { status: "closed", step_status: "done" }),
    step("verify", { status: "in_progress", step_status: "current", is_current: true }),
    step("smoke-test-approved"),
    step("finish"),
    gate("step:gate-smoke-test-approved"),
  ],
};
const finishingLines = moleculeWidgetLines(finishing, 200);
for (const key of FINISH_VIEW) {
  assert.ok(
    finishingLines.some((l) => l.includes(titleOf(key))),
    `finish row ${key} resolves and renders: ${finishingLines.join(" | ")}`,
  );
}

console.log("widget-formula-coupling: all assertions passed");
