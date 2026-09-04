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

Each task is one task bead. The template below is the exact shape of every task bead's
`description` — what `beads_create({ title, description })` writes. The markdown
heading `### Task N: [Component Name]` is the bead's TITLE, not a heading in a
document:
Set the bead title to `Task N: <name>`; the description body starts after the
heading (do not include the `### Task N:` heading in the description).

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

### Task N+1: [Next Component Name]

(Repeat the same shape for every task.)
````

## Creating Tasks as Beads

Once the task breakdown above is authored and has passed the
lifecycle-duplicate check (Self-Review item 4), create the real task beads under the
`implement` step with **one `beads_create_list` call**. The `tasks` array order IS the plan
order — `beads_create_list` creates them sequentially (one `bd create --parent` awaited at a
time), so ids come out `parent.1, parent.2, … ` matching Task 1..N, which is what keeps
`bd list` and the molecule widget showing tasks in plan order.

```
# One call creates the gate bead + human gate, then every task bead in plan order,
# then wires the blocks-chain (each task → gate; Task N+1 → Task N).
RESULT = beads_create_list({
  parent: "<implement-step-id>",
  gate: {
    description: "## Global Constraints\n<the constraints block, authored here>",
    reason: "Plan approval",
  },
  tasks: [
    { title: "Task 1: <name>", description: "<the Task 1 breakdown above, verbatim>" },
    { title: "Task 2: <name>", description: "<the Task 2 breakdown above, verbatim>" },
    # ... one entry per task, IN PLAN ORDER (Task 1 → Task N)
  ],
})
GATE_ID        = RESULT.gate
HUMAN_GATE_ID  = RESULT.human-gate   # the human gate's id (present when a gate is requested)
TASK1_ID       = RESULT.t1
TASK2_ID       = RESULT.t2
# ...
```

**Tasks MUST be passed in plan order (Task 1 → Task N).** `beads_create_list` creates them
sequentially in that order so ids come out `parent.1..N`; a task listed out of order would get
the wrong id sequence and break plan-order display in `bd list` and the widget. Never issue
multiple `beads_create` / `beads_create_list` calls for the same plan — one call, declared in
order.

The gate bead's `description` is the **canonical Global Constraints artifact**: this is
where the constraints block is authored (exact values, exact formats, stated component
relationships). It stays readable after the gate is resolved/closed.

Each task bead's `description` is the task's **entire** breakdown above — every step, every
code block, exactly as written. This bead is what
`executing-plans`/`subagent-driven-development` read during execution —
`beads_show({ id: "<task-id>" })`. It is the requirements at execution time; there is no plan.md.

**Recording the plan-approval verdict** (same revise/recheck pattern as brainstorming's
`design-approved`/`spec-approved` gates, Task 2 Step 3): when presenting the plan for
review, don't just wait silently on the gate. Bind the ids straight from the
`beads_create_list` result (it already returned them, so no lookup is needed):

```
GATE_ID        = RESULT.gate          # gate TASK bead id (e.g. parent.1)
HUMAN_GATE_ID  = RESULT.human-gate    # the human gate the task beads are blocked by
TASK1_ID       = RESULT.t1
TASK2_ID       = RESULT.t2
```

`RESULT.gate` (`parent.1`) is the gate **task bead** — never pass it to
`beads_gate_resolve`, and never `beads_gate_resolve` any task-bead id.
`RESULT.human-gate` is the id of the **human gate** `beads_create_list` creates internally,
returned only when a gate was requested — and that is the only id the verdict resolver
resolves.
  - Approved: `beads_update({ id: GATE_ID, setMetadata: "review.verdict=done" })`, then
  `beads_gate_resolve({ id: HUMAN_GATE_ID })`. This resolves the human gate and closes the
  gate task bead it was gating, so dependent task beads aren't later blocked by the
  still-open gate ("blocked by open issues [..]"). Step closes are order-enforced: a blocked
  `beads_close` means a prerequisite step/gate is still open — close/resolve it first; the
  error is the signal, not a mistake. If no gate was requested, `RESULT.human-gate` is
  absent — there is no human gate to resolve.
  - Changes requested: `beads_update({ id: GATE_ID, setMetadata: "review.verdict=iterate" })`, write
  a specific revision summary (`beads_comment({ id: GATE_ID, text: "<what needs to change>" })`), revise
  the affected task beads' descriptions in place (`beads_update({ id: "<task-id>", description:
  "<revised instructions>" })`) or add/remove/re-order task beads as needed, and re-present
  — do NOT resolve the human gate (nor `beads_gate_resolve` any task id). On resume, read the existing
  task beads under `implement` (`beads_mol_show({ id: "<implement-step-id>" })`) plus the latest
  revision summary before revising, rather than starting the breakdown over.

Close each step bead in the same turn its real output exists (never batch several closes at the end of a phase) — this is what keeps `bd mol current --json` honest so the widget shows the real current step.
**When you claim step N+1, close step N you just completed in the same turn** — every step handoff (e.g. `spec-review`→`spec-approved`, `spec-approved`→`implement`) follows this same general rule.


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
`<plan-approved-gate-id>`. Once you approve, I'll record `review.verdict=done` and
resolve the gate to unblock execution (see Step 3's verdict recording). Two execution
options:**

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
