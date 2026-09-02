# `/superpowers` Command Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Implement the `/superpowers` slash command (dashboard, `tasks`, `stage`, `reset` — not `query`) by migrating the plan-tracker to `appendEntry` persistence, extracting a shared state module, adding `add`/`remove`/`rewind` task actions, and registering the unified command.

**Architecture:** Extract `extensions/plan-tracker-state.ts` (shared source of truth: task list + mutators + `appendEntry` persistence + branch reconstruction, mirroring `superpowers_state`). `plan-tracker.ts` (the tool) becomes a thin wrapper. `workflow-monitor.ts` registers `/superpowers` and imports the shared module for `tasks` mutations + the dashboard's task list. Rendering: `setEditorText` for reads (dashboard/list/show), `notify` for mutation confirmations (option D).

**Tech Stack:** TypeScript, vitest, biome, pi ExtensionAPI (`registerCommand`, `appendEntry`, `sessionManager.getBranch`).

**Branch:** `feat/skills-upstream-sync` (current).

**Design spec:** `docs/superpowers/specs/2026-07-29-superpowers-command-design.md`.

**Key patterns to mirror:**
- `superpowers_state` persistence: `extensions/workflow-monitor.ts:55` (`SUPERPOWERS_STATE_ENTRY_TYPE`), `:149` (`persistState`), `reconstructState` (`:61`).
- Command test pattern: `tests/extension/workflow-monitor/workflow-reset-command.test.ts` (fake pi, capture `appendEntry`, capture `notify`).
- Existing command registration: `extensions/workflow-monitor.ts:761` (`/workflow-reset`), `:773` (`/workflow-next`).

---

## Phase 1 — Plan-tracker state module + appendEntry migration (TDD)

### Task 1: Create `plan-tracker-state.ts` shared module with mutators + persistence + reconstruction (TDD)

**TDD scenario:** New feature — full TDD cycle. Write failing tests for the shared module, then implement.

**Files:**
- Create test: `tests/extension/plan-tracker/plan-tracker-state.test.ts`
- Create: `extensions/plan-tracker-state.ts`

**Step 1: Write the failing test** (`tests/extension/plan-tracker/plan-tracker-state.test.ts`)

Test the shared module's pure functions + persistence + reconstruction. Cover:
- `initTasks(["a","b","c"])` → `getTasks()` returns 3 tasks all `pending`.
- `updateTask(1, "complete")` → task 1 status `complete`; others unchanged.
- `addTask("d")` → appends a `pending` task "d".
- `removeTask(0)` → removes task 0; remaining reindexed (task 0 is now the old task 1).
- `rewindTask(1)` → task 1 and all after it → `pending`; tasks before unchanged. (e.g. tasks [✓0, ✓1, →2, ○3], rewind(1) → [✓0, ○1, ○2, ○3]).
- `clearTasks()` → empty.
- `setTasks([...])` → replaces.
- `persistTasks(pi)` → calls `pi.appendEntry("plan_tracker_state", tasks)`.
- `reconstructTasksFromBranch(ctx)` → scans `getBranch()` for the last `custom` entry with `customType === "plan_tracker_state"` and `setTasks(data)`; falls back to legacy `plan_tracker` tool-result `details` reconstruction; falls back to empty.
- Error cases: `updateTask`/`removeTask`/`rewindTask` out-of-range index → throw or return error (pick one — recommend throwing a typed error the caller catches); `addTask` empty name → throw.

The module owns a module-level `tasks` array (singleton, like the current plan-tracker). Export an accessor `getTasks()` returning a copy.

Use a mock `pi` with `appendEntry` captured (like the command test pattern) and a mock `ctx` with `sessionManager.getBranch()` returning a scripted entry list.

**Step 2: Run test to verify it fails (RED)**

Run: `npx vitest run tests/extension/plan-tracker/plan-tracker-state.test.ts`
Expected: FAIL — module doesn't exist yet (import error).

