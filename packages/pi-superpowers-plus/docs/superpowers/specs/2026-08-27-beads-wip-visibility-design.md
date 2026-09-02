# Beads WIP Visibility + Guaranteed Closure — Design Spec

**Date:** 2026-08-27
**Branch:** `johnstegeman/beads-work`
**Source:** Two follow-up fixes to the 2026-08-26 beads migration (`docs/superpowers/specs/2026-08-26-beads-migration-design.md`): (1) phase wisps are never marked `in_progress`, so the pi-beads widget shows nothing being worked on during a phase; (2) a wisp left open was observed in `pmm-iris` (`pmm-iris-wisp-a8z` "Brainstorm: write design doc" and `pmm-iris-04w.4.1` "Implement Task 11"), orphaned by a session stopped/restarted mid-WIP — the skills only close on the happy path.

## Motivation

beads is working well, two gaps remain:

1. **No WIP visibility.** The superpowers skills create phase wisps (`"Planning"`, `"Implement"`, `"Verify"`, brainstorming checklist items) via `beads_create({ ..., ephemeral: true })`, which lands them in `open` status. The pi-beads widget renders `open` as `○` (available/ready) and `in_progress` as `◐` (current work). Since no skill ever calls `beads_update({ status: "in_progress" })` on a wisp, the widget shows nothing being worked on for the whole duration of a phase.
2. **Open wisps are left behind.** Skills close wisps only on the happy path (phase completes). When a session is stopped/restarted mid-WIP (hard kill — no chance for the skill to run), the phase wisp stays open forever. Observed twice in `pmm-iris` (a brainstorming checklist wisp and a plan-task wisp, both `open` at 13–16h old).

A third, related improvement (requested during design): at phase end the session's done beads should be cleared, so a DB-derived widget "done this session" panel can accumulate across turns and reset at each phase boundary.

**Goals:**
1. Every phase wisp is `in_progress` while it is being worked on (widget shows `◐`).
2. Every bead/wisp ends **closed** — on completion, on any graceful exit (blocker/redirect/error/abandon), and, for hard kills, reclaimed deterministically at the next session start.
3. Phase end clears the session's done **wisps** (durable closed issues stay visible).

## Decisions

### 1. Wisp lifecycle: create → `in_progress` → close

Every skill that creates a phase wisp gains the same lifecycle:

```
beads_create({ title: "<phase>", ephemeral: true })        // -> id (open)
beads_update({ id: "<id>", status: "in_progress" })        // widget shows ◐
... work ...
beads_close({ ids: "<id>" })                               // completion (existing)
beads_close({ ids: "<id>" })                               // graceful exit (new)
```

- `in_progress` is set **immediately after create**, not later — the widget should show the phase from its first moment.
- **Completion close** already exists in every site; this spec does not remove it.
- **Graceful-exit close** is new: *"if the phase does not complete for any reason (blocked, redirected, stopped early, error), close any open wisps you created."* This covers every moment the agent is still alive to act.

Sites: `writing-plans` ("Planning"), `test-driven-development` ("Implement"), `verification-before-completion` ("Verify"), `brainstorming` (per-item checklist wisps).

### 2. Hard-kill reaping: `bd mol wisp gc` at session start

A killed session cannot run skill instructions, so the graceful-exit close can't cover it. Reclaim these deterministically at the **next session start** with bd's stock garbage collection:

```
bd mol wisp gc --dry-run --age 24h  # preview abandoned wisps (same threshold as the sweep)
bd mol wisp gc --age 24h --force  # delete wisps untouched 24h+ and not closed
```

- `wisp gc` considers a wisp abandoned if it "hasn't been updated in `--age` and is not closed" — exactly the orphan class (open / abandoned `in_progress`). Preview is the default; deletion requires `--force`.
- **Threshold:** `--age 24h` (recommended), not the default `1h`. 24h is unambiguous "abandoned" while still catching the observed 13–16h orphans at the next daily session start; `1h` is too aggressive for resumed long phases.
- **Resume safeguard:** the skill rule runs `--dry-run --age 24h` first and instructs: if a listed wisp belongs to work you're about to resume, refresh its timestamp via `bd update <id> --notes "resuming <phase>"` (the sweep skips recently-updated wisps) or use a longer `--age` before forcing. `bd mol squash <id>` does NOT promote a directly-created wisp (verified against bd 1.2.2: "No ephemeral children found for molecule") — it only condenses molecule hierarchies, so it is not the preserve mechanism. This is the only judgment step; the sweep itself stays deterministic.
- **Persistent issues are never touched** — `gc` is wisp-only. Durable plan-step tasks closed or `in_progress` are unaffected.
- Lives in a new **Session Start** section of `using-superpowers` (the skill loaded at conversation start). No pi-beads fork change — this is stock bd 1.2.2.

### 3. Phase-end done-clear (widget panel reset)

At the end of each phase, after its wisps are closed, the skills purge the closed wisps so a DB-derived "done this session" panel empties:

```
bd mol wisp gc --closed --force   # purge all closed wisps (wisp-only)
```

