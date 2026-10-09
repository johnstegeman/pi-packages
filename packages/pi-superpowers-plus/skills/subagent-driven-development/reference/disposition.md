# Disposition: what happens to a finding that is not Critical/Important

> **Reaching beads tools:** every `beads_*` tool has `codemode`/`deferred` exposure, so
> none is in your tool list. Call them from a `codemode` script —
> `await tools.beads_update({ ... })` — and find the deferred ones with
> `await searchTools("beads")`. The call shapes below are that script's arguments.

Every finding this cycle produces that is **not** Critical or Important gets exactly one
disposition, decided **when it is recorded** — never left as "parked". Parked is not a resting
state; a roll-up nobody resolves is a silent discard.

## The three outcomes

**1. Fix now — the default.**
The controller fixes it in-session. Where a fix round is already running for that task, the fix
rides that round — the implementer is still warm and the marginal cost is ~0. Where the review is
otherwise clean, the finding goes on the `wrap-up` list and is fixed in that batch. No interrupt,
no bead.

**2. Drop — the controller's own authority, and it must be reported.**
Allowed only for **non-issues**: a wrong nitpick, a duplicate of another finding, something already
handled elsewhere, a point already refuted. Record a one-line reason and report every drop in the
final report. This is the only outcome nobody else has to approve.

**3. Defer — the human's ruling, and the bar is narrow.**
Allowed only when:

- **the session cannot do it** — it needs a restart or an upgrade, an external actor, or a runtime
  this session does not have; or
- **it needs a genuine design pass** — a brainstorm and a spec of its own.

A question is not a design pass. The test:

> If the only thing between you and the fix is a decision you could make in one sentence, it is not
> a defer — make the decision and fix it.

Collect defers and ask **once**, as a batched list, when you work the `wrap-up` step. The human's
yes is what creates the bead. Filing one on your own authority is the failure this policy exists to
prevent.

## Every channel feeds this rule

All five of these are findings for the purposes of this policy — none is exempt:

1. a task reviewer's `#### Minor (Nice to Have)` items;
2. a residual parked at the fix-loop cap — the breaker's "real, but nothing downstream builds on
   it";
3. an implementer's `DONE_WITH_CONCERNS` observations;
4. the reviewer's `Recommendations` section;
5. a plan-level observation, such as "the plan mandates a test that asserts nothing".

If a finding reaches the end of the cycle without one of the three dispositions, the cycle is not
finished.

## Reporting

The final report names every finding's outcome:

- **fixed** — one line each, with the commit;
- **dropped** — one line each, with the reason (this is the only record a drop leaves);
- **deferred** — one line each, with the bead id the human approved.

## When the pile is large

If the accumulated fix work is large relative to the task — more than a handful of items, fixes
reaching well outside the task's file set, or a fix that is itself a design decision — stop and ask
the human before working through it. This is the same batched question as the defer ruling, so in
practice it is one ask, not two.

## The step this policy belongs to

`wrap-up` (in the workflow molecule, between `implement` and `verify`) is where the list is worked
and cleared. It closes when every finding is fixed or dropped and no defer is unruled. `verify`
cannot start until it closes.
