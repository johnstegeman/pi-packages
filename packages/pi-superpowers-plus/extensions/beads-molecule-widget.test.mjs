import assert from "node:assert/strict";
import {
  applyErrorFrame,
  applyMoleculeFrame,
  createChangeCoalescer,
  displayWidth,
  hasLockedMolecule,
  moleculeWidgetLines,
  nextRefreshArgs,
  parseMoleculeCurrent,
  phaseFor,
  topicFor,
} from "./beads-molecule-widget.mjs";

// ---------- parser: malformed input never throws ----------

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
const gateCurrent = { ...bstate, current_step: { id: "gate-g", title: "Gate: human", issue_type: "gate" } };
const gLines = moleculeWidgetLines(gateCurrent, 120);
assert.ok(gLines.some((l) => l.includes("Waiting on you:") && l.includes("Gate: human")));
assert.ok(gLines.some((l) => l.includes("Ask clarifying questions")));
const gWait = gLines.find((l) => l.includes("Waiting on you:"));
assert.ok(gWait && gWait.includes("gate-g"), `gate-current footer falls back to gate id (got '${gWait}')`);

// ---------- awaiting human: no current step, ready Human gate -> Waiting on you line ----------
const awaitState = {
  molecule_id: "bd-mol-a1",
  molecule_title: "superpowers-workflow",
  current_step: null,
  next_step: { id: "bd-mol-g2", title: "Gate: human", status: "open", issue_type: "gate" },
  doneCount: 6,
  total: 8,
  steps: [
    {
      id: "a1",
      title: "Explore project context: widget fixes",
      status: "closed",
      issue_type: "task",
      created_at: "",
      step_status: "done",
      is_current: false,
    },
    {
      id: "a2",
      title: "Write spec to docs/superpowers/specs/",
      status: "closed",
      issue_type: "task",
      created_at: "",
      step_status: "done",
      is_current: false,
    },
    {
      id: "a3",
      title: "Spec self-review",
      status: "closed",
      issue_type: "task",
      created_at: "",
      step_status: "done",
      is_current: false,
    },
    {
      id: "a4",
      title: "User reviews written spec",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
    {
      id: "a5",
      title: "Gate: human",
      status: "open",
      issue_type: "gate",
      created_at: "",
      step_status: "ready",
      is_current: false,
    },
    {
      id: "a6",
      title: "Implement widget fixes",
      status: "open",
      issue_type: "task",
      created_at: "",
      step_status: "pending",
      is_current: false,
    },
  ],
};
const aLines = moleculeWidgetLines(awaitState, 120);
const aWait = aLines.find((l) => l.includes("Waiting on you:"));
assert.ok(aWait && aWait.includes("User reviews written spec"), `footer shows gated step title (got '${aWait}')`);
assert.ok(aWait && !aWait.includes("Gate: human"), `footer does not expose raw gate title (got '${aWait}')`);
assert.ok(aWait && aWait.includes("a4"), `footer carries the gated step id (got '${aWait}')`);
const aIdx = aLines.findIndex((l) => l.includes("User reviews written spec"));
assert.ok(
  aIdx !== -1 && aIdx < aLines.findIndex((l) => l.includes("Waiting on you:")),
  "awaited step rendered as active row",
);
assert.ok(aLines[aIdx].includes("\u25d0"), `awaited row carries the active marker: ${aLines[aIdx]}`);

// ---------- awaiting human: ready gate but gated step already done => no active row ----------
const awaitNullState = {
  ...awaitState,
  steps: awaitState.steps.map((s) => (s.id === "a4" ? { ...s, status: "closed", step_status: "done" } : s)),
};
const anLines = moleculeWidgetLines(awaitNullState, 120);
assert.ok(
  anLines.some((l) => l.includes("Waiting on you:") && l.includes("Gate: human")),
  `waiting line still pinned: ${anLines.join(" | ")}`,
);
const anWait = anLines.find((l) => l.includes("Waiting on you:"));
assert.ok(
  anWait && anWait.includes("a5"),
  `no-precursor awaiting line falls back to the gate id (got '${anWait}')`,
);
assert.ok(
  !anLines.some((l) => l.includes("\u25d0")),
  `no mis-associated active row when no preceding open gated step: ${anLines.join(" | ")}`,
);

// ---------- Finding 6: footer shows the gated human-review step, not raw gate title ----------
{
  const approveState = {
    molecule_id: "pi-packages-mol-27qs",
    molecule_title: "superpowers-workflow",
    current_step: null,
    next_step: { id: "g.1", title: "Gate: human", status: "open", issue_type: "gate" },
    doneCount: 4,
    total: 7,
    steps: [
      { id: "t1", title: "Explore project context: footer test", status: "closed", issue_type: "task", created_at: "", step_status: "done", is_current: false },
      { id: "t2", title: "Ask clarifying questions", status: "closed", issue_type: "task", created_at: "", step_status: "done", is_current: false },
      { id: "t3", title: "Propose approaches", status: "closed", issue_type: "task", created_at: "", step_status: "done", is_current: false },
      { id: "t4", title: "Present design sections", status: "closed", issue_type: "task", created_at: "", step_status: "done", is_current: false },
      { id: "t5", title: "User approves design", status: "open", issue_type: "task", created_at: "", step_status: "pending", is_current: false },
      { id: "g.1", title: "Gate: human", status: "open", issue_type: "gate", created_at: "", step_status: "ready", is_current: false },
      { id: "t6", title: "Write spec to docs/superpowers/specs/", status: "open", issue_type: "task", created_at: "", step_status: "pending", is_current: false },
    ],
  };
  const approveLines = moleculeWidgetLines(approveState, 200);
  const foot = approveLines.find((l) => l.includes("Waiting on you:"));
  assert.ok(foot, `awaiting footer present: ${approveLines.join(" | ")}`);
  assert.ok(foot.includes("User approves design"), `footer shows gated step title (got '${foot}')`);
  assert.ok(!foot.includes("Gate: human"), `footer does not expose raw gate title (got '${foot}')`);
  assert.ok(foot.includes("t5"), `footer carries the gated step id (got '${foot}')`);
}

// ---------- awaiting human + overflow: awaited step and waiting line stay pinned, in order ----------
const awaitOverflowState = {
  molecule_id: "bd-mol-o1",
  molecule_title: "superpowers-workflow",
  current_step: null,
  next_step: { id: "o.g", title: "Gate: human", status: "open", issue_type: "gate" },
  doneCount: 2,
  total: 30,
  steps: [
    {
      id: "o.i",
      title: "Implement overflow widget",
      status: "open",
      issue_type: "task",
      created_at: "t0",
      step_status: "current",
      is_current: false,
    },
    ...Array.from({ length: 24 }, (_, i) => ({
      id: `o.i.${i + 1}`,
      title: `Task ${i + 1}: item ${i}`,
      status: "open",
      issue_type: "task",
      created_at: `t${i + 1}`,
      step_status: "pending",
      is_current: false,
    })),
    {
      id: "o.g",
      title: "Gate: human",
      status: "open",
      issue_type: "gate",
      created_at: "t25",
      step_status: "ready",
      is_current: false,
    },
    {
      id: "o.done",
      title: "Finish development branch",
      status: "open",
      issue_type: "task",
      created_at: "t26",
      step_status: "pending",
      is_current: false,
    },
  ],
};
const aoLines = moleculeWidgetLines(awaitOverflowState, 120);
assert.ok(aoLines.length <= 15, `overflow capped: ${aoLines.length}`);
const aoAwaitIdx = aoLines.findIndex((l) => l.includes("Task 24: item 23"));
const aoWaitIdx = aoLines.findIndex((l) => l.includes("Waiting on you:"));
assert.ok(aoAwaitIdx !== -1, `awaited step survives overflow: ${aoLines.join(" | ")}`);
assert.ok(aoWaitIdx !== -1, `waiting line survives overflow: ${aoLines.join(" | ")}`);
const aoWait = aoLines[aoWaitIdx];
assert.ok(aoWait.includes("Task 24: item 23"), `footer shows gated step title (got '${aoWait}')`);
assert.ok(!aoWait.includes("Gate: human"), `footer does not expose raw gate title (got '${aoWait}')`);
assert.ok(aoWait.includes("o.i.24"), `footer carries the gated step id (got '${aoWait}')`);
assert.ok(aoAwaitIdx < aoWaitIdx, "awaited step before the waiting line under overflow");
assert.ok(
  aoLines[aoAwaitIdx].includes("\u25d0"),
  `awaited child still carries the active marker: ${aoLines[aoAwaitIdx]}`,
);
assert.ok(aoLines[aoLines.length - 1].includes(" more"), "overflow tail present");
assert.ok(
  aIdx !== -1 && aIdx < aLines.findIndex((l) => l.includes("Waiting on you:")),
  "awaited step rendered as active row",
);

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
// ---------- implementing = tree: impl head, then ├──/└── task rows ----------
const iC1 = iLines.findIndex((l) => l.includes("├──"));
const iC2 = iLines.findIndex((l) => l.includes("└──"));
assert.ok(iHead < iC1 && iC1 < iC2, `tree rows after impl head: ${iLines.join(" | ")}`);
assert.ok(iLines[iC1].includes("├──"), "first child connector ├──");
assert.ok(iLines[iC2].includes("└──"), "last child connector └──");
assert.ok(iLines[iTask2].includes("◐"), "current child keeps ◐ marker");
assert.ok(iLines[iTask1].includes("✓"), "closed child keeps ✓ marker");

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

// ---------- Finding 7: bead ids on step rows ----------
// stepRow rows (brainstorming formula steps) append the bead id after the title
{
  const idState = {
    molecule_id: "pi-packages-mol-abc123",
    molecule_title: "superpowers-workflow",
    current_step: {
      id: "pi-packages-mol-abc123.2",
      title: "Ask clarifying questions",
      status: "in_progress",
      issue_type: "task",
    },
    next_step: null,
    doneCount: 1,
    total: 3,
    steps: [
      {
        id: "pi-packages-mol-abc123.1",
        title: "Explore project context: bead ids restore",
        status: "closed",
        issue_type: "task",
        created_at: "",
        step_status: "done",
        is_current: false,
      },
      {
        id: "pi-packages-mol-abc123.2",
        title: "Ask clarifying questions",
        status: "in_progress",
        issue_type: "task",
        created_at: "",
        step_status: "current",
        is_current: true,
      },
    ],
  };
  const idLines = moleculeWidgetLines(idState, 200);
  const exploreRow = idLines.find((l) => l.includes("Explore project context"));
  assert.ok(
    exploreRow && exploreRow.includes("pi-packages-mol-abc123.1"),
    `done step row carries its bead id (got '${exploreRow}')`,
  );
  const clarifyRow = idLines.find((l) => l.includes("Ask clarifying questions"));
  assert.ok(
    clarifyRow && clarifyRow.includes("pi-packages-mol-abc123.2"),
    `current step row carries its bead id (got '${clarifyRow}')`,
  );
}

// implementing-view kid-task rows carry the kid's full id (starts with <impl.id>.)
{
  const kidLines = moleculeWidgetLines(implState, 200);
  assert.ok(
    kidLines.some((l) => l.includes("mol-9.i.2") && l.includes("Task 2: build it")),
    `impl kid row carries its full bead id: ${kidLines.join(" | ")}`,
  );
  assert.ok(
    kidLines.some((l) => l.includes("mol-9.i.3") && l.includes("Task 1: setup")),
    `impl kid row carries its full bead id: ${kidLines.join(" | ")}`,
  );
}

// awaiting footer line carries the ready gate's bead id
{
  const awaitLines2 = moleculeWidgetLines(awaitState, 200);
  const waitLine = awaitLines2.find((l) => l.includes("Waiting on you:"));
  assert.ok(waitLine, `awaiting footer present: ${awaitLines2.join(" | ")}`);
  assert.ok(waitLine.includes("a4"), `awaiting footer carries gated step id (got '${waitLine}')`);
}

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

// ---------- stale-frame fix: args selection ----------
assert.deepEqual(nextRefreshArgs(null), ["mol", "current", "--json"]); // no lock yet -> no-id inference
assert.deepEqual(nextRefreshArgs("bd-mol-abc"), ["mol", "current", "bd-mol-abc", "--json"]); // locked -> by id

// ---------- stale-frame fix: pure refresh transition ----------
{
  const prev = parseMoleculeCurrent(RAW); // real-shaped 4-step molecule (bd-mol-g0z)
  // parsed non-null: adopt the new frame AND lock its molecule_id
  const adopted = applyMoleculeFrame(null, null, prev, false);
  assert.equal(adopted.activeMolecule, prev, "parsed frame adopted");
  assert.equal(adopted.lockedMoleculeId, "bd-mol-g0z", "parsed molecule id locked");

  // parsed non-null replaces an earlier frame and re-locks to the new id
  const future = { ...prev, molecule_id: "bd-mol-fut" };
  const switched = applyMoleculeFrame(prev, "bd-mol-g0z", future, true);
  assert.equal(switched.activeMolecule, future, "with-id refresh adopts the newer frame");
  assert.equal(switched.lockedMoleculeId, "bd-mol-fut", "lock follows the adopted frame");

  // null + queriedById (by-id query found nothing): real molecule gone -> clear widget + lock
  const cleared = applyMoleculeFrame(prev, "bd-mol-g0z", null, true);
  assert.deepEqual(cleared, { activeMolecule: null, lockedMoleculeId: null });

  // null + no-id fallback (no lock yet): inference found nothing, nothing better to show -> keep prior frame
  const kept = applyMoleculeFrame(prev, null, null, false);
  assert.equal(kept.activeMolecule, prev, "no-id null keeps the previous frame");
  assert.equal(kept.lockedMoleculeId, null);
}

// ---------- stale-frame regression (behavior): a by-id refresh must advance a frozen frame ----------
{
  // raw bd JSON captured while Implement was in_progress (the frozen/WIP frame)
  const WIP_RAW = JSON.stringify([
    {
      molecule_id: "bd-mol-g0z",
      molecule_title: "superpowers-workflow",
      current_step: { id: "bd-mol-i", title: "Implement stale-frame fix", status: "in_progress", issue_type: "task" },
      next_step: null,
      steps: [
        {
          issue: {
            id: "bd-mol-e",
            title: "Explore project context: stale-frame fix",
            issue_type: "task",
            status: "closed",
          },
          status: "done",
          is_current: false,
        },
        {
          issue: { id: "bd-mol-i", title: "Implement stale-frame fix", issue_type: "task", status: "in_progress" },
          status: "current",
          is_current: true,
        },
        {
          issue: { id: "bd-mol-v", title: "Verify", issue_type: "task", status: "open" },
          status: "ready",
          is_current: false,
        },
        {
          issue: { id: "bd-mol-f", title: "Finish development branch", issue_type: "task", status: "open" },
          status: "pending",
          is_current: false,
        },
      ],
    },
  ]);
  // raw bd JSON post-implementation: Implement done + closed, Verify current
  const DONE_RAW = JSON.stringify([
    {
      molecule_id: "bd-mol-g0z",
      molecule_title: "superpowers-workflow",
      current_step: { id: "bd-mol-v", title: "Verify", status: "in_progress", issue_type: "task" },
      next_step: null,
      steps: [
        {
          issue: {
            id: "bd-mol-e",
            title: "Explore project context: stale-frame fix",
            issue_type: "task",
            status: "closed",
          },
          status: "done",
          is_current: false,
        },
        {
          issue: { id: "bd-mol-i", title: "Implement stale-frame fix", issue_type: "task", status: "closed" },
          status: "done",
          is_current: false,
        },
        {
          issue: { id: "bd-mol-v", title: "Verify", issue_type: "task", status: "in_progress" },
          status: "current",
          is_current: true,
        },
        {
          issue: { id: "bd-mol-f", title: "Finish development branch", issue_type: "task", status: "open" },
          status: "pending",
          is_current: false,
        },
      ],
    },
  ]);

  // the widget captured the WIP frame earlier while implement was in_progress;
  // under the fix the id was locked at capture time.
  let active = parseMoleculeCurrent(WIP_RAW);
  let locked = active.molecule_id; // "bd-mol-g0z"
  assert.equal(phaseFor(active), "implementing", "precondition: widget frozen on the implementing frame");

  const calls = [];
  const fakeExec = async (_cmd, args) => {
    calls.push(args);
    // no-id inference drops out post-implementation (nothing in_progress+assigned) -> []
    if (!locked) return { code: 0, stdout: "[]", stderr: "" };
    // a by-id query always returns the full, current molecule
    return { code: 0, stdout: DONE_RAW, stderr: "" };
  };

  // replicate the fixed refreshMolecule decision flow exactly
  async function refresh() {
    const args = nextRefreshArgs(locked);
    const r = await fakeExec("bd", args);
    if (r.code !== 0) return;
    const parsed = parseMoleculeCurrent(r.stdout);
    const queriedById = args.length > 3;
    const nxt = applyMoleculeFrame(active, locked, parsed, queriedById);
    active = nxt.activeMolecule;
    locked = nxt.lockedMoleculeId;
  }

  await refresh();

  assert.deepEqual(
    calls.at(-1),
    ["mol", "current", "bd-mol-g0z", "--json"],
    "refresh re-queries by the locked id, never no-id inference after capture",
  );
  assert.equal(phaseFor(active), "finishing", "frozen implementing frame advanced to finishing");
  const rLines = moleculeWidgetLines(active, 120);
  assert.ok(rLines[0].includes("Finishing"), `header is Finishing: ${rLines.join(" | ")}`);
  assert.ok(
    rLines.some((l) => l.includes("Verify")),
    `Verify visible in finishing view: ${rLines.join(" | ")}`,
  );
  assert.ok(
    !rLines.some((l) => l.includes("Implement stale-frame fix")),
    `Implement-WIP row gone from finishing view: ${rLines.join(" | ")}`,
  );
}

// ---------- lock predicate: null / undefined / empty all mean "no lock" ----------
{
  const NO_ID = ["mol", "current", "--json"];
  assert.deepEqual(nextRefreshArgs(null), NO_ID);
  assert.deepEqual(nextRefreshArgs(undefined), NO_ID);
  assert.deepEqual(nextRefreshArgs(""), NO_ID, "empty-string lock falls back to no-id inference");
  assert.deepEqual(nextRefreshArgs("bd-mol-abc"), ["mol", "current", "bd-mol-abc", "--json"]);
  assert.equal(hasLockedMolecule(null), false);
  assert.equal(hasLockedMolecule(undefined), false);
  assert.equal(hasLockedMolecule(""), false, "empty string is not a usable lock");
  assert.equal(hasLockedMolecule("bd-mol-abc"), true);
}

// ---------- Finding 1a: a fully-done by-id frame releases the lock ----------
{
  const prev = parseMoleculeCurrent(RAW); // parsed RAW 4-step molecule (bd-mol-g0z)
  const done = {
    ...prev,
    current_step: null,
    next_step: null,
    steps: prev.steps.map((s) => ({ ...s, step_status: "done", status: "closed" })),
    doneCount: prev.total,
  };
  assert.equal(done.doneCount, done.total, "precondition: fixture is fully done");
  const released = applyMoleculeFrame(prev, "bd-mol-g0z", done, true);
  assert.equal(released.activeMolecule, done, "finished frame still shown (once)");
  assert.equal(released.lockedMoleculeId, null, "fully-done by-id frame releases the lock");
  assert.deepEqual(
    nextRefreshArgs(released.lockedMoleculeId),
    ["mol", "current", "--json"],
    "next refresh after a finished molecule is no-id inference",
  );

  // a by-id frame still in progress keeps locking (existing pin behavior preserved)
  const still = applyMoleculeFrame(prev, "bd-mol-g0z", prev, true);
  assert.equal(still.lockedMoleculeId, "bd-mol-g0z", "in-progress by-id frame stays locked");
  // a fully-done frame is never re-locked, even by a no-id refresh
  const never = applyMoleculeFrame(done, null, done, false);
  assert.equal(never.lockedMoleculeId, null, "finished frame never re-locks");
}

// ---------- Finding 1a (behavior): finish A -> pour B, lock moves to B ----------
{
  const A_DONE_RAW = JSON.stringify([
    {
      molecule_id: "bd-mol-A",
      molecule_title: "superpowers-workflow",
      current_step: null,
      next_step: null,
      steps: [
        {
          issue: { id: "A.1", title: "Explore project context: A", issue_type: "task", status: "closed" },
          status: "done",
          is_current: false,
        },
        {
          issue: { id: "A.2", title: "Implement A", issue_type: "task", status: "closed" },
          status: "done",
          is_current: false,
        },
      ],
    },
  ]);
  const B_RAW = JSON.stringify([
    {
      molecule_id: "bd-mol-B",
      molecule_title: "superpowers-workflow",
      current_step: { id: "B.2", title: "Implement B", status: "in_progress", issue_type: "task" },
      next_step: null,
      steps: [
        {
          issue: { id: "B.1", title: "Explore project context: B", issue_type: "task", status: "closed" },
          status: "done",
          is_current: false,
        },
        {
          issue: { id: "B.2", title: "Implement B", issue_type: "task", status: "in_progress" },
          status: "current",
          is_current: true,
        },
      ],
    },
  ]);

  let locked = "bd-mol-A";
  let active = null;
  let bActive = false;
  const calls = [];
  const fakeExec = async (_c, args) => {
    calls.push(args);
    if (locked === "bd-mol-A") return { code: 0, stdout: A_DONE_RAW, stderr: "" };
    if (locked === "bd-mol-B") return { code: 0, stdout: B_RAW, stderr: "" };
    return bActive ? { code: 0, stdout: B_RAW, stderr: "" } : { code: 0, stdout: "[]", stderr: "" };
  };
  async function refresh() {
    const args = nextRefreshArgs(locked);
    const r = await fakeExec("bd", args);
    if (r.code !== 0) return;
    const parsed = parseMoleculeCurrent(r.stdout);
    const queriedById = hasLockedMolecule(locked);
    const nxt = applyMoleculeFrame(active, locked, parsed, queriedById);
    active = nxt.activeMolecule;
    locked = nxt.lockedMoleculeId;
  }

  await refresh(); // A finishes -> the lock must drop
  assert.equal(locked, null, "fully-done A releases the lock");
  assert.equal(active.molecule_id, "bd-mol-A", "finished frame still shown once");
  assert.deepEqual(calls.at(-1), ["mol", "current", "bd-mol-A", "--json"]);

  await refresh(); // idle -> no-id inference finds nothing, finished frame persists
  assert.equal(active.molecule_id, "bd-mol-A", "finished frame persists while nothing new is active");
  assert.deepEqual(calls.at(-1), ["mol", "current", "--json"], "after release, refresh is no-id");

  bActive = true;
  await refresh(); // B poured -> no-id inference re-locks B
  assert.equal(locked, "bd-mol-B", "fresh molecule B re-locks via no-id inference");
  assert.equal(active.molecule_id, "bd-mol-B", "widget switches to B");

  await refresh(); // B stays pinned by id while in progress
  assert.equal(locked, "bd-mol-B", "B stays locked while in progress");
  assert.deepEqual(calls.at(-1), ["mol", "current", "bd-mol-B", "--json"], "in-progress B is queried by id");
}

// ---------- Finding 1b: error-path not-found (in stdout OR stderr) clears lock + widget ----------
{
  const prev = parseMoleculeCurrent(RAW);
  // bd writes some errors ("not found", "no active molecule") to STDOUT, not stderr
  const clearedStdout = applyErrorFrame(prev, "bd-mol-g0z", {
    code: 1,
    stdout: "molecule bd-mol-g0z not found",
    stderr: "",
  });
  assert.deepEqual(clearedStdout, { activeMolecule: null, lockedMoleculeId: null }, "not-found in stdout clears both");

  const clearedNoActive = applyErrorFrame(prev, "bd-mol-g0z", {
    code: 1,
    stdout: "no active molecule",
    stderr: "",
  });
  assert.deepEqual(
    clearedNoActive,
    { activeMolecule: null, lockedMoleculeId: null },
    "no-active in stdout clears both",
  );

  const clearedStderr = applyErrorFrame(prev, "bd-mol-g0z", {
    code: 1,
    stdout: "",
    stderr: "no active molecule",
  });
  assert.deepEqual(clearedStderr, { activeMolecule: null, lockedMoleculeId: null }, "no-active in stderr clears both");

  // arbitrary/transient failure keeps the frame AND the lock
  const kept = applyErrorFrame(prev, "bd-mol-g0z", { code: 1, stdout: "connection refused", stderr: "" });
  assert.equal(kept.activeMolecule, prev, "transient failure keeps the frame");
  assert.equal(kept.lockedMoleculeId, "bd-mol-g0z", "transient failure keeps the lock");

  // null result (bd binary unreachable) keeps everything
  const keptNull = applyErrorFrame(prev, "bd-mol-g0z", null);
  assert.equal(keptNull.activeMolecule, prev);
  assert.equal(keptNull.lockedMoleculeId, "bd-mol-g0z");
}

// ---------- Finding 2: current-row staleness fallback (close-as-you-go gap) ----------
// No step is_current and no awaitingStep: the DEEPEST open/ready (non-done, non-gate) step
// in the view's render set leads, instead of nothing being marked active.
{
  // brainstorm: step s2 just closed, next step s3 is open+ready; s4..s8 still pending.
  const gapState = {
    ...bstate,
    current_step: null,
    next_step: null,
    steps: bstate.steps.map((s) => ({
      ...s,
      is_current: false,
      ...(s.id === "s2" ? { status: "closed", step_status: "done" } : {}),
    })),
  };
  const gapLines = moleculeWidgetLines(gapState, 200);
  const proposeIdx = gapLines.findIndex((l) => l.includes("Propose approaches"));
  assert.ok(proposeIdx !== -1, `propose row rendered: ${gapLines.join(" | ")}`);
  assert.ok(
    gapLines[proposeIdx].includes("\u25d0"),
    `fallback step carries the active marker: ${gapLines[proposeIdx]}`,
  );
  const gapActive = gapLines.filter((l) => l.includes("\u25d0")).length;
  assert.equal(gapActive, 1, `exactly one active row, got ${gapActive}: ${gapLines.join(" | ")}`);
}

{
  // deeper of two open/ready steps wins (s7 beats s5): deepest = last in render order.
  const deepState = {
    ...bstate,
    current_step: null,
    next_step: null,
    steps: bstate.steps.map((s) =>
      s.id === "s2"
        ? { ...s, status: "closed", step_status: "done", is_current: false }
        : { ...s, is_current: false, ...(s.id === "s5" || s.id === "s7" ? { step_status: "ready", status: "open" } : {}) },
    ),
  };
  const deepLines = moleculeWidgetLines(deepState, 200);
  const s5Idx = deepLines.findIndex((l) => l.includes("User approves design"));
  const s7Idx = deepLines.findIndex((l) => l.includes("Spec self-review"));
  assert.ok(s5Idx !== -1 && s7Idx !== -1, `deep rows rendered: ${deepLines.join(" | ")}`);
  assert.ok(deepLines[s7Idx].includes("\u25d0"), `deepest open/ready step leads: ${deepLines[s7Idx]}`);
  assert.ok(!deepLines[s5Idx].includes("\u25d0"), `shallower ready step must not lead: ${deepLines[s5Idx]}`);
}

// a step marked is_current still wins over any open/ready fallback (no regression).
{
  const lines = moleculeWidgetLines(bstate, 200); // s2 is_current:true, s3 open+ready
  const clarifyIdx = lines.findIndex((l) => l.includes("Ask clarifying questions"));
  const proposeIdx = lines.findIndex((l) => l.includes("Propose approaches"));
  assert.ok(clarifyIdx !== -1 && proposeIdx !== -1);
  assert.ok(lines[clarifyIdx].includes("\u25d0"), `is_current row keeps the marker: ${lines[clarifyIdx]}`);
  assert.ok(!lines[proposeIdx].includes("\u25d0"), `fallback must not steal from is_current: ${lines[proposeIdx]}`);
  const activeCount = lines.filter((l) => l.includes("\u25d0")).length;
  assert.equal(activeCount, 1, `only the is_current step is active: ${lines.join(" | ")}`);
}

// implementing: impl step open/ready + no kid in_progress => deepest open kid leads;
// the impl head itself must NOT be falsely pinned/active.
{
  const gapImplState = {
    ...implState,
    current_step: null,
    steps: implState.steps.map((s) => {
      if (s.id === "mol-9.i") return { ...s, status: "open", step_status: "ready", is_current: false };
      if (s.id === "mol-9.i.2") return { ...s, status: "closed", step_status: "done", is_current: false };
      return { ...s, is_current: false };
    }),
  };
  const gapImplLines = moleculeWidgetLines(gapImplState, 200);
  const giImpl = gapImplLines.findIndex((l) => l.includes("Implement Superpowers widget changes"));
  const giGate = gapImplLines.findIndex((l) => l.includes("Plan reviewed / ready to execute"));
  assert.ok(giImpl !== -1 && giGate !== -1, `impl rows rendered: ${gapImplLines.join(" | ")}`);
  assert.ok(
    !gapImplLines[giImpl].includes("\u25d0"),
    `impl head must not be falsely active (status open => ○): ${gapImplLines[giImpl]}`,
  );
  assert.ok(
    gapImplLines[giGate].includes("\u25d0"),
    `deepest open kid leads: ${gapImplLines[giGate]}`,
  );
}

console.log("beads-molecule-widget: all assertions passed");
