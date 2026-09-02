# Beads Migration (pi-tasks → pi-beads fork) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all `@tintinweb/pi-tasks` references from the extension's skills and docs, replacing them with `beads_*` tool calls (forked pi-beads) — persistent issues for durable plan-step tracking, self-owned wisps for session phase bookkeeping.

**Architecture:** Six `SKILL.md` files get their tracking calls rewritten. Durable plan-step skills (`executing-plans`, `subagent-driven-development`) create **persistent** beads issues per plan step (`beads_create` without `ephemeral`), mark `in_progress` via `beads_update`, close via `beads_close`, and wire ordering via `beads_dep`. Phase-bookkeeping skills (`brainstorming`, `writing-plans`, `test-driven-development`, `verification-before-completion`) each own a **wisp** (`beads_create({ ..., ephemeral: true })`) that they create at phase start and close at completion. Reference docs (`pi-tools.md`, `README.md`, `CHANGELOG.md`) are rewritten to name the forked pi-beads instead of pi-tasks.

**Tech Stack:** Markdown skill/docs editing only — no TypeScript, no runtime code. Verification is a grep fence (no `TaskCreate`/`TaskUpdate`/`TaskList`/`pi-tasks` remains) plus `npx biome check .` (limited coverage — see Global Constraints).

**Design spec:** `docs/superpowers/specs/2026-08-26-beads-migration-design.md`

## Global Constraints

- **No pi-tasks tokens anywhere except historical CHANGELOG entries:** `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TaskOutput`, `TaskStop`, `TaskExecute`, and the string `pi-tasks` must not appear in `skills/**`, `README.md`, or `skills/using-superpowers/references/pi-tools.md`. Historical CHANGELOG entries (the 2026-07-29 migration record) are untouched and may mention pi-tasks.
- **Canonical call shapes — use these verbatim in every heading/prose edit:**
  - Persistent issue: `beads_create({ title: "…", description: "…" })` — no `ephemeral` flag.
  - Wisp: `beads_create({ title: "…", ephemeral: true })`.
  - In-progress: `beads_update({ id: "<id>", status: "in_progress" })`.
  - Close: `beads_close({ ids: "<id>" })` (accepts multiple space/comma-separated ids).
  - Dependency: `beads_dep({ issue: "<dependent>", blocker: "<prerequisite>" })` (blocker must be done before issue).
- **Repo routing rule (stated once, near `beads_create` intro text, in README + pi-tools.md):** omit `repo` to target the session cwd's repo; from an umbrella root pass the owning repo explicitly. Skills never hardcode a repo name.
- **One status transition everywhere:** completion is always `beads_close`, never `beads_update` to a "completed" status (beads has none). Persistent-vs-wisp lives only in the `ephemeral` flag at creation.
- **Python-agnostic note:** this is a docs-only change; each task's deliverable is verified by the grep fence + a read of the modified lines, not by running tests.
- `pi-subagents` / the `Agent` tool are untouched.
- Verification: `npx biome check .` passes (exit 0) — note `biome.json` excludes `**/*.md`, `**/*.json`, `**/docs`, and no `.ts`/`.js` remain, so biome is a trivial gate; the grep fence below is the real check.
- **Intentional deferred value:** `<forked-pi-beads-package>` (appears in pi-tools.md/README install commands and the README `packages:` array) is the one deliberately-unfilled value — the user is forking pi-beads into their own monorepo and the exact install spec isn't chosen yet. Replace it with the real package spec when the fork is published; do not invent one.
- **Check-only, no edit expected:** `AGENTS.md` and `CLAUDE.md` already carry the managed beads directive ("Use `bd` for ALL task tracking — do NOT use ... TaskCreate") — verify the block is present and not stale, but do not edit. `package.json` never listed pi-tasks (user-managed prerequisite) — confirm no manifest change is required.

---

### Task 1: Durable plan-step tracking → persistent beads issues

