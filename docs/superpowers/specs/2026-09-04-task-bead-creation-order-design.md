# Order Task Beads by Plan Order (Sequential Creation) — Design

Date: 2026-09-04
Tracking: epic `pi-packages-lk5q`, finding `pi-packages-lk5q.1`, molecule `pi-packages-mol-nlwq`
Target packages: `packages/pi-beads`, `packages/pi-superpowers-plus`

## Context

Implementation task beads created under a plan's `implement` step display **out of plan order** in
both `bd list` and the Superpowers molecule widget. Concrete example (plan `pi-packages-mol-27qs`,
implement step `pi-packages-mol-27qs`): task beads were batch-created and got ids
`pi-packages-mol-27qs.7 (Task 1), .4 (Task 2), .5 (Task 3), .3 (Task 4), .6 (Task 5), .2 (Task 6)`.
Neither `bd list --parent` (id ascending) nor the widget's implementing view (created_at → id)
shows them as Task 1..6.

### Root cause

Investigation (including empirical checks against the installed `bd` 1.2.2 and its source) shows:

- `bd` allocates child ids **in creation order**: `bd create --parent` mints `parent.N` via a
  per-parent counter (`GetNextChildIDTx`), so id order == commit order, and the widget's
  created_at-first sort agrees with `bd list`'s id-sort. The display surfaces are not the bug.
- The three creating agent fired multiple `beads_create` tool calls in a single message; those
  committed non-deterministically, so the beads were **literally created out of plan order**
  (Task 6 first, Task 1 last). Ids faithfully recorded that scrambled creation order.
- A native batch alternative, `bd create --graph`, creates atomically in one transaction but mints
  **random hash ids** for children (not hierarchical `parent.N`), so it would not fix ordering and
  would break the widget's kid filter (`s.id.startsWith(impl.id + '.')`).

Therefore the fix is to make creation deterministic: **create the task beads sequentially, in plan
order**, so id order == created_at order == Task N order, making both `bd list` and the widget
render Task 1..N with **zero display-side ordering changes**.

### Scope / exclusions

- **No** display-side ordering logic changes (no "Task N:" prefix sort in the widget or
  `beads_list`). Past / already-scrambled molecules are out of scope.
- **No** changes to the external `bd` CLI (out of repo).
- **In scope:** new `beads_create_list` tool in `packages/pi-beads`; `writing-plans` skill
  integration; widget **id placement** change (folded in per user request); tests.

## Approach

Single implement step under molecule `pi-packages-mol-nlwq`, covering:

1. **`beads_create_list` tool** (new) in `packages/pi-beads/src/index.ts`.
2. **`writing-plans` skill** updated to use it.
3. **Widget id placement** change in `packages/pi-superpowers-plus`.
4. **Tests + manual verification.**

Details in the sections below.

## Section 1 — New `beads_create_list` tool (pi-beads extension)

Add one tool to `packages/pi-beads/src/index.ts`:

```
beads_create_list({
  parent:  "<implement-step-id>",
  tasks:   [{ title, type?, description?, labels?, priority? }, ...],   // index order = plan order
  gate?:   { title?, description?, reason? },                           // optional first bead + human gate
})
```

Behavior, in order:

1. If `gate` provided: create the gate bead via `bd create --parent` (title defaulting to
   `Plan reviewed / ready to execute`, description = the Global Constraints block), then
   `beads_gate_create({ blocks: gateId, type: "human", reason })`.
2. Loop `tasks` **sequentially** — `await` each `bd` call before the next — creating each task
   under the same `parent`. Because `bd create --parent` mints `.N` via the per-parent child
   counter, tasks come out `parent.<k+1>, parent.<k+2>, …` in declared order.
3. Wire deps: each task depends on the gate (blocks); task `i+1` depends on task `i` (blocks) —
   matching today's `beads_dep` chains as authored in `writing-plans`.
4. Return a compact map: `gate: <id>`, `t1: <id>, t2: …` keyed by input index, plus the list of
   created ids in order.

Internally it reuses the existing `bd()` helper (already serializes via `pexec`) and
`resolveCreateTarget()` for repo routing; a sequential `await` in a `for` loop is all that is
needed — no new DB code. Returns `textResult` like the other tools.

### Error handling

