# Wrap up in-session: a disposition policy for parked findings, and a required `wrap-up` step

Molecule: `pi-packages-mol-2omf0` · Date: 2026-10-09 · Status: approved design
(`review.verdict=done` on `pi-packages-mol-j7sfx`)

Backlog bead (follow-up, deliberately **not** part of this cycle): `pi-packages-6t1xv`

All line numbers are as of `fb935ef`.

## Problem

Every superpowers cycle ends with a fresh crop of "deferred minors" beads, and the pile never
drains — running a cycle on the pile produces more of them. The mechanism is structural, not a
model quirk:

1. Reviewers report a `#### Minor (Nice to Have)` section
   (`agent-templates/task-reviewer.md:54`, `agent-templates/code-reviewer.md:81`).
2. The fix loop records them in the SDD ledger as `Task <N>: minor (deferred): <one-liner>` and
   explicitly keeps them out of the loop — "Minor findings never enter the loop"
   (`reference/fix-loop.md:8-13`).
3. `reference/final-review.md:30-37` tells the controller to triage that list — *"Triage the minors
   in the controller (you hold the ledger and the rulings) … A roll-up nobody reads is a silent
   discard; you are the reader"* — but never says what triage *does*. It is the reader, not the
   resolver.
4. The only durable place left is a bead: the workspace holding the ledger is deleted the moment
   the final review is clean (`SKILL.md:324`).

So a finding that is real but small has exactly one exit. The underlying intent is sound — *"nothing
is silently dropped: every deferred item gets a **durable bead** or an explicit won't-fix"*
(`2026-09-14-reconcile-deferred-promises-upstream-design.md:16`) — but it is stated as a
**conservation** rule when the missing option is **completion**. "Fix it now" is not on the menu,
so the pile is the only legal move.

**Measured cost of the current shape.** The stall-watchdog branch parked 38 non-blocking findings,
"grouped into `pi-packages-5k3fy` so the workspace could be deleted without losing them"
(`2026-10-08-subagent-workflow-stall-watchdog-deferred-minors-remediation-design.md:16`). That bead
then became a full brainstorm → spec → plan → implement cycle of its own; reconnaissance found 33
of the 38 still true and worth fixing, 2 deliberate, 3 parked. One branch's minors cost a second
branch's entire lifecycle.

Prior art already moved the *decision* into the controller (`c5bd504`, `afb01f9` dropped the
"deferred minors" trigger from the final-review finders after six minors were re-reported 21 times
across 33 agents). That fixed *who* reads the list. This design fixes *what happens* to it.

## Goal

A cycle wraps its own work up. When it ends, every finding it produced is either **fixed**,
**dropped with a reason**, or — only when the session genuinely cannot do it — **filed as a bead
with the human's explicit approval**. Reaching `verify` with an undispositioned finding is
impossible, not discouraged.

## Decisions (from brainstorming)

1. **Fix now is the default.** A finding is dispositioned at the moment it is parked. "Parked"
   stops being a resting state.
2. **Three outcomes**, per finding: fix now, drop, or defer.
3. **Authority is split.** Fix = the controller, no interrupt. Drop = the controller, allowed only
   for non-issues, reported with a reason. Defer = the human's ruling, batched, never per-item.
4. **The defer bar is narrow:** the session cannot do it (needs a restart/upgrade, an external
   actor, an unavailable runtime) **or** it needs a genuine design pass (a brainstorm + spec). A
   mere question is not a design pass.
5. **All five channels are swept.** Task-review minors, final-review residuals parked at the
   fix-loop cap, `DONE_WITH_CONCERNS` observations, the reviewer's `Recommendations`, and
   plan-level observations. Nothing is exempt, so there is no side channel that can leak back into
   beads under a different name.
6. **Enforcement is a molecule step, not prose.** `wrap-up`, between `implement` and `verify`,
   cleared either by the controller (nothing deferred) or by the human (approving the defer list).
7. **No separate gate bead** on `wrap-up`. Most cycles have nothing to rule on; a gate would
   manufacture an interrupt every cycle to make a rare state visible. The dependency edge already
   blocks `verify`.
8. **Fixes ride the round** when one is already running for that task (marginal cost ≈ 0,
   implementer still warm); otherwise they batch into `wrap-up`. The 5-round cap keeps its exact
   current meaning.
9. **Molecule-driven runs only.** A standalone `/requesting-code-review` keeps "note Minor issues
   for later".
10. **The record is report-only.** Fixed and dropped items leave no durable trace beyond the final
    report; deferrals leave a bead. This is deliberate — the goal is a drained list, not a richer
    ledger.
11. **No cap on fix work**, but a "large relative to the task" pause that asks the human — the
    cue being more than a handful of items, fixes reaching well outside the task's file set, or a
    fix that is itself a design decision. In practice this and the defer ruling are the same
    batched question.
