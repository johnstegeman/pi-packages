---
name: executing-plans
description: Use when you have a written implementation plan to execute in a separate session with review checkpoints
disable-model-invocation: true
---

> **Related skills:** Need an isolated workspace? `/skill:using-git-worktrees`. Verify each task with `/skill:verification-before-completion`. Done? `/skill:finishing-a-development-branch`.

# Executing Plans

## Overview

Load plan, review critically, execute tasks in batches, report for review between batches.

**Core principle:** Batch execution with checkpoints for architect review.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

Call `set_phase({ phase: "development" })`.

## Prerequisites
- Active branch (not main) or user-confirmed intent to work on main
- Approved plan or clear task scope

## The Process

### Step 1: Load and Review Plan
1. Load the molecule: `bd mol current <implement-step-id> --json` — this returns every
   task bead's status and the current/next step, replacing "read plan file."
2. Review critically — read each task bead's full description
   (`bd show <task-id>`) and identify any questions or concerns about the plan.
3. If concerns: Raise them with your human partner before starting.
4. If no concerns: confirm the `plan-approved` gate is resolved
   (`bd show <plan-approved-gate-id>` — status should be `closed`; if not, stop and ask
   the human to run `bd gate resolve <plan-approved-gate-id>` before proceeding).

### Step 2: Execute Batch
**Default: First 3 tasks**

For each task, working the ready frontier (`bd ready --mol <implement-step-id>` shows
what's unblocked right now):
1. Claim it: `bd update <task-id> --claim` (atomically sets assignee + `in_progress`).
2. Follow the task bead's full description exactly (it holds the same bite-sized steps a
   plan.md task body used to hold).
3. Run verifications as specified in the description.
4. Close it: `bd close <task-id> --reason "<what was done>"` — this unblocks whatever
   depended on it; re-run `bd ready --mol <implement-step-id>` to see the next batch.

### Step 3: Report
When batch complete:
- Show what was implemented
- Show verification output
- Say: "Ready for feedback."

### Step 4: Continue
Based on feedback:
- Apply changes if needed
- Execute next batch
- Repeat until complete

### Step 5: Complete Development

After all tasks complete and verified — confirm with `bd ready --mol
<implement-step-id>` returning empty — close the `implement` step itself
(`bd close <implement-step-id> --reason "all tasks complete"`), which unblocks `verify`.
Claim `verify` (`bd update <verify-step-id> --claim`) and proceed to that work before the
finishing-a-development-branch handoff below.

- Announce: "I'm using the finishing-a-development-branch skill to complete this work."
- **REQUIRED SUB-SKILL:** Use `/skill:finishing-a-development-branch`
- Follow that skill to verify tests, present options, execute choice

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker mid-batch (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

If you stop on a blocker or abort mid-batch, do not silently leave the current task bead
in `in_progress`: mark it `blocked` (`bd update <task-id> --status blocked` with a
`bd comment <task-id> "<blocker>"` explaining why), or leave it `in_progress` for resume,
and on resume re-claim it (`bd update <task-id> --claim`) to continue.

## When the Plan Is Wrong

**Different from being blocked** — you're not stuck, but you've learned something that makes the remaining plan unworkable.

- Stop executing immediately
- Report what you've learned and why remaining tasks won't work
- Propose a revised approach, or ask your human partner to revisit the design
- Don't continue executing tasks you know are heading somewhere bad

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- TDD is the default for production code: failing test first, verify fail, implement, verify pass
- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Reference skills when plan says to
- Between batches: just report and wait
- Stop when blocked, don't guess
- Never start implementation on main/master branch without explicit user consent

## Integration

**Required workflow skills:**
- **`/skill:using-git-worktrees`** - Recommended: Set up isolated workspace before starting. For small changes, branching in the current directory is acceptable with human approval.
- **`/skill:writing-plans`** - Creates the plan this skill executes
- **`/skill:finishing-a-development-branch`** - Complete development after all tasks
