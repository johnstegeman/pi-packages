import assert from "node:assert/strict";
import {
  createChangeCoalescer,
  displayWidth,
  moleculeWidgetLines,
  parseMoleculeCurrent,
  phaseFor,
  topicFor,
} from "./beads-molecule-widget.mjs";

// ---------- parser: malformed input never throws ----------
assert.deepEqual(parseMoleculeCurrent(""), null);
assert.deepEqual(parseMoleculeCurrent("not json"), null);
assert.deepEqual(parseMoleculeCurrent("[]"), null);

// ---------- parser: keeps full step data (title/status/is_current/created_at) ----------
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
const parsed = parseMoleculeCurrent(RAW);
assert.equal(parsed.molecule_id, "bd-mol-g0z");
assert.equal(parsed.doneCount, 1);
assert.equal(parsed.total, 4);
assert.equal(parsed.steps[0].title, "Explore project context: Superpowers widget changes");
assert.equal(parsed.steps[1].step_status, "current");
assert.equal(parsed.steps[1].is_current, true);
assert.equal(parsed.steps[0].created_at, "");

// ---------- topic + phase helpers ----------
assert.equal(topicFor(parsed), "Superpowers widget changes");
assert.equal(
  topicFor({ ...parsed, steps: parsed.steps.filter((s) => !s.title.startsWith("Explore")) }),
  "superpowers-workflow",
);
assert.equal(topicFor(null), "");
assert.equal(phaseFor(parsed), "brainstorming"); // implement pending
assert.equal(
  phaseFor({
    ...parsed,
    steps: parsed.steps.map((s) => (s.title === "Implement" ? { ...s, step_status: "current" } : s)),
  }),
  "implementing",
);
assert.equal(
  phaseFor({
    ...parsed,
    steps: parsed.steps.map((s) => (s.title === "Implement" ? { ...s, step_status: "done" } : s)),
  }),
  "finishing",
);

// ---------- render: nothing to draw ----------
assert.deepEqual(moleculeWidgetLines(null, 80), []);
assert.deepEqual(moleculeWidgetLines(parsed, 0), []);

