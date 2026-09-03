import assert from "node:assert/strict";
import {
  createChangeCoalescer,
  displayWidth,
  moleculeWidgetLines,
  parseMoleculeCurrent,
  parseMoleculeShow,
  phaseFor,
  topicFor,
} from "./beads-molecule-widget.mjs";

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

// ---------- parser: keeps full step data (title/status/is_current/created_at) ----------
const RAW2 = JSON.stringify([
  {
    molecule_id: "bd-mol-g0z",
    molecule_title: "superpowers-workflow",
    current_step: { id: "bd-mol-1vz", title: "Ask clarifying questions", status: "in_progress", issue_type: "task" },
    next_step: { id: "bd-mol-8y2", title: "Gate: human", issue_type: "gate" },
    steps: [
      {
        issue: {
          id: "bd-mol-meq",
          title: "Explore project context: Superpowers widget changes",
          issue_type: "task",
          status: "closed",
        },
        status: "done",
        is_current: false,
      },
      {
        issue: { id: "bd-mol-1vz", title: "Ask clarifying questions", issue_type: "task", status: "in_progress" },
        status: "current",
        is_current: true,
      },
      {
        issue: { id: "bd-mol-8y2", title: "Gate: human", issue_type: "gate", status: "open" },
        status: "ready",
        is_current: false,
      },
      {
        issue: { id: "bd-mol-9ev", title: "Implement", issue_type: "task", status: "open" },
        status: "pending",
        is_current: false,
      },
    ],
  },
]);
const p2 = parseMoleculeCurrent(RAW2);
assert.equal(p2.steps[0].title, "Explore project context: Superpowers widget changes");
assert.equal(p2.steps[1].step_status, "current");
assert.equal(p2.steps[1].is_current, true);
assert.equal(p2.steps[0].created_at, "");

// ---------- topic + phase helpers ----------
assert.equal(topicFor(p2), "Superpowers widget changes");
assert.equal(
  topicFor({ ...p2, steps: p2.steps.filter((s) => !s.title.startsWith("Explore")) }),
  "superpowers-workflow",
);
assert.equal(topicFor(null), "");
assert.equal(phaseFor(p2), "brainstorming"); // implement pending
assert.equal(
  phaseFor({ ...p2, steps: p2.steps.map((s) => (s.title === "Implement" ? { ...s, step_status: "current" } : s)) }),
  "implementing",
);
assert.equal(
  phaseFor({ ...p2, steps: p2.steps.map((s) => (s.title === "Implement" ? { ...s, step_status: "done" } : s)) }),
  "finishing",
);

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

// ---------- render: view B header replaces the phase label ----------
const explorePhase = {
  ...parsed,
  current_step: {
    id: "bd-mol-meq",
    title: "Explore project context: x",
    issue_type: "task",
    formula_step_id: "explore",
  },
};
const phaseLines = moleculeWidgetLines(explorePhase, 80);
assert.ok(phaseLines[0].includes("Superpowers:") && phaseLines[1].includes("Explore project context: x"));
assert.ok(!phaseLines[0].includes("Brainstorming"), "phase label removed from header");

// ---------- parseMoleculeShow ----------
assert.deepEqual(parseMoleculeShow(""), null);
assert.deepEqual(parseMoleculeShow("not json"), null);
assert.deepEqual(parseMoleculeShow("[]"), null);

