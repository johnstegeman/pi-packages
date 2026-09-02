# Beads WIP Visibility + Guaranteed Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every superpowers phase wisp `in_progress` while worked (widget visibility), close it on completion *and* on graceful exit, reap hard-kill leftovers at session start via `bd mol wisp gc`, and clear the session's done wisps at phase end.

**Architecture:** Pure markdown-skill edits — no code. Every skill that creates a phase wisp (`writing-plans`, `test-driven-development`, `verification-before-completion`, `brainstorming`) gains the lifecycle: create → `beads_update({ status: "in_progress" })` → close on completion → close on graceful exit → `bd mol wisp gc --closed --force` at phase end. `using-superpowers` gains a Session Start section running `bd mol wisp gc --age 24h --force` for hard-kill leftovers. `executing-plans` / `subagent-driven-development` gain persistent-task blocker handling. Relies on stock `bd` 1.2.2 commands; the pi-beads widget side is out of scope (user-owned).

**Tech Stack:** None (markdown skills). Verification via `npx biome check .` + grep gates + manual smoke.

## Global Constraints

- Repo: `pi-superpowers-plus`; work in the `johnstegeman/beads-work` branch. Files edited: the 7 `skills/*/SKILL.md` files, `CHANGELOG.md`, plus plan/spec docs. No other files.
- All `beads_*` examples keep the skill's existing placeholder style (`<id>`), and skills never hardcode a repo name.
- All `bd mol wisp gc` invocations appear verbatim in the skill text:
  - Session-start stale sweep: `bd mol wisp gc --age 24h --force` (after `--dry-run` preview).
  - Phase-end done-clear: `bd mol wisp gc --closed --force`.