**Step 3: Implement `extensions/plan-tracker-state.ts`**

```typescript
// Shared plan-tracker state: the single source of truth for the task list.
// Both the plan_tracker tool (extensions/plan-tracker.ts) and the
// /superpowers tasks command (extensions/workflow-monitor.ts) import this.
// State persists via pi.appendEntry("plan_tracker_state", tasks), mirroring
// the workflow-monitor's superpowers_state pattern. Reconstructed from the
// last plan_tracker_state entry in getBranch() on session events, with a
// legacy tool-result-details fallback for sessions predating the migration.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type TaskStatus = "pending" | "in_progress" | "complete";

export interface Task {
  name: string;
  status: TaskStatus;
}

export const PLAN_TRACKER_STATE_ENTRY_TYPE = "plan_tracker_state";

let tasks: Task[] = [];

export function getTasks(): Task[] {
  return tasks.map((t) => ({ ...t }));
}

export function setTasks(next: Task[]): void {
  tasks = next.map((t) => ({ ...t }));
}

export function initTasks(names: string[]): Task[] {
  tasks = names.map((name) => ({ name, status: "pending" as TaskStatus }));
  return getTasks();
}

export function updateTask(index: number, status: TaskStatus): Task[] {
  if (tasks.length === 0) throw new Error("no plan active");
  if (index < 0 || index >= tasks.length) throw new Error(`index ${index} out of range (0-${tasks.length - 1})`);
  tasks[index].status = status;
  return getTasks();
}

export function addTask(name: string): Task[] {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("task name required");
  tasks.push({ name: trimmed, status: "pending" });
  return getTasks();
}

export function removeTask(index: number): Task[] {
  if (tasks.length === 0) throw new Error("no plan active");
  if (index < 0 || index >= tasks.length) throw new Error(`index ${index} out of range (0-${tasks.length - 1})`);
  tasks.splice(index, 1);
  return getTasks();
}

export function rewindTask(index: number): Task[] {
  if (tasks.length === 0) throw new Error("no plan active");
  if (index < 0 || index >= tasks.length) throw new Error(`index ${index} out of range (0-${tasks.length - 1})`);
  for (let i = index; i < tasks.length; i++) {
    tasks[i].status = "pending";
  }
  return getTasks();
}

export function clearTasks(): Task[] {
  tasks = [];
  return getTasks();
}

export function persistTasks(pi: ExtensionAPI): void {
  pi.appendEntry(PLAN_TRACKER_STATE_ENTRY_TYPE, getTasks());
}

// Reconstruct from the last plan_tracker_state appendEntry in the branch;
// fall back to legacy plan_tracker tool-result details; fall back to empty.
export function reconstructTasksFromBranch(ctx: ExtensionContext): Task[] {
  const entries = ctx.sessionManager.getBranch();

  // First preference: newest plan_tracker_state custom entry
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry.type === "custom" && entry.customType === PLAN_TRACKER_STATE_ENTRY_TYPE) {
      setTasks(Array.isArray(entry.data) ? entry.data : []);
      return getTasks();
    }
  }

  // Legacy fallback: last plan_tracker tool-result details (pre-migration)
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry.type === "message") {
      const msg = entry.message;
      if (msg?.role === "toolResult" && msg?.toolName === "plan_tracker") {
        const details = msg.details;
        if (details && !details.error && Array.isArray(details.tasks)) {
          setTasks(details.tasks);
          return getTasks();
        }
      }
    }
  }

  setTasks([]);
  return getTasks();
}
```

**Step 4: Run test to verify it passes (GREEN)**

Run: `npx vitest run tests/extension/plan-tracker/plan-tracker-state.test.ts`
Expected: PASS.

**Step 5: Run full suite + lint**

Run: `npm test` (expect 40+ files pass — existing 40 + new test file) and `npm run lint` (expect clean).

**Step 6: Commit**

