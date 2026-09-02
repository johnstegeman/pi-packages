# `/superpowers` Command — Design Spec

**Date:** 2026-07-29
**Branch:** `feat/skills-upstream-sync` (current branch — no new branch).
**Source:** ROADMAP.md "Future" → `/superpowers` command + "Command-driven phase advancement"

## Goal

Implement a unified `/superpowers` user command for inspecting and controlling
workflow state, subsuming the existing `/workflow-next` and `/workflow-reset`
commands. Per user direction, implement all subcommands EXCEPT `query`.

## Scope — the 4 subcommands

Per ROADMAP, the full command is:
- `/superpowers` — full status dashboard (workflow stage, tasks, TDD phase, debug state)
- `/superpowers tasks [list|add|remove|complete|reset|rewind]` — manipulate plan-tracker tasks directly
- `/superpowers stage [show|<phase>|reset]` — view or advance workflow stage
- `/superpowers reset` — reset all workflow state (stage, monitors, tasks)
- `/superpowers query "<question>"` — **OUT OF SCOPE (user direction: skip)**

## Decision: migrate plan-tracker to `appendEntry` persistence

**The core architectural decision.** The plan-tracker currently persists state
via tool-result `details` (reconstructed from `getBranch()`). The session-state-
persistence design (ROADMAP v0.3.0, shipped) deliberately kept plan-tracker on
`details` while moving the workflow monitors to a combined `superpowers_state`
appendEntry snapshot. That was correct *for a tool that owns its results* — but
the `/superpowers tasks` command needs to mutate task state from a slash command,
and a command can't append a `plan_tracker` tool-result entry (that would
fabricate tool history). Command-side mutations under the `details` model would
NOT persist across session restore/fork — regressing the durability the
persistence design fixed for the monitors.

**Decision: migrate the plan-tracker to `appendEntry` persistence** with a
`plan_tracker_state` entry type, mirroring the proven `superpowers_state`
pattern. Then:
- The `plan_tracker` tool mutates the in-memory task list AND appends a
  `plan_tracker_state` entry (durable).
- The `/superpowers tasks` command mutates the same shared in-memory task list
  AND appends a `plan_tracker_state` entry (durable).
- Both reconstruct from the last `plan_tracker_state` entry in `getBranch()` on
  session events (mirroring `reconstructState` for `superpowers_state`).

This makes command mutations durable, aligns plan-tracker with the workflow-
monitor's proven pattern, and makes the tool + command symmetric callers over
one persisted state.

### Shared state module

Extract `extensions/plan-tracker-state.ts` as the single source of truth:
- Owns the in-memory `tasks: Task[]`.
- Exports: `getTasks()`, `setTasks()`, `initTasks(names)`, `updateTask(index, status)`, `addTask(name)`, `removeTask(index)`, `rewindTask(index)`, `clearTasks()`, `reconstructTasksFromBranch(ctx)`, `persistTasks(pi)`.
- `persistTasks(pi)` calls `pi.appendEntry(PLAN_TRACKER_STATE_ENTRY_TYPE, tasks)`.
- `reconstructTasksFromBranch(ctx)` scans `getBranch()` for the last `custom` entry with `customType === "plan_tracker_state"` and `setTasks(data)`; falls back to the legacy tool-result-`details` reconstruction (backward compat for sessions created before the migration) then defaults to empty.

`extensions/plan-tracker.ts` (the tool) imports the shared module and becomes a
thin wrapper: each tool action calls the shared mutator + `persistTasks(pi)` +
updates the widget. `extensions/workflow-monitor.ts` (the command) imports the
shared module for `/superpowers tasks` mutations and the dashboard's task list.

### New task actions

- `add <name>` — append a task (status `pending`).
- `remove <index>` — remove a task by 0-based index; reindex remaining.
- `rewind <index>` — mark task at `index` and all tasks *after* it back to
  `pending` (use case: re-do task N and everything downstream). The task at
  `index` becomes `pending` (not `in_progress`); tasks before it are unchanged.
- `complete <index>` — set task at `index` to `complete` (wraps existing
  `update`).
- `reset` — clear all tasks (wraps existing `clear`).
- `list` — render the task list (read-only).

### Tool API extension

The `plan_tracker` tool gains `add`, `remove`, `rewind` actions (in addition to
`init`/`update`/`status`/`clear`), so the agent can also use them directly.
Params: add `name?: string` (for `add`), reuse `index` (for `remove`/`rewind`).

## The 4 subcommands — detailed design

### `/superpowers` (dashboard, no args)

Renders a multi-section status view (TUI via `ctx.ui.setWidget` or a notify +
editor text — see rendering question below). Sections:
- **Workflow stage**: the phase strip (`-brainstorm → ✓plan → [execute] → verify → ...`) via the existing `formatPhaseStrip` + `handler.getWorkflowState()`.
- **Tasks**: the plan-tracker task list (`✓ [0] ... → [1] ... ○ [2] ...`) + counts (`Plan: 2/5 complete`).
- **TDD phase**: `handler.getTddPhase()` (IDLE/RED-PENDING/RED/GREEN/REFACTOR).
- **Debug state**: `handler.isDebugActive()` + `handler.getDebugFixAttempts()`.
- **Verification**: `handler.getVerificationState()` (verified/waived).

This is essentially the existing `workflow_monitor` widget content expanded
with the full task list. Reads only — no state mutation.

