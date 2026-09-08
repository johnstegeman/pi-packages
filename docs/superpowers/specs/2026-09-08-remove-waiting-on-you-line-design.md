# Fix: "Waiting on you" line renders when the workflow is not waiting on the user

Date: 2026-09-08 · Status: approved design (review.verdict=done on pi-packages-mol-wvmy)

## Problem

The superpowers molecule widget (`packages/pi-superpowers-plus/extensions/beads-molecule-widget.mjs`)
always shows a bright `⏸ Waiting on you: …` line, even while the agent is actively working.
Users find this confusing: the workflow is not waiting on them.

### Root cause

The awaiting line fires whenever **any** gate in the molecule is "ready":

```js
const readyGate = gateCurrent
  ? state.current_step
  : state.steps.find((s) => s.issue_type === "gate" && s.step_status === "ready" && s.status === "open");
...
if (!gateCurrent && awaitingLine) rows.push(awaitingLine);
```

In `bd mol current --json`, every open human gate reports `step_status: "ready"` because
gates have no dependencies of their own (they only *block* their gated review step). A
poured `superpowers-workflow` molecule therefore always has 3–4 open ready gates
(`step:gate-design-approved`, `step:gate-spec-approved`, `step:gate-smoke-test-approved`).
Live repro on a freshly poured molecule: `current_step` is a claimed task (in_progress /
`step_status: "current"`) while three gates still report `ready`, so the line renders.

A second, latent flaw: the footer's gate→gated-step association (`awaitingStep`) scans
`state.steps` **backward in array order** from the gate. Live `bd mol current` emits steps in
creation order (gates first, interleaved), not chain order — the tests use chain-ordered
fixtures, so the footer-naming bug is invisible in tests but real on live data (it names the
raw `Gate: human <id>` or the wrong gate).

## Design

The intended semantics (design doc `2026-09-03-superpowers-workflow-internals-fixes-design.md`,
Part D2): the line fires **only when nothing else is current/in_progress** and a human gate
is the actual next action. This design implements that intent order-independently.

### 1. State: carry gate labels

`parseMoleculeCurrent` currently strips `issue.labels`. Add `labels: s.issue.labels ?? []`
to each parsed step. The payload already contains them (verified live:
`labels: ["step:gate-design-approved"]` on the gate). No other data-contract change.

### 2. Genuine-wait predicate (replaces `readyGate` + array-order scan)

```
isWaiting(state, chainOrder):
  if current_step is a gate        -> true   (bd says the gate IS current)
  if any step is current/in_progress -> false (agent mid-work)
  firstOpen = chainOrder.find(step not done/closed)
  return firstOpen is a human-review step AND its gate (by label) is open/ready
```

- **chainOrder** = the existing per-phase views (`BRAINSTORM_VIEW`, `FINISH_VIEW`,
  implement head + children sorted by `created_at`). These already encode plan order and
  are independent of bd's array order.
- **Gate→step mapping** (by label on the gate):
  - `step:gate-design-approved` → `User approves design`
  - `step:gate-spec-approved` → `User reviews written spec`
  - `step:gate-smoke-test-approved` → `Smoke test / manual QA sign-off`
- **False positives eliminated:**
  - Mid-work with open ready gates (live repro): a step is `current`/`in_progress` → no line.
  - Close→claim gap (agent closes one step, hasn't claimed the next): the first open step
    is a *task* (e.g. "Present design sections"), not a human-review step → no line.
  - Stale gate whose gated step is already done: first open step (if any) is not the gated
    review step, or none exists → no line.
  - Implementing phase: no human-review step in the chain → no line even with open gates.

### 3. Rendering + tests

- **gateCurrent** → line pinned at top, names the gate (title + id) — unchanged behavior.
- **Genuine wait** → line pushed after the view rows, names the human-review step
  (title + id), its row highlighted `◐` — same visual contract as today, now only when
  truthful. The `awaitingStep` value that drives the row highlight is the identified
  human-review step; the `leadCandidate` suppression guard (`awaitingStep || gateCurrent`)
  is unchanged.
- **Tests** (`extensions/beads-molecule-widget.test.mjs`):
  - Fixtures updated to realistic payloads: gate steps carry `labels`, tasks carry
    `current`/`in_progress` status; array order no longer has to be chain order.
  - New regression: *current task in_progress + open ready gates → no "Waiting on you" line*.
  - Updated: stale-gate-with-done-gated-step case now asserts **no** line (was: line);
    implementing-phase with open gates asserts no line; overflow/finish fixtures updated to
    the label-based shape.
  - `parseMoleculeCurrent` gains a label-copy assertion.
- **Verify:** widget test suite + `npx biome check` on touched files; live-render the
  poured molecule's current state (explore in_progress) and confirm the line is gone.

## Files touched

- `packages/pi-superpowers-plus/extensions/beads-molecule-widget.mjs`
- `packages/pi-superpowers-plus/extensions/beads-molecule-widget.test.mjs`

## Out of scope

- No changes to pi-beads, `bd` semantics, or the skills' close instructions.
- No changes to the row-highlight / active-step logic beyond assigning `awaitingStep`.