```bash
git add extensions/plan-tracker-state.ts tests/extension/plan-tracker/plan-tracker-state.test.ts
git commit -m "feat(plan-tracker): extract shared state module with appendEntry persistence

Extract extensions/plan-tracker-state.ts as the single source of truth for
the task list: get/set/init/update/add/remove/rewind/clear mutators +
persistTasks (pi.appendEntry('plan_tracker_state', tasks)) +
reconstructTasksFromBranch (last plan_tracker_state entry, with legacy
tool-result-details fallback). Mirrors the workflow-monitor's
superpowers_state pattern. New actions: add, remove, rewind. This module
will be imported by both the plan_tracker tool and the /superpowers tasks
command."
```

---

### Task 2: Refactor `plan-tracker.ts` to use the shared module + appendEntry persistence

**TDD scenario:** Modifying tested code — the existing behavior must still hold. Add a test that `appendEntry` is called on mutations; verify existing tool behavior via the shared module.

**Files:**
- Modify: `extensions/plan-tracker.ts`
- Create/modify test: `tests/extension/plan-tracker/plan-tracker-tool.test.ts`

**Step 1: Write/extend the test** asserting the tool persists via `appendEntry` on each mutation (init/update/add/remove/rewind/clear) and that the tool's `details` still carry the task list (backward compat). Use the fake-pi pattern capturing `appendEntry` calls.

**Step 2: Run test to verify it fails (RED)** — the tool doesn't call `appendEntry` yet.

**Step 3: Refactor `extensions/plan-tracker.ts`:**
- Remove the module-private `tasks` array, `Task`/`TaskStatus`/`PlanTrackerDetails` types (import from `plan-tracker-state.ts`), and the `reconstructState` function (use `reconstructTasksFromBranch`).
- Import `{ getTasks, initTasks, updateTask, addTask, removeTask, rewindTask, clearTasks, setTasks, reconstructTasksFromBranch, persistTasks, type Task, type TaskStatus }` from `./plan-tracker-state`.
- Extend `PlanTrackerParams`: add `"add" | "remove" | "rewind"` to the `action` enum; add `name: Type.Optional(Type.String())` param (for `add`).
- Rewrite each `case` to call the shared mutator + `persistTasks(pi)` + `updateWidget(ctx)` + return `details: { action, tasks: getTasks() }`.
- Add `case "add"`, `case "remove"`, `case "rewind"` mirroring `update`'s error handling (catch the shared module's thrown errors → return an error result with `details.error`).
- Replace the `reconstructState` session-event handler with `reconstructTasksFromBranch(ctx)`.
- Update the tool `description` to mention `add`/`remove`/`rewind`.
- Keep `formatWidget`/`formatStatus` (rendering helpers) in place, reading `getTasks()`.
- The `pi` reference is captured in the extension's closure — `persistTasks(pi)` works.

**Step 4: Run test to verify it passes (GREEN)** — `appendEntry` called on mutations; `details` carry tasks.

**Step 5: Run full suite + lint** — existing 40 test files still pass (no regressions; the tool's external behavior is unchanged) + new plan-tracker tests pass.

**Step 6: Commit**

```bash
git add extensions/plan-tracker.ts tests/extension/plan-tracker/plan-tracker-tool.test.ts
git commit -m "refactor(plan-tracker): use shared state module; persist via appendEntry

plan-tracker.ts becomes a thin wrapper over plan-tracker-state.ts. Each
mutation (init/update/add/remove/rewind/clear) now calls persistTasks(pi)
to append a plan_tracker_state entry (durable across session restore/fork),
in addition to the existing tool-result details. Adds add/remove/rewind
tool actions. Backward compat: legacy tool-result-details reconstruction
still works for sessions predating the migration."
```

---

## Phase 2 — The `/superpowers` command

### Task 3: Register `/superpowers` command with the dashboard (read-only) + `stage` subcommand

**TDD scenario:** New feature — TDD. Test the command registration + dashboard rendering + `stage` mutations.

**Files:**
- Modify: `extensions/workflow-monitor.ts`
- Create test: `tests/extension/workflow-monitor/superpowers-command.test.ts`

**Step 1: Write the failing test** covering:
- Command `superpowers` is registered.
- `/superpowers` (no args) calls `ctx.ui.setEditorText` with a multi-section status string containing: the phase strip, the task list (from `getTasks()`), TDD phase, debug state, verification state.
- `/superpowers stage show` → `setEditorText` with the phase strip.
- `/superpowers stage execute` → `handler.advanceTo("execute")` is called; `persistState()` appends a `superpowers_state` entry; `notify` called with info.
- `/superpowers stage badphase` → `notify` error "invalid phase".
- `/superpowers stage reset` → workflow tracker reset to defaults; persist; notify.

The test uses the fake-pi pattern (capture `appendEntry`, `notify`, `setEditorText`). The `handler` is internal to the extension — the test exercises it via the command's observable effects (the persisted `superpowers_state` entry's `workflow.currentPhase`).

