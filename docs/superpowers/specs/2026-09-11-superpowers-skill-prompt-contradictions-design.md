# Superpowers skill & prompt contradictions — design

**Date:** 2026-09-11
**Issue:** `pi-packages-3iej.2` (child of the Superpowers-stack remediation epic `pi-packages-3iej`)
**Provenance:** read-only audit findings H7, H8, M12, M13, M14, M15, plus two cleanup items
(stale `todo`/`TaskCreate` wording after the beads migration; `set_phase` vocabulary drift).
**Scope:** `packages/pi-superpowers-plus` only.

## Problem

Six cross-file contradictions sit in the shipped Superpowers skills, prompts, and agent
templates. Each is verified in the current tree:

| # | Where | Contradiction |
|---|-------|---------------|
| H7 | `skills/subagent-driven-development/task-reviewer-prompt.md:20` | Emits `set_phase({ phase: "brainstorming" })` for a development-phase review; every sibling SDD prompt emits `"development"`. |
| H8 | `skills/executing-plans/SKILL.md:34-36` | One placeholder `<plan-approved-gate-id>` is used for both `beads_show` and `beads_gate_resolve`, but those are two different beads: the gate **task** bead (`RESULT.gate`) and the human gate (`RESULT.human-gate`, the only id the resolver resolves). `writing-plans` already distinguishes them. |
| M12 | `skills/requesting-code-review/SKILL.md:33` | Uses `git rev-parse HEAD~1` as the review base; `subagent-driven-development/SKILL.md:265,300` explicitly forbids `HEAD~1` because it silently truncates multi-commit tasks. |
| M13 | `skills/subagent-driven-development/SKILL.md:458-461` | Terminal handoff jumps from "final review clean" straight to "delete workspace + `/finish`", skipping the molecule's `verify` / `smoke-test` / `finish` steps, so the molecule stalls. `executing-plans` Step 5 does it correctly. |
| M14 | `agent-templates/code-reviewer.md` vs `skills/requesting-code-review/code-reviewer.md` | Two divergent code-reviewer mandates ("You are a code quality reviewer" vs "You are a Senior Code Reviewer"). Additionally `requesting-code-review` claims per-task review while SDD's per-task gate is `task-reviewer`. |
| M15 | `skills/dispatching-parallel-agents/SKILL.md:82` | Tells the reader to "add `run_in_background: true`"; background is now the default, so this is obsolete. |
| — | `skills/subagent-driven-development/SKILL.md:201` | Stale pre-beads wording: "no `TaskCreate`-equivalent step is needed here". |
| — | skills across the set | `set_phase` vocabulary drift: `"writing plan"`, `"final review"`, `"finishing"` vs the documented `brainstorming` / `development`. |

## Design decisions

### D1 — Two-layer agent contract (M14)

Agent behaviour is split by *layer*, and only one layer owns the role identity:

- **`agent-templates/*.md` = the canonical agent identity.** This is the system prompt pi
  actually loads for a `subagent_type`. It owns the role statement, `tools` /
  `allowed_subagents` frontmatter, the Bounded Lookups policy, and the output contract.
- **`skills/**/*-prompt.md` = task-context templates.** They supply the `Agent({...})` call's
  prompt — placeholders (`[DESCRIPTION]`, `[BASE_SHA]`, `[DIFF_FILE]`, …), diff-loading
  instructions, and the review checklist — but must **not** restate a conflicting role
  identity.

Concretely: the substantive mandate currently in `skills/requesting-code-review/code-reviewer.md`
(plan alignment / code quality / architecture / testing / production readiness, calibration,
and the Strengths / Issues / Assessment output contract) moves into
`agent-templates/code-reviewer.md`. The skill file is reduced to a dispatch-context template
pointing at that identity.

**Division of labour:** `requesting-code-review` = whole-branch / feature / before-merge review
(`code-reviewer`); per-task review = SDD's `task-reviewer` gate. The `task-reviewer` pair
(`agent-templates/task-reviewer.md` + `subagent-driven-development/task-reviewer-prompt.md`)
already agrees on output format, so it only receives a symmetric pointer — no rewrite.

