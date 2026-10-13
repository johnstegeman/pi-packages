# Design Verdict Recording

> **Reaching beads tools:** every `beads_*` tool has `codemode`/`deferred` exposure, so
> none is in your tool list. Call them from a `codemode` script —
> `await tools.beads_update({ ... })` — and find the deferred ones with
> `await searchTools("beads")`. The call shapes below are that script's arguments.

Edge cases for recording the verdict on the `design-approved` step. The Approved and
Changes-requested commands are in `SKILL.md`; this file covers the surrounding procedure.

## Changes requested

`beads_update({ id: "<design-approved-id>", setMetadata: "review.verdict=iterate" })`, then write a specific revision summary naming exactly
which sections/assumptions/questions need another pass:
`beads_comment({ id: "<design-approved-id>", text: "<what needs to change>" })`. Re-claim `playback`
(`beads_update({ id: "<playback-step-id>", claim: true })`) and loop back into the
playback work — do NOT resolve the gate. Never treat "changes requested" as
an unstructured do-over: the revision summary is what the next pass reads before
touching the design again.

## On resume

On resume (new session, or picking this back up after a gap): read the design
content already agreed (`beads_show({ id: "<playback-step-id>" })`) plus the latest verdict and
revision summary (`beads_show({ id: "<design-approved-id>" })`) before continuing — revise the
existing design in place; never discard earlier answered questions, approach
trade-offs, or already-approved sections.

## Only `review.verdict=done` permits resolving the gate

If brainstorming stops early for any reason (blocked, redirected, session stopped) before a verdict is
recorded, leave the current step's status as-is (open or in_progress) for the next
session to resume — do not close steps whose real output doesn't exist yet.

## Gate-resolve and close ordering

Closing steps is order-enforced: `beads_close({ ids: "<step>" })` fails ("blocked by open issues
[..]") until the prerequisite step is closed and its gate resolved. `beads_gate_resolve`
unblocks the dependent step and closes the gate bead itself in one call — e.g. after
`writing-plans` reveals the plan, a single `beads_gate_resolve` on the plan-approval gate
handles both resolve and close, so no separate close is needed.

On the **small-change** path the same call closes the skipped `spec-approved` step: close
`write-spec` and `spec-review` as skipped (`"small change: description agreed in chat"`), then
`beads_gate_resolve` on `step:gate-spec-approved` resolves the gate and closes the gated
`spec-approved` step in one call, which is what frees `implement`. Resolving the gate is
required — `spec-approved` cannot be closed directly while its gate is open (the
order-enforcement above), so a small change never closes that step on its own.

## `spec-review`'s close

`spec-review` is the builder check. Its close reason asserts that the check *returned* and
that its questions were sorted into the three piles — not that a self-review happened. The
mechanical four-point self-review belongs to writing the document and is recorded in
`write-spec`'s close reason instead (see [process-guidance.md](process-guidance.md)).

## The fast route

When the human takes the opt-out at your first message, the molecule stays and `explore` is already
closed — it runs before that message. Close the rest of the pre-implement steps in order; close
order is enforced, so each becomes closable only once the previous step closes or its gate
resolves.

1. `beads_close({ ids: "<conversation-id>", reason: "fast route: human opted out at the first message" })`
2. `beads_close({ ids: "<playback-id>", reason: "fast route: human opted out at the first message" })`
3. `beads_update({ id: "<design-approved-id>", setMetadata: "review.verdict=done" })` — the opt-out
   *is* the approval — then `beads_gate_resolve({ id: "<step:gate-design-approved-gate-id>" })`,
   which resolves the gate and closes the gated `design-approved` step in one call.
4. `beads_close({ ids: "<write-spec-id>", reason: "fast route: human opted out at the first message" })`
5. `beads_close({ ids: "<spec-review-id>", reason: "fast route: human opted out at the first message" })`
6. `beads_gate_resolve({ id: "<step:gate-spec-approved-gate-id>" })` — resolves the gate and closes
   `spec-approved`, freeing `implement`.

This is the one place the batch-close rule bends: the closes in steps 1–2 and 4–5 may happen in a
single turn, because the human has just declined those steps and the close reason records it.