**Files:**
- Modify: `skills/executing-plans/SKILL.md` (lines 31-33, 38, 41)
- Modify: `skills/subagent-driven-development/SKILL.md` (lines 155-160, 375-377)

**Interfaces:**
- Consumes: none.
- Produces: canonical `beads_create` / `beads_update` / `beads_close` / `beads_dep` shapes now taught in the durable-tracking skills; Tasks 2-4 reuse the same shapes (Global Constraints).

- [ ] **Step 1: Rewrite `executing-plans` Step 1 (create issues per plan task)**

In `skills/executing-plans/SKILL.md`, replace lines 31-33:

```markdown
4. If no concerns: Create a task per plan task via `TaskCreate({ subject:
   "Task N: <name>", description: "<one-line summary>" })` and proceed
```

with:

```markdown
4. If no concerns: Create a beads issue per plan task via `beads_create({
   title: "Task N: <name>", description: "<one-line summary>" })` (persistent —
   no `ephemeral` flag). Note each returned id; you'll pass it to
   `beads_update` / `beads_close` as the task proceeds, then proceed.
```

- [ ] **Step 2: Rewrite `executing-plans` Step 2 (in_progress + close)**

In `skills/executing-plans/SKILL.md`, replace line 38:

```markdown
1. Update task status via `TaskUpdate({ taskId: <id>, status: "in_progress" })`
```

with:

```markdown
1. Mark the task in progress via `beads_update({ id: "<id>", status: "in_progress" })`
```

and replace line 41:

```markdown
4. Update task status via `TaskUpdate({ taskId: <id>, status: "completed" })`
```

with:

```markdown
4. Close the task via `beads_close({ ids: "<id>" })` — beads has no
   "completed" status; completion is a closed persistent issue
```

- [ ] **Step 3: Rewrite `subagent-driven-development` setup (create + deps)**

In `skills/subagent-driven-development/SKILL.md`, replace lines 155-160:

```markdown
Read the plan once, note its context and Global Constraints, and create a
task per plan task via `TaskCreate({ subject: "Task N: <name>", description:
"<one-line summary>" })` — one `TaskCreate` call per task. Note each returned
task ID; you'll pass it to `TaskUpdate` when the task is complete. If the
plan states tasks depend on each other, wire those with `addBlockedBy` on the
dependent task's `TaskUpdate` (or `addBlocks` on the prerequisite).
```

with:

```markdown
Read the plan once, note its context and Global Constraints, and create a
beads issue per plan task via `beads_create({ title: "Task N: <name>",
description: "<one-line summary>" })` — one `beads_create` call per task,
persistent (no `ephemeral` flag). Note each returned id; you'll pass it to
`beads_update` / `beads_close` as the task is worked. If the plan states tasks
depend on each other, wire those with `beads_dep({ issue: "<dependent>",
blocker: "<prerequisite>" })` (blocker must be done before issue).
```

- [ ] **Step 4: Rewrite `subagent-driven-development` task-loop completion**

In `skills/subagent-driven-development/SKILL.md`, replace lines 375-377:

```markdown
Then mark the task complete via `TaskUpdate({ taskId: <id>, status:
"completed" })` and move on. Never
```

with:

```markdown
Then close the task via `beads_close({ ids: "<id>" })` and move on. Never
```

- [ ] **Step 5: Verify + commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-superpowers-plus/beads
grep -n "TaskCreate\|TaskUpdate\|TaskList\|pi-tasks\|addBlockedBy\|addBlocks" \
  skills/executing-plans/SKILL.md skills/subagent-driven-development/SKILL.md