- This makes **`Q1`-A** concrete: the widget's done list is DB-derived (closed wisps in the DB); purging them resets the panel. No new tool, no in-memory accumulator on the skill side.
- **Durable closed issues are untouched** (gc is wisp-only), so closed plan-step tasks from `executing-plans`/`subagent-driven-development` stay in the panel as durable "done" work for the session.
- Fires at: end of `brainstorming` (after the checklist batch-close), and in `writing-plans`, `test-driven-development`, `verification-before-completion` (right after closing their phase wisp). The purge pairs with the close step and runs on **every** close path — completed or gracefully exited/aborted — so closed wisps never linger in the panel either way.
- **Not** in `executing-plans` / `subagent-driven-development` — they create persistent tasks, not phase wisps, so the purge is a no-op and would add churn; their durable closed tasks should remain visible.

### 4. Persistent plan tasks: blocker handling, never reaped

`executing-plans` and `subagent-driven-development` already mark each plan task `in_progress` and close it on completion. Two additions:

- On a mid-batch blocker/abort, mark the open task `blocked` (with a note) or leave it open for resume — never silently abandon it in `in_progress`/`open`.
- On resume, re-mark the task `in_progress` to continue. Session-start `gc` never touches these (Decision 2).

### 5. Brainstorming granularity

The checklist creates all 8 item wisps up front (that is the visible checklist). The **current** item is marked `in_progress` as work on it starts and closed as its real output exists; the remaining open items close in the phase-end batch-close. One wisp is `◐` at a time — the widget shows exactly what's being worked on, not all 8 simultaneously.

### 6. Contract with the pi-beads widget (user-owned, out of scope here)

The widget side (in the user's pi-beads fork) is **not** part of this repo's change set. This spec only fixes the contract the skills rely on:

- Widget shows `in_progress` beads as current work (`◐`) — already true.
- Widget's "done this session" panel is **DB-derived** (closed wisps present in the DB), accumulating across turns rather than the current one-turn in-memory `closedShown`; it empties when the skills purge closed wisps at phase end (Decision 3).
- No new tool is required of pi-beads for the skill-side behavior.

## Scope

### Skill files changed

| File | Change |
|---|---|
| `skills/writing-plans/SKILL.md` | "Planning" wisp: `in_progress` after create; close on completion (exists) + graceful exit; phase-end `gc --closed --force` after close |
| `skills/test-driven-development/SKILL.md` | "Implement" wisp: `in_progress` after create; close on completion (exists) + graceful exit; phase-end `gc --closed --force` after close |
| `skills/verification-before-completion/SKILL.md` | "Verify" wisp: `in_progress` after create; close on completion (exists) + graceful exit; phase-end `gc --closed --force` after close |
| `skills/brainstorming/SKILL.md` | Checklist wisps: mark current item `in_progress`; close each as done (exists); close all on early exit/abort; phase-end batch-close (exists) + `gc --closed --force` |
| `skills/using-superpowers/SKILL.md` | New "Session Start" section: `bd mol wisp gc` sweep (Decision 2) |
| `skills/executing-plans/SKILL.md` | Persistent task `in_progress`→close (exists); add blocker/abort handling (mark `blocked` or leave open; re-mark `in_progress` on resume) |
| `skills/subagent-driven-development/SKILL.md` | Same as executing-plans |

### Docs

- `CHANGELOG.md` — new `[Unreleased]` entry in the existing style.
- This spec file.

### Checked, no edit expected

- `skills/using-superpowers/references/pi-tools.md` — tool table already documents `beads_*` and wisps; no tool add/remove. Re-verify during implementation that it doesn't contradict the new lifecycle.
- `README.md` — beads-related prose remains accurate (wisps + `bd purge`). No change planned unless a contradiction surfaces.

## Out of scope

- **pi-beads widget** (session done-panel accumulation) — user-owned, in the pi-beads fork. Only the contract (Decision 6) is pinned here.
- Any auto-close/hook in pi-beads — dropped in favor of stock `bd mol wisp gc` (Decision 2).
- Changes to historical `docs/` records from prior migrations.
- The `pi-subagents` (`Agent` tool) package — unaffected.

## Verification

- `npx biome check .` clean (repo lint gate).
- Grep: every `beads_create({ ... ephemeral: true })` site in `skills/` is followed by `beads_update({ id, status: "in_progress" })` and has a close path covering both completion and graceful exit; `using-superpowers` contains the `bd mol wisp gc` session-start rule; the four phase skills contain the `bd mol wisp gc --closed --force` phase-end step.
- Manual smoke (as in the migration): run a phase skill in a `.beads/` project — wisp appears `◐` in the widget while the phase runs, `✓` on close, done panel empties after phase end; stop/start a session mid-WIP and confirm next session-start `gc --dry-run --age 24h` flags the orphan AND that the resume-preserve path (`bd update <id> --notes "resuming <phase>"`) keeps the wisp intact after the forced sweep; run the session-start rule in a fresh non-beads directory and confirm it degrades gracefully (no error, step skipped).
