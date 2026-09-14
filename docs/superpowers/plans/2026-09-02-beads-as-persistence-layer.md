# Beads as Structural Persistence Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace superpowers-plus's markdown-file-only spec/plan tracking with a beads formula/molecule as the structural backbone of brainstorm → design → plan → implement → verify → finish, keeping spec prose in a diffable file, and ship a self-contained widget (in this package's own extension code) that renders the active molecule's pipeline state.

**Architecture:** Everything lives in `pi-superpowers-plus`. A new formula file plus rewrites to six `SKILL.md` files make skills pour/query/advance the molecule via bare `bd` calls (no new tool wrappers needed — `beads_create` already supports `parent`/`description`/`type`; everything else runs as bash). A new self-contained extension (`extensions/beads-molecule-widget.ts`, alongside the existing `extensions/set-phase.ts`) renders the active molecule's pipeline state above the editor by shelling out to `bd mol current --json` directly via `pi.exec` — no pi-beads changes, no second repo, no dependency on code outside this package's own release cycle.

**Tech Stack:** Markdown skill editing + one TOML formula file + one new TypeScript extension file, tested with a plain-JS pure-render module (no framework — matches the existing `extensions/set-phase.ts` style).

**Design spec:** `docs/superpowers/specs/2026-09-02-beads-as-persistence-layer-design.md`

## Global Constraints

