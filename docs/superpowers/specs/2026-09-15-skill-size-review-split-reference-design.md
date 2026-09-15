# Skill size review: split reference material out of oversized SKILL.md files

Date: 2026-09-15
Status: approved design
Tracking: `pi-packages-axam` (issue), `pi-packages-mol-h4nw` (molecule)

## Problem

The `pi-superpowers-plus` skills have grown to roughly 2x the upstream
`coctostan/pi-superpowers` baseline. The default system-prompt cost is not the
problem — only `using-superpowers` and `systematic-debugging` are visible
(`disable-model-invocation: true` hides the other 11), so always-on description
cost stays ~52 tokens. The problem is **on-invoke context and maintainability**:
a 45.9 KB `subagent-driven-development/SKILL.md` loads in full the moment the
skill is invoked, and long prose sections make the file hard to maintain.

Measured `SKILL.md` sizes (bytes/1024), against upstream:

| Skill | Now (KB) | Upstream (KB) |
|---|---:|---:|
| `subagent-driven-development` | 45.9 | 10.2 |
| `brainstorming` | 17.8 | 2.5 |
| `writing-plans` | 14.9 | 3.3 |
| `test-driven-development` | 9.3 | 9.8 |
| `finishing-a-development-branch` | 8.0 | 4.3 |
| `using-git-worktrees` | 7.4 | 5.5 |
| `systematic-debugging` | 7.0 | 9.8 |
| `dispatching-parallel-agents` | 6.6 | 6.2 |
| `receiving-code-review` | 6.0 | 6.2 |
| `executing-plans` | 5.4 | 2.7 |
| `verification-before-completion` | 5.2 | 4.1 |
| `using-superpowers` | 5.1 | — |
| `requesting-code-review` | 3.6 | 2.9 |

## Goal

Minimize on-invoke context **without disturbing a flow that works well**.
`SKILL.md` becomes a lean decision tree; stable reference material moves to
on-demand `reference/*.md` files that are read when needed. There is **no fixed
size target** — the rule for what moves is what matters. The resulting sizes
quoted below are rough estimates recorded for the README, not goals to hit.

Acceptance criteria (from `pi-packages-axam`):

- A written proposal/spec enumerating, per skill, what moves to `reference/`
  and the resulting `SKILL.md` size.
- No behavior change: skills still function via `/skill:`; moved content stays
  discoverable and linked from `SKILL.md`.
- `cd packages/pi-superpowers-plus && npm test` (incl. `skills-contract`) green.
- README context-size table regenerated after the split.

## Scope

In scope: the six skills > 7 KB except `test-driven-development` —

1. `subagent-driven-development` (45.9 KB)
2. `brainstorming` (17.8 KB)
3. `writing-plans` (14.9 KB)
4. `finishing-a-development-branch` (8.0 KB)
5. `using-git-worktrees` (7.4 KB)
6. `systematic-debugging` (7.0 KB)

Out of scope: `test-driven-development` (9.3 KB) is technically > 7 KB but is
*below* its upstream baseline (9.8 KB) and already has a `reference/` split —
re-litigating it is not worth the gain. Also out of scope:
`dispatching-parallel-agents` (6.6 KB) and every smaller skill.
`using-superpowers/references/` (plural) is not normalized.

## Approach: in-place per-skill split

Each in-scope skill is split independently; there is no shared reference
library. This keeps every skill self-contained and installable alone, matches
the existing `test-driven-development` / `systematic-debugging` pattern, and
keeps each change verifiable in isolation. Text may additionally be tightened or
de-duplicated, provided no guidance is lost.

### Directory layout and conventions

```
skills/<name>/
├── SKILL.md                 # decision tree only
└── reference/
    ├── <topic>.md           # read-gated process content, one topic per file
    └── <theme>.md           # soft-pointer enrichment, grouped by theme
```

- `reference/` (singular), matching the existing TDD/systematic-debugging splits.
- **Inline (decision tree) keeps:** frontmatter; the `> **Related skills:**`
  line; purpose / "why" / core principle; every `<HARD-GATE>` block (a gate is
  loaded eagerly by definition and must never become a "go read something else"
  pointer); the ordered process / checklist / numbered steps and the live
  current-step logic; and the `Reference material` index.
