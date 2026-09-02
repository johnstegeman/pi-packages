# Migrate Task Tracking from @tintinweb/pi-tasks to beads (pi-beads fork) — Design Spec

**Date:** 2026-08-26
**Branch:** `feat/beads`
**Source:** Replace `@tintinweb/pi-tasks` with the forked `@abix5/pi-beads` for all task creation/tracking across the extension. `pi-tasks` will be uninstalled once this lands. `@tintinweb/pi-subagents` (the `Agent` tool) is untouched.

## Motivation

The extension's skills currently reference pi-tasks tools (`TaskCreate`, `TaskUpdate`, `TaskList`, ...) for all task tracking. The user's own project conventions already direct agents to beads (`AGENTS.md`/`CLAUDE.md` carry a managed beads block: *"Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists"*), so the skills' pi-tasks instructions actively conflict with the repo's own guidance.

beads provides everything pi-tasks did for this repo, with a better fit for the two distinct jobs the skills used pi-tasks for:

- **Durable plan-step tracking** (`executing-plans`, `subagent-driven-development`) creates a task per real plan step and updates status as work proceeds. This maps naturally to **persistent beads issues** (synced, auditable, repo-owned).
- **Ephemeral phase bookkeeping** (`brainstorming` checklist items; the "mark X phase complete" one-liners in `writing-plans`, `test-driven-development`, `verification-before-completion`) is session-local status with no cross-session audit value. This maps to **wisps** — beads' ephemeral issues (`Ephemeral=true`), excluded from federation push and purged wholesale via `bd purge --force` once closed.

**Fork requirement:** upstream `@abix5/pi-beads` v0.2.2 does **not** expose an `ephemeral` flag on its `beads_create` tool (`bd` itself supports `--ephemeral` since v1.2.2). The user will fork pi-beads into their own pi monorepo to add `ephemeral: true` support to `beads_create`. That single parameter is the only behavioral dependency this design places on the fork.

**Goals:**
1. Remove all pi-tasks references from skills and docs; skills teach beads tool calls instead.
2. Durable plan work tracked as persistent beads issues; session bookkeeping tracked as wisps.
3. Match the repo's existing AGENTS.md/CLAUDE.md directive so skills and project conventions agree.
4. Silent swap for the single-user repo — no legacy-migration note, no fallback path.

## Decisions

### 1. Dependency: user-managed peer prerequisite replaces pi-tasks