- **Single repo root.** Everything in this plan is `pi-superpowers-plus` (`docs/`, `skills/`, `extensions/`, `README.md`, `CHANGELOG.md`) — no other package is modified.
- **No new tool wrappers for molecule operations.** `bd cook`, `bd mol pour`, `bd dep add --type <x>`, `bd ready --mol`, `bd mol current` are invoked as bare `bd` shell commands from skill instructions (via the agent's own `bash` tool) or via `pi.exec` from the new widget extension — the same pattern `writing-plans`/`brainstorming` already use for `bd mol wisp gc`. Only `beads_create`/`beads_update`/`beads_close`/`beads_dep` (tools from whatever beads tool package is installed, e.g. pi-beads) are used from skills where they already cover the need (e.g. creating dynamic task children under `implement` via `beads_create({ parent, description, type })`).
- **Formula step ids are fixed** and used verbatim in every skill reference: `explore`, `clarify`, `approaches`, `design`, `design-approved`, `write-spec`, `spec-review`, `spec-approved`, `implement`, `verify`, `smoke-test-approved`, `finish`. Skills reference these ids, never re-derive or rename them.
- **`implement` and `verify` are `type = "task"` in the formula, never `type = "epic"`** — beads disallows `blocks`-type edges crossing the epic/task type boundary in either direction (validated in the design spec); a task-typed step with children is still a valid molecule for `bd mol show`/`bd ready --mol`.
- **Spec content stays a file.** No task in this plan writes spec prose into a bead field. The `write-spec` bead's role is linkage only (`bd update <id> --spec-id <path>`).
- **Plan-task descriptions are write-once.** No `appendDescription` tool support is added or required anywhere in this plan (see design spec Decision 3/4).
- **Quality gates:** `npx biome check .` (biome covers `extensions/*.ts`; markdown/TOML are excluded per `biome.json`, so for those the real check is the grep fences and manual `bd cook --dry-run` verification specified per task) plus `node --test extensions/beads-molecule-widget.test.mjs` for the new render module.
- **The widget is self-contained.** It registers under its own widget key (`beads-mol`) via `ctx.ui.setWidget` from this package's own extension code — it does not depend on, modify, or coordinate with any other installed package's widget (a parallel effort is removing the old generic pi-beads widget entirely, which this plan neither depends on nor is blocked by).

---

### Task 1: Formula file + cook/pour verification

**Files:**
- Create: `formulas/superpowers-workflow.formula.toml` (at the package root, in `pi-superpowers-plus`, so it ships as a template — `.beads/` is the git-ignored local DB dir and is NOT in `package.json`'s `files`, so it cannot hold the shipped template). Add `"formulas/"` to `package.json`'s `files` array so it ships. The `using-superpowers` skill copies from here into a consuming project's `.beads/formulas/` at install time — see Task 7 for the copy-on-first-use logic.

**Interfaces:**
- Consumes: none.
- Produces: the 12 formula step ids listed in Global Constraints, consumed by every later task's skill rewrites.

- [ ] **Step 1: Write the formula file**

Create `formulas/superpowers-workflow.formula.toml`:

```toml
formula = "superpowers-workflow"
description = "Brainstorm -> design -> plan -> implement -> verify -> finish"
version = 1
type = "workflow"

[vars.topic]
description = "The feature/topic being brainstormed"
required = true

[[steps]]
id = "explore"
title = "Explore project context: {{topic}}"
type = "task"

[[steps]]
id = "clarify"
title = "Ask clarifying questions"
type = "task"
needs = ["explore"]

[[steps]]
id = "approaches"
title = "Propose approaches"
type = "task"
needs = ["clarify"]

[[steps]]
id = "design"
title = "Present design sections"
type = "task"
needs = ["approaches"]

[[steps]]
id = "design-approved"
title = "User approves design"
type = "task"
needs = ["design"]

[steps.gate]
type = "human"

[[steps]]
id = "write-spec"
title = "Write spec to docs/superpowers/specs/"
type = "task"
needs = ["design-approved"]

[[steps]]
id = "spec-review"
title = "Spec self-review"
type = "task"
needs = ["write-spec"]

[[steps]]
id = "spec-approved"
title = "User reviews written spec"
type = "task"
needs = ["spec-review"]

[steps.gate]
type = "human"

[[steps]]
id = "implement"
title = "Implement {{topic}}"
type = "task"
needs = ["spec-approved"]

[[steps]]
id = "verify"
title = "Verify"
type = "task"
needs = ["implement"]

[[steps]]
id = "smoke-test-approved"
title = "Smoke test / manual QA sign-off"
type = "task"
needs = ["verify"]

[steps.gate]
type = "human"

[[steps]]
id = "finish"
title = "Finish development branch"
type = "task"
needs = ["smoke-test-approved"]
```

- [ ] **Step 2: Verify it cooks with no errors**

Run in a scratch beads-initialized directory (`mkdir -p /tmp/formula-check/.beads/formulas && cp formulas/superpowers-workflow.formula.toml /tmp/formula-check/.beads/formulas/ && cd /tmp/formula-check && bd init -q 2>&1 | tail -3`):

```bash
bd cook superpowers-workflow --var topic="test topic" --dry-run
```

Expected: 12 steps listed, `needs` chains matching the file above, three `[steps.gate]` blocks reported, no error output.

- [ ] **Step 3: Verify it pours with no epic/task boundary errors**

```bash
bd mol pour superpowers-workflow --var topic="test topic"
```

Expected: `✓ Poured mol: created 16 issues` (12 steps + 3 gate beads + the root — matches the live count observed during design; if the count differs, re-check step types before proceeding), no `"epics can only block..."` / `"tasks can only block..."` error.

- [ ] **Step 4: Commit**

```bash
git add formulas/superpowers-workflow.formula.toml package.json
git commit -m "feat: add superpowers-workflow beads formula"
```

---

### Task 2: `brainstorming` — pour molecule at start, existing-issue entry mode

**Files:**
- Modify: `skills/brainstorming/SKILL.md` (Checklist section, lines 40-51 in the current file; After the Design section, line 129)

**Interfaces:**
- Consumes: formula step ids from Task 1 (`explore`, `clarify`, `approaches`, `design`, `design-approved`).
- Produces: the poured molecule's root id and `implement` step id, which Task 3 (`writing-plans`) consumes to create dynamic task children.

- [ ] **Step 1: Replace the wisp-per-checklist-item instruction with pour + existing-issue linking**

Replace the current Checklist intro paragraph (the line beginning "You MUST create a wisp for each of these items...") with:

```markdown
**Starting from a fresh topic:** cook and pour the workflow formula to create the epic
this brainstorming session works against:

```bash
bd cook superpowers-workflow --var topic="<topic>" --persist
bd mol pour superpowers-workflow --var topic="<topic>"
```

Note the returned root issue id (the `Root issue:` line) — this is the molecule you work
against for the rest of this skill and for `writing-plans`/`executing-plans` afterward.

**Starting from an existing issue** (e.g. "brainstorm beads-kp0"): pour a new molecule as
above, seeding `--var topic="<existing issue's title>"`, then link the new root to the
existing issue without mutating it:

```bash
bd dep add <new-root-id> <existing-issue-id> --type discovered-from
```

If `discovered-from` is rejected by your `bd` version, use `--type related` instead — both
are non-blocking link types; do not use `blocks` here. Never change the existing issue's
type, parent, or status — it stays exactly what it was.

Each checklist item below corresponds to one formula step. Claim the step when you begin
it (`bd update <step-id> --claim`), work it, and close it (`bd close <step-id> --reason
"<one-line summary>"`) only once its real output actually exists in the conversation (see
the hard-gate above) — never close several in a row within the same turn. Step ids in
this molecule: `explore`, `clarify`, `approaches`, `design`, `design-approved` (a gate —
see After the Design below), then `write-spec`/`spec-review`/`spec-approved` continue
into spec work, handed off to `writing-plans` at `implement`.
```

- [ ] **Step 2: Map each checklist line to its formula step id**

Replace checklist items 1-4 (the numbered list beginning "1. **Explore project
context**") with:

```markdown
1. **Explore project context** (`bd update <explore-step-id> --claim`) — check files, docs, recent commits in the **user's current working directory** (not the skill's install directory — see `using-superpowers` → Working Directory). Close with `bd close <explore-step-id>` once done.
2. **Ask clarifying questions** (`bd update <clarify-step-id> --claim`) — one at a time, across as many turns as it takes, waiting for the user's actual reply each time, until you understand purpose/constraints/success criteria. Do not close this step after a single question.
3. **Propose 2-3 approaches** (`bd update <approaches-step-id> --claim`) — with trade-offs and your recommendation
4. **Present design** (`bd update <design-step-id> --claim`) — in sections scaled to their complexity, get user approval after each section
```

Leave items 5-8 (Write design doc / Spec self-review / User reviews written spec /
Transition to implementation) as prose — they map onto `write-spec`/`spec-review`/
`spec-approved`/`implement`, handled by Step 3 below and by Task 3's rewrite of
`writing-plans`.

- [ ] **Step 3: Rewrite "After the Design" as a verdict-driven revise/recheck loop, not a one-shot gate resolve**

Replace the current line beginning "Mark the brainstorm phase complete: close any
checklist wisps..." with:

```markdown
- After presenting the design, record the verdict on the `design-approved` step so a
  resumed session or the widget can see it without replaying the conversation:
  - Approved: `bd update <design-approved-id> --set-metadata review.verdict=done`,
    then resolve the gate so `write-spec` becomes ready:
    `bd gate resolve <design-approved-gate-id>` (find the gate id via
    `bd mol current <root-id> --json` — it's the `next_step` when `design` is closed
    and the gate hasn't resolved yet).
  - Changes requested: `bd update <design-approved-id> --set-metadata
    review.verdict=iterate`, then write a specific revision summary naming exactly
    which sections/assumptions/questions need another pass:
    `bd comment <design-approved-id> "<what needs to change>"`. Re-claim `design`
    (`bd update <design-step-id> --claim`) and loop back into Step 2's design-
    presentation work — do NOT resolve the gate. Never treat "changes requested" as
    an unstructured do-over: the revision summary is what the next pass reads before
    touching the design again.
  - On resume (new session, or picking this back up after a gap): read the design
    content already written (`bd show <design-step-id>`) plus the latest verdict and
    revision summary (`bd show <design-approved-id>`) before continuing — revise the
    existing design in place; never discard earlier answered questions, approach
    trade-offs, or already-approved sections.
  - Only `review.verdict=done` permits resolving the gate. If brainstorming stops
    early for any reason (blocked, redirected, session stopped) before a verdict is
    recorded, leave the current step's status as-is (open or in_progress) for the next
    session to resume — do not close steps whose real output doesn't exist yet.
```

- [ ] **Step 4: Verify**

Run: `grep -n "beads_create\|ephemeral" skills/brainstorming/SKILL.md`
Expected: no remaining references to per-checklist-item wisp creation (the skill now
references `bd update --claim`/`bd close`/`bd gate resolve` against formula step ids
instead).

- [ ] **Step 5: Commit**

```bash
git add skills/brainstorming/SKILL.md
git commit -m "feat: brainstorming pours the superpowers-workflow molecule"
```

---

### Task 3: `writing-plans` — dynamic task children under `implement`, `plan-approved` gate

**Files:**
- Modify: `skills/writing-plans/SKILL.md` (Overview wisp-creation line 18; Task Structure section 90-150; Execution Handoff section 188-212)

**Interfaces:**
- Consumes: `implement` step id (from the molecule Task 2 poured).
- Produces: task bead ids + `plan-approved` gate id, consumed by Task 4 (`executing-plans`) and Task 5 (`subagent-driven-development`).

- [ ] **Step 1: Replace the "create a wisp to track Planning" line**

Replace the line beginning "At the start of planning, create a wisp to track the
phase..." with:

```markdown
At the start of planning, claim the `implement` step of the molecule brainstorming
poured: `bd update <implement-step-id> --claim`. This is the container all real task
beads are created under.
```

- [ ] **Step 2: Add a self-review guard against lifecycle-duplicate tasks**

Add this to the plan document's existing Self-Review section (the checklist run before
tasks are wired into beads), as a new numbered item:

```markdown
4. **Lifecycle-duplicate check:** Does any task in this plan re-implement a phase the
   molecule already executes as its own formula step — e.g. a task titled "write the
   design doc," "get the spec approved," or "get the plan approved"? Those belong to
   `write-spec`/`spec-approved`/`plan-approved`, not to a task under `implement`. Any
   task that duplicates formula-owned work is a plan bug: remove it before wiring tasks
   into beads in Step 3 below.
```

- [ ] **Step 3: Add the plan-approved gate + dynamic task creation to Task Structure**

After the "## Task Structure" section's closing code fence (before "## Task
Separation"), add:

```markdown
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
```

- [ ] **Step 4: Rewrite Execution Handoff to close the gate-wiring work, not a wisp**

Replace the two "close the planning wisp..." lines (188 and the graceful-exit variant)
with:

```markdown
After the task beads and `plan-approved` gate are created and wired, the `implement`
step's own claim is left open on purpose — it stays `in_progress`, representing the
whole implementation phase, until every task bead under it closes (see `executing-plans`
Step 3, "Rewrite Complete Development"). Nothing further to close here; the plan is now
the bead graph itself.

Also update the two now-stale plan-file references elsewhere in this skill so nothing
contradicts the "plan.md is retired" design: replace line 26's
`**Save plans to:** \`docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md\`` with
`**Plan output:** dynamic task beads under the molecule's \`implement\` step (see
"Creating Tasks as Beads" below) — no markdown plan file is written.`, and replace the
Boundaries line `- Write to docs/superpowers/plans/: yes` with
`- Write to docs/superpowers/plans/: no (plan output is beads, not a file)`.

If planning stops early for any reason (blocked, redirected, session stopped), leave
`implement` and any partially-created task beads as-is — the next session resumes by
reading `bd mol show <implement-step-id>` to see what's already wired.
```

- [ ] **Step 5: Update the execution-handoff prose to point at the molecule, not a filename**

Replace the "Plan complete and saved to `docs/superpowers/plans/<filename>.md`" handoff
message with:

```markdown
**"Plan complete — <N> tasks created under `<implement-step-id>`, gated by
`<plan-approved-gate-id>`. Once you approve, I'll record `review.verdict=done` and
resolve the gate to unblock execution (see Step 3's verdict recording). Two execution
options:**
```

- [ ] **Step 6: Verify**

Run: `grep -n "docs/superpowers/plans\|ephemeral" skills/writing-plans/SKILL.md`
Expected: no remaining references to writing a plan markdown file or creating a wisp —
only the bead-creation commands from Step 3 and the molecule-based handoff from Step 5.

- [ ] **Step 7: Commit**

```bash
git add skills/writing-plans/SKILL.md
git commit -m "feat: writing-plans creates dynamic task beads under implement"
```

---

### Task 4: `executing-plans` — molecule-driven execution loop

**Files:**
- Modify: `skills/executing-plans/SKILL.md` (Step 1 "Load and Review Plan" lines 27-35; Step 2 "Execute Batch" lines 36-44; Step 5 "Complete Development" lines 58-63)

**Interfaces:**
- Consumes: `implement` step id, `plan-approved` gate id, task bead ids (from Task 3).
- Produces: none (terminal consumer of the molecule for this plan's scope).

- [ ] **Step 1: Rewrite "Load and Review Plan" to read the molecule instead of a file**

Replace Step 1's four numbered lines with:

```markdown
1. Load the molecule: `bd mol current <implement-step-id> --json` — this returns every
   task bead's status and the current/next step, replacing "read plan file."
2. Review critically — read each task bead's full description
   (`bd show <task-id>`) and identify any questions or concerns about the plan.
3. If concerns: Raise them with your human partner before starting.
4. If no concerns: confirm the `plan-approved` gate is resolved
   (`bd show <plan-approved-gate-id>` — status should be `closed`; if not, stop and ask
   the human to run `bd gate resolve <plan-approved-gate-id>` before proceeding).
```

- [ ] **Step 2: Rewrite "Execute Batch" to use claim/close instead of TaskUpdate-style status**

Replace Step 2's four numbered lines with:

```markdown
For each task, working the ready frontier (`bd ready --mol <implement-step-id>` shows
what's unblocked right now):
1. Claim it: `bd update <task-id> --claim` (atomically sets assignee + `in_progress`).
2. Follow the task bead's full description exactly (it holds the same bite-sized steps a
   plan.md task body used to hold).
3. Run verifications as specified in the description.
4. Close it: `bd close <task-id> --reason "<what was done>"` — this unblocks whatever
   depended on it; re-run `bd ready --mol <implement-step-id>` to see the next batch.
```

- [ ] **Step 3: Rewrite "Complete Development" to close `implement` and advance to `verify`**

Replace Step 5's line "After all tasks complete and verified:" block's lead-in with:

```markdown
After all tasks complete and verified — confirm with `bd ready --mol
<implement-step-id>` returning empty — close the `implement` step itself
(`bd close <implement-step-id> --reason "all tasks complete"`), which unblocks `verify`.
Claim `verify` (`bd update <verify-step-id> --claim`) and proceed to that work before the
finishing-a-development-branch handoff below.
```

- [ ] **Step 4: Update the "When to Stop and Ask for Help" blocked-task guidance**

Replace the line beginning "If you stop on a blocker or abort mid-batch..." with:

```markdown
If you stop on a blocker or abort mid-batch, do not silently leave the current task bead
in `in_progress`: mark it `blocked` (`bd update <task-id> --status blocked` with a
`bd comment <task-id> "<blocker>"` explaining why), or leave it `in_progress` for resume,
and on resume re-claim it (`bd update <task-id> --claim`) to continue.
```

- [ ] **Step 5: Verify**

Run: `grep -n "read plan file\|TaskUpdate\|plan\.md" skills/executing-plans/SKILL.md`
Expected: no output — every reference to reading a plan file or TaskUpdate-style status
is gone.

- [ ] **Step 6: Commit**

```bash
git add skills/executing-plans/SKILL.md
git commit -m "feat: executing-plans drives the implement molecule via bd ready/claim/close"
```

---

### Task 5: `subagent-driven-development` — same molecule loop, batch-dispatch variant

**Files:**
- Modify: `skills/subagent-driven-development/SKILL.md` (setup section lines 155-160; task-loop completion lines 375-377)

**Interfaces:**
- Consumes: same molecule ids as Task 4.
- Produces: none.

- [ ] **Step 1: Rewrite the setup section to read the molecule instead of creating tasks**

Replace the paragraph beginning "Read the plan once, note its context and Global
Constraints, and create a beads issue per plan task..." with:

```markdown
Read the molecule once (`bd mol current <implement-step-id> --json`), note its context
and Global Constraints from each task bead's description, and confirm the
`plan-approved` gate is closed (`bd show <plan-approved-gate-id>`) before dispatching any
subagent. Task ids and their `needs` ordering already exist as real dependency edges —
no `TaskCreate`-equivalent step is needed here; `writing-plans` already created them
(see its Task Structure section).
```

- [ ] **Step 2: Rewrite the task-loop completion line**

Replace the line "Then close the task via `beads_close({ ids: "<id>" })` and move on.
Never" with:

```markdown
Then close the task bead (`bd close <task-id> --reason "<summary>"`) and move on. Never
```

- [ ] **Step 3: Verify**

Run: `grep -n "TaskCreate\|TaskUpdate\|beads_create.*Task N" skills/subagent-driven-development/SKILL.md`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add skills/subagent-driven-development/SKILL.md
git commit -m "feat: subagent-driven-development reads the implement molecule directly"
```

---

### Task 6: `test-driven-development` / `verification-before-completion` — map onto verify/smoke-test-approved/finish

**Files:**
- Modify: `skills/test-driven-development/SKILL.md` (phase-wisp lines ~18, ~255)
- Modify: `skills/verification-before-completion/SKILL.md` (phase-wisp lines ~25, ~133)

**Interfaces:**
- Consumes: `verify`, `smoke-test-approved`, `finish` step ids.
- Produces: none (terminal steps for this plan's scope).

- [ ] **Step 1: Rewrite `test-driven-development`'s phase-tracking line**

Replace the line beginning "**Track the phase:** when the TDD implementation cycle
begins, create a wisp..." with:

```markdown
**Track the phase:** this skill's TDD cycles happen inside individual task beads
(claimed via `bd update <task-id> --claim` per `executing-plans`) — no separate wisp is
created here.
```

Replace the line beginning "When the TDD implementation cycle is complete..." with:

```markdown
When the TDD implementation cycle is complete for a given task (all tests green, code
committed), close that task bead per `executing-plans` Step 2 — this skill doesn't own
its own close step.
```

Also replace the now-orphaned graceful-exit line right after it, which still references
the old wisp model ("If the cycle does not complete for any reason (blocked, redirected,
stopped early), close the implement wisp you created..."), with:

```markdown
If the cycle does not complete for any reason (blocked, redirected, stopped early), do
not close the task bead — leave it `in_progress` (or mark it `blocked` via `bd update
<task-id> --status blocked` with a `bd comment` explaining why) for `executing-plans` to
resume, per its own blocked-task guidance.
```

- [ ] **Step 2: Rewrite `verification-before-completion`'s phase-tracking line**

Replace the line beginning "When verification begins, create a wisp..." with:

```markdown
When verification begins, claim the molecule's `verify` step: `bd update <verify-step-id> --claim`.
```

Replace the line beginning "When all verification passes, close the verify wisp you
created..." (and the adjacent "If verification does not complete for any reason..."
graceful-exit line right after it) with:

```markdown
When all verification passes, close the `verify` step (`bd close <verify-step-id>
--reason "verification passed"`), which unblocks `smoke-test-approved`. That gate needs a
human to actually run/confirm the smoke test before resolving it
(`bd gate resolve <smoke-test-approved-gate-id>`) — announce this to the user rather than
resolving it yourself. Once resolved, claim and work `finish`
(`bd update <finish-step-id> --claim`), handing off to
`/skill:finishing-a-development-branch` as today.

If verification does not complete for any reason (blocked, redirected, stopped early),
do not close the `verify` step — leave it `in_progress` for the next session to resume,
or mark it `blocked` (`bd update <verify-step-id> --status blocked` with a `bd comment`
explaining why) if you're certain it can't proceed as-is.
```

- [ ] **Step 3: Verify**

Run: `grep -n "ephemeral\|create a wisp" skills/test-driven-development/SKILL.md skills/verification-before-completion/SKILL.md`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add skills/test-driven-development/SKILL.md skills/verification-before-completion/SKILL.md
git commit -m "feat: TDD/verification skills advance verify/smoke-test-approved/finish steps"
```

---

### Task 7: Reference docs + formula-copy bootstrap in `using-superpowers`

**Files:**
- Modify: `skills/using-superpowers/SKILL.md` (add a formula-bootstrap check near the existing "Session Start: beads cleanup" section)
- Modify: `skills/using-superpowers/references/pi-tools.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the formula file path from Task 1.
- Produces: none.

- [ ] **Step 1: Add formula-bootstrap check to `using-superpowers`**

In `skills/using-superpowers/SKILL.md`, immediately after the existing "## Session
Start: beads cleanup" section's numbered list (before the next `##` heading), add:

```markdown
5. Confirm the superpowers workflow formula is available in this project:
   `bd formula list | grep superpowers-workflow`. If missing, copy it in from this
   package's bundled copy (`formulas/superpowers-workflow.formula.toml` inside
   the installed `pi-superpowers-plus` package directory) into the project's
   `.beads/formulas/superpowers-workflow.formula.toml`, then re-run
   `bd formula list` to confirm it's now visible. Never overwrite an existing formula
   file of the same name — a user-customized formula takes precedence.
```

- [ ] **Step 2: Rewrite `pi-tools.md`'s tracking description**

Replace the beads row's description text (the bullet list following the tools table) to
add, after the existing "Repo routing" bullet:

```markdown
- **Structural workflow:** brainstorm → design → plan → implement → verify → finish is
  modeled as a beads molecule poured from the bundled `superpowers-workflow` formula
  (`bd cook`/`bd mol pour`), not tracked via ad hoc wisps. Skills advance it with bare
  `bd` calls (`bd update --claim`, `bd close`, `bd gate resolve`, `bd ready --mol`) —
  see `docs/superpowers/specs/2026-09-02-beads-as-persistence-layer-design.md` for the
  full step graph.
```

- [ ] **Step 3: Update README's workflow-progress paragraph**

Replace the paragraph describing task tracking via beads tools (the one beginning
"Progress through the workflow is tracked with the beads tools...") with:

```markdown
Progress through the workflow is tracked as a real beads molecule — a dependency graph
poured from a formula, with human-approval gates as first-class nodes (design, spec, plan,
and smoke-test sign-off) instead of prose instructions. Plan tasks are beads with their
full instructions in the `description` field, not a separate markdown plan file; the spec
document remains a markdown file, linked from its bead via `--spec-id` for traceability.
This package's own molecule widget renders the active pipeline's current/next step above
the editor.
```

- [ ] **Step 4: Add CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]`, add a new `### Changed` bullet:

```markdown
- **Structural persistence moved from markdown plan files to a beads molecule.**
  Brainstorming pours a `superpowers-workflow` formula into a real epic; plan tasks are
  beads with full instructions in their descriptions (no more
  `docs/superpowers/plans/*.md`); execution reads `bd ready --mol`/`bd mol current`
  instead of parsing checkboxes. Spec documents remain markdown files for diffability,
  linked from their bead via `--spec-id`. See
  `docs/superpowers/specs/2026-09-02-beads-as-persistence-layer-design.md`.
```

- [ ] **Step 5: Verify**

```bash
grep -n "superpowers-workflow" skills/using-superpowers/SKILL.md skills/using-superpowers/references/pi-tools.md CHANGELOG.md
grep -n "beads molecule" README.md
```
Expected: at least one match in each of `using-superpowers/SKILL.md`, `pi-tools.md`, and
`CHANGELOG.md` for "superpowers-workflow"; at least one match in `README.md` for "beads
molecule" (the README's verbatim replacement text describes the mechanism without naming
the formula literally — checking for "beads molecule" is the correct proxy there).

- [ ] **Step 6: Commit**

```bash
git add skills/using-superpowers/SKILL.md skills/using-superpowers/references/pi-tools.md README.md CHANGELOG.md
git commit -m "docs: describe the beads-molecule workflow and formula bootstrap"
```

---

### Task 8: molecule widget — pure state fetch + render function

**Files:**
- Create: `extensions/beads-molecule-widget.mjs` (pure parser + render function, plain JS so it's trivially unit-testable without a TS build step)
- Create: `extensions/beads-molecule-widget.test.mjs`

**Interfaces:**
- Consumes: `bd mol current --json` output shape (documented inline below).
- Produces: `parseMoleculeCurrent(json)` and `moleculeWidgetLines(state, width, theme)`, consumed by Task 9's `extensions/beads-molecule-widget.ts`.

- [ ] **Step 1: Write the failing test**

Create `extensions/beads-molecule-widget.test.mjs`:

```js
import assert from "node:assert/strict";
import { parseMoleculeCurrent, moleculeWidgetLines } from "./beads-molecule-widget.mjs";

// ---------- parser: malformed input never throws ----------
assert.deepEqual(parseMoleculeCurrent(""), null);
assert.deepEqual(parseMoleculeCurrent("not json"), null);
assert.deepEqual(parseMoleculeCurrent("[]"), null);

// ---------- parser: happy path ----------
const RAW = JSON.stringify([
  {
    molecule_id: "bd-mol-g0z",
    molecule_title: "superpowers-workflow",
    current_step: {
      id: "bd-mol-1vz",
      title: "Ask clarifying questions",
      status: "in_progress",
      issue_type: "task",
      started_at: "2026-09-02T15:34:18Z",
    },
    next_step: {
      id: "bd-mol-8y2",
      title: "Gate: human",
      issue_type: "gate",
    },
    steps: [
      { issue: { id: "bd-mol-meq", issue_type: "task" }, status: "done" },
      { issue: { id: "bd-mol-1vz", issue_type: "task" }, status: "current" },
      { issue: { id: "bd-mol-8y2", issue_type: "gate" }, status: "ready" },
      { issue: { id: "bd-mol-9ev", issue_type: "task" }, status: "pending" },
    ],
  },
]);
const parsed = parseMoleculeCurrent(RAW);
assert.equal(parsed.molecule_id, "bd-mol-g0z");
assert.equal(parsed.doneCount, 1);
assert.equal(parsed.total, 4);
assert.equal(parsed.current_step.title, "Ask clarifying questions");

// ---------- render: nothing to draw ----------
assert.deepEqual(moleculeWidgetLines(null, 80), []);
assert.deepEqual(moleculeWidgetLines(parsed, 0), []);

// ---------- render: header + current step ----------
const lines = moleculeWidgetLines(parsed, 80);
assert.ok(lines[0].includes("superpowers-workflow"));
assert.ok(lines[0].includes("1/4"));
assert.ok(lines.some((l) => l.includes("Ask clarifying questions")));

// ---------- render: gate-as-current gets the waiting glyph ----------
const gateCurrent = {
  ...parsed,
  current_step: { id: "bd-mol-8y2", title: "Gate: human", issue_type: "gate" },
};
const gateLines = moleculeWidgetLines(gateCurrent, 80);
assert.ok(gateLines.some((l) => l.includes("Waiting on you")));

// ---------- render: pending count folds into one row ----------
assert.ok(lines.some((l) => l.includes("pending")));

// ---------- phase label mapping ----------
const explorePhase = {
  ...parsed,
  current_step: { id: "bd-mol-meq", title: "Explore project context: x", issue_type: "task", formula_step_id: "explore" },
};
assert.ok(moleculeWidgetLines(explorePhase, 80)[0].includes("Brainstorming"));

console.log("beads-molecule-widget: all assertions passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extensions/beads-molecule-widget.test.mjs`
Expected: FAIL — `Cannot find module './beads-molecule-widget.mjs'`.

- [ ] **Step 3: Implement the parser and render function**

Create `extensions/beads-molecule-widget.mjs`:

```js
/**
 * Pure parsing + rendering for the superpowers molecule widget.
 * Plain JS (no TS) so it's directly runnable/testable by node.
 */

// ---- minimal display-width + truncation + paint-after-cut helpers ----
// (self-contained here rather than depending on another package's internals;
// the width-safety rule is: measure the plain-text twin, only paint fragments
// after they've already been cut to width.)
function charWidth(cp) {
  if (cp === 0x200d) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1f300 && cp <= 0x1f9ff)) return 2;
  return 1;
}
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
  return w;
}
export function truncToWidth(s, width) {
  s = String(s);
  if (width <= 0) return "";
  if (displayWidth(s) <= width) return s;
  const budget = width - 1;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + "\u2026";
}
function assemble(frags, width) {
  let used = 0;
  let text = "";
  for (const f of frags) {
    if (!f.text) continue;
    if (used >= width) break;
    const piece = truncToWidth(f.text, width - used);
    if (!piece) break;
    text += f.paint ? f.paint(piece) : piece;
    used += displayWidth(piece);
  }
  return { text, width: used };
}
export function formatAge(startedAt, now = Date.now()) {
  const t = Date.parse(startedAt ?? "");
  if (!Number.isFinite(t)) return "";
  const min = Math.floor((now - t) / 60000);
  if (!Number.isFinite(min) || min < 0) return "";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const PHASE_MAP = {
  explore: "Brainstorming",
  clarify: "Brainstorming",
  approaches: "Brainstorming",
  design: "Brainstorming",
  "design-approved": "Brainstorming",
  "write-spec": "Spec",
  "spec-review": "Spec",
  "spec-approved": "Spec",
  implement: "Implementing",
  verify: "Verifying",
  "smoke-test-approved": "Verifying",
  finish: "Finishing",
};
function phaseOf(step) {
  if (!step) return "Working";
  return PHASE_MAP[step.formula_step_id] ?? "Implementing";
}

/** Parse `bd mol current --json` output. Returns null on any malformed input. */
export function parseMoleculeCurrent(json) {
  let arr;
  try {
    const text = typeof json === "string" ? json.trim() : json;
    arr = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  const obj = Array.isArray(arr) ? arr[0] : arr;
  if (!obj || !obj.molecule_id || !Array.isArray(obj.steps)) return null;
  const doneCount = obj.steps.filter((s) => s.status === "done").length;
  return {
    molecule_id: obj.molecule_id,
    molecule_title: obj.molecule_title ?? "",
    current_step: obj.current_step ?? null,
    next_step: obj.next_step ?? null,
    steps: obj.steps,
    doneCount,
    total: obj.steps.length,
  };
}

const PLAIN_FG = (_c, t) => t;
function themeOf(theme) {
  return theme && typeof theme.fg === "function" ? (c, t) => theme.fg(c, t) : PLAIN_FG;
}

/** Render the molecule widget. Returns [] when there's nothing to draw. */
export function moleculeWidgetLines(state, width, theme) {
  const fg = themeOf(theme);
  if (!state || !Array.isArray(state.steps) || state.steps.length === 0 || !(width > 0))
    return [];

  const phase = phaseOf(state.current_step ?? state.next_step);
  const header = assemble(
    [
      { text: "\u29BF ", paint: (t) => fg("accent", t) },
      { text: phase, paint: (t) => fg("accent", t) },
      {
        text: ` \u00b7 ${state.molecule_title} \u00b7 ${state.doneCount}/${state.total}`,
        paint: (t) => fg("muted", t),
      },
    ],
    width,
  );

  const rows = [];
  if (state.current_step) {
    const isGate = state.current_step.issue_type === "gate";
    const age = state.current_step.started_at ? formatAge(state.current_step.started_at) : "";
    rows.push(
      assemble(
        [
          { text: isGate ? "\u23f8 " : "\u25d0 ", paint: (t) => fg("warning", t) },
          { text: isGate ? "Waiting on you: " : "", paint: (t) => fg("warning", t) },
          { text: state.current_step.title ?? "", paint: (t) => fg("text", t) },
          { text: age ? `  ${age}` : "", paint: (t) => fg("dim", t) },
        ],
        width,
      ).text,
    );
  } else if (state.next_step) {
    rows.push(
      assemble(
        [
          { text: "\u25e6 Next: ", paint: (t) => fg("dim", t) },
          { text: state.next_step.title ?? "", paint: (t) => fg("text", t) },
        ],
        width,
      ).text,
    );
  }

  const pendingCount = state.steps.filter(
    (s) => s.status === "blocked" || s.status === "pending",
  ).length;
  if (pendingCount > 0) rows.push(fg("dim", truncToWidth(`+${pendingCount} pending`, width)));

  return [header.text, ...rows].filter(Boolean);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extensions/beads-molecule-widget.test.mjs`
Expected: PASS, all assertions succeed.

- [ ] **Step 5: Commit**

```bash
git add extensions/beads-molecule-widget.mjs extensions/beads-molecule-widget.test.mjs
git commit -m "feat: molecule widget parser + pure render function"
```

---

### Task 9: molecule widget — extension registration + refresh hooks

**Files:**
- Create: `extensions/beads-molecule-widget.ts`
- Modify: `package.json` (`pi.extensions` array, if it lists files individually rather than the directory)

**Interfaces:**
- Consumes: `parseMoleculeCurrent`, `moleculeWidgetLines` from Task 8.
- Produces: none (terminal consumer — the registered extension itself).

- [ ] **Step 1: Write the extension file**

Create `extensions/beads-molecule-widget.ts`, modeled directly on the existing
`extensions/set-phase.ts` in this same directory for style (default-export factory,
`ExtensionAPI` type import) but registering event hooks instead of a tool:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseMoleculeCurrent, moleculeWidgetLines } from "./beads-molecule-widget.mjs";

export default function (pi: ExtensionAPI) {
  let uiRef: any = null;
  let activeMolecule: ReturnType<typeof parseMoleculeCurrent> | null = null;

  // No timers, ever: refreshed at session_start and every agent_start. Skills run bare
  // `bd cook`/`bd mol pour`/`bd dep add`/`bd create --parent` outside any tool call this
  // extension could hook, so a per-turn safety-net read is required, not optional.
  async function refreshMolecule(cwd: string): Promise<void> {
    const r = await pi.exec("bd", ["mol", "current", "--json"], {
      cwd,
      timeout: 5000,
    });
    if (!r || r.code !== 0) {
      // only clear on a clean "no active molecule" signal, never on a transient
      // failure — an unreachable `bd` binary should not blank a widget that was
      // showing real progress a moment ago.
      if (r && /no active molecule|not found/i.test(r.stderr ?? "")) activeMolecule = null;
      return;
    }
    const parsed = parseMoleculeCurrent(r.stdout);
    if (parsed) activeMolecule = parsed;
  }

  function renderMolecule() {
    try {
      if (!uiRef?.setWidget) return;
      if (!activeMolecule) {
        uiRef.setWidget("beads-mol", undefined);
        return;
      }
      uiRef.setWidget(
        "beads-mol",
        (_tui: any, theme: any) => ({
          render: (width: number) =>
            moleculeWidgetLines(activeMolecule, width - 1, uiRef?.theme ?? theme).map(
              (l: string) => ` ${l}`,
            ),
          invalidate: () => {},
        }),
        { placement: "aboveEditor" },
      );
    } catch {
      /* ui may be unavailable in non-interactive runs — never fatal */
    }
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    uiRef = ctx?.ui ?? null;
    const cwd = ctx?.cwd ?? process.cwd();
    void refreshMolecule(cwd).then(
      () => renderMolecule(),
      () => {
        /* bd missing/broken -> widget just stays empty */
      },
    );
  });

  pi.on("agent_start", async (_event: any, ctx: any) => {
    const cwd = ctx?.cwd ?? process.cwd();
    void refreshMolecule(cwd).then(
      () => renderMolecule(),
      () => {},
    );
  });
}
```

- [ ] **Step 2: Confirm the extension is picked up by the package's extension loader**

```bash
grep -A3 '"extensions"' package.json
```

Expected: `"extensions": ["./extensions"]` — a directory reference, meaning pi's loader
picks up every extension file in that directory automatically and no `package.json`
change is needed. If the loader instead lists files individually, add
`"./extensions/beads-molecule-widget.ts"` alongside the existing
`"./extensions/set-phase.ts"` entry.

- [ ] **Step 3: Manual smoke test**

In a scratch project with the formula from Task 1 poured and a step claimed:

```bash
cd /tmp/formula-check
bd update <explore-step-id> --claim
```

Start a pi session in that directory with this package installed; confirm the
`beads-mol` widget renders above the editor showing "Brainstorming · superpowers-workflow ·
0/N" and the claimed step's title. Close the step and start a new turn; confirm the
widget's progress count updates without any manual refresh action, and that closing the
molecule's last step causes the widget to clear.

- [ ] **Step 4: Verify**

```bash
npx biome check extensions/
node --test extensions/beads-molecule-widget.test.mjs
```
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/beads-molecule-widget.ts package.json
git commit -m "feat: register the molecule widget extension"
```

---

### Task 10: CHANGELOG + version bump

**Files:**
- Modify: `package.json` (version field)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: none.
- Produces: none (release bookkeeping).

- [ ] **Step 1: Bump the package version**

Check the current version and bump the minor: `grep '"version"' package.json` (this
plan does not hardcode the current value since Tasks 1-7 may land first and change it) —
increment the minor component (new widget surface, no breaking change to any existing
skill-facing interface).

- [ ] **Step 2: Add CHANGELOG entry for the widget**

In `CHANGELOG.md`, under `## [Unreleased]`, add to the `### Changed` bullet from Task 7
Step 4 (or as a new adjacent bullet if that entry already landed and is no longer
`[Unreleased]`):

```markdown
- **New molecule widget** (`extensions/beads-molecule-widget.ts`) renders the active
  superpowers molecule's pipeline state (current phase, current/next step, pending
  count) above the editor — shells out to `bd mol current --json` directly via
  `pi.exec`, refreshed at session start and every turn (no polling).
```

- [ ] **Step 3: Verify**

```bash
npx biome check .
node --test extensions/beads-molecule-widget.test.mjs
```
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: version bump for the molecule widget"
```

---

## Verification

- **Formula + skills:** `npx biome check .` passes; grep fences in Tasks 2-7's verify
  steps all return empty/expected output; `bd cook superpowers-workflow --dry-run` and
  `bd mol pour` succeed against the formula from Task 1 (re-verify after any skill
  wording changes, since the formula file itself doesn't change after Task 1).
- **Widget:** `node --test extensions/beads-molecule-widget.test.mjs` passes; manual
  smoke test from Task 9 Step 3 confirms the widget renders and updates live in a real
  pi session, with no dependency on any other installed package.
- **End-to-end (manual, not automated by this plan):** run a full brainstorm → design →
  plan → implement → verify → finish cycle in a scratch project with this package
  installed, confirming every gate actually blocks progress until resolved and the
  widget tracks the pipeline correctly throughout.