- **Moves to `reference/`:** long prose rationale; rationalization tables and
  red-flag catalogs; worked examples and code samples; extended troubleshooting;
  reference tables / parameter catalogs / API detail; background recovery detail
  where the inline step only needs a one-line rule.
- **Two pointer kinds**, both relative markdown links so they are clickable and
  machine-checkable:
  - **Read-gate** at point of use, for process content that must be followed:
    `> **Read now:** [reference/fix-loop.md](reference/fix-loop.md) — fix rounds, gated path, breaker rules. Do not start the fix loop without it.`
  - **Soft pointer** in the bottom `Reference material` index, for
    optional/enrichment content: `- [reference/rationalizations.md](reference/rationalizations.md) — extended rationale and common excuses.`
  - Read-gated files are *also* listed in the index.

### Invariants

- `/skill:` invocation and frontmatter are untouched.
- Every existing `related skills` / sub-skill hand-off link is preserved.
- **No `set_phase(...)` call may move into `reference/`** — a skill only
  executes what is in `SKILL.md`, so a relocated `set_phase` would silently
  stop firing.
- Content that `skills-contract.test.mjs` enforces (canonical `set_phase`
  vocabulary, gate-placeholder rules, no `HEAD~1` review base, no restated
  code-reviewer identity) must remain valid after the move.

## Per-skill application

### `subagent-driven-development` (45.9 KB → ~13 KB)

- **Stays:** frontmatter/why/core principle, Prerequisites, When to Use, the
  The Process graph, `## The Task Loop` as a skeleton (dispatch → report →
  review → fix loop → complete, with the live current-step rules), After All
  Tasks Complete, task-completion + close rules, Integration.
- **Moves:**
  - `## Workflows (SubagentWorkflow)` → `reference/subagent-workflows.md`
    (read-gate at wave-parallel + final review).
  - Setup recovery / `@handle` / `resume` mechanics → `reference/recovery.md`
    (read-gate at Setup).
  - Dispatch cost / handle / report detail → `reference/dispatch-implementer.md`
    (read-gate).
  - Review-inputs and pre-judging detail → `reference/task-review.md` (read-gate).
  - The whole fix loop → `reference/fix-loop.md` (**hard read-gate** — the loop
    must not be started without it).
  - Final Review workflow payload/args → `reference/final-review.md` (read-gate).
  - `## When a Subagent Fails` + `## Red Flags` → `reference/red-flags.md` (soft).
- The two dot graphs restate the numbered text; the process graph stays, and the
  restatements are tightened.

### `brainstorming` (17.8 KB → ~8 KB)

- **Stays:** all three `<HARD-GATE>` blocks, intro + `set_phase`, Boundaries,
  the Checklist (decision tree), and the operational core of After the Design
  (verdict recording, spec self-review, user gate, `/plan` handoff).
- **Moves:**
  - The three anti-pattern sections → `reference/anti-patterns.md`
    (**read-gate** — they encode hard-gate behavior).
  - Process Flow dot → `reference/process-flow.md` (soft; restatement).
  - "The Process" elaboration (understanding / approaches / design-for-isolation
    / existing-codebases) → `reference/process-guidance.md` (soft).
  - After-the-Design resume/edge-case prose → `reference/verdict-recording.md`
    (read-gate at the design-approved step).

### `writing-plans` (14.9 KB → ~7 KB)

- **Stays:** Overview + `set_phase` + implement-step claim, Boundaries, Scope
  Check, File Structure, Task Right-Sizing, Bite-Sized Granularity, Self-Review,
  Execution Handoff (tightened).
- **Moves:**
  - Task template → `reference/task-template.md` (read-gate before authoring
    tasks).
  - "Creating Tasks as Beads" detail + verdict-recording ids →
    `reference/creating-task-beads.md` (read-gate at that step).
  - "No Placeholders" → `reference/red-flags.md` (soft; linked from Self-Review).

### `finishing-a-development-branch` (8.0 KB → ~5.5 KB)

