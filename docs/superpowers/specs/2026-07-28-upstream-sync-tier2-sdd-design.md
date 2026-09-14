# Upstream Sync Tier 2 (2.3 + 2.4) — Design Spec

**Date:** 2026-07-28
**Branch:** feat/skills-upstream-sync (current — no new branch)
**Source:** `obra/superpowers` @ HEAD (v6.2.0, commit `3dcbd5c`)

## Goal

Adopt the original `obra/superpowers` reworked Subagent-Driven Development (SDD)
model wholesale — **Option A, minus model selection** — replacing the fork's
current two-stage SDD skill. This is a design adoption, not a clean port: the
original's dispatch shape, agent model, and workspace conventions are adapted to
this fork's `subagent` extension and `agents/` profiles.

## Decision

**Option A (full adoption) minus model selection**, with the fork's end-of-plan
checkpoint preserved (Section 2 choice: **ii** — continuous execution between
tasks, pause once before final review).

### Why A over B/C/D
The fork's current SDD model works (proven in Tier 1 & 2.1 this session) but has
real weaknesses the original solved: no compaction-survival (progress ledger),
context bloat (pasting task text into dispatches — experienced this session), and
an unbounded loose fix loop ("2 attempts then STOP" with no adjudication). A
captures the full reviewer-model sophistication the original invested in
(unified task reviewer, scoped re-review, 5-round fix loop with breaker, finding
adjudication/parking, pre-flight plan-conflict scan, Global Constraints lens,
context-hygiene scripts). B (selective) would leave the highest-value pieces —
the reviewer loop — on the table.

### Why minus model selection
Keep one model across all 5 fix rounds (no per-role / per-round capability
escalation). A separate "pick the best model for each phase" change can come
later. The fork's `subagent` extension does support a per-call `model` field, so
this is a deliberate scope deferral, not a capability gap. All `[MODEL]`
placeholders and "choose per Model Selection" language are stripped; the
5-round loop still dispatches a **fresh** implementer on rounds 4-5 (fresh eyes)
but on the **same** model.

