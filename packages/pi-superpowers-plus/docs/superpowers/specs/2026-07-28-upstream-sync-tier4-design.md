# Upstream Sync Tier 4 — Design Spec

**Date:** 2026-07-28
**Branch:** feat/skills-upstream-sync (current — no new branch)
**Source:** `obra/superpowers` @ HEAD (v6.2.0, commit `3dcbd5c`); conversion snapshot `a98c5df`

## Goal

Three-way merge the original's SKILL.md changes (since conversion) into the 9
remaining fork skills, preserving fork pi-adaptations (`/skill:` syntax,
`docs/superpowers/` paths, `plan_tracker`, Related-skills lines, workflow-monitor
integration) while adopting the original's substantive content. This completes
the skill-content sync with the original.

## Already handled by prior tiers (NOT in scope)

- **test-driven-development** — Tier 1 (writing-good-tests replacement + SKILL.md
  section edits). Verified: the fork's rationalizations table already contains
  the "Why Order Matters" rebuttals ("Tests after achieve same goals", "Already
  manually tested", "Deleting X hours is wasteful") that the original folded in
  via commit `b9e75dd` — so the TDD SKILL.md is fully synced.
- **using-superpowers** — Tier 2.1 (ported Option B).
- **subagent-driven-development** — Tier 2 SDD rework (wholesale replacement).
- **writing-skills** — not ported (meta-skill, low priority per analysis).
- **systematic-debugging/SKILL.md** — partially: Tier 1 handled
  `find-polluter.sh` + `root-cause-tracing.md`. The SKILL.md's "Real-World
  Impact" social proof is **already gone in the fork**. Remaining: a 2-line
  overview edit (drop the "Random fixes waste time..." filler line) + a Phase 4
  cross-ref ("Use the superpowers:verification-before-completion skill before
  claiming success" → adapt to `/skill:verification-before-completion`) + the
  "ultrathink"→"ultra-think" keyword scanner fix. Small; included here.

## Decision

**Scope A — all 9 remaining skills, in priority order.** The compression-sweep
(Group 3) is consistent with the fork's own stated philosophy (README line 88:
skills "grew" with "red flags, rationalizations, and verification checklists" —
NOT recap prose or social proof). The recap sections ("The Bottom Line",
"Remember") are **conversion-snapshot carryover** (verified: present at
conversion, dropped by original, still in fork unedited) — not deliberate fork
additions. **Drop both recap sections** to match upstream (confirmed decision).

## Scope — 9 skills in 3 groups (priority order)

### Group 1 — Clean bug fixes / small edits (do first, pure wins)

#### 1a. `systematic-debugging/SKILL.md` (small, ~5 lines)
- Drop the "Random fixes waste time and create new bugs. Quick patches mask
  underlying issues." filler line under Overview (original dropped it).
- In Phase 4 step 3, add: "Use `/skill:verification-before-completion` before
  claiming success" (adapt `superpowers:` → `/skill:`).
- Fix the red-flags line: "Ultrathinks this" → "Ultra-think this" (keyword
  scanner fix; commit `90e1721`). Verify exact wording against original HEAD.
- Note: the original also folded the bottom "Related skills" block into Phase 4
  — the fork already has a Related-skills line at the top, so this is partly
  redundant; keep the fork's top Related-skills line and ensure Phase 4's
  verification cross-ref is present (the substantive change). Don't duplicate.

#### 1b. `using-git-worktrees/SKILL.md` + `finishing-a-development-branch/SKILL.md` — worktree-path-capture fix
- **The clean bug fix (in both skills):** capture the worktree path *before*
  Step 5 changes directory (the `cd "$path"` into the worktree loses the
  original path needed for cleanup/PR). Commit `0b47219`.
- **`using-git-worktrees` is a full structural rewrite (199 lines churn):** the
  original restructured it around "Step 0: Detect Existing Isolation" (native
  worktree tools vs git worktree fallback) + "Step 1a/1b" + submodule guard +
  sandbox fallback, and converted "Common Mistakes"/"Red Flags"/"Example
  Workflow" guard sections into a "Common Rationalizations" table. This is a
  big three-way merge: take the original's new structure as the base, re-apply
  fork pi-adaptations (Related-skills line at top with `/skill:` syntax; the
  fork's "Announce at start" line; `docs/superpowers/` path if referenced).
  Verify no `superpowers:` syntax remains; convert to `/skill:`.
- **`finishing-a-development-branch` (223 lines churn):** forge-agnostic PR
  creation (detect remote platform before PR/MR — `gh` vs `gitlab` vs generic),
  stop offering to discard work, convert guard sections → rationalization
  table, compress, AND the worktree-path-capture fix. Big three-way merge;
  preserve fork's `/skill:` syntax + Related-skills line + `plan_tracker`
  checkpoint if present.

### Group 2 — Feature/process content (the valuable bulk, three-way merges)

#### 2a. `brainstorming/SKILL.md` (131 lines — high value)
- Add HARD-GATE block ("no implementation until design approved") + "Anti-
  Pattern: This Is Too Simple To Need A Design" callout + 6-item Checklist +
  Process Flow graphviz + "writing-plans as terminal state".
- Add Spec Self-Review (placeholder scan, internal consistency, scope,
  ambiguity) + User Review Gate (ask user to review spec before proceeding to
  planning).
- Add project-level scope assessment, architecture guidance, capability-aware
  escalation.
- Fold "Key Principles" into points of use (compression).
- **Preserve fork's:** Boundaries section (file-write boundaries, enforced by
  workflow-monitor), `docs/superpowers/specs/` path, Related-skills line,
  `plan_tracker` complete-step call, git-state check at start.
- **Note:** the original's checklist says "save to `docs/plans/YYYY-MM-DD-...`";
  the fork uses `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. Keep the
  fork's path convention.

#### 2b. `writing-plans/SKILL.md` (100 lines)
- Add task right-sizing ("a task is the smallest unit that carries its own test
  cycle"), Global Constraints header, per-task Interfaces blocks.
- Add plan review loop (single-pass, raised issue bar — note: the original
  toned down the review loop in commit `2c6a8a3`; use the toned-down version,
  not the earlier heavier one). Add checkbox (`- [ ]`) syntax for tracking.
- Use 4-backtick fences for nested code blocks in the Task Structure template.
- **Drop "## Remember" recap** (carryover; confirmed decision).
- Convert "For Claude" → "For agentic workers" in plan headers (already done in
  fork? verify).
- **Preserve fork's:** `docs/superpowers/plans/` path, Related-skills line,
  Boundaries section, plan_tracker complete-step call, execution-handoff
  section (the fork's end-of-plan checkpoint + subagent-driven option).

#### 2c. `finishing-a-development-branch/SKILL.md` — (covered in 1b; it spans
Group 1's bug fix + Group 2's feature content. Listed once under 1b.)

#### 2d. `requesting-code-review/SKILL.md` + `code-reviewer.md` (36 + 196 lines)
- Trim requesting-code-review; keep review guards as a table (commit `cfb6281`).
- Add context isolation principle (commit `9ccce3b`).
- `code-reviewer.md`: apply the original's trims/restructure.
- **Preserve fork's:** `/skill:` syntax, Related-skills line, the
  requesting-code-review/code-reviewer.md template that the SDD skill (Tier 2)
  dispatches for final review — ensure consistency with the reworked SDD's
  final-review path.

#### 2e. `dispatching-parallel-agents/SKILL.md` (35 lines)
- Add context isolation principle (commit `9ccce3b`).
- Drop social proof (commit `6dbbbda`).
- Agent-neutral prose (commit `f0e5117`).
- **Preserve fork's:** `/skill:` syntax, Related-skills line.

#### 2f. `executing-plans/SKILL.md` (42 lines)
- Remove the "batch-and-stop" pattern (commit `3bdd66e`).
- Trim the subagent quality claim (commit `09fc6e0`).
- Fold "Integration" skill lists into points of use (commit `03147d2`).
- **Preserve fork's:** `/skill:` syntax, Related-skills line, the fork's
  checkpoint/batch behavior if it differs (verify the fork's current
  executing-plans vs original — the fork's SDD skill now references
  executing-plans as the parallel-session alternative; ensure consistency).

### Group 3 — Compression sweep (consistent with fork philosophy)

#### 3a. `receiving-code-review/SKILL.md` (12 lines)
- **Drop "## The Bottom Line" recap** (3-line summary; carryover; confirmed
  decision). The original also made a small "How to Respond" / "Forbidden
  Responses" restructure (commits `6b9f1b2`, `0fad59e`) — apply if present.
- **Preserve fork's:** `/skill:` syntax, Related-skills line.

#### 3b. `writing-plans/SKILL.md` "## Remember" drop — (covered in 2b.)

#### 3c. `verification-before-completion/SKILL.md` (19 lines — all deletions)
- Drop the "Claiming work is complete without verification is dishonesty, not
  efficiency." filler line under Overview.
- Drop "## Why This Matters" section (social proof: "From 24 failure
  memories...").
- Drop "## The Bottom Line" recap ("No shortcuts for verification...").
- **Preserve fork's:** `/skill:` syntax, Related-skills line, the verification
  checklist + monitor integration.

#### 3d. `systematic-debugging/SKILL.md` social-proof drop — (covered in 1a;
the "Real-World Impact" section is already gone in the fork.)

#### 3e. `dispatching-parallel-agents/SKILL.md` social-proof drop — (covered in 2e.)

## Cross-cutting adaptation rules (apply to every skill)

- **Skill references:** `superpowers:X` → `/skill:X` (fork convention).
- **Paths:** keep `docs/superpowers/specs/` + `docs/superpowers/plans/` (fork
  convention); do NOT adopt the original's `docs/plans/` or `.superpowers/`
  tracked-artifact paths. (Exception: the SDD workspace `.superpowers/sdd/` is
  git-ignored scratch, already handled in Tier 2.)
- **`plan_tracker`:** preserve any fork `plan_tracker` complete-step calls.
- **Related-skills lines:** preserve the fork's `> **Related skills:**` line at
  the top of each skill (the original lacks these; they're a fork convention).
- **workflow-monitor integration:** preserve fork references to the
  workflow-monitor / `workflow_reference` tool where present.
- **No `superpowers:` syntax remains** in any ported content.
- **Compression decision:** drop "The Bottom Line" (receiving-code-review) and
  "Remember" (writing-plans) recaps; drop social-proof sections
  (verification-before-completion "Why This Matters"; already-gone
  systematic-debugging "Real-World Impact"; dispatching-parallel-agents social
  proof). Keep rationalization tables and red-flags/checklists (the fork's
  "grew" content).

## Out of scope

- test-driven-development, using-superpowers, subagent-driven-development
  (prior tiers).
- writing-skills (not ported).
- Visual companion (Tier 3).
- Model selection (deferred, noted in Tier 2 spec).
- The out-of-scope `superpowers:writing-skills` reference in
  `writing-good-tests.md` and `Subagent (general-purpose):` in `pi-tools.md`
  (pre-existing from prior tiers' verbatim ports — candidates for a separate
  small fork-adaptation cleanup, NOT part of Tier 4's SKILL.md merges).

## Risks

- **Three-way merge complexity:** the fork's SKILL.md files diverged (pi-
  adaptations + carryover). Each merge must preserve fork adaptations while
  adopting original content — not wholesale copies. The biggest
  (using-git-worktrees 199, finishing 223, brainstorming 131, writing-plans 100)
  are real rewrites; the small ones (receiving 12, systematic-debugging 5,
  verification 19, dispatching 35, executing 42) are tractable.
- **Behavior change:** brainstorming's HARD-GATE + checklist changes agent
  behavior (enforces design-before-implementation). This is the original's
  intent and a valuable guard; the fork's workflow-monitor enforces file-write
  boundaries but not process-level "no implementation skill before design
  approval." The HARD-GATE fills that gap. Acceptable.
- **Consistency with reworked SDD (Tier 2):** `requesting-code-review/code-reviewer.md`
  is dispatched by the SDD skill's final review. Ensure the ported
  code-reviewer.md stays consistent with how the SDD skill invokes it.
- **No new tests:** skill prose has no unit tests. Verification is test/lint
  non-regression + manual grep (no `superpowers:`, `/skill:` present, recaps
  dropped, no stale content).

## Verification (per skill + overall)

- `npm test` (vitest) — all existing tests pass (no code change; skills are
  prose). 40 files / 380 tests as of Tier 2.
- `npm run lint` (biome) — clean.
- Per skill: `grep -c "superpowers:" skills/<s>/SKILL.md` → 0.
- Per skill: relevant `/skill:` references present.
- Recap drops: `grep -c "## The Bottom Line" skills/receiving-code-review/SKILL.md` → 0;
  `grep -c "## Remember" skills/writing-plans/SKILL.md` → 0.
- Social-proof drops: `grep -c "## Why This Matters\|## Real-World Impact" skills/verification-before-completion/SKILL.md skills/systematic-debugging/SKILL.md` → 0.
- Cross-skill: `grep -rn "superpowers:" skills/` → only the known out-of-scope
  `writing-good-tests.md:51` reference (pre-existing, noted); no new ones.
- No stale references to deleted/renamed files (e.g., `spec-reviewer`).
- brainstorming HARD-GATE present: `grep -c "HARD-GATE" skills/brainstorming/SKILL.md` → ≥1.
- using-git-worktrees Step 0 + rationalization table present; old "Common
  Mistakes"/"Red Flags" guard sections gone (converted to table).
- finishing-a-development-branch: forge-agnostic PR detection present;
  worktree-path-capture fix present; rationalization table present.

## Setup

Work on the current branch `feat/skills-upstream-sync`. No new branch. Implement
via subagent-driven-development (fresh implementer per skill/task + spec + code
quality review). Batch the small Group 1/3 skills where sensible; treat the big
rewrites (using-git-worktrees, finishing, brainstorming, writing-plans) as
individual tasks. Preserve fork pi-adaptations in every merge.