- Any `bd create` failure mid-loop: stop immediately, return `textResult` with the error plus the
  ids created **so far** (`<N> of <M> tasks created before failure`), so a partial batch is visible
  and the caller can resume (re-run with the remaining tasks; already-created beads keep their ids,
  no reuse/recycling).
- Deps wiring failure after all creates succeed: same pattern — report which edges failed; created
  beads remain.
- Gate creation failure: abort before any tasks are created (nothing partial).
- The tool returns the `gate`/task id map even on the error path for whatever was created.

## Section 2 — `writing-plans` skill integration

Update `packages/pi-superpowers-plus/skills/writing-plans/SKILL.md`:

- Replace the current "Creating Tasks as Beads" pseudo-code (N separate `beads_create` +
  `beads_dep` + `beads_gate_create` call blocks) with **one** `beads_create_list` call containing:
  - `parent: <implement-step-id>`
  - `gate: { description: "<Global Constraints block>", reason: "Plan approval" }`
  - `tasks: [ { title: "Task 1: <name>", description: "<breakdown>" }, … ]` — declared in plan
    order, which is exactly the order task beads already carry in their titles.
- Add an explicit instruction: *"tasks MUST be passed in plan order (Task 1 → Task N);
  `beads_create_list` creates them sequentially in that order so ids come out `parent.1..N`."*
- Keep the wording that each task's `description` is the entire breakdown verbatim (the
  execution-time requirements artifact).
- Keep the existing "Recording the plan-approval verdict" (gate resolve / iterate) and
  Self-Review sections unchanged — they operate on `GATE_ID` / `TASK<n>_ID`, now bound from
  `beads_create_list`'s returned map rather than individual calls.

No other skill creates task beads under an implement step, so this is the only caller to update.

## Section 3 — Widget id placement

In `packages/pi-superpowers-plus/extensions/beads-molecule-widget.mjs` (the row templates live in
the `.mjs`; `.ts` imports `moleculeWidgetLines` — confirm during implementation whether `.ts` needs
changes):

- Move the id from the last fragment to **right after the status marker** in every row builder:
  - Implementing kids: `├── ◑ <id> <title>` (was `├── ◑ <title>  <id>`)
  - Implement head row: `◐ <id> <title>`
  - Brainstorming / finishing step rows: `◐ <id> <title>` (same treatment for consistency)
- Ordering of kids stays **exactly as-is** (created_at → id). **No sort change** — the sequential
  `beads_create_list` guarantees id order == plan order, so the widget renders Task 1..N correctly
  with zero ordering logic touched.
- Truncation behavior unchanged: `assemble()` truncates from the end, so a long title still gets
  cut, but now the id (the actionable token) survives narrow widths.

Update `beads-molecule-widget.test.mjs` assertions that expect the id at end-of-line to match the
new `marker id title` layout for the affected rows.

## Section 4 — Error handling & testing

**Error handling:** covered in Section 1 (partial-batch reporting, abort-on-gate-failure).

**Testing:**

- pi-beads has no automated test harness (per AGENTS.md: widget tests removed) — the tool's
  sequentiality is verified by construction (loop with `await`) plus a manual smoke test: create a
  throwaway plan molecule, call `beads_create_list` with N tasks, confirm ids are `parent.1..N` in
  declared order and `bd list`/widget show them in order. Add a lightweight test only if a test
  runner exists to hang it on (check during implementation).
- Widget: extend `beads-molecule-widget.test.mjs` — assert id placement (`marker id title`) for
  implementing kids, implement head, and brainstorming rows; assert kid **order** when
  ids/created_at are sequential (Task 1..N) and confirm the existing out-of-order fixture still
  renders in created_at order (no behavior regression).
- Manual QA (the molecule's `verify` step): run the writing-plans flow end-to-end on a scratch
  spec, confirm the widget shows Task 1..N and `bd list --parent` shows ids in plan order.

## Verification

- `cd packages/statusline && npm test` unaffected (no statusline change).
- `cd packages/pi-superpowers-plus && npm test` (widget tests) — all pass with updated id-placement
  assertions.
- Manual: `beads_create_list` smoke test on a scratch molecule — ids `parent.1..N` in declared
  order; `bd list --parent` and the widget both show Task 1..N.