# Expected: no output
npx biome check .
git add skills/executing-plans/SKILL.md skills/subagent-driven-development/SKILL.md
git commit -m "feat: swap plan-step tracking to persistent beads issues"
```

---

### Task 2: Phase bookkeeping → self-owned wisps

**Files:**
- Modify: `skills/brainstorming/SKILL.md` (line 42, 129)
- Modify: `skills/writing-plans/SKILL.md` (after line 18; line 188)
- Modify: `skills/test-driven-development/SKILL.md` (after line 20; line 255)
- Modify: `skills/verification-before-completion/SKILL.md` (after Boundaries block, line 25; line 133)

**Interfaces:**
- Consumes: wisp shape `beads_create({ title: "…", ephemeral: true })` from Global Constraints.
- Produces: the self-owned-wisp pattern (create at phase start → close at completion) for Tasks 3-4 docs to describe.

- [ ] **Step 1: Rewrite `brainstorming` checklist wisp creation**

In `skills/brainstorming/SKILL.md`, replace line 42:

```markdown
You MUST create a task for each of these items and complete them in order. Only mark a task complete once its real output actually exists in the conversation (see the hard-gate above) — never mark several in a row within the same turn.
```

with:

```markdown
You MUST create a wisp for each of these items via `beads_create({ title: "<checklist item>", description: "<item detail>", ephemeral: true })` and complete them in order. Only `beads_close({ ids: "<id>" })` an item once its real output actually exists in the conversation (see the hard-gate above) — never close several in a row within the same turn.
```

- [ ] **Step 2: Rewrite `brainstorming` phase-complete marker**

In `skills/brainstorming/SKILL.md`, replace line 129:

```markdown
- Mark the brainstorm phase complete: call `TaskUpdate({ taskId: <id>, status: "completed" })` for the current phase's task (the task ID comes from whatever task list the invoking context already created — pi-tasks has no implicit "current task" pointer)
```

with:

```markdown
- Mark the brainstorm phase complete: close all remaining checklist wisps in one call — `beads_close({ ids: "<id-1> <id-2> ..." })` (multiple space/comma-separated ids are accepted)
```

- [ ] **Step 3: Add wisp creation to `writing-plans` start**

In `skills/writing-plans/SKILL.md`, after line 18 (`Call `set_phase({ phase: "writing plan" })``), add:

```markdown

At the start of planning, create a wisp to track the phase: `beads_create({ title: "Planning", ephemeral: true })` — note the returned id.
```

- [ ] **Step 4: Rewrite `writing-plans` phase-complete marker**

In `skills/writing-plans/SKILL.md`, replace line 188:

```markdown
After saving the plan, mark the planning phase complete: call `TaskUpdate({ taskId: <id>, status: "completed" })` for the current phase's task (the task ID comes from whatever task list the invoking context already created — pi-tasks has no implicit "current task" pointer).
```

with:

```markdown
After saving the plan, close the planning wisp you created: `beads_close({ ids: "<id>" })`.
```

- [ ] **Step 5: Add wisp creation to `test-driven-development`**

In `skills/test-driven-development/SKILL.md`, after line 20 (`**Violating the letter of the rules is violating the spirit of the rules.**`), add:

```markdown

**Track the phase:** when the TDD implementation cycle begins, create a wisp for the implement phase via `beads_create({ title: "Implement", ephemeral: true })` — note the returned id.
```

- [ ] **Step 6: Rewrite `test-driven-development` phase-complete marker**

In `skills/test-driven-development/SKILL.md`, replace line 255:

```markdown
When the TDD implementation cycle is complete (all tests green, code committed), mark the implement phase complete: call `TaskUpdate({ taskId: <id>, status: "completed" })` for the current phase's task (the task ID comes from whatever task list the invoking context already created — pi-tasks has no implicit "current task" pointer).
```

with:

```markdown
When the TDD implementation cycle is complete (all tests green, code committed), close the implement wisp you created: `beads_close({ ids: "<id>" })`.
```

- [ ] **Step 7: Add wisp creation to `verification-before-completion`**

In `skills/verification-before-completion/SKILL.md`, after line 25 (`- Edit source code: no`), add:

```markdown
- When verification begins, create a wisp to track the verify phase via `beads_create({ title: "Verify", ephemeral: true })` — note the returned id
```

- [ ] **Step 8: Rewrite `verification-before-completion` phase-complete marker**

In `skills/verification-before-completion/SKILL.md`, replace line 133:

```markdown
When all verification passes, mark the verify phase complete: call `TaskUpdate({ taskId: <id>, status: "completed" })` for the current phase's task (the task ID comes from whatever task list the invoking context already created — pi-tasks has no implicit "current task" pointer).
```

with:

```markdown
When all verification passes, close the verify wisp you created: `beads_close({ ids: "<id>" })`.
```

- [ ] **Step 9: Verify + commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-superpowers-plus/beads
grep -n "TaskCreate\|TaskUpdate\|TaskList\|pi-tasks" \
  skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md \
  skills/test-driven-development/SKILL.md skills/verification-before-completion/SKILL.md
# Expected: no output
npx biome check .
git add skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md \
  skills/test-driven-development/SKILL.md skills/verification-before-completion/SKILL.md
git commit -m "feat: track phase bookkeeping as self-owned beads wisps"
```