12. **The existing pile is out of scope** of this cycle, captured in one P1 bead
    (`pi-packages-6t1xv`) as a single kickoff point.

## Design

### 1. The policy — `skills/subagent-driven-development/reference/disposition.md` (new)

The canonical rule, linked from the SDD `SKILL.md` with a `Read now` gate at the point where
findings first appear. Content:

**Every finding that is not Critical/Important gets exactly one disposition, decided when it is
parked:**

1. **Fix now — the default.** The controller fixes it in-session. Where a fix round is already
   running for that task, it rides that round; where the review is otherwise clean, it goes to the
   `wrap-up` batch. No interrupt, no bead.
2. **Drop — controller's own authority, must be reported.** Only for **non-issues**: a wrong
   nitpick, a duplicate of another finding, something already handled elsewhere, a point already
   refuted. One-line reason, and every drop appears in the final report.
3. **Defer — needs the human's ruling, and the bar is narrow.** Only when the session cannot do it
   or it needs a genuine design pass. Defers are collected and asked **once**, batched, at
   `wrap-up`. The human's yes is what creates the bead.

The operating test, stated verbatim in the reference:

> If the only thing between you and the fix is a decision you could make in one sentence, it is not
> a defer — make the decision and fix it.

Plus: the five channels; the report requirement (fixes, drops with reasons, defers); and the
"large relative to the task" pause.

### 2. The molecule step — `packages/pi-superpowers-plus/formulas/superpowers-workflow.formula.toml`

```toml
[[steps]]
id = "wrap-up"
title = "Wrap up: disposition all parked findings"
type = "task"
needs = ["implement"]
```

and `verify` is rewired from `needs = ["implement"]` to `needs = ["wrap-up"]`.

**Why there.** The extra fixes must land *before* `verify` and the smoke test, or the human signs
off on a tree that then changes. `smoke-test-approved` and `finish` keep their current positions.

**Clearance.** One step, two paths: the controller worked it to completion (everything fixed or
dropped, nothing deferred), **or** the human ruled on the defer list and the approved items were
filed. Then the controller closes `wrap-up`, which unblocks `verify`.

**No gate bead.** See decision 7.

**In-flight molecules** poured before this change have no `wrap-up` step, so the skills resolve it
by label (`beads_list({ label: "step:wrap-up", mol: "<root-id>" })`) and must state: if the molecule
has no `step:wrap-up`, skip it. Without that, an in-flight run wedges on a step that does not exist.
The formula applies at pour time only, so there is no migration.

**Seeding.** `formulas/superpowers-workflow.formula.toml` is the source; the existing `formula-seed`
extension links it into `~/.beads/formulas/`, so a fresh pour picks it up with no manual step.

### 3. Where the fix work happens

The decision is always made at park time; the *fix* rides the round already running for that task
when one exists, and otherwise batches into `wrap-up`.

Rejected alternatives:

- **Always inline.** A minors-only review would trigger its own round per task, changing the task
  loop's trigger condition and the meaning of its 5-round cap — the loop already tuned by
  `2026-07-28-upstream-sync-tier2-sdd`. Cleanup would compete with finding loops for the budget.
- **Always batch.** Simple and predictable, but discards the free warm fix when a round is already
  open.

Honest caveat: `pi-packages-6f0p` records that implementer resume is broken in practice past the
~10-minute eviction window, so "warm" is best-effort. It costs nothing when it fails — the fix
simply lands in the batch.

### 4. Skill text changes, file by file

| File | Change |
|---|---|
| `skills/subagent-driven-development/reference/disposition.md` | **New** — the policy above |
| `skills/subagent-driven-development/SKILL.md` | Process graph gains `wrap-up` between final review and verify; the step-id resolution text gains `step:wrap-up`; **"Delete this plan's workspace" moves from "final review clean" to after `wrap-up` closes** — that ordering is the fix, because the ledger has to outlive the step that reads it; `Read now` gate for `disposition.md`; states the skip-if-absent rule for molecules poured before this change |
| `skills/subagent-driven-development/reference/fix-loop.md` | The "Record Minor findings … triage that list yourself" passage becomes "disposition each per `reference/disposition.md` when it is recorded"; only genuine defers stay on the wrap-up list |
| `skills/subagent-driven-development/reference/final-review.md` | Rule 1's "Triage the minors in the controller" points at the policy. The "never in `description`" rule is untouched |
| `skills/executing-plans/SKILL.md` | Step 5: close `implement` → work `wrap-up` → claim `verify`. States explicitly that this path usually has nothing to disposition (it has no task reviewer), plus the same skip-if-absent rule |
| `skills/verification-before-completion/SKILL.md` | **No change needed** — `verify` is claimed only after `wrap-up` closes, enforced by the molecule's dependency edge; its own text (`:140`) covers `verify` → `smoke-test-approved` and stays as is |
| `skills/requesting-code-review/SKILL.md` | "Note Minor issues for later" (`:57`) becomes conditional: inside a molecule-driven cycle, disposition them in-session; standalone runs keep the current behaviour |
| `agent-templates/task-reviewer.md`, `agent-templates/code-reviewer.md` | One line in the output contract: report each minor with `file:line` and a concrete fix so the controller can act on it. The existing "never write beads" guardrail is **unchanged and byte-identical** (`skills-contract.test.mjs` pins it) |
| `extensions/beads-molecule-widget.mjs` | `phaseFor` (see §5) |
| `CHANGELOG.md`, `package.json` | Minor version bump (0.9.0 → 0.10.0) |

