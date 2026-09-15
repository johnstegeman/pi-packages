---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
disable-model-invocation: true
---

> **Related skills:** Did you `/skill:brainstorming` first? Ready to implement? Use `/skill:executing-plans` or `/skill:subagent-driven-development`.

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."
Call `set_phase({ phase: "brainstorming" })`

At the start of planning, resolve the implement step id via
`beads_list({ label: "step:implement", mol: "<root-id>" })`, then claim it:
`beads_update({ id: "<implement-step-id>", claim: true })`. This is the container all real task
beads are created under. **When you claim the `implement` step, close the `spec-approved` step in the same turn.**

**Context:** If working in an isolated worktree, it should have been created via the `/skill:using-git-worktrees` skill at execution time.

**Plan output:** dynamic task beads under the molecule's `implement` step (see "Creating Tasks as Beads" below) — the plan output is the task beads, not a separate document.

## Boundaries
- Read code and docs: yes
- Write to docs/superpowers/plans/: no (plan output is beads, not a file)
- Edit or create any other files: no

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step


## Task Structure

Each task is one task bead. The `### Task N: [Component Name]` heading is the bead's
TITLE, not a heading in a document: set the bead title to `Task N: <name>` and start the
description body after the heading. Each task's Acceptance Criteria are also passed as the
`acceptance` field in `beads_create_list` so `bd lint` is clean for every task bead.

> **Read now:** [reference/task-template.md](reference/task-template.md) — the exact task-bead description template and the optional Gate line. Read before authoring tasks.

## Creating Tasks as Beads

Once the task breakdown is authored and has passed the lifecycle-duplicate check
(Self-Review item 4), create the real task beads under the `implement` step with **one
`beads_create_list` call**. The `tasks` array order IS the plan order — `beads_create_list`
creates them sequentially, so ids come out `parent.1..N` matching Task 1..N. Never issue
multiple create calls for the same plan.

> **Read now:** [reference/creating-task-beads.md](reference/creating-task-beads.md) — the single `beads_create_list` call, plan-order rule, and plan-approval verdict recording. Read before creating task beads.

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns in [reference/red-flags.md](reference/red-flags.md). Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

4. **Lifecycle-duplicate check:** Does any task in this plan re-implement a phase the
   molecule already executes as its own formula step — e.g. a task titled "write the
   design doc," "get the spec approved," or "get the plan approved"? Those belong to
   `write-spec`/`spec-approved`/`plan-approved`, not to a task under `implement`. Any
   task that duplicates formula-owned work is a plan bug: remove it before wiring tasks
   into beads in Step 3 below.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

After the task beads and `plan-approved` gate are created and wired, the `implement`
step's own claim is left open on purpose — it stays `in_progress`, representing the
whole implementation phase, until every task bead under it closes (see `executing-plans`
Step 5, "Complete Development"). Nothing further to close here; the plan is now
the bead graph itself.

Hand the **implement step id** over to execution — it's resolved via
`beads_list({ label: "step:implement", mol: "<root-id>" })`. `subagent-driven-development` /
`executing-plans` read task beads directly (`beads_show({ id: "<task-id>" })`); no plan file is
written or required.

If planning stops early for any reason (blocked, redirected, session stopped), leave
`implement` and any partially-created task beads as-is — the next session resumes by
reading `beads_mol_show({ id: "<implement-step-id>" })` to see what's already wired.

Then offer execution choice:

**"Plan complete — <N> tasks created under `<implement-step-id>`, gated by
`<plan-approval-human-gate-id>`. Once you approve, I'll record `review.verdict=done` and
resolve the gate to unblock execution (see [reference/creating-task-beads.md](reference/creating-task-beads.md)). Two
execution options:**

**1. Subagent-Driven (this session)** - Fresh subagent per task with two-stage review. Better for plans with many independent tasks.

**2. Parallel Session (separate)** - Batch execution with human review checkpoints. Better when tasks are tightly coupled or you want more control between batches.

**Which approach? Or type `/execute` to see the two options presented by the command."**

**If Subagent-Driven chosen:**
- **REQUIRED SUB-SKILL:** Use `/skill:subagent-driven-development`
- Stay in this session
- Fresh subagent per task + code review

**If Parallel Session chosen:**
- Guide them to open new session in worktree
- **REQUIRED SUB-SKILL:** New session uses `/skill:executing-plans`

Alternatively, use `/execute` to enter the execution phase (presents both options).

## Reference material

- [reference/task-template.md](reference/task-template.md) — the exact task-bead description template and the optional Gate line.
- [reference/creating-task-beads.md](reference/creating-task-beads.md) — the single `beads_create_list` call, plan-order rule, gate description, and plan-approval verdict recording.
- [reference/red-flags.md](reference/red-flags.md) — the placeholder red-flag catalog scanned during Self-Review item 2.