### Why preserve the end-of-plan checkpoint (choice ii)
The original's continuous-execution discipline is about not wasting the user's
time with "should I continue?" *between* tasks (a real win). The fork's
end-of-plan checkpoint is a meaningful review gate before an irreversible-ish
step (final review + merge/PR). The two are compatible: continuous mid-plan,
pause once at the end. Mid-plan check-ins are removed (adopt A's discipline);
the end-of-plan "stop and ask before final review" pause is kept (fork's UX
choice).

## Scope — what changes

### Replace (wholesale)
1. `skills/subagent-driven-development/SKILL.md` (261 → ~503 lines, adapted)
2. `skills/subagent-driven-development/implementer-prompt.md` (83 → ~142 lines,
   the richer version: report-file contract, TDD evidence, "in over your head"
   escalation, code organization)

### Add
3. `skills/subagent-driven-development/task-reviewer-prompt.md` (~185 lines,
   unified spec + quality reviewer)
4. `skills/subagent-driven-development/re-review-prompt.md` (~106 lines, scoped
   fix-round re-reviewer)
5. `skills/subagent-driven-development/scripts/sdd-workspace` (bash, ~40 lines)
6. `skills/subagent-driven-development/scripts/task-brief` (bash, ~41 lines)
7. `skills/subagent-driven-development/scripts/review-package` (bash, ~46 lines)

### Delete
8. `skills/subagent-driven-development/spec-reviewer-prompt.md` (two-stage prompt)
9. `skills/subagent-driven-development/code-quality-reviewer-prompt.md` (two-stage prompt)
10. `agents/spec-reviewer.md` (role subsumed by unified task-reviewer)

### Rename / repurpose
11. `agents/spec-reviewer.md` → `agents/task-reviewer.md` (read-only: read, bash,
    find, grep, ls; model claude-sonnet-4-5; description "Review one task: spec
    compliance + code quality (read-only)"). The re-review dispatches the existing
    `code-reviewer` agent; the final review uses `code-reviewer` agent +
    `requesting-code-review/code-reviewer.md` template (as today).

## Adaptations (mechanical — applied to the ported content)

- **Dispatch shape:** convert every prompt's `Subagent (general-purpose):` +
  `model:` block to the fork's `subagent({ agent, task })` form. Strip all
  `[MODEL]` placeholders and "choose per Model Selection" language. Rounds 4-5
  still dispatch a fresh implementer (fresh eyes) but on the same model — no
  capability bump.
- **Agent references:** repurpose `agents/spec-reviewer.md` →
  `agents/task-reviewer.md` (same read-only tool set). Re-review dispatches the
  `code-reviewer` agent (already exists, read-only). Final review uses
  `code-reviewer` agent + `requesting-code-review/code-reviewer.md` template.
- **Skill references:** `superpowers:using-git-worktrees` →
  `/skill:using-git-worktrees`, etc. (fork convention).
- **Workspace location:** keep `.superpowers/sdd/<plan-basename>/` (git-ignored
  scratch — correct for short-lived artifacts; does not conflict with tracked
  `docs/superpowers/{specs,plans}`). The `sdd-workspace` script's self-ignoring
  `.gitignore` at `.superpowers/sdd/` keeps it out of `git status`/commits.
- **Claude-specific comment** in `sdd-workspace` ("Claude Code treats .git/ as a
  protected path and denies agent writes there") → rewrite for pi (drop the
  Claude rationale; the working-tree location is chosen because scratch
  artifacts should be git-ignored and outside `.git/`).
- **plan_tracker integration:** KEEP `plan_tracker` (TUI todo widget) alongside
  the ledger (durable file). Different purposes: ledger = compaction-survival +
  completion/adjudication records; plan_tracker = visible session todo list.
  The original has no plan_tracker, but the fork's is a visible UX asset. The
  adapted SKILL.md uses the ledger for completion/adjudication records AND
  plan_tracker for the per-task todo list. Setup creates a todo per task (via
  plan_tracker) and the ledger (via sdd-workspace + a first-line identity).
- **End-of-plan checkpoint (choice ii):** preserve the fork's "After All Tasks
  Complete — stop and ask: 'All tasks complete. Ready for final review and
  finishing?' Wait for confirmation before proceeding." Insert this BEFORE the
  original's "Final Review → delete workspace → finishing" sequence. Remove the
  original's mid-plan "do not pause to check in" framing only insofar as it
  conflicts (it doesn't — both agree on no mid-plan check-ins; the only change
  is the fork's end-of-plan pause is retained).
- **Final review path:** the original dispatches `../requesting-code-review/code-reviewer.md`.
  Keep this (the fork has that file). Use the `code-reviewer` agent as the
  dispatch target (read-only tools).

## Out of scope

- **Model selection** (per-role / per-round model tiering, "turn count beats
  token price", complexity signals). Deferred to a separate future change.
- **Visual companion** (Tier 3).
- **Compression sweep / other SKILL.md merges** (Tier 4) — except where this
  skill's content overlaps (the SDD SKILL.md is being replaced wholesale, so its
  Tier 4 delta is consumed here).
- **`using-superpowers` interaction:** none — that skill is meta/bootstrap; SDD
  is a workflow-execution skill. No wiring changes to `using-superpowers`.

## Risks

- **Behavior change for users of this package:** SDD dispatch flow changes
  (unified reviewer, scripts, ledger). Anyone relying on the two-stage
  spec-then-quality flow or the `spec-reviewer`/`code-quality-reviewer` prompt
  files will see a change. Mitigation: this is an unreleased fork (v0.4.1);
  the change is documented in the commit + this spec.
- **Script portability:** 3 new bash scripts use `#!/usr/bin/env bash` and
  standard `git`/`awk`/`find`. Tested on macOS (the fork's CI runs biome +
  vitest; no bash tests exist). Low risk.
- **Workspace dir creation:** `.superpowers/sdd/` is created on first SDD use.
  The `sdd-workspace` script writes a self-ignoring `.gitignore`. Verify it
  does not interfere with the existing `docs/superpowers/` tracked artifacts
  (it won't — different path, git-ignored).

## Verification

- `npm test` (vitest) — all existing tests pass. No tests reference SDD prompt
  files or `agents/spec-reviewer.md` (verified), so renames/deletions are safe.
  No new unit test is meaningful for skill prose / bash scripts.
- `npm run lint` (biome) — clean (markdown/bash not linted; no TS changes).
- `bash -n` syntax check on the 3 new scripts.
- Manual: scripts run end-to-end — `sdd-workspace <plan>` prints a path and
  creates the dir + `.gitignore`; `task-brief <plan> 1` extracts a task;
  `review-package <plan> <base> <head>` writes a diff file.
- Manual: `skills/subagent-driven-development/` contains SKILL.md +
  implementer-prompt.md + task-reviewer-prompt.md + re-review-prompt.md +
  scripts/{sdd-workspace,task-brief,review-package}; `spec-reviewer-prompt.md`
  and `code-quality-reviewer-prompt.md` are gone; `agents/task-reviewer.md`
  exists; `agents/spec-reviewer.md` is gone.
- Manual: no live references to the deleted files remain in `skills/`,
  `extensions/`, `agents/`, `tests/`, `README.md`.
- Manual grep: no `[MODEL]` / "Model Selection" / "superpowers:" references
  remain in the ported SDD content; `/skill:` syntax used throughout.

## Setup

Work on the current branch `feat/skills-upstream-sync`. No new branch. This is a
content/script port + a rename + deletions, not application logic — implement
via review (checks: file set correctness, adaptation completeness, script
syntax, no stale references, test/lint non-regression).
