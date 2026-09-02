import assert from "node:assert/strict";
import { moleculeWidgetLines, parseMoleculeCurrent } from "./beads-molecule-widget.mjs";

// ---------- parser: malformed input never throws ----------
assert.deepEqual(parseMoleculeCurrent(""), null);
assert.deepEqual(parseMoleculeCurrent("not json"), null);
assert.deepEqual(parseMoleculeCurrent("[]"), null);

// ---------- parser: happy path ----------
const RAW = JSON.stringify([
  {
    molecule_id: "bd-mol-g0z",
    molecule_title: "superpowers-workflow",
    current_step: {
      id: "bd-mol-1vz",
      title: "Ask clarifying questions",
      status: "in_progress",
      issue_type: "task",
      started_at: "2026-09-02T15:34:18Z",
    },
    next_step: {
      id: "bd-mol-8y2",
      title: "Gate: human",
      issue_type: "gate",
    },
    steps: [
      { issue: { id: "bd-mol-meq", issue_type: "task" }, status: "done" },
      { issue: { id: "bd-mol-1vz", issue_type: "task" }, status: "current" },
      { issue: { id: "bd-mol-8y2", issue_type: "gate" }, status: "ready" },
      { issue: { id: "bd-mol-9ev", issue_type: "task" }, status: "pending" },
    ],
  },
]);
const parsed = parseMoleculeCurrent(RAW);
assert.equal(parsed.molecule_id, "bd-mol-g0z");
assert.equal(parsed.doneCount, 1);
assert.equal(parsed.total, 4);
assert.equal(parsed.current_step.title, "Ask clarifying questions");

// ---------- render: nothing to draw ----------
assert.deepEqual(moleculeWidgetLines(null, 80), []);
assert.deepEqual(moleculeWidgetLines(parsed, 0), []);

// ---------- render: header + current step ----------
const lines = moleculeWidgetLines(parsed, 80);
assert.ok(lines[0].includes("superpowers-workflow"));
assert.ok(lines[0].includes("1/4"));
assert.ok(lines.some((l) => l.includes("Ask clarifying questions")));

// ---------- render: gate-as-current gets the waiting glyph ----------
const gateCurrent = {
  ...parsed,
  current_step: { id: "bd-mol-8y2", title: "Gate: human", issue_type: "gate" },
};
const gateLines = moleculeWidgetLines(gateCurrent, 80);
assert.ok(gateLines.some((l) => l.includes("Waiting on you")));

// ---------- render: pending count folds into one row ----------
assert.ok(lines.some((l) => l.includes("pending")));

// ---------- phase label mapping ----------
const explorePhase = {
  ...parsed,
  current_step: {
    id: "bd-mol-meq",
    title: "Explore project context: x",
    issue_type: "task",
    formula_step_id: "explore",
  },
};
assert.ok(moleculeWidgetLines(explorePhase, 80)[0].includes("Brainstorming"));

console.log("beads-molecule-widget: all assertions passed");