**Step 2: Run test to verify it fails (RED)** — command not registered.

**Step 3: Implement in `extensions/workflow-monitor.ts`:**
- Register `pi.registerCommand("superpowers", { description, handler })`.
- Arg parsing: `const [sub, ...rest] = args.trim().split(/\s+/); const subArg = rest.join(" ");`
- **No sub (dashboard):** build a status string from `handler.getFullState()` (workflow phase strip + TDD + debug + verification) + `getTasks()` (task list via `formatStatus`-equivalent — import a renderer or inline). Call `ctx.ui.setEditorText(status)`.
- **`stage` subcommand:** `stage` or `stage show` → `setEditorText` with phase strip. `stage <phase>` → validate against `WORKFLOW_PHASES`; `handler.advanceTo(phase)`; `persistState()`; `updateWidget(ctx)`; `notify("Stage set to <phase>. Use /skill:<skill> to proceed.", "info")` (map phase→skill via the existing `phaseToSkill`). `stage reset` → reset workflow tracker only (need `handler.resetWorkflowOnly()` — add to the handler interface + impl, calling `tracker.reset()`); `persistState()`; `updateWidget(ctx)`; `notify`.
- Add `resetWorkflowOnly()` to the `WorkflowHandler` interface + `createWorkflowHandler` impl (calls `tracker.reset()` only, not the monitors).

**Step 4: Run test to verify it passes (GREEN).**

**Step 5: Run full suite + lint.**

**Step 6: Commit**

```bash
git add extensions/workflow-monitor.ts extensions/workflow-monitor/workflow-handler.ts tests/extension/workflow-monitor/superpowers-command.test.ts
git commit -m "feat(superpowers): add /superpowers dashboard + stage subcommand

/superpowers (no args) renders a status dashboard (workflow phase strip,
tasks, TDD phase, debug state, verification) via setEditorText.
/superpowers stage [show|<phase>|reset] views or advances the workflow
tracker in place (non-session-spawning counterpart to /workflow-next) via
handler.advanceTo / a new resetWorkflowOnly. Reads use setEditorText
(option D). Adds resetWorkflowOnly to the handler."
```

---

### Task 4: Add `tasks` subcommand to `/superpowers`

**TDD scenario:** New feature — TDD. Test each `tasks` subcommand's mutation + persistence + output.

**Files:**
- Modify: `extensions/workflow-monitor.ts`
- Modify test: `tests/extension/workflow-monitor/superpowers-command.test.ts`

**Step 1: Write failing tests** for:
- `/superpowers tasks` and `/superpowers tasks list` → `setEditorText` with the task list.
- `/superpowers tasks add <name>` → `getTasks()` includes the new task; `appendEntry` called with `plan_tracker_state`; `notify` info. (name may contain spaces — `tasks add fix the bug` → name "fix the bug".)
- `/superpowers tasks remove <index>` → task removed; persist; notify.
- `/superpowers tasks complete <index>` → status `complete`; persist; notify.
- `/superpowers tasks rewind <index>` → task + later tasks → `pending`; persist; notify.
- `/superpowers tasks reset` → empty; persist; notify.
- Error cases: `tasks add` (no name) → notify error; `tasks remove 5` (out of range / no plan) → notify error; `tasks complete` (no index) → notify error; `tasks bogus` → notify error "unknown tasks subcommand".

