# Creating Tasks as Beads

Once the task breakdown is authored and has passed the
lifecycle-duplicate check (Self-Review item 4), create the real task beads under the
`implement` step with **one `beads_create_list` call**. The `tasks` array order IS the plan
order — `beads_create_list` creates them sequentially (one `bd create --parent` awaited at a
time), so ids come out `parent.1, parent.2, … ` matching Task 1..N, which is what keeps
`bd list` and the molecule widget showing tasks in plan order.

```
# One call creates the gate bead + human gate, then every task bead in plan order,
# then wires the blocks-chain (each task → gate; Task N+1 → Task N).
RESULT = beads_create_list({
  parent: "<implement-step-id>",
  gate: {
    description: "## Global Constraints\n<the constraints block, authored here>",
    reason: "Plan approval",
  },
  tasks: [
    { title: "Task 1: <name>", description: "<the Task 1 breakdown above, verbatim>", acceptance: "<the Task 1 Acceptance Criteria above>" },
    { title: "Task 2: <name>", description: "<the Task 2 breakdown above, verbatim>", acceptance: "<the Task 2 Acceptance Criteria above>" },
    # ... one entry per task, IN PLAN ORDER (Task 1 → Task N)
  ],
})
GATE_ID        = RESULT.gate
HUMAN_GATE_ID  = RESULT.human-gate   # the human gate's id (present when a gate is requested)
TASK1_ID       = RESULT.t1
TASK2_ID       = RESULT.t2
# ...
```

**Tasks MUST be passed in plan order (Task 1 → Task N).** `beads_create_list` creates them
sequentially in that order so ids come out `parent.1..N`; a task listed out of order would get
the wrong id sequence and break plan-order display in `bd list` and the widget. Never issue
multiple `beads_create` / `beads_create_list` calls for the same plan — one call, declared in
order.

The gate bead's `description` is the **canonical Global Constraints artifact**: this is
where the constraints block is authored (exact values, exact formats, stated component
relationships). It stays readable after the gate is resolved/closed.

Each task bead's `description` is the task's **entire** breakdown — every step, every
code block, exactly as written. This bead is what
`executing-plans`/`subagent-driven-development` read during execution —
`beads_show({ id: "<task-id>" })`. It is the requirements at execution time; there is no plan.md.

**Recording the plan-approval verdict** (same revise/recheck pattern as brainstorming's
`design-approved`/`spec-approved` gates, Task 2 Step 3): when presenting the plan for
review, don't just wait silently on the gate. Bind the ids straight from the
`beads_create_list` result (it already returned them, so no lookup is needed):

```
GATE_ID        = RESULT.gate          # gate TASK bead id (e.g. parent.1)
HUMAN_GATE_ID  = RESULT.human-gate    # the human gate the task beads are blocked by
TASK1_ID       = RESULT.t1
TASK2_ID       = RESULT.t2
```
`RESULT.gate` ≡ `<plan-approval-gate-bead-id>`; `RESULT.human-gate` ≡ `<plan-approval-human-gate-id>`.

`RESULT.gate` (`parent.1`) is the gate **task bead** — never pass it to
`beads_gate_resolve`, and never `beads_gate_resolve` any task-bead id.
`RESULT.human-gate` is the id of the **human gate** `beads_create_list` creates internally,
returned only when a gate was requested — and that is the only id the verdict resolver
resolves.
  - Approved: `beads_update({ id: GATE_ID, setMetadata: "review.verdict=done" })`, then
  `beads_gate_resolve({ id: HUMAN_GATE_ID })`. This resolves the human gate and closes the
  gate task bead it was gating, so dependent task beads aren't later blocked by the
  still-open gate ("blocked by open issues [..]"). Step closes are order-enforced: a blocked
  `beads_close` means a prerequisite step/gate is still open — close/resolve it first; the
  error is the signal, not a mistake. If no gate was requested, `RESULT.human-gate` is
  absent — there is no human gate to resolve.
  - Changes requested: `beads_update({ id: GATE_ID, setMetadata: "review.verdict=iterate" })`, write
  a specific revision summary (`beads_comment({ id: GATE_ID, text: "<what needs to change>" })`), revise
  the affected task beads' descriptions in place (`beads_update({ id: "<task-id>", description:
  "<revised instructions>" })`) or add/remove/re-order task beads as needed, and re-present
  — do NOT resolve the human gate (nor `beads_gate_resolve` any task id). On resume, read the existing
  task beads under `implement` (`beads_mol_show({ id: "<implement-step-id>" })`) plus the latest
  revision summary before revising, rather than starting the breakdown over.

Close each step bead in the same turn its real output exists (never batch several closes at the end of a phase) — this is what keeps `bd mol current --json` honest so the widget shows the real current step.
**When you claim step N+1, close step N you just completed in the same turn** — every step handoff (e.g. `spec-review`→`spec-approved`, `spec-approved`→`implement`) follows this same general rule.