const SHOW = JSON.stringify({
  root: { id: "mol-9", title: "Implement X", priority: 2, status: "in_progress", issue_type: "task" },
  issues: [
    { id: "mol-9", title: "Implement X", priority: 2, status: "in_progress", issue_type: "task" },
    {
      id: "mol-9.1",
      title: "Task 1",
      priority: 2,
      status: "open",
      issue_type: "task",
      created_at: "2026-09-02T10:00:01Z",
    },
    {
      id: "mol-9.2",
      title: "Task 2",
      priority: 2,
      status: "in_progress",
      issue_type: "task",
      created_at: "2026-09-02T10:00:00Z",
    },
    {
      id: "mol-9.3",
      title: "Task 3",
      priority: 2,
      status: "closed",
      issue_type: "task",
      created_at: "2026-09-02T10:00:02Z",
    },
    {
      id: "other",
      title: "Some other bead",
      priority: 1,
      status: "open",
      issue_type: "task",
      created_at: "2026-09-02T09:00:00Z",
    },
  ],
  dependencies: [
    { issue_id: "mol-9.1", depends_on_id: "mol-9", type: "parent-child" },
    { issue_id: "mol-9.2", depends_on_id: "mol-9", type: "parent-child" },
    { issue_id: "mol-9.3", depends_on_id: "mol-9", type: "parent-child" },
    { issue_id: "other", depends_on_id: "mol-9", type: "blocks" },
    { issue_id: "mol-9.2", depends_on_id: "mol-9.1", type: "blocks" },
  ],
});
const children = parseMoleculeShow(SHOW);
// sorted by created_at then id => mol-9.2, mol-9.1, mol-9.3
assert.deepEqual(
  children.map((c) => c.id),
  ["mol-9.2", "mol-9.1", "mol-9.3"],
);
assert.equal(children[0].status, "in_progress");
assert.equal(children[1].priority, 2);
// a blocks-only relationship produces no child
const NO_CHILD = JSON.stringify({
  root: { id: "r" },
  issues: [{ id: "r" }, { id: "b" }],
  dependencies: [{ issue_id: "b", depends_on_id: "r", type: "blocks" }],
});
assert.deepEqual(parseMoleculeShow(NO_CHILD), []);

// ---------- renderer: view B ----------
const base = {
  molecule_id: "mol-9",
  molecule_title: "Superpowers widget upgrade",
  current_step: { id: "mol-9", title: "Implement the widget", status: "in_progress", priority: 2, issue_type: "task" },
  next_step: null,
  steps: [{ issue: { id: "mol-9" }, status: "current" }],
  doneCount: 1,
  total: 4,
  children: [
    { id: "mol-9.2", title: "Task 2 (done)", status: "closed", priority: 2, issue_type: "task" },
    { id: "mol-9.1", title: "Task 1 (open)", status: "open", priority: 2, issue_type: "task" },
    { id: "mol-9.3", title: "Task 3 (last)", status: "in_progress", priority: 2, issue_type: "task" },
  ],
};

// header
const out = moleculeWidgetLines(base, 80);
assert.ok(out[0].includes("Superpowers:") && out[0].includes("Superpowers widget upgrade"));
assert.ok(out[0].includes("· 1/4"), "header shows done/total");
// trunk
assert.ok(out[1].includes("◐") && out[1].includes("mol-9") && out[1].includes("P2"));
// children glyphs: first two ├── , last └── ; markers: ✓ for closed child, ○ for open
assert.ok(out[2].includes("├──") && out[2].includes("✓") && out[2].includes("mol-9.2"));
assert.ok(out[3].includes("├──") && out[3].includes("○") && out[3].includes("mol-9.1"));
assert.ok(out[4].includes("└──") && out[4].includes("mol-9.3"));

// no children => no glyph rows
const noKids = { ...base, children: [] };
const out2 = moleculeWidgetLines(noKids, 80);
assert.equal(out2.length, 2); // header + trunk
assert.ok(!out2.some((l) => l.includes("├──") || l.includes("└──")));

// gate trunk => "Waiting on you", no subtree
const gate = {
  ...base,
  current_step: { id: "g", title: "Gate: human", status: "open", priority: 2, issue_type: "gate" },
  children: [],
};
const out3 = moleculeWidgetLines(gate, 80);
assert.ok(out3[1].includes("Waiting on you:") && out3[1].includes("Gate: human"));
assert.equal(out3.length, 2);