// ---------- full brainstorming fixture: all 8 pre-impl tasks + 2 gates + implement ----------
const bstate = {
  molecule_id: "bd-mol-g0z",
  molecule_title: "superpowers-workflow",
  current_step: { id: "bd-mol-1vz", title: "Ask clarifying questions", status: "in_progress", issue_type: "task" },
  next_step: null,
  doneCount: 4,
  total: 12,
  steps: [
    {
      id: "s1",
      title: "Explore project context: Superpowers widget changes",
      status: "closed",
      issue_type: "task",
      created_at: "",
      step_status: "done",
      is_current: false,
    },
    {
      id: "s2",
      title: "Ask clarifying questions",
      status: "in_progress",
      issue_type: "task",
      created_at: "",
      step_status: "current",
      is_current: true,
    },
    {
      id: "s3",
      title: "Propose approaches",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "ready",
      is_current: false,
    },
    {
      id: "s4",
      title: "Present design sections",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
    {
      id: "s5",
      title: "User approves design",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
    {
      id: "g1",
      title: "Gate: human",
      status: "open",
      issue_type: "gate",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
    {
      id: "s6",
      title: "Write spec to docs/superpowers/specs/",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
    {
      id: "s7",
      title: "Spec self-review",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
    {
      id: "s8",
      title: "User reviews written spec",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
    {
      id: "g2",
      title: "Gate: human",
      status: "open",
      issue_type: "gate",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
    {
      id: "s9",
      title: "Implement Superpowers widget changes",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
    {
      id: "s10",
      title: "Verify",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
  ],
};

// ---------- header: topic (not formula name) + phase label + done/total ----------
const headerLines = moleculeWidgetLines(bstate, 120);
assert.ok(
  headerLines[0].includes("Superpowers:") && headerLines[0].includes("Superpowers widget changes"),
  headerLines[0],
);
assert.ok(headerLines[0].includes("Brainstorming"), headerLines[0]);
assert.ok(headerLines[0].includes("4/12"), headerLines[0]);
assert.ok(!headerLines[0].includes("superpowers-workflow"), "formula name not in header");

// ---------- brainstorming: all 8 tasks incl. done, formula order, markers ----------
assert.ok(headerLines.length <= 15);
const labelAt = (label) => headerLines.findIndex((l) => l.includes(label));
const order = [
  "Explore project context",
  "Ask clarifying questions",
  "Propose approaches",
  "Present design sections",
  "User approves design",
  "Write spec",
  "Spec self-review",
  "User reviews written spec",
].map(labelAt);
for (let i = 1; i < order.length; i++) {
  assert.ok(order[i - 1] !== -1 && order[i] > order[i - 1], `${i} out of order: ${order}`);
}
assert.ok(headerLines[order[0]].includes("✓"), "done explore row: ✓");
assert.ok(headerLines[order[1]].includes("◐"), "current clarify row: ◐");

// ---------- gate as current => waiting line, checklist still shown ----------
const gateCurrent = { ...bstate, current_step: { id: "g", title: "Gate: human", issue_type: "gate" } };
const gLines = moleculeWidgetLines(gateCurrent, 120);
assert.ok(gLines.some((l) => l.includes("Waiting on you:") && l.includes("Gate: human")));
assert.ok(gLines.some((l) => l.includes("Ask clarifying questions")));

// ---------- implementing: head row + plan gate first + task beads, current pinned ----------
const implState = {
  molecule_id: "mol-9",
  molecule_title: "superpowers-workflow",
  current_step: { id: "mol-9.i.2", title: "Task 2: build it", status: "in_progress", issue_type: "task" },
  next_step: null,
  doneCount: 10,
  total: 13,
  steps: [
    {
      id: "mol-9.i",
      title: "Implement Superpowers widget changes",
      status: "in_progress",
      issue_type: "task",
      created_at: "t0",
      step_status: "current",
      is_current: false,
    },
    {
      id: "mol-9.i.1",
      title: "Plan reviewed / ready to execute",
      status: "open",
      issue_type: "task",
      created_at: "t1",
      step_status: "ready",
      is_current: false,
    },
    {
      id: "mol-9.i.2",
      title: "Task 2: build it",
      status: "in_progress",
      issue_type: "task",
      created_at: "t3",
      step_status: "current",
      is_current: true,
    },
    {
      id: "mol-9.i.3",
      title: "Task 1: setup",
      status: "closed",
      issue_type: "task",
      created_at: "t2",
      step_status: "done",
      is_current: false,
    },
    {
      id: "mol-9.u.1",
      title: "Finish development branch",
      status: "open",
      issue_type: "task",
      created_at: "t9",
      step_status: "pending",
      is_current: false,
    },
  ],
};
const iLines = moleculeWidgetLines(implState, 120);
assert.ok(iLines[0].includes("Superpowers:") && iLines[0].includes("Implementing"), iLines[0]);
const iHead = iLines.findIndex((l) => l.includes("Implement Superpowers widget changes"));
const iGate = iLines.findIndex((l) => l.includes("Plan reviewed / ready to execute"));
const iTask2 = iLines.findIndex((l) => l.includes("Task 2: build it"));
const iTask1 = iLines.findIndex((l) => l.includes("Task 1: setup"));
assert.ok(iHead !== -1 && iGate !== -1 && iTask2 !== -1 && iTask1 !== -1);
assert.ok(iGate > iHead, "plan gate after implement head");
assert.ok(iLines[iTask2].includes("◐"), "current task marker ◐");
assert.ok(iLines[iTask1].includes("✓"), "closed task marker ✓");
assert.ok(!iLines.some((l) => l.includes("Finish development branch")), "finishing steps hidden during implementing");

// ---------- finishing: verify/smoke/finish rows only ----------
const finState = {
  molecule_id: "mol-9",
  molecule_title: "superpowers-workflow",
  current_step: { id: "f1", title: "Verify", status: "in_progress", issue_type: "task" },
  next_step: null,
  doneCount: 11,
  total: 13,
  steps: [
    {
      id: "m1",
      title: "Explore project context: Superpowers widget changes",
      status: "closed",
      issue_type: "task",
      created_at: "",
      step_status: "done",
      is_current: false,
    },
    {
      id: "m2",
      title: "Implement Superpowers widget changes",
      status: "closed",
      issue_type: "task",
      created_at: "",
      step_status: "done",
      is_current: false,
    },
    {
      id: "f1",
      title: "Verify",
      status: "in_progress",
      issue_type: "task",
      created_at: "",
      step_status: "current",
      is_current: true,
    },
    {
      id: "f2",
      title: "Smoke test / manual QA sign-off",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "ready",
      is_current: false,
    },
    {
      id: "f3",
      title: "Finish development branch",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
  ],
};
const fLines = moleculeWidgetLines(finState, 120);
assert.ok(fLines[0].includes("Finishing"), fLines[0]);
const vIdx = fLines.findIndex((l) => l.includes("Verify"));
const sIdx = fLines.findIndex((l) => l.includes("Smoke test / manual QA sign-off"));
const fIdx = fLines.findIndex((l) => l.includes("Finish development branch"));
assert.ok(vIdx !== -1 && sIdx !== -1 && fIdx !== -1);
assert.ok(vIdx < sIdx && sIdx < fIdx, "finish rows in formula order");
assert.ok(fLines[vIdx].includes("◐"), "verify current");
assert.ok(!fLines.some((l) => l.includes("Explore project context")), "brainstorming hidden during finishing");

// ---------- fully complete: single finished line ----------
const doneState = {
  ...finState,
  current_step: null,
  steps: finState.steps.map((s) => ({ ...s, status: "closed", step_status: "done" })),
  doneCount: 5,
  total: 5,
};
const doneLines = moleculeWidgetLines(doneState, 120);
assert.equal(doneLines.length, 1);
assert.ok(doneLines[0].includes("Superpowers widget changes") && doneLines[0].includes("finished"), doneLines[0]);

// ---------- cap + open-preference: closed dropped before open, <= 15 lines ----------
const manyTasks = {
  ...implState,
  current_step: { id: "m.i.6", title: "Task 6: item 5", status: "in_progress", issue_type: "task" },
  steps: [
    {
      id: "m",
      title: "Implement Superpowers widget changes",
      status: "in_progress",
      issue_type: "task",
      created_at: "t0",
      step_status: "current",
      is_current: false,
    },
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `m.i.${i + 1}`,
      title: `Task ${i + 1}: item ${i}`,
      status: i % 2 === 0 ? "open" : "closed",
      issue_type: "task",
      created_at: `t${i + 1}`,
      step_status: i === 5 ? "current" : i % 2 === 0 ? "ready" : "done",
      is_current: i === 5,
    })),
    {
      id: "m.done",
      title: "Finish development branch",
      status: "open",
      issue_type: "task",
      created_at: "t99",
      step_status: "pending",
      is_current: false,
    },
  ],
};
const manyLines = moleculeWidgetLines(manyTasks, 300);
assert.equal(manyLines.length, 15, `capped at 15 lines, got ${manyLines.length}`);
assert.ok(
  manyLines.some((l) => l.includes("Task 6: item 5")),
  "pinned current task survives overflow",
);
const closedCount = manyLines.filter((l) => l.includes("✓")).length;
const openCount = manyLines.filter((l) => l.includes("◐") || l.includes("○")).length;
assert.ok(openCount > closedCount, `open preferred over closed: open=${openCount} closed=${closedCount}`);
assert.ok(manyLines[manyLines.length - 1].includes(" more"), "overflow tail present");
for (const line of manyLines) assert.ok(displayWidth(line) <= 300);

// width truncation still enforced at narrow width
for (const line of moleculeWidgetLines(implState, 30)) assert.ok(displayWidth(line) <= 30);

// ---------- theme passthrough ----------
const THEME = { fg: (color, t) => (color === "accent" ? t.toUpperCase() : t) };
const themed = moleculeWidgetLines(bstate, 120, THEME);
assert.ok(themed[0].includes("SUPERPOWERS:"), `theme-colored header label (got '${themed[0]}')`);
const plain = moleculeWidgetLines(bstate, 120);
assert.ok(plain[0].includes("Superpowers:"), "absent theme renders plain label");

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