---

### Task 3: Reference docs — pi-tools.md and README point at the beads fork

**Files:**
- Modify: `skills/using-superpowers/references/pi-tools.md` (lines 5-20)
- Modify: `README.md` (lines 15, 25, 28, 69, 77, 88-89, 126, 215, 255)

**Interfaces:**
- Consumes: canonical call shapes + repo-routing rule from Global Constraints; wisp/persistent distinction from Tasks 1-2.
- Produces: the "prerequisites point at the forked pi-beads" wording that Task 4's CHANGELOG entry summarizes.

- [ ] **Step 1: Rewrite `pi-tools.md` tracking line + install command**

In `skills/using-superpowers/references/pi-tools.md`:

Replace line 9:

```markdown
pi install npm:@tintinweb/pi-tasks
```

with:

```markdown
pi install <forked-pi-beads-package>   # fork of @abix5/pi-beads with ephemeral support
```

Replace the second row of the table (line 15):

```markdown
| Task tracking (`TaskCreate`, `TaskUpdate`, `TaskList`, ...) | [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) | `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TaskOutput`, `TaskStop`, `TaskExecute` |
```

with:

```markdown
| Task tracking (`beads_create`, `beads_update`, `beads_close`, `beads_dep`) | forked [`pi-beads`](https://github.com/abix5/pi-beads) (requires the fork's `ephemeral` support — upstream v0.2.2 lacks it) | `beads_ready`, `beads_list`, `beads_show`, `beads_create`, `beads_update`, `beads_close`, `beads_dep`, `beads_undep`, `beads_comment` |
```

