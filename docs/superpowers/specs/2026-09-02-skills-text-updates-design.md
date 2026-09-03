# Design: Skills-text updates — close-order/gate notes + plan-file↔beads reconciliation (R4, R5, R8)

Date: 2026-09-02 · Source: learnings `pi-packages-pin` (R4/R5/R8) + backlog `pi-packages-i85` · Molecule: `pi-packages-mol-lol`.

## Goal

Fix the Superpowers skill text where it teaches behavior that no longer matches how beads actually
work: (R4) document that step closes are order-enforced and that a resolved plan-approval gate must
still be explicitly closed; (R5) remove stale "plan.md / docs/superpowers/plans" references; (R8)
reconcile writing-plans ("no plan file is written") with subagent-driven-development's tooling by
making SDD read task bodies **directly from task beads** (no plan file, and now no brief files
either — implementers read their own task bead).

## Context

- Observed during the sync-hardening run, recorded in the learnings bead:
  - Closing `write-spec` was blocked by the still-open "User approves design" step; closing task
    beads was blocked by the still-open plan-approval gate bead — `bd close` is ORDER-ENFORCED.
  - `bd gate resolve` on the plan-approval human gate unblocks dependents but does NOT close the
    gate task bead itself; the skill text omitted the explicit `bd close <gate-bead>`.
  - `writing-plans` emits task beads, not a plan.md; controller had to hand-synthesize
    `.superpowers/sdd/<plan>.md` for SDD's scripts (`sdd-workspace`/`task-brief`/`review-package` all
    required a `PLAN_FILE`) — two sources of truth.
- `bd show <task-id> --json` returns the full raw task body in its `description` field — that is all
  SDD needs to give an implementer its task text.
- Stale `plan.md` references: `writing-plans/SKILL.md:172` ("the plan.md document itself … (see Task
  4/5)"), `executing-plans/SKILL.md:44`, `requesting-code-review/SKILL.md:65` (example cites
  `docs/superpowers/plans/deployment-plan.md`).

## Decision

### 1. Scripts (`skills/subagent-driven-development/scripts/`)

- **Delete `task-brief`** — briefs no longer exist; the implementer reads its own task bead.
- **Rewrite `sdd-workspace`** → `sdd-workspace <slug>`: no file-existence check; `mkdir -p
  .superpowers/sdd/<slug>/`; (re)write the self-ignoring `.gitignore`; print the dir. The slug is the
  implement step id (e.g. `pi-packages-mol-ogh`).
- **Rewrite `review-package`** → `review-package <slug> BASE HEAD [OUTFILE]`: validate BASE/HEAD
  (`git rev-parse --verify`), derive the workspace via `sdd-workspace <slug>`, write
  `review-<base7>..<head7>.diff` with unchanged content (commits / stat / `git diff -U10`).

### 2. Skills + templates

- `subagent-driven-development/SKILL.md`: every `PLAN_FILE` reference becomes the anchor
  `<implement-step-id>` (workspace, ledger identity `# SDD ledger — plan: <implement-step-id>`,
  `review-package` ×4); the task-brief step is removed and the dispatch narrative says the
  implementer reads `bd show <task-id>` as its single source of requirements; the "never let a
  subagent read the whole plan file" red flag becomes "never hand a subagent more than its own task
  bead".
- Prompt templates `implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md`:
  `[BRIEF_FILE]` becomes a `[TASK_ID]` contract ("Read your task bead first: `bd show <TASK_ID>`
  (or `--json`)."); report files name after the task id (`<workspace>/<task-id>-report.md`).
- `writing-plans/SKILL.md`: (R8) Execution Handoff gains "hand execution the implement step id —
  SDD reads task beads directly; no plan file is written or required"; (R5) line 172 becomes "the
  task-bead description is the requirements at execution time; there is no plan.md"; (R4) the verdict
  block gains "after `bd gate resolve`, explicitly `bd close $GATE_ID` — resolving the human gate
  unblocks dependents but does not close the gate task bead" and an order-enforced-close note
  ("blocked by open issues [..]" = close/resolve the prerequisite first; it's a signal, not an
  error).
- `brainstorming/SKILL.md` (R4): same compact order-enforced-close note in "After the Design"
  (resolve gates to unblock dependents; a blocked `bd close` means an open prerequisite).
- `executing-plans/SKILL.md:44` (R5): "a plan.md task body used to hold" → "the bite-sized steps
  that used to live in a plan file — now they live in the task bead's description".
- `requesting-code-review/SKILL.md:65` (R5): example `PLAN_OR_REQUIREMENTS` → the bead model (e.g.
  "task bead `pi-packages-mol-ogh.2`, read via `bd show`").

## Files

- Delete: `skills/subagent-driven-development/scripts/task-brief`
- Modify: `skills/subagent-driven-development/scripts/sdd-workspace`, `scripts/review-package`
- Modify: `skills/subagent-driven-development/SKILL.md`, `implementer-prompt.md`,
  `task-reviewer-prompt.md`, `re-review-prompt.md`
- Modify: `skills/writing-plans/SKILL.md`, `skills/brainstorming/SKILL.md`,
  `skills/executing-plans/SKILL.md`, `skills/requesting-code-review/SKILL.md`

## Verification

- `sdd-workspace <slug>` works with no plan file in existence (creates dir + `.gitignore`, prints
  path).
- `review-package <slug> BASE HEAD` produces a correctly-named, correctly-shaped diff file for the
  same range as before.
- `task-brief` is gone; no `.superpowers/sdd/<plan>.md` synthesis remains in any skill text.
- Greps, all clean: no `PLAN_FILE` / "plan file" / `task-brief` / `[BRIEF_FILE]` in the SDD skill +
  templates; no stale `plan.md` / `docs/superpowers/plans` across `skills/**` (the sole deliberate
  exception: writing-plans' boundary line "Write to docs/superpowers/plans/: no"); the R4 language
  ("close the plan-approval gate bead", "order-enforced close") present in brainstorming +
  writing-plans.
- Focused smoke: `sdd-workspace` + `review-package` on the current repo. End-to-end confidence comes
  from the next real SDD run.

## Scope

- **In:** the 10 file/script changes above.
- **Out:** any `bd` CLI changes (`pi-packages-826`); the widget/formula features (already shipped
  separately); other packages.

## Risks

- The SDD scripts and skill are a live toolchain; the change removes the brief-file indirection the
  per-task prompts were built on — the first real SDD run after this change is the true test (the
  mechanical smoke covers the scripts).
- Grep-based verification is exact but not exhaustive of prose drift; a light copy-edit read of the
  modified skill sections is included in review.
