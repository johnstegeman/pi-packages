# Design Verdict Recording

Edge cases for recording the verdict on the `design-approved` step. The Approved and
Changes-requested commands are in `SKILL.md`; this file covers the surrounding procedure.

## Changes requested

`beads_update({ id: "<design-approved-id>", setMetadata: "review.verdict=iterate" })`, then write a specific revision summary naming exactly
which sections/assumptions/questions need another pass:
`beads_comment({ id: "<design-approved-id>", text: "<what needs to change>" })`. Re-claim `design`
(`beads_update({ id: "<design-step-id>", claim: true })`) and loop back into Step 2's design-
presentation work — do NOT resolve the gate. Never treat "changes requested" as
an unstructured do-over: the revision summary is what the next pass reads before
touching the design again.

## On resume

On resume (new session, or picking this back up after a gap): read the design
content already written (`beads_show({ id: "<design-step-id>" })`) plus the latest verdict and
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