**Step 2: Run test to verify it fails (RED)** — `tasks` subcommand not implemented.

**Step 3: Implement** in the `superpowers` command handler, `tasks` branch:
- Import the shared module's mutators + `persistTasks` into `workflow-monitor.ts`.
- `tasks` / `tasks list` → `setEditorText(formatStatus(getTasks()))`.
- `tasks add <name>` → `addTask(name)`; `persistTasks(pi)`; `updateWidget(ctx)` (need to trigger the plan-tracker widget — see Step 3 note); `notify("Task added: <name>", "info")`. Catch errors → `notify(err.message, "error")`.
- `tasks remove <index>` → `removeTask(parseInt(index))`; persist; notify.
- `tasks complete <index>` → `updateTask(parseInt(index), "complete")`; persist; notify.
- `tasks rewind <index>` → `rewindTask(parseInt(index))`; persist; notify.
- `tasks reset` → `clearTasks()`; persist; notify.
- `tasks <unknown>` → `notify("Unknown tasks subcommand: <unknown>. Use list|add|remove|complete|reset|rewind.", "error")`.
- Index parsing: `parseInt(rest[0], 10)`; validate `Number.isInteger`.

**Widget update note:** the plan-tracker widget is owned by the plan-tracker extension. After a `/superpowers tasks` mutation, the widget won't auto-update (separate extension). Two options: (a) call `ctx.ui.setWidget("plan_tracker", ...)` directly from the command using the shared `formatWidget`-equivalent; (b) skip widget update (the next plan_tracker tool call or session event refreshes it). Recommend (a) — import a `renderPlanTrackerWidget(tasks, theme)` from the shared module (extract it from plan-tracker.ts) so both the tool and the command update the widget. Add `renderPlanTrackerWidget` to the shared module (or a separate `plan-tracker-render.ts`) in this task.

**Step 4: Run test to verify it passes (GREEN).**

**Step 5: Run full suite + lint.**

**Step 6: Commit**

```bash
git add extensions/workflow-monitor.ts extensions/plan-tracker-state.ts tests/extension/workflow-monitor/superpowers-command.test.ts
git commit -m "feat(superpowers): add tasks subcommand (list|add|remove|complete|reset|rewind)

/superpowers tasks manipulates the plan-tracker task list directly via the
shared plan-tracker-state module, persisting each mutation via
persistTasks (appendEntry plan_tracker_state). Reads (list) use
setEditorText; mutations use notify (option D). Widget updates after
mutations via a shared renderPlanTrackerWidget helper."
```

---

### Task 5: Add `reset` subcommand to `/superpowers` (reset all workflow state)

**TDD scenario:** New feature — TDD. Test that `reset` clears workflow + monitors + tasks + persists both.

**Files:**
- Modify: `extensions/workflow-monitor.ts`
- Modify test: `tests/extension/workflow-monitor/superpowers-command.test.ts`

**Step 1: Write failing tests** for:
- `/superpowers reset` → `handler.resetState()` called (workflow+TDD+debug+verification back to defaults); `clearTasks()` (task list empty); `appendEntry` called with both `superpowers_state` (reset workflow/monitors) AND `plan_tracker_state` (empty); `notify` info "All workflow state reset".
- Verify the persisted `superpowers_state` entry has `currentPhase: null`, all phases `pending`, tdd idle, debug inactive, verification not verified.
- Verify the persisted `plan_tracker_state` entry is `[]`.

**Step 2: Run test to verify it fails (RED)** — `reset` subcommand not implemented (only `/workflow-reset` exists).