**Deliberately unchanged:** the `Critical`/`Important`/`Minor` severity taxonomy (minors are still
*reported*; they are just no longer *parked*), the fix loop's Critical/Important machinery, the
finder prompts (finders never see the defer list — the 33-agent lesson), and everything outside
molecule-driven runs.

### 5. Widget phase labelling — `extensions/beads-molecule-widget.mjs:268-275`

`phaseFor` currently returns `finishing` the moment the `Implement` step is done, so during
`wrap-up` the widget would claim the branch is being finished while fixes are still landing — the
same class of lie this cycle is about. The change: stay `implementing` until `wrap-up` is done, and
fall back to the current rule when the molecule has no `wrap-up` step (old molecules).

### 6. Tests

- `test/skills-contract.test.mjs` (existing) already enforces the things this change can break:
  every `reference/*.md` linked from its `SKILL.md`, the `Read now` gate line format, relative links
  resolving, and the byte-identical beads guardrail in the agent templates. New reference file and
  new prose must satisfy them.
- `test/formula-seed.test.mjs` is unaffected — it seeds a *synthetic* formula, so it does not pin
  the real step list.
- **New: `test/workflow-formula.test.mjs`.** Nothing currently pins the real formula's structure, so
  a future edit could delete the step with every test green. Parse
  `formulas/superpowers-workflow.formula.toml` and assert: `wrap-up` exists, `verify` needs
  `wrap-up`, `implement` needs `spec-approved`, and every step id is unique.
- Widget: extend the existing `phaseFor` tests with the `wrap-up`-in-progress and
  no-`wrap-up`-step (old molecule) cases.

## Acceptance criteria

1. A molecule-driven cycle cannot reach `verify` while any swept finding is undispositioned.
2. No bead is created for a minor unless the human ruled it a defer.
3. Every fix, drop, and defer appears in the final report; drops carry their reason.
4. A cycle with no minors reaches `wrap-up` and clears it without a human interrupt.

## Risks

- **Prose-only enforcement of "ask the human".** The step's *dependency edge* is mechanical; the
  requirement to ask before filing is not. A controller that files a deferral without asking is
  undetectable by the molecule — the same exposure every other skill rule has. Mitigation: the
  rule is stated once in the reference and repeated in the `wrap-up` step text, and the acceptance
  criteria make the violation visible in the report.
- **Reviewers producing minors in bulk.** The policy adds work to the controller, not to finders,
  and the "large relative to the task" pause is the pressure valve. If a cycle starts drowning in
  minor fixes, that is a review-rubric problem surfaced, not created.
- **The batch at `wrap-up` can be a cold fix.** Accepted: `ride the round` gets the warm case for
  free, and the cold case is what happens today anyway (just filed instead of fixed).
- **`phaseFor` change touches the widget.** Bounded by tests; the fallback keeps old molecules
  behaving exactly as now.

## Out of scope

- **The existing pile.** `pi-packages-6t1xv` (P1) lists the accumulated follow-ups as one kickoff
  point; triaging it is a separate cycle.
- Any change to the severity taxonomy, the finder prompts, or the fix loop's Critical/Important
  machinery.
- Non-molecule runs (`/requesting-code-review` standalone), which keep "note Minor issues for
  later".
- Adding a per-cycle or per-task cap on minor-fix work (decision 11: report-and-ask instead).
- A durable disposition record. Fixed and dropped items leave no trace beyond the report
  (decision 10).

## Files

```
packages/pi-superpowers-plus/
  formulas/superpowers-workflow.formula.toml          (step + verify rewire)
  skills/subagent-driven-development/reference/disposition.md   (new)
  skills/subagent-driven-development/SKILL.md
  skills/subagent-driven-development/reference/fix-loop.md
  skills/subagent-driven-development/reference/final-review.md
  skills/executing-plans/SKILL.md
  skills/verification-before-completion/SKILL.md
  skills/requesting-code-review/SKILL.md
  agent-templates/task-reviewer.md
  agent-templates/code-reviewer.md
  extensions/beads-molecule-widget.mjs
  test/workflow-formula.test.mjs                      (new)
  test/beads-molecule-widget.test.mjs
  CHANGELOG.md
  package.json
```
