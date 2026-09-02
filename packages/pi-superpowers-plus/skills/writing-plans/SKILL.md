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
Call `set_phase({ phase: "writing plan" })`

At the start of planning, claim the `implement` step of the molecule brainstorming
poured: `bd update <implement-step-id> --claim`. This is the container all real task
beads are created under.

**Context:** If working in an isolated worktree, it should have been created via the `/skill:using-git-worktrees` skill at execution time.

**Plan output:** dynamic task beads under the molecule's `implement` step (see "Creating Tasks as Beads" below) — no markdown plan file is written.

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

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

## Global Constraints

[The spec's project-wide requirements — version floors, dependency limits,
naming and copy rules, platform requirements — one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [what this task uses from earlier tasks — exact signatures]
- Produces: [what later tasks rely on — exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```

---

### Task N+1: [Next Component Name]

(Repeat the same shape for every task. After the LAST task, place a final
`---` before any trailing section such as `## Verification` or `## Summary` —
see Task Separation below.)
````

## Creating Tasks as Beads

Once the task breakdown above is written out in the plan document and has passed the
lifecycle-duplicate check (Self-Review item 4), mirror it into real beads under the
`implement` step:

```bash
# One gate, every real task depends on it — nothing executes until the human approves
# the plan shape.
GATE_ID=$(bd create "Plan reviewed / ready to execute" --parent <implement-step-id> -t task --json | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
bd gate create --type=human --blocks $GATE_ID --reason "Plan approval"

# One bead per task, in order, each depending on the gate and on its plan-declared
# predecessor:
TASK1_ID=$(bd create "Task 1: <name>" --parent <implement-step-id> -t task -d "<full step-by-step instructions from the plan's Task 1 body>" --json | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
bd dep add $TASK1_ID $GATE_ID

TASK2_ID=$(bd create "Task 2: <name>" --parent <implement-step-id> -t task -d "<full step-by-step instructions from the plan's Task 2 body>" --json | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
bd dep add $TASK2_ID $GATE_ID
bd dep add $TASK2_ID $TASK1_ID   # only if the plan actually orders Task 2 after Task 1
```

Each task bead's `-d`/`--description` is the task's **entire** body from the plan
document — every step, every code block, exactly as written. This bead is what
`executing-plans`/`subagent-driven-development` read during execution; the plan.md
document itself is no longer read at execution time (see Task 4/5).

**Recording the plan-approval verdict** (same revise/recheck pattern as brainstorming's
`design-approved`/`spec-approved` gates, Task 2 Step 3): when presenting the plan for
review, don't just wait silently on the gate.
- Approved: `bd update $GATE_ID --set-metadata review.verdict=done`, then
  `bd gate resolve <the-gate-id-bd-gate-create-returned>`.
- Changes requested: `bd update $GATE_ID --set-metadata review.verdict=iterate`, write
  a specific revision summary (`bd comment $GATE_ID "<what needs to change>"`), revise
  the affected task beads' descriptions in place (`bd update <task-id> --description
  "<revised instructions>"`) or add/remove/re-order task beads as needed, and re-present
  — do NOT resolve the gate. On resume, read the existing task beads under `implement`
  (`bd mol show <implement-step-id>`) plus the latest revision summary before revising,
  rather than starting the breakdown over.

## Task Separation

Each task MUST end with an unfenced `---` (three or more hyphens) on its own
line, immediately followed (after optional blank lines) by the next task's
`### Task N` heading or a non-task trailing section. An extractor named by
one task number (e.g. a task-brief script) needs a definite end-of-task
delimiter, so the rule is absolute:

- Between consecutive tasks: `---`, blank line, `### Task N+1`.
- After the last task, before any trailing section (`## Verification`,
  `## Summary`, `## Notes`, etc.): `---`, then the section heading.
- NEVER use `---` inside a task body (e.g. between `**Files:**` and the
  first step). The `**Step N:**` labels are bold text, not headings, so
  an extractor would not mistake them for a boundary — but keep bodies
  free of `---` anyway so the format stays unambiguous.

A `---` line inside a code fence is literal markdown content (the file
content the task edits) and is NOT a separator.

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

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
Step 3, "Rewrite Complete Development"). Nothing further to close here; the plan is now
the bead graph itself.

If planning stops early for any reason (blocked, redirected, session stopped), leave
`implement` and any partially-created task beads as-is — the next session resumes by
reading `bd mol show <implement-step-id>` to see what's already wired.

Then offer execution choice:

**"Plan complete — <N> tasks created under `<implement-step-id>`, gated by
`<plan-approved-gate-id>`. Once you approve, I'll record `review.verdict=done` and
resolve the gate to unblock execution (see Step 3's verdict recording). Two execution
options:**

**1. Subagent-Driven (this session)** - Fresh subagent per task with two-stage review. Better for plans with many independent tasks.

**2. Parallel Session (separate)** - Batch execution with human review checkpoints. Better when tasks are tightly coupled or you want more control between batches.

**Which approach?"**

**If Subagent-Driven chosen:**
- **REQUIRED SUB-SKILL:** Use `/skill:subagent-driven-development`
- Stay in this session
- Fresh subagent per task + code review

**If Parallel Session chosen:**
- Guide them to open new session in worktree
- **REQUIRED SUB-SKILL:** New session uses `/skill:executing-plans`

Alternatively, use `/execute` to enter the execution phase (presents both options).