### `/superpowers tasks [list|add|remove|complete|reset|rewind]`

- `tasks` (no subcommand) or `tasks list` → render the task list (same as dashboard's task section).
- `tasks add <name>` → `addTask(name)` + `persistTasks(pi)` + update widget + notify.
- `tasks remove <index>` → `removeTask(index)` + persist + widget + notify.
- `tasks complete <index>` → `updateTask(index, "complete")` + persist + widget + notify.
- `tasks rewind <index>` → `rewindTask(index)` + persist + widget + notify.
- `tasks reset` → `clearTasks()` + persist + widget + notify.
- Errors: missing index/name, index out of range, no plan active → `ctx.ui.notify(..., "error")`.

Arg parsing: split args on whitespace; first token is the subcommand; rest is
the index or name (name may contain spaces — join the remainder).

### `/superpowers stage [show|<phase>|reset]`

- `stage` or `stage show` → render the current phase strip + which phases are complete/skipped.
- `stage <phase>` → `handler.advanceTo(phase)` (validates phase against `WORKFLOW_PHASES`); persist workflow state (`persistState()`); update widget; notify. This is the **non-session-spawning** counterpart to `/workflow-next` (which spawns a new session). `stage` advances the tracker in place; the user then invokes the skill themselves. (Per ROADMAP "command-driven phase advancement", `/brainstorm` etc. would *also* pre-fill the editor — that's a future enhancement; `stage <phase>` here just advances + tells the user which skill to invoke.)
- `stage reset` → reset the workflow tracker to fresh (phases all pending, currentPhase null) via a new `handler.resetWorkflowOnly()` (or `tracker.reset()` exposed) — distinct from `/superpowers reset` which resets everything. Persist + widget + notify.

### `/superpowers reset` (reset all workflow state)

- `handler.resetState()` (resets workflow + TDD + debug + verification — already exists).
- `clearTasks()` + `persistTasks(pi)` (reset plan-tracker — new shared module).
- `persistState()` (persist the reset workflow/monitor state).
- Update widget + notify: "All workflow state reset. Ready for a new task."

## Rendering question (the one open UI choice)

The dashboard and `tasks list` / `stage show` produce multi-line status output. Pi commands have two output channels: `ctx.ui.notify(msg, "info")` (transient toast) and `ctx.ui.setEditorText(text)` (fills the editor input). The existing `workflow_monitor` *widget* (above the editor) is a separate persistent surface.

**Options for status/dashboard output:**
- **A — `ctx.ui.notify` with a multi-line string.** Simplest; transient. But toasts may truncate long task lists and disappear.
- **B — `ctx.ui.setEditorText` with the status text.** Persistent (user sees it in the editor), but clobbers any in-progress editor content (rude if the user was typing).
- **C — A dedicated TUI widget** (`ctx.ui.setWidget("superpowers_status", ...)`) that renders the dashboard on demand and clears after a delay or on next input. Most polished; most code.
- **D — Hybrid: notify for short confirmations (mutations), setEditorText for the dashboard/list/show reads.** Mirrors how `/workflow-next` uses `setEditorText` for its handoff prompt.

**Confirmed: option D** — mutations (`add`/`remove`/`complete`/`rewind`/`reset`/`stage <phase>`) use `notify` (short confirmation); reads (`/superpowers` dashboard, `tasks list`, `stage show`) use `setEditorText` (persistent status the user can read). This mirrors `/workflow-next`'s precedent and avoids widget-lifecycle complexity.

## Backward compatibility

- The existing `/workflow-next` and `/workflow-reset` commands are **subsumed** but NOT removed in this PR (ROADMAP says `/superpowers` "subsumes" them). Add a deprecation notice to their descriptions ("Use `/superpowers stage` / `/superpowers reset` instead"). Removal is a future change.
- The `plan_tracker` tool's existing `init`/`update`/`status`/`clear` actions keep working (the tool now also persists via appendEntry, transparently). Old sessions reconstruct from legacy tool-result `details` (backward-compat path in `reconstructTasksFromBranch`) until a new mutation appends a `plan_tracker_state` entry.

## Out of scope

- `/superpowers query` (user direction: skip).
- Command-driven phase advancement (`/brainstorm`, `/plan`, etc. that pre-fill the editor + invoke the skill) — ROADMAP marks this a separate future feature depending on `/superpowers stage`. This PR implements `stage` (the dependency), not the `/brainstorm`-style commands.
- Removing `/workflow-next` / `/workflow-reset` (deprecation only this PR).

## Verification

- `npm test` (vitest) — all existing tests pass + new tests for:
  - `plan-tracker-state.ts` shared module (init/update/add/remove/rewind/clear/reconstruct).
  - `plan_tracker` tool's new `add`/`remove`/`rewind` actions.
  - `plan_tracker_state` appendEntry persistence + reconstruction (session events).
  - `/superpowers` command: each subcommand's arg parsing + state mutation + output.
  - Backward compat: legacy tool-result-`details` reconstruction still works.
- `npm run lint` (biome) — clean.
- Manual: `/superpowers` dashboard renders all 5 sections; each `tasks`/`stage`/`reset` subcommand works; mutations persist across a simulated session restore.

## Setup

Work on the current branch `feat/skills-upstream-sync`. No new branch. This is a
real feature (new command + plan-tracker persistence migration + new tool
actions) — implement via TDD (the shared state module + tool actions + command
are all testable). Use subagent-driven-development.