- **Stays:** Overview + `set_phase`, Steps 1–7 (all operational), Integration.
- **Moves:** Common Rationalizations → `reference/rationalizations.md` (soft);
  Quick Reference table → `reference/quick-reference.md` (soft; restatement).

### `using-git-worktrees` (7.4 KB → ~4.5 KB)

- **Stays:** Overview + announce, Step 0 detection (incl. submodule guard),
  Step 1a native-tools rule, Step 1b heading + create/prune commands, Steps 2–3,
  Integration.
- **Moves:** directory-selection priority + safety-verification prose →
  `reference/directory-selection.md` (read-gate from Step 1b); Common
  Rationalizations → `reference/rationalizations.md` (soft); Quick Reference →
  `reference/quick-reference.md` (soft).

### `systematic-debugging` (7.0 KB → ~4.5 KB)

- **Stays:** Iron Law, When to Use, The Four Phases (decision tree), When
  Process Reveals "No Root Cause".
- **Moves:**
  - `## Red Flags` → `reference/red-flags.md` (read-gate; keep a one-line
    pointer to it in Phase 1).
  - When 3+ Fixes Fail → `reference/architecture-question.md` (read-gate from
    Phase 4).
  - Multi-component evidence example → `reference/evidence-gathering.md` (soft).
  - `## Common Rationalizations` table → merged into the existing
    `reference/rationalizations.md` (soft). **This table already duplicates that
    file today**, so this is an immediate win.
- Root-level technique files (`root-cause-tracing.md`, `defense-in-depth.md`,
  `condition-based-waiting.md`) **stay at the skill root** — their paths are
  referenced by `SKILL.md` and appear in historical plans/specs.

## Verification

1. **Link-integrity + read-gate contract test.** Extend
   `packages/pi-superpowers-plus/test/skills-contract.test.mjs` (already
   `walk()`s every `.md`/`.js` under `skills/` and is wired into `npm test`):
   - **No orphans:** every file under any `skills/*/reference/` is linked from
     that skill's `SKILL.md`.
   - **No dangling links:** every relative, non-URL target referenced from a
     `SKILL.md` resolves to a real file (new read-gates and index bullets, plus
     pre-existing links such as `implementer-prompt.md` and
     `../requesting-code-review/code-reviewer.md`).
   - **Read-gate markers well-formed:** every read-gate line matches the agreed
     marker and its target exists.
   - Because `walk()` scans reference files too, moved content stays subject to
     the existing invariants.
2. **Fidelity review (per skill).** A diff review confirming every removed line
   is either present in a `reference/` file or an intentional tightening /
   de-duplication with no lost guidance. Recorded one line per skill in the
   plan. Anything ambiguous is kept, not dropped.
3. **Existing suite green:** `cd packages/pi-superpowers-plus && npm test`
   (biome + `skills-contract` + the SDD workflow-script tests).

## README regeneration

After the split, recompute `packages/pi-superpowers-plus/README.md`'s
context-size table from actual `wc -c` values:

- update the `pi-superpowers-plus (KB)` column;
- update the shared / all-13 totals line;
- update the "roughly 2x the upstream baseline" claim to the new ratio (or note
  it has been addressed);
- keep the on-demand-loading explanation and add a sentence that oversized
  skills now ship a `reference/` directory loaded via read-gates.

Only the package README carries this table; the repo root README does not.

## Rollout order

One skill per plan task, biggest/riskiest first, each independently verifiable:

1. `subagent-driven-development`
2. `brainstorming`
3. `writing-plans`
4. `finishing-a-development-branch`
5. `using-git-worktrees`
6. `systematic-debugging`

Each task ends with that skill green against the contract test and its fidelity
review done. README regeneration is the final task.

## Risks

- **Burying process behind a pointer.** Mitigated by read-gates on critical
  process content (SDD fix loop, task template, worktree directory selection) and
  by the read-gate contract test.
- **Silent loss during tightening.** Mitigated by the per-skill fidelity review
  and the keep-if-ambiguous rule.
- **A relocated `set_phase` stops firing.** Explicitly forbidden by the
  invariants; the contract test covers vocabulary.