- Existing "close on completion" behavior is preserved everywhere; the lifecycle **adds** `in_progress`-after-create, graceful-exit close, and the phase-end purge.
- Persistent (non-ephemeral) plan-step tasks are never touched by any `bd mol wisp gc` command.
- Quality gate: `npx biome check .` stays clean (markdown files are ignored by biome, but the repo's lint must not regress).

---

### Task 1: Session-start bead cleanup in `using-superpowers`

**Files:**
- Modify: `skills/using-superpowers/SKILL.md` — insert a new `## Session Start: beads cleanup` section between the `## The Rule` section and `## Working Directory`.

**Interfaces:**
- Produces: the verbal rule every future session-start reads before any work. No constants consumed.

- [ ] **Step 1: Insert the Session Start section**

Insert this block after the end of `## The Rule` (after the line `Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, create a todo per item.`) and before `## Working Directory`:

```markdown
## Session Start: beads cleanup

Before beginning work, clean up beads left behind by interrupted sessions
(a stopped/restarted session cannot close its own wisps):

1. Run `bd mol wisp gc --dry-run` to list abandoned wisps (untouched past
   `--age` and not closed) — leftovers from a stopped/restarted session.
2. Review the list. If any listed wisp belongs to work you're about to
   resume, preserve it with `bd mol squash <id>` (gc deletes without leaving
   a digest) or use a longer `--age`.
3. Delete the rest: `bd mol wisp gc --age 24h --force` (a wisp untouched for
   a full day and not closed is abandoned; the default 1h threshold is too
   aggressive for resumed phases).
4. This touches **wisps only** — persistent issues are never affected.
```

- [ ] **Step 2: Verify the section exists**

Run: `grep -n "Session Start: beads cleanup" skills/using-superpowers/SKILL.md`
Expected: prints the new heading line.

- [ ] **Step 3: Commit**

```bash
git add skills/using-superpowers/SKILL.md
git commit -m "feat: session-start wisp cleanup rule (bd mol wisp gc)"
```

---

### Task 2: `writing-plans` — Planning wisp lifecycle

**Files:**
- Modify: `skills/writing-plans/SKILL.md:20` (create site) and `:190` (close site).

**Interfaces:**
- Consumes: `beads_create({ title, ephemeral })`, `beads_update({ id, status })`, `beads_close({ ids })`, `bd mol wisp gc --closed --force` — all stock.

- [ ] **Step 1: Add `in_progress` after wisp creation**

Replace line 20:

```markdown
At the start of planning, create a wisp to track the phase: `beads_create({ title: "Planning", ephemeral: true })` — note the returned id.
```

with:

```markdown
At the start of planning, create a wisp to track the phase: `beads_create({ title: "Planning", ephemeral: true })` — note the returned id, then mark it in progress: `beads_update({ id: "<id>", status: "in_progress" })` so the beads widget shows the planning phase being worked on.
```

- [ ] **Step 2: Add graceful-exit close + phase-end purge to the close site**

Replace line 190:

```markdown
After saving the plan, close the planning wisp you created: `beads_close({ ids: "<id>" })`.
```

with:

```markdown
After saving the plan, close the planning wisp you created: `beads_close({ ids: "<id>" })`, then clear the session's done wisps: `bd mol wisp gc --closed --force` (wisp-only; persistent issues untouched).

If the plan is NOT fully written for any reason (blocked, redirected, stopped early), close the planning wisp you created (`beads_close({ ids: "<id>" })`) and run the same `bd mol wisp gc --closed --force` — never leave the wisp open.
```

- [ ] **Step 3: Verify both sites**

Run: `grep -n "status: \"in_progress\"\|bd mol wisp gc --closed --force\|never leave the wisp open" skills/writing-plans/SKILL.md`
Expected: `Plan` wisp shows the `in_progress` update and the phase-end purge, plus the graceful-exit line.

- [ ] **Step 4: Commit**

```bash
git add skills/writing-plans/SKILL.md
git commit -m "feat: planning wisp lifecycle (in_progress, graceful-exit close, phase-end purge)"
```

---

### Task 3: `test-driven-development` — Implement wisp lifecycle

**Files:**
- Modify: `skills/test-driven-development/SKILL.md:18` (create site) and `:257` (close site).

**Interfaces:**
- Consumes: same stock tools as Task 2.

- [ ] **Step 1: Add `in_progress` after wisp creation**

Replace line 18:

```markdown
**Track the phase:** when the TDD implementation cycle begins, create a wisp for the implement phase via `beads_create({ title: "Implement", ephemeral: true })` — note the returned id.
```

with:

```markdown
**Track the phase:** when the TDD implementation cycle begins, create a wisp for the implement phase via `beads_create({ title: "Implement", ephemeral: true })` — note the returned id, then mark it in progress: `beads_update({ id: "<id>", status: "in_progress" })` so the beads widget shows the implement phase being worked on.
```

- [ ] **Step 2: Add graceful-exit close + phase-end purge to the close site**

Replace line 257:

```markdown
When the TDD implementation cycle is complete (all tests green, code committed), close the implement wisp you created: `beads_close({ ids: "<id>" })`.
```

with:

```markdown
When the TDD implementation cycle is complete (all tests green, code committed), close the implement wisp you created: `beads_close({ ids: "<id>" })`, then clear the session's done wisps: `bd mol wisp gc --closed --force` (wisp-only; persistent issues untouched).

If the cycle does not complete for any reason (blocked, redirected, stopped early), close the implement wisp you created (`beads_close({ ids: "<id>" })`) and run `bd mol wisp gc --closed --force` — never leave the wisp open.
```

- [ ] **Step 3: Verify both sites**

Run: `grep -n "status: \"in_progress\"\|bd mol wisp gc --closed --force\|never leave the wisp open" skills/test-driven-development/SKILL.md`
Expected: the Implement wisp gets the `in_progress` update, phase-end purge, and graceful-exit line.

- [ ] **Step 4: Commit**

```bash
git add skills/test-driven-development/SKILL.md
git commit -m "feat: implement wisp lifecycle (in_progress, graceful-exit close, phase-end purge)"
```

---

### Task 4: `verification-before-completion` — Verify wisp lifecycle

**Files:**
- Modify: `skills/verification-before-completion/SKILL.md:22` (create site) and `:135` (close site).

**Interfaces:**
- Consumes: same stock tools as Task 2.

- [ ] **Step 1: Add `in_progress` after wisp creation**

Replace line 22:

```markdown
**Track the phase:** when verification begins, create a wisp via `beads_create({ title: "Verify", ephemeral: true })` — note the returned id.
```

with:

```markdown
**Track the phase:** when verification begins, create a wisp via `beads_create({ title: "Verify", ephemeral: true })` — note the returned id, then mark it in progress: `beads_update({ id: "<id>", status: "in_progress" })` so the beads widget shows the verification phase being worked on.
```

- [ ] **Step 2: Add graceful-exit close + phase-end purge to the close site**

Replace line 135:

```markdown
When all verification passes, close the verify wisp you created: `beads_close({ ids: "<id>" })`.
```

with:

```markdown
When all verification passes, close the verify wisp you created: `beads_close({ ids: "<id>" })`, then clear the session's done wisps: `bd mol wisp gc --closed --force` (wisp-only; persistent issues untouched).

If verification does not complete for any reason (blocked, redirected, stopped early), close the verify wisp you created (`beads_close({ ids: "<id>" })`) and run `bd mol wisp gc --closed --force` — never leave the wisp open.
```

- [ ] **Step 3: Verify both sites**

Run: `grep -n "status: \"in_progress\"\|bd mol wisp gc --closed --force\|never leave the wisp open" skills/verification-before-completion/SKILL.md`
Expected: the Verify wisp gets the `in_progress` update, phase-end purge, and graceful-exit line.

- [ ] **Step 4: Commit**

```bash
git add skills/verification-before-completion/SKILL.md
git commit -m "feat: verify wisp lifecycle (in_progress, graceful-exit close, phase-end purge)"
```

---

### Task 5: `brainstorming` — checklist wisp lifecycle

**Files:**
- Modify: `skills/brainstorming/SKILL.md:42` (checklist wisp-creation paragraph) and `:129` (phase-complete bullet in "After the Design").

**Interfaces:**
- Consumes: same stock tools as Task 2.

- [ ] **Step 1: Mark the current checklist item `in_progress`**

Replace line 42:

```markdown
You MUST create a wisp for each of these items via `beads_create({ title: "<checklist item>", description: "<item detail>", ephemeral: true })` and complete them in order. Only `beads_close({ ids: "<id>" })` an item once its real output actually exists in the conversation (see the hard-gate above) — never close several in a row within the same turn.
```

with:

```markdown
You MUST create a wisp for each of these items via `beads_create({ title: "<checklist item>", description: "<item detail>", ephemeral: true })` and complete them in order. When you begin an item, mark it in progress: `beads_update({ id: "<id>", status: "in_progress" })` so the beads widget shows the item being worked on — only the current item is `in_progress` at a time. Only `beads_close({ ids: "<id>" })` an item once its real output actually exists in the conversation (see the hard-gate above) — never close several in a row within the same turn.
```

- [ ] **Step 2: Add graceful-exit close + phase-end purge to the phase-complete bullet**

Replace line 129:

```markdown
- Mark the brainstorm phase complete: close any checklist wisps still open in one call — `beads_close({ ids: "<id-1> <id-2> ..." })` (the one allowed batch exception to closing one-at-a-time; multiple space/comma-separated ids are accepted)
```

with:

```markdown
- Mark the brainstorm phase complete: close any checklist wisps still open in one call — `beads_close({ ids: "<id-1> <id-2> ..." })` (the one allowed batch exception to closing one-at-a-time; multiple space/comma-separated ids are accepted), then clear the session's done wisps: `bd mol wisp gc --closed --force` (wisp-only; persistent issues untouched). If brainstorming stops early for any reason (blocked, redirected, session stopped), close any open checklist wisps you still hold (`beads_close({ ids: ... })`) and run the same purge — never leave a checklist wisp open.
```

- [ ] **Step 3: Verify both sites**

Run: `grep -n "status: \"in_progress\"\|bd mol wisp gc --closed --force\|never leave a checklist wisp open" skills/brainstorming/SKILL.md`
Expected: current-item `in_progress` marking, phase-end purge, and graceful-exit line.

- [ ] **Step 4: Commit**

```bash
git add skills/brainstorming/SKILL.md
git commit -m "feat: checklist wisp lifecycle (current-item in_progress, graceful-exit close, phase-end purge)"
```

---

### Task 6: `executing-plans` — persistent task blocker handling

**Files:**
- Modify: `skills/executing-plans/SKILL.md` — in the `## When to Stop and Ask for Help` section, after the line `**Ask for clarification rather than guessing.**`.

**Interfaces:**
- Produces: guidance for the open plan-task bead when a batch is stopped.

- [ ] **Step 1: Add the open-task handling rule**

After the line `**Ask for clarification rather than guessing.**` (end of the `## When to Stop and Ask for Help` section), append:

```markdown
If you stop on a blocker or abort mid-batch, do not silently leave the current task bead in `in_progress`/`open`: mark it `blocked` (`beads_update({ id: "<id>", status: "blocked", appendNotes: "<blocker>" })`) or leave it open for resume, and on resume re-mark it `in_progress` (`beads_update({ id: "<id>", status: "in_progress" })`) to continue.
```

- [ ] **Step 2: Verify**

Run: `grep -n "do not silently leave" skills/executing-plans/SKILL.md`
Expected: prints the new line.

- [ ] **Step 3: Commit**

```bash
git add skills/executing-plans/SKILL.md
git commit -m "feat: persistent task blocker handling in executing-plans"
```

---

### Task 7: `subagent-driven-development` — persistent task blocker handling

**Files:**
- Modify: `skills/subagent-driven-development/SKILL.md` — in the `**BLOCKED:**` bullet block, after the numbered list and before `**Never** ignore an escalation ...`.

**Interfaces:**
- Consumes: `beads_update({ id, status, appendNotes })`.

- [ ] **Step 1: Add the blocker-status update to the BLOCKED handling**

After the `4. If the plan itself is wrong, escalate to the human` line and before `**Never** ignore an escalation or force a retry without changes. ...`, append:

```markdown
Update the task's bead: `beads_update({ id: "<id>", status: "blocked", appendNotes: "<blocker>" })`. If the task is later re-dispatched (anything other than escalate-to-human), re-mark it `in_progress` when work resumes — never leave it silently in `in_progress`/`open`.
```

- [ ] **Step 2: Verify**

Run: `grep -n "Update the task's bead" skills/subagent-driven-development/SKILL.md`
Expected: prints the new line.

- [ ] **Step 3: Commit**

```bash
git add skills/subagent-driven-development/SKILL.md
git commit -m "feat: persistent task blocker handling in subagent-driven-development"
```

---

### Task 8: CHANGELOG entry + final verification

**Files:**
- Modify: `CHANGELOG.md` — add a `- **` bullet under `## [Unreleased]` → `### Changed`, after the existing beads-migration bullet.

**Interfaces:**
- Consumes: nothing.

- [ ] **Step 1: Add the Changelog bullet**

After the existing `- **Task tracking migrated from \`@tintinweb/pi-tasks\` to beads ...**` bullet (still under `### Changed`), add:

```markdown
- **Beads WIP visibility + guaranteed closure.** Phase wisps (`"Planning"`, `"Implement"`, `"Verify"`, brainstorming checklist items) are marked `in_progress` immediately after creation so the pi-beads widget shows what's being worked on (`◐`), closed on graceful exit (blocker/redirect/stop) as well as on completion, and the session's done wisps are purged at phase end via `bd mol wisp gc --closed --force` (wisp-only; persistent issues untouched). `using-superpowers` gains a Session Start rule reaping hard-kill leftovers via `bd mol wisp gc --dry-run` / `--age 24h --force` (a stopped/restarted session cannot close its own wisps). `executing-plans` / `subagent-driven-development` mark blocked plan-step tasks `blocked` instead of leaving them silently open, and re-mark them `in_progress` on resume. Uses stock `bd mol wisp gc` — no pi-beads fork change required; the widget's accumulated session done-panel is user-side.
```

- [ ] **Step 2: Run the repo lint gate**

Run: `npx biome check .`
Expected: clean (no errors; markdown is not linted by biome, so this is a regression guard).

- [ ] **Step 3: Run the grep gates across all skills**

Run:
```bash
grep -rn "status: \"in_progress\"" skills/ | wc -l   # >= 4 (Planning/Implement/Verify/brainstorming + executing-plans existing)
grep -rln "bd mol wisp gc --closed --force" skills/  # writing-plans, test-driven-development, verification-before-completion, brainstorming
grep -n "bd mol wisp gc --age 24h --force" skills/using-superpowers/SKILL.md
grep -rln "never leave" skills/                      # the 4 phase skills' graceful-exit lines
```
Expected: each command matches as described.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for beads WIP visibility + guaranteed closure"
```

---

## Verification

- All 8 tasks committed on `johnstegeman/beads-work`; `git log --oneline -9` shows the chain.
- `npx biome check .` clean.
- Grep gates from Task 8 Step 3 pass.
- Manual smoke (documented in the spec): in a `.beads/` project, run a phase skill — wisp appears `◐` while working, `✓` on close, done panel empties after phase-end purge; stop/start a session mid-WIP and confirm the next session-start `bd mol wisp gc --dry-run` flags the orphan.

## Summary

Eight small markdown commits deliver both goals: (1) every phase wisp is `in_progress` while worked, so the pi-beads widget shows what superpowers is doing; (2) every bead/wisp ends closed — on completion, on graceful exit (new per-skill language), and, for hard-killed sessions, deterministically at the next session start via `bd mol wisp gc`. Phase end clears the done panel; persistent plan-step tasks are never reaped and get blocker-aware status handling.