### D2 — One canonical `set_phase` vocabulary

Allowed values become exactly `brainstorming`, `development`, and `""` (the latter clears):

- `brainstorming` = brainstorming **and planning** → `writing-plans` emits `brainstorming`.
- `development` = implementation, final review, finishing → SDD final-review and
  `finishing-a-development-branch` emit `development`; finishing's end-of-skill call emits
  `""` to clear.
- `extensions/set-phase.ts`'s tool description is updated to state this mapping explicitly
  (arbitrary strings stay accepted only for future extension).

The widget is unaffected: it derives its own phase (`brainstorming` / `implementing` /
`finishing`) from molecule state, not from these events. langfuse and bifrost merely retain the
tag string, so the change only makes observability tags consistent.

### D3 — Documented tail flow (M13)

The canonical molecule tail — per the beads-persistence spec and
`skills/verification-before-completion/SKILL.md:135` — is:

```
implement done → close implement step → claim verify
  → /skill:verification-before-completion   (closes verify; surfaces the human smoke-test gate)
  → work finish → /skill:finishing-a-development-branch
```

SDD's terminal handoff is rewritten to mirror `executing-plans` Step 5, so the molecule does
not stall after the final review.

### D4 — Structural-guard strategy

One cross-file contract guard (`scripts/skills-contract.test.mjs`) turns the findings into
enforced invariants rather than one-off edits. This is slightly broader than the literal ask
(H7 requests "a structural assertion keeping the SDD prompt set aligned"), but each assertion
maps 1:1 to a finding and prevents the same drift class from returning.

## Per-finding changes

### H7 — phase string

- `skills/subagent-driven-development/task-reviewer-prompt.md:20`:
  `set_phase({ phase: "brainstorming" })` → `"development"`, matching `implementer-prompt.md`,
  `re-review-prompt.md`, and `SKILL.md:154`.

### H8 — split the conflated placeholder (plan-approval only)

- `skills/executing-plans/SKILL.md:35-36`: both the `beads_show` status check and the
  `beads_gate_resolve` call use **`<plan-approval-human-gate-id>`** — the human gate is what
  the human resolves and what blocks the task beads.
- Rename the gate-**task**-bead sites from `<plan-approved-gate-id>` to
  **`<plan-approval-gate-bead-id>`**: `subagent-driven-development/SKILL.md:196,197,198,307,473`
  and `writing-plans/SKILL.md:261`.
- `writing-plans`' `RESULT.gate` / `RESULT.human-gate` symbol block stays; add a one-line note
  that `RESULT.gate` ≡ `<plan-approval-gate-bead-id>` and `RESULT.human-gate` ≡
  `<plan-approval-human-gate-id>`.
- Out of scope: brainstorming's `<design-approved-gate-id>` / `<spec-approved-gate-id>` are
  *single* human gates found by label — not conflated.

### M12 — review base

- `skills/requesting-code-review/SKILL.md:33`:
  `BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main` →
  `BASE_SHA=$(git merge-base origin/main HEAD)`, plus a line that inside SDD the recorded
  per-task BASE is passed instead (never `HEAD~1`). Align the line-60 example's base snippet.

### M13 — terminal handoff

Rewrite `skills/subagent-driven-development/SKILL.md` around lines 458-461 (and the diagram
nodes at 115/118/148) so that, once the final review is clean, SDD:

1. closes the `implement` step (`beads_close`), unblocking `verify`;
2. claims `verify` (`beads_update({ id: "<verify-step-id>", claim: true })`);
3. deletes the review workspace (findings now live in git);
4. proceeds to verification via `/skill:verification-before-completion`, which owns closing
   `verify`, surfacing the human `smoke-test-approved` gate, and working `finish`;
5. hands off to `/skill:finishing-a-development-branch` (`/finish`).