Then append, immediately after the table (after line 20's existing "no fallback" sentence), the following bullets:

```markdown

- **Pass `ephemeral: true` to `beads_create` for wisps** (session phase bookkeeping — excluded from sync, purged via `bd purge` when closed); omit it for persistent issues (durable plan-step work).
- **Repo routing:** omit `repo` on `beads_create` to target the session cwd's repo; from an umbrella root, pass the owning repo explicitly (`repo` is required there). Skills never hardcode a repo name.
- `pi-beads` registers its own `beads` skill — see it for the full tool reference rather than re-documenting the API here.
```

- [ ] **Step 2: Rewrite README companion-package bullet (line 15)**

In `README.md`, replace line 15:

```markdown
- [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) — registers the `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` / `TaskOutput` / `TaskStop` / `TaskExecute` tools for dependency-graph task tracking with a persistent widget.
```

with:

```markdown
- **forked [`pi-beads`](https://github.com/abix5/pi-beads)** — registers the `beads_create` / `beads_update` / `beads_close` / `beads_dep` / `beads_list` / `beads_show` tools for beads issue tracking — persistent issues for plan work, wisps (`ephemeral: true`) for session phase bookkeeping — with an in-progress widget. The fork is required for `ephemeral` support (upstream v0.2.2 lacks it).
```

- [ ] **Step 3: Rewrite README prerequisites command + note (lines 25, 28)**

In `README.md`:

Replace line 25:

```markdown
pi install npm:@tintinweb/pi-tasks
```

with:

```markdown
pi install <forked-pi-beads-package>
```

Replace line 28:

```markdown
The skills reference `Agent(...)`, `TaskCreate(...)`, `TaskUpdate(...)`, etc. directly. There is **no fallback** if these packages aren't installed — the skills assume the tools are available.
```

with:

```markdown
The skills reference `Agent(...)` and the `beads_*` tools directly. There is **no fallback** if these packages aren't installed — the skills assume the tools are available. Beads must also be initialized in a project (a `.beads/` directory) for the tracking tools to work. Task tracking (`beads_create`/`beads_update`/`beads_close`) is persistent for plan-step work and wisp-based (`ephemeral: true`) for session phase bookkeeping.
```

- [ ] **Step 4: Rewrite README migration packages array + "What's new" bullets (lines 69, 77, 88-89)**

In `README.md`:

Replace line 69:

```markdown
- **Task tracking** via [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) (`TaskCreate`/`TaskUpdate`/`TaskList` tools) with a dependency graph and TUI widget
```

with:

```markdown
- **Task tracking** via forked [`pi-beads`](https://github.com/abix5/pi-beads) (`beads_create`/`beads_update`/`beads_close`/`beads_dep` tools) — persistent issues for plan work, self-owned wisps for phase bookkeeping
```

Replace line 77:

```markdown
  "packages": ["npm:pi-superpowers-plus", "npm:@tintinweb/pi-subagents", "npm:@tintinweb/pi-tasks"]
```

with:

```markdown
  "packages": ["npm:pi-superpowers-plus", "npm:@tintinweb/pi-subagents", "<forked-pi-beads-package>"]
```

Replace lines 88-89:

```markdown
- The **TUI widgets** from `pi-tasks` and `pi-subagents` show task progress and active agents above the editor.
- Tools like **`TaskCreate`/`TaskUpdate`** and **`Agent`** store execution state and run subagents outside the prompt.
```

with:

```markdown
- The **TUI widgets** from `pi-beads` and `pi-subagents` show in-progress issues and active agents above the editor.
- Tools like **`beads_create`/`beads_update`/`beads_close`** and **`Agent`** store execution state and run subagents outside the prompt.
```

- [ ] **Step 5: Rewrite README workflow-progress prose (line 126)**

In `README.md`, replace line 126:

```markdown
Progress through the workflow is tracked with the `TaskCreate`/`TaskUpdate` tools from `@tintinweb/pi-tasks` as the agent works through each phase's checklist; the `pi-tasks` widget renders the task list above the editor.
```

with:

```markdown
Progress through the workflow is tracked with the beads tools (`beads_create`/`beads_update`/`beads_close`) as the agent works through each phase — durable plan-step work as persistent issues, session phase bookkeeping as wisps (`ephemeral: true`); the `pi-beads` widget renders in-progress issues above the editor.
```

- [ ] **Step 6: Rewrite README comparison table (line 215)**

In `README.md`, replace line 215:

```markdown
| **Task tracking** | — | — | `@tintinweb/pi-tasks` (`TaskCreate`/`TaskUpdate`) with dependency graph + TUI widget |
```

with:

```markdown
| **Task tracking** | — | — | beads via forked `pi-beads` (`beads_create`/`beads_update`/`beads_close`) — persistent issues + wisps |
```

- [ ] **Step 7: Rewrite README attribution (line 255)**

In `README.md`, replace the paragraph containing `Task tracking are provided by` (line 255):

```markdown
Skill content adapted from [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT). This package builds on [pi-superpowers](https://github.com/coctostan/pi-superpowers). Subagent dispatch and task tracking are provided by [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) and [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) (installed separately).
```

with:

```markdown
Skill content adapted from [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT). This package builds on [pi-superpowers](https://github.com/coctostan/pi-superpowers). Subagent dispatch is provided by [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) and task tracking by beads (a [`pi-beads`](https://github.com/abix5/pi-beads) fork with `ephemeral`/wisp support; installed separately).
```

- [ ] **Step 8: Verify + commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-superpowers-plus/beads
grep -rn "TaskCreate\|TaskUpdate\|TaskList\|pi-tasks" \
  README.md skills/using-superpowers/references/pi-tools.md
# Expected: no output
npx biome check .
git add README.md skills/using-superpowers/references/pi-tools.md
git commit -m "docs: point task-tracking prerequisites at the beads fork"
```

---

### Task 4: CHANGELOG entry + full-grep final verification

**Files:**
- Modify: `CHANGELOG.md` (new `[Unreleased]` sub-section)
- Verify-only: `skills/**`, `README.md`, `pi-tools.md` (grep fence)

**Interfaces:**
- Consumes: all wording settled in Tasks 1-3; the spec's Motivation/Decisions summary.
- Produces: the release-facing record of the migration.

- [ ] **Step 1: Add CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]` and **before** the existing `### Removed` section (i.e. directly after the `## [Unreleased]` heading line), insert:

```markdown
### Changed

- **Task tracking migrated from `@tintinweb/pi-tasks` to beads (a `pi-beads` fork).** Durable plan-step tracking (`executing-plans`, `subagent-driven-development`) now creates **persistent beads issues** per plan step (`beads_create`, `beads_update`, `beads_close`, `beads_dep`) — repo-owned, synced, auditable. Session phase bookkeeping (`brainstorming` checklist items; the "Planning"/"Implement"/"Verify" phase markers in `writing-plans`, `test-driven-development`, `verification-before-completion`) now uses **self-owned wisps** (`beads_create({ ..., ephemeral: true })`) created at phase start and closed at completion — ephemeral, excluded from sync, purged via `bd purge` once closed. `pi-tasks` is removed as a prerequisite; `pi-subagents` (`Agent` tool) is unaffected. **Requires** the forked pi-beads: upstream v0.2.2 lacks the `ephemeral` flag on `beads_create` that wisps depend on.
```

- [ ] **Step 2: Final verification — full repo grep fence**

```bash
cd /Users/jstegeman/orca/workspaces/pi-superpowers-plus/beads
# No pi-tasks tokens in skills or README or pi-tools.md (CHANGELOG historical entries exempt):
grep -rn "TaskCreate\|TaskUpdate\|TaskList\|TaskGet\|TaskOutput\|TaskStop\|TaskExecute\|pi-tasks" \
  skills/ README.md | grep -v CHANGELOG
# Expected: no output
# CHANGELOG should still mention pi-tasks exactly twice (historical record + new entry):
grep -c "pi-tasks" CHANGELOG.md
# Confirm the new entry exists:
grep -n "Task tracking migrated from" CHANGELOG.md
npx biome check .
# AGENTS.md / CLAUDE.md still carry the managed beads directive (check-only, no edit):
grep -c "Use \`bd\` for ALL task tracking" AGENTS.md CLAUDE.md  # expect: 1 1
# package.json unchanged — pi-tasks was never a manifest dependency (user-managed prerequisite):
grep -c "pi-tasks" package.json 2>/dev/null  # expect: no output / 0
```

- [ ] **Step 3: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-superpowers-plus/beads
git add CHANGELOG.md
git commit -m "docs: changelog entry for beads migration"
```

---

## Verification

- `npx biome check .` passes (exit 0) — trivial gate given `biome.json` excludes markdown/json/docs and no `.ts`/`.js` remain.
- Grep fence (Task 4 Step 2): no `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`/`TaskOutput`/`TaskStop`/`TaskExecute`/`pi-tasks` tokens in `skills/`, `README.md`, or `pi-tools.md`. Historical CHANGELOG entries remain and may reference pi-tasks.
- Manual smoke (not automated here): run a workflow in a project with `.beads/` + the fork installed — persistent issues for plan steps, wisps for phases, `beads_dep` wiring, and `beads_close` all work end-to-end.
