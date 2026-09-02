# Upstream Sync Tier 1 — Design Spec

**Date:** 2026-07-28
**Branch:** feat/skills-upstream-sync (current branch — no new branch)
**Source:** `obra/superpowers` @ HEAD (v6.2.0, commit `3dcbd5c`); conversion snapshot `a98c5df` (v4.2.0)

## Goal

Bring three Tier 1 changes from the original `obra/superpowers` into this fork:
two verbatim copies and one replacement, all in `skills/`.

## Scope — three work items

### Item 1: `find-polluter.sh` bug fixes (verbatim copy)

- **What:** Copy original HEAD's `skills/systematic-debugging/find-polluter.sh`
  verbatim over the fork's copy.
- **Why:** Fork's copy is pristine (identical to the conversion snapshot `a98c5df`).
  Original has two clean bug-fix commits since conversion:
  - `6015d37` "match find -path ./ prefix in find-polluter.sh (#2011)"
  - `c8921b5` "find-polluter accepts ./-prefixed patterns and matches top-level tests"
- **Effect:** ~12 lines changed. The bisection helper now accepts `./`-prefixed
  test patterns and matches top-level test files (patterns like `src/**/*.test.ts`
  no longer skip `src/top.test.ts`).
- **Risk:** None. Referenced in `systematic-debugging/root-cause-tracing.md` and
  `systematic-debugging/SKILL.md` usage is unchanged.

### Item 2: `root-cause-tracing.md` anonymization (verbatim copy)

- **What:** Copy original HEAD's `skills/systematic-debugging/root-cause-tracing.md`
  verbatim over the fork's copy.
- **Why:** Fork's copy is pristine. Original has one 2-line change since
  conversion: anonymizes an example path `/Users/jesse/project/...` →
  `~/project/...` (privacy / portability).
- **Effect:** 2 lines changed in the "Observe the Symptom" example.
- **Risk:** None. File is actively wired: `systematic-debugging/SKILL.md` Phase 1
  references it; workflow-monitor `debug-tracing` reference topic points to it.

### Item 3: Replace `testing-anti-patterns.md` with `writing-good-tests.md` (Approach A)

- **What:**
  1. Delete `skills/test-driven-development/testing-anti-patterns.md`.
  2. Add `skills/test-driven-development/writing-good-tests.md` (verbatim from
     original HEAD, 198 lines).
  3. Repoint the workflow-monitor `tdd-anti-patterns` reference topic from
     `testing-anti-patterns.md` → `writing-good-tests.md`. **Keep the topic name**
     `tdd-anti-patterns` unchanged so the existing reference-tool test
     (`tests/extension/workflow-monitor/reference-tool.test.ts` asserts the topic
     exists and loads) passes without modification.
  4. Rewrite the "Testing Anti-Patterns" section of
     `skills/test-driven-development/SKILL.md` to describe the two-principle model
     and point at `writing-good-tests.md` instead of listing the old anti-patterns.
- **Why:** `writing-good-tests.md` is a ground-up rewrite. Its Principle 2
  ("Exercise the Real Thing") + Quick Reference table + Warning Signs cover the
  substance of all 5 old anti-patterns, and it adds Principle 1 ("Name the
  Break" — independent expectation derivation, no change detectors, behavior not
  text, your code not the framework) plus a Mutation Check, which the old doc
  entirely lacked.
- **Decision rationale (Approach A over B/C):** The whole point of this sync is
  to track upstream. A single authoritative doc that matches upstream makes
  future syncs trivial. Keeping both (B) leaves two overlapping docs and drift
  risk; a hybrid (C) diverges from upstream and defeats the sync goal. The
  elaborate per-anti-pattern gate-function blocks lost are largely subsumed by
  the new doc's own gate functions + Quick Reference table.
- **Risk:** Low. New file is harness-agnostic Markdown. The repoint keeps the
  topic name, so the reference-tool test is unaffected. The SKILL.md section
  rewrite is a content edit.

## Out of scope

- Tier 2+ items (using-superpowers, reviewer prompts, SDD scripts/rework,
  visual companion) — separate efforts.
- Any SKILL.md compression-sweep merges (Tier 4) — separate effort.
- The `docs/upstream-sync-analysis.md` report stays as-is (it's the source
  document for this work; not edited by Tier 1).

## Verification

- `npm test` (vitest) — all existing tests pass, including
  `reference-tool.test.ts` (topic name unchanged, file repointed).
- `npm run lint` (biome) — clean.
- Manual: `workflow_reference` `tdd-anti-patterns` loads the new
  `writing-good-tests.md` content.
- Diff review: items 1 & 2 match original HEAD verbatim; item 3 new file matches
  original HEAD verbatim.

## Setup

Work on the current branch `feat/skills-upstream-sync` (which carries the
analysis doc). No new branch. Implement via TDD where there's logic to test
(item 3's reference-tool repoint); items 1 & 2 are content copies with no logic.