Also fix the garbled sentence at line 451 (`After the user confirms, At the start of the
skill, call …`) and set its phase to `development`.

### M14 — canonicalize code-reviewer (D1)

- `agent-templates/code-reviewer.md`: becomes the single canonical mandate — absorbs
  what-to-check (plan alignment / code quality / architecture / testing / production
  readiness), calibration, and the Strengths / Issues (Critical/Important/Minor) / Assessment
  output contract.
- `skills/requesting-code-review/code-reviewer.md`: reduced to the dispatch-context template —
  the `Agent({ subagent_type: "code-reviewer", … })` call, placeholders, diff-loading
  instructions, and a pointer to `agent-templates/code-reviewer.md` for the identity/output
  contract. No duplicate "Senior Code Reviewer" identity.
- `skills/requesting-code-review/SKILL.md`: reframed as whole-branch / feature / before-merge
  review; the "Mandatory: after each task" bullet points per-task review at SDD's
  `task-reviewer` gate instead.
- `task-reviewer` pair: symmetric pointer only.

### M15 — background default

- `skills/dispatching-parallel-agents/SKILL.md:82`: reword "add `run_in_background: true`" →
  "background is the default — pass `run_in_background: false` to force foreground" (keeps the
  `run_in_background` token that `named-agents.test.mjs:48-49` asserts).

### Cleanup — stale beads-migration wording

- `skills/subagent-driven-development/SKILL.md:201`: "no `TaskCreate`-equivalent step is needed
  here…" → beads vocabulary (task beads already exist as real dependency edges).
- Sweep the named skill set for other pre-beads "todo list / plan file / `TaskCreate`" language
  and align it.

## Structural guard

**New file `scripts/skills-contract.test.mjs`** (plain-node, same harness style as
`scripts/agent-dispatch-guard.test.mjs`; no dependencies). It walks `skills/**/*.md` and
asserts:

1. **`set_phase` vocabulary** — every `set_phase({ phase: "X" })` literal under `skills/**`
   has `X ∈ {brainstorming, development, ""}`.
2. **SDD prompt-set alignment (H7)** — `implementer-prompt.md`, `re-review-prompt.md`, and
   `task-reviewer-prompt.md` each emit a `set_phase` call and all three agree
   (expected `"development"`).
3. **No `HEAD~1`** — the string never appears anywhere under `skills/**` (M12).
4. **Gate-placeholder discipline (H8)** — the old conflated name `<plan-approved-gate-id>` is
   gone, and no `beads_gate_resolve({ id: "…gate-bead-id" })` call exists (the gate *task* bead
   is never handed to the resolver).

Wire it in by appending `&& node scripts/skills-contract.test.mjs` to the `test` script in
`package.json`.

*Considered but omitted:* a guard asserting `run_in_background: true` guidance is absent —
too close to a prose assertion with high false-positive risk; M15 is caught by review instead.

## Verification

- `cd packages/pi-superpowers-plus && npm install` (installs the `biome` dev dependency, needed
  by the `test` script's `biome check .`), then `npm test` fully green: `biome check .` plus
  every existing node test (`beads-molecule-widget`, `phase-commands`, `final-review`,
  `fix-loop`, `wave-parallel`, `named-agents`, `agent-dispatch-guard`) plus the new
  `skills-contract`.
- Spot greps as a sanity net: no `<plan-approved-gate-id>`, no `HEAD~1` under `skills/`, all
  `set_phase` values canonical.
- `agent-dispatch-guard`'s existing "every `subagent_type:` resolves to an `agent-templates/`
  file" check still passes after the M14 edits (both `code-reviewer` and `task-reviewer`
  templates remain).

## Out of scope

- brainstorming's design/spec gate placeholders (single human gates, not conflated).
- `packages/langfuse` and `packages/bifrost` (they accept any phase string).
- The workflow formula (`formulas/superpowers-workflow.formula.toml`).
- Any deeper molecule-tail automation beyond routing SDD through
  `verification-before-completion` (M13 mirrors `executing-plans`).