`pi-tasks` is dropped from the prerequisite set; the **forked** pi-beads takes its place. Install command in docs becomes `pi install <fork>` (the fork's published package path once available). There is **no fallback** if the fork isn't installed — skills reference `beads_*` tools directly. This follows the prior tintinweb migration precedent (clean break, no abstraction layer): Decision 2 and Decision 6 of `2026-07-29-tintinweb-migration-design.md`.

`pi-subagents` (Agent tools) stays exactly as-is — only the tracking layer changes.

### 2. Persistent issues for durable plan-step work

`executing-plans` and `subagent-driven-development` track one beads issue per plan step.

- Create: `beads_create({ title: "Task N: <name>", description: "<one-line summary>" })` — no `ephemeral` flag → persistent, synced, auditable.
- Status: `beads_update({ id: "<id>", status: "in_progress" })` as work proceeds.
- Done: `beads_close({ ids: "<id>" })` — beads has no "completed" status; completion is a closed persistent issue.
- Dependencies (`subagent-driven-development` only): pi-tasks' `addBlockedBy`/`addBlocks` → `beads_dep({ issue: "<dependent>", blocker: "<prerequisite>" })` (beads semantics: blocker must be done before issue — same direction as `addBlockedBy`).

**One status transition everywhere:** both durable issues and wisps are "closed" when done. The persistent-vs-wisp distinction lives entirely in the `ephemeral` flag at creation, never in the close operation. Skills teach one status transition instead of two.

### 3. Self-owned wisps for phase bookkeeping

For the phase markers (`writing-plans`, `test-driven-development`, `verification-before-completion`) and per-item checklist tracking (`brainstorming`), the **child skill owns its own wisp lifecycle** — no parent coordination, no ID handoff.

Chosen over the alternatives because:
- It removes the coordination burden pi-tasks itself flagged ("the task ID comes from whatever task list the invoking context already created — pi-tasks has no implicit 'current task' pointer"). Each skill creates exactly what it tracks, with an explicit ID at the call site.
- Repeat-run duplication (a revisited phase spawns a fresh wisp) is harmless — wisps purge when closed, leaving no lingering audit noise.
- It's compaction-survivable: if parent context is lost, the wisp still exists and can be closed or purged — no orphaned reference to a passed-down ID.

Sites:

- **`brainstorming`**: one wisp per checklist item via `beads_create({ title: "<item>", description: "<item detail>", ephemeral: true })`; `beads_close({ ids: "<id>" })` as each item's real output exists. Phase-end closes the session's checklist wisps (`beads_close` accepts multiple space/comma-separated ids).
- **`writing-plans`**: at phase start create wisp `beads_create({ title: "Planning", ephemeral: true })`; on plan saved `beads_close({ ids: "<id>" })`.
- **`test-driven-development`**: at phase start wisp `"Implement"`; on all-green+committed `beads_close`.
- **`verification-before-completion`**: at phase start wisp `"Verify"`; on passing `beads_close`.

### 4. Repo routing: session default + umbrella note

Skills are generic (installed into any user's project), so every `beads_create` example **omits `repo`**, matching beads' own default: the repo containing the session cwd. A single one-line note covers the umbrella case: *"from an umbrella root, pass the owning repo explicitly."* No branching logic in the skills beyond that note.

### 5. No abstraction layer

Skills show real `beads_*` call shapes directly (`beads_create`, `beads_update`, `beads_close`, `beads_dep`) — no translation layer, no intermediate "tracking reference" the skills indirect through. `pi-tools.md` shrinks to a prerequisites note naming the required packages and pointing at pi-beads' own bundled `beads` skill for the full tool reference (pi-beads registers a `beads` skill automatically from its package). Same rule as prior Decision 6.

### 6. Error handling: prerequisites, not fallbacks

- **No `.beads/` in the user's project:** pi-beads stays quiet (`bd✗` status, tools refuse). Documented as a prerequisite (beads must be initialized in the project) in the prerequisites section — no fallback path in the skills.
- **Umbrella-root creation:** covered by the one-line `repo` note in Decision 4.
- **Fork's `ephemeral` flag:** treated as present; the failure mode is a wrong-package-installed prerequisite problem, called out in `pi-tools.md`, not branch-handled in the skills.
- **Re-running a phase skill** creates a fresh wisp each run — accepted (wisps purge).

## Scope

### Skill files rewritten (tracking calls)

| File | Sites | Change |
|---|---|---|
| `skills/executing-plans/SKILL.md` | L31, L38, L41 | `TaskCreate` per plan step → `beads_create` (persistent); `TaskUpdate in_progress` → `beads_update`; `TaskUpdate completed` → `beads_close` |
| `skills/subagent-driven-development/SKILL.md` | L156-160, L375 | `TaskCreate` per plan step → `beads_create` (persistent); `addBlockedBy`/`addBlocks` → `beads_dep`; `TaskUpdate completed` → `beads_close` |
| `skills/brainstorming/SKILL.md` | L42, L129 | Create a wisp per checklist item (`ephemeral: true`); close each when its real output exists; phase-end closes the session's checklist wisps |
| `skills/writing-plans/SKILL.md` | L188 | Self-owned wisp ("Planning"); `beads_close` after plan saved |
| `skills/test-driven-development/SKILL.md` | L255 | Self-owned wisp ("Implement"); `beads_close` when green+committed |
| `skills/verification-before-completion/SKILL.md` | L133 | Self-owned wisp ("Verify"); `beads_close` when passed |

All sites drop the "pi-tasks has no implicit 'current task' pointer" hedging — every beads call has an explicit target.

### Reference/prerequisite docs

- `skills/using-superpowers/references/pi-tools.md` — tracking row: `TaskCreate`/`TaskUpdate`/... via pi-tasks → `beads_*` tools via the forked pi-beads; install command updated; note that the fork (not upstream v0.2.2) is required for `ephemeral`; point at the bundled beads skill for the tool reference. `pi-subagents` row unchanged.

### README

- L15, L25, L28: pi-tasks companion bullet / install command → forked pi-beads.
- L69, L77, L88-89, L126, L213-215, L255: feature-comparison rows, `packages:` example array, widget/phase-progress prose, and attribution reworded from pi-tasks (`TaskCreate`/`TaskUpdate` + pi-tasks widget) to beads (`beads_*` + pi-beads widget). `pi-subagents` rows unchanged.
- No new custom widget/ASCII art — credit pi-beads' own widget (prior Decision 6 rule).
- Silent swap — no "users of pi-tasks should migrate" note.

### CHANGELOG

New `[Unreleased]` entry (existing style): tracking moved to beads — persistent issues for plan-step work, wisps for session phase bookkeeping; `ephemeral` support requires the pi-beads fork; pi-tasks removed as a prerequisite. Historical 2026-07-29 entries stay as-is.

### Checked, no edit expected

- `AGENTS.md`, `CLAUDE.md` — already carry the beads integration block ("Use `bd` for ALL task tracking — do NOT use ... TaskCreate") via the beads integration; already aligned with the migration's end state. Verify the block isn't stale during implementation.
- `package.json` — pi-tasks was never a dependency here (user-managed prerequisite), so no package manifest change. Confirm `pi` key / scripts unchanged.

## Out of scope

- `@tintinweb/pi-subagents` / the `Agent` tool — untouched.
- Upstream contributions to pi-beads — the user is forking instead.
- Any change to historical `docs/` records from prior migrations.
- Cleaning up pi-tasks' session storage (`.pi/tasks/`) in existing projects — per-session, harmless once pi-tasks is uninstalled.

## Verification

- `npx biome check .` clean (repo test/lint script — no vitest/tsc remain post-migration; confirm `biome.json` doesn't reference removed paths).
- Grep fence: `grep -rn "TaskCreate\|TaskUpdate\|TaskList\|pi-tasks"` returns nothing in `skills/`, `README.md`, `pi-tools.md` (CHANGELOG historical entries excluded).
- Manual smoke: run a workflow in a working project with `.beads/` + the fork installed — confirm persistent issues for plan steps, wisps for phases, `beads_dep` wiring, and `beads_close` all work end-to-end.