**Step 3: Implement** the `reset` branch in the `superpowers` handler:
- `handler.resetState()`; `persistState()` (persists `superpowers_state`).
- `clearTasks()`; `persistTasks(pi)` (persists `plan_tracker_state` empty).
- `updateWidget(ctx)` (clears workflow widget); update plan-tracker widget (clear).
- `ctx.ui.notify("All workflow state reset. Ready for a new task.", "info")`.

**Step 4: Run test to verify it passes (GREEN).**

**Step 5: Run full suite + lint.**

**Step 6: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/superpowers-command.test.ts
git commit -m "feat(superpowers): add reset subcommand (reset all workflow state)

/superpowers reset clears workflow + TDD + debug + verification (via
handler.resetState) AND the plan-tracker task list (via clearTasks),
persisting both a superpowers_state and a plan_tracker_state entry.
Subsumes /workflow-reset."
```

---

## Phase 3 — Backward compat + docs

### Task 6: Deprecate `/workflow-next` and `/workflow-reset`; update docs

**TDD scenario:** Trivial change — description edits + doc updates.

**Files:**
- Modify: `extensions/workflow-monitor.ts` (deprecation notices on the two old commands' `description`)
- Modify: `README.md` (mention `/superpowers` command)
- Modify: `ROADMAP.md` (mark the `/superpowers` command item as shipped, move to a "shipped" note)
- Modify: `CHANGELOG.md` (add `[0.6.0]` entry)

**Step 1: Add deprecation notices.** In `workflow-monitor.ts`, update the two `registerCommand` descriptions:
- `workflow-reset`: `"Reset workflow tracker to fresh state for a new task (deprecated — use /superpowers reset)"`.
- `workflow-next`: `"Start a fresh session for the next workflow phase (deprecated — use /superpowers stage <phase>)"`.

**Step 2: README** — add a `/superpowers` command mention (in the extensions/workflow section or a new "Commands" subsection): list the 4 subcommands.

**Step 3: ROADMAP** — update the `/superpowers` command + command-driven-phase-advancement lines: mark `/superpowers` (dashboard/tasks/stage/reset) as shipped; note `query` and the `/brainstorm`-style commands remain future work.

**Step 4: CHANGELOG** — add `[0.6.0]` entry: Added (`/superpowers` command, plan-tracker `add`/`remove`/`rewind` actions, plan-tracker `appendEntry` persistence); Changed (plan-tracker migrated to shared state module); Deprecated (`/workflow-next`, `/workflow-reset`). Bump `package.json` version to `0.6.0`.

**Step 5: Verify** — `npm test` + `npm run lint` pass; `grep -n "deprecated" extensions/workflow-monitor.ts` shows the 2 notices.

**Step 6: Commit**

```bash
git add extensions/workflow-monitor.ts README.md ROADMAP.md CHANGELOG.md package.json
git commit -m "docs: deprecate /workflow-next + /workflow-reset; document /superpowers command

Mark /workflow-next and /workflow-reset as deprecated (subsumed by
/superpowers stage and /superpowers reset; not removed yet). README +
ROADMAP updated; CHANGELOG [0.6.0] entry added; version bumped to 0.6.0."
```

---

## Verification (after all tasks)

- `npm test` — all green (existing 40 files + new plan-tracker + superpowers-command tests).
- `npm run lint` — clean.
- `/superpowers` registered; dashboard renders all 5 sections.
- `/superpowers tasks [list|add|remove|complete|reset|rewind]` all work; mutations persist via `plan_tracker_state` appendEntry.
- `/superpowers stage [show|<phase>|reset]` works; `stage <phase>` advances tracker + persists `superpowers_state`.
- `/superpowers reset` resets everything; persists both entry types.
- `plan_tracker` tool's new `add`/`remove`/`rewind` actions work + persist.
- Backward compat: legacy tool-result-details reconstruction still works (old sessions).
- `/workflow-next` + `/workflow-reset` still work (deprecated notices).