// gate with non-empty children still never renders a subtree (and never bypasses the cap)
const gateKids = { ...gate, children: [{ id: "g1", title: "x", status: "open", priority: 2, issue_type: "task" }] };
const out3k = moleculeWidgetLines(gateKids, 80);
assert.equal(out3k.length, 2, `gate renders exactly [header, trunk], got ${out3k.length} lines`);
assert.ok(!out3k.some((l) => l.includes("├──") || l.includes("└──")), "gate output has no glyph rows");
assert.ok(!out3k.some((l) => l.includes("g1")), "gate output contains no child id");
assert.ok(out3k[1].includes("Waiting on you:") && out3k[1].includes("Gate: human"));

// next fallback when no current step
const next = { ...base, current_step: null, next_step: { id: "n", title: "Gate: human" }, children: [] };
const out4 = moleculeWidgetLines(next, 80);
assert.ok(out4[1].includes("Next:") && out4[1].includes("Gate: human"));

// 15-line cap with +N more tail (wide width so only the cap matters)
const many = {
  ...base,
  children: Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`,
    title: `child ${i}`,
    status: "open",
    priority: 2,
    issue_type: "task",
  })),
};
const out5 = moleculeWidgetLines(many, 300);
assert.equal(out5.length, 15, `capped at 15 lines, got ${out5.length}`);
assert.ok(out5[out5.length - 1].includes(" more"), "overflow tail present");

// width truncation still enforced: each line's plain-text width <= given width
for (const line of out5) assert.ok(displayWidth(line) <= 300);

// ✓ closed flip: same child open -> closed across two states
const openChild = { ...base, children: [{ id: "c", title: "t", status: "open", priority: 2, issue_type: "task" }] };
const closedChild = { ...base, children: [{ id: "c", title: "t", status: "closed", priority: 2, issue_type: "task" }] };
const a = moleculeWidgetLines(openChild, 80)[2];
const b = moleculeWidgetLines(closedChild, 80)[2];
assert.ok(a.includes("○") && b.includes("✓"), `flip ○ -> ✓ (got '${a}' -> '${b}')`);

// theme passthrough: a custom theme transforms the accent-painted header label;
// a null/absent theme still renders the plain text.
const THEME = { fg: (color, t) => (color === "accent" ? t.toUpperCase() : t) };
const themed = moleculeWidgetLines(base, 80, THEME);
assert.ok(themed[0].includes("SUPERPOWERS:"), `theme-colored header label (got '${themed[0]}')`);
assert.ok(!themed[0].includes("Superpowers:"), "untransformed label gone when themed");
const plain = moleculeWidgetLines(base, 80);
assert.ok(plain[0].includes("Superpowers:"), "absent theme renders plain label");
const plainNull = moleculeWidgetLines(base, 80, null);
assert.ok(plainNull[0].includes("Superpowers:"), "null theme renders plain label");

// ---------- createChangeCoalescer: leading-edge fire, single trailing timer ----------
{
  let scheduled = null; // { cb, ms }
  const fakeTimers = {
    setTimeout: (cb, ms) => {
      scheduled = { cb, ms };
      return scheduled;
    },
    clearTimeout: (t) => {
      if (t === scheduled) scheduled = null;
    },
  };
  const fires = [];
  const c = createChangeCoalescer(() => fires.push(1), 10000, fakeTimers);

  c.trigger();
  assert.equal(fires.length, 1, "leading-edge trigger fires immediately");
  assert.ok(scheduled && scheduled.ms === 10000, "10s trailing timer started");

  c.trigger();
  c.trigger();
  assert.equal(fires.length, 1, "triggers during the window are coalesced, not fired");

  const timerCb = scheduled.cb;
  timerCb();
  assert.equal(fires.length, 2, "one trailing render after coalescing a burst");
  assert.ok(scheduled && scheduled.ms === 10000, "timer restarts after a dirty trailing fire");

  const timerCb2 = scheduled.cb;
  timerCb2();
  assert.equal(fires.length, 2, "no render when nothing changed during the window");
  assert.equal(scheduled, null, "timer cleared when idle");

  c.trigger();
  assert.equal(fires.length, 3, "trigger after idle is a fresh leading edge");
}

console.log("beads-molecule-widget: all assertions passed");
