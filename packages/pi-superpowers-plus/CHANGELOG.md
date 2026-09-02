# Changelog

All notable changes to pi-superpowers-plus are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed

- **Structural persistence moved from markdown plan files to a beads molecule.**
  Brainstorming pours a `superpowers-workflow` formula into a real epic; plan tasks are
  beads with full instructions in their descriptions (no more
  `docs/superpowers/plans/*.md`); execution reads `bd ready --mol`/`bd mol current`
  instead of parsing checkboxes. Spec documents remain markdown files for diffability,
  linked from their bead via `--spec-id`. See
  `docs/superpowers/specs/2026-09-02-beads-as-persistence-layer-design.md`.
- **Task tracking migrated from `@tintinweb/pi-tasks` to beads (a `pi-beads` fork).** Durable plan-step tracking (`executing-plans`, `subagent-driven-development`) now creates **persistent beads issues** per plan step (`beads_create`, `beads_update`, `beads_close`, `beads_dep`) — repo-owned, synced, auditable. Session phase bookkeeping (`brainstorming` checklist items; the "Planning"/"Implement"/"Verify" phase markers in `writing-plans`, `test-driven-development`, `verification-before-completion`) now uses **self-owned wisps** (`beads_create({ ..., ephemeral: true })`) created at phase start and closed at completion — ephemeral, excluded from sync, purged via `bd purge` once closed. `pi-tasks` is removed as a prerequisite; `pi-subagents` (`Agent` tool) is unaffected. **Requires** the forked pi-beads: upstream v0.2.2 lacks the `ephemeral` flag on `beads_create` that wisps depend on.
- **Beads WIP visibility + guaranteed closure.** Phase wisps (`"Planning"`, `"Implement"`, `"Verify"`, brainstorming checklist items) are marked `in_progress` immediately after creation so the pi-beads widget shows what's being worked on (`◐`), closed on graceful exit (blocker/redirect/stop) as well as on completion, and the session's done wisps are purged at phase end via `bd mol wisp gc --closed --force` (wisp-only; persistent issues untouched). `using-superpowers` gains a Session Start rule reaping hard-kill leftovers via `bd mol wisp gc --dry-run` / `--age 24h --force` (a stopped/restarted session cannot close its own wisps). `executing-plans` / `subagent-driven-development` mark blocked plan-step tasks `blocked` instead of leaving them silently open, and re-mark them `in_progress` on resume. Uses stock `bd mol wisp gc` — no pi-beads fork change required; the widget's accumulated session done-panel is user-side.
- **New molecule widget** (`extensions/beads-molecule-widget.ts`) renders the active
  superpowers molecule's pipeline state (current phase, current/next step, pending
  count) above the editor — shells out to `bd mol current --json` directly via
  `pi.exec`, refreshed at session start and every turn (no polling).
- **Renamed `agents/` → `agent-templates/`.** The 4 specialized roles (`implementer`, `worker`, `task-reviewer`, `code-reviewer`) are now copy-in templates, not auto-loaded agents. `pi-subagents` discovers custom agents from `.pi/agents/`, `.agents/agents/`, or `$PI_CODING_AGENT_DIR/agents/` — not from an installed package's own directory. Copy the templates into one of those locations to use them (see README Install). Frontmatter reformatted to the `pi-subagents` schema: `name:` dropped (type derived from filename), invalid `lsp` tool dropped.

- **Skill files rewritten** to the new tools' real call shapes: `subagent({agent, task})` → `Agent({subagent_type, prompt, description})`; `plan_tracker({action, ...})` → `TaskCreate({...})` / `TaskUpdate({...})`. The `subagent-driven-development` fix loop now uses a real `resume: <agent_id>` parameter (rounds 1-3) instead of an unimplemented "resume this agent" instruction. No abstraction layer — skills show concrete call syntax (per the design spec's Decision 6).

- **Build/test infrastructure trimmed** to match the package's new shape (skills + templates, no compiled code): `tsconfig.json`, `vitest.config.ts`, `tests/`, and the `@earendil-works/*` / `typebox` / `typescript` / `vitest` devDependencies removed. The quality gate is now `biome check .` (the `test`, `lint`, and `check` npm scripts and CI/publish workflows all run it). `package.json` `pi.extensions` dropped; `pi.skills` retained.

- **README rewritten**: the bundled-extensions section is replaced by a Prerequisites section naming both companion packages; the Subagent Dispatch section uses `Agent(...)` call shapes and points custom-agent instructions at `.pi/agents/`; the architecture tree drops `extensions/` and renames `agents/` → `agent-templates/`.

### Removed

- **Removed the bundled `subagent` and `plan_tracker` extensions entirely** (`extensions/` directory, `agents/` bundled definitions, and `tests/`). These are replaced by two companion packages the user installs separately: [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (in-process subagent dispatch via `createAgentSession` — no subprocess, no stdout parsing, no hand-rolled inactivity watchdog) and [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) (dependency-graph task tracking with `TaskCreate`/`TaskUpdate`/`TaskList`). This eliminates the inactivity-timeout bug class by construction (no subprocess lifecycle left in this repo) and brings UX upgrades the bundled tools lacked: a persistent widget, FleetView, mid-run steering, session resume, background/scheduled dispatch, and bidirectional task dependencies. **Breaking change:** skills now reference `Agent(...)` / `TaskCreate(...)` / `TaskUpdate(...)` directly with no fallback path — both prerequisite packages must be installed. See the README Prerequisites section for install commands.
- **Removed `lsp` from agent template `tools:` frontmatter** — it was a silent no-op (not a real pi built-in tool in either the old system or `pi-subagents`). A real LSP extension is a fast-follow.

### Added

- **`agent-templates/` directory** with the 4 reformatted agent definitions (copy-in only — never auto-loaded, never clobbered by a package update).

### Removed

- **Removed the Workflow Monitor extension entirely** (`extensions/workflow-monitor.ts` and `extensions/workflow-monitor/`), along with its TDD/debug/verification monitors, workflow phase tracker, branch-safety notices, `/superpowers`, `/workflow-next`, `/workflow-reset` commands, and the `workflow_reference` tool. Dogfooding surfaced that `plan_tracker` init calls (e.g. brainstorming creating a todo per checklist item) were misread by the phase tracker as "entering the execute phase," auto-completing the brainstorm phase and reporting "Brainstorming complete, Execute in progress" after a single clarifying question — a confusing, incorrect status that undermined trust in the whole feature. Rather than patch around that specific bug, the extension is gone: discipline (TDD, investigate-before-fix, verify-before-claiming-done, branch safety) now lives entirely in the skill instructions the agent reads and follows, with no separate runtime layer trying to infer workflow state from tool calls. `plan_tracker` (flat task list) and `subagent` are unaffected and remain. *(Both were subsequently removed in the `@tintinweb` migration — see the Removed section above.)*
- Reference content previously served through the `workflow_reference` tool (TDD/debug rationalizations, examples, etc.) still exists as plain markdown files in each skill's directory (e.g. `skills/test-driven-development/reference/rationalizations.md`); skills now point at these files directly instead of a tool call.

### Changed

- **Removed the spontaneous "What next?" boundary transition prompts** (Kind A) from the workflow-monitor's workflow tracker. These prompted the agent at every phase boundary with Next step / Fresh session / Skip / Discuss options, but the premise was false in practice — the agent doesn't need to be told to keep going, and the prompt UI collided with the plan-tracker's own end-of-task UX. Phase transitions are now driven entirely by the workflow skills themselves (e.g. `brainstorming` invoking `writing-plans`) and by explicit user commands (`/brainstorm`…`/finish`, `/superpowers stage`, `/workflow-next`); the tracker only tracks state and renders the phase strip in the TUI widget. The skip-confirmation gate (asking whether to do/skip/cancel a still-pending phase before it's skipped) is unaffected and remains the only prompt fired without explicit user action.
- The finish-phase reminder (nudging the agent to consider doc updates and capture learnings before shipping) is preserved, relocated from the removed boundary-prompt logic into the `/finish` command handler.

### Fixed

- **Artifact-based phase tracking now uses relative paths.** Detection of spec/plan writes under `docs/superpowers/specs/` and `docs/superpowers/plans/` was comparing against absolute paths, so phase advancement silently failed to fire; fixed to normalize against the workspace-relative path.
- **Extensions aligned with pi 0.82.1 core packages and API.** Imports rewritten from the deprecated `@mariozechner/*` + `@sinclair/typebox` specifiers to the `@earendil-works/*` + `typebox` names pi 0.82.1 bundles (per `packages.md`), and 0.52.9→0.82.1 API drift a pure rename would have left broken:
  - `session_switch`/`session_fork` events removed in 0.82.1; reconstruction now uses `session_start` (reason `new`/`resume`/`fork`) + `session_tree`, registered per-event so `pi.on`'s per-literal overloads match.
  - `tool_call` handler returns `{ block: true }` (was `{ blocked: true }`, which pi ignores — tool blocking silently never worked).
  - Subagent `AgentConfig.timeout` now parsed from frontmatter; the absolute kill timer no longer always falls back to the 10-minute default.
  - Type drift: `InputEventResult` on the input `finish()` helper, dropped dead `event.input` fallback (`InputEvent.text`), `Record<TransitionBoundary, Phase>` and `Record<string, ThemeColor>` for the lookup maps.

### Added

- **`tsc --noEmit` typecheck gate** (`tsconfig.json`, scoped to `extensions/`) added to the `check` script and CI, so core API drift is caught going forward.
- Regression tests for the 0.82.1 session-event contract and subagent `timeout` frontmatter parsing.

### Changed

- `package-lock.json` regenerated from stale `@mariozechner/*@0.52.9` / `typebox@0.34.48` to `@earendil-works/*@0.82.1` + `typebox@1.1.38` (pinned in `devDependencies` so CI typechecks against exactly what pi ships). Core packages listed in `peerDependencies` as `"*"` per pi's packaging guidance.

---

## [0.7.0] — 2026-07-29

### Summary

Command-driven workflow: the 7 phase skills leave the system prompt (context-clean) and are entered via `/brainstorm`-style commands that load them on demand. Heuristic skill detection removed (command-only).

### Added

- **Phase commands** — `/brainstorm`, `/plan`, `/execute`, `/verify`, `/review`, `/finish`: advance the workflow tracker and load the corresponding skill (via an `input` transform that rewrites `/brainstorm` → `/skill:brainstorming` before skill expansion; args preserved). `/execute` presents the SDD-vs-executing-plans choice. Skip-confirmation fires when a command jumps past unresolved phases.
- **`disable-model-invocation: true`** on the 7 phase skills — they no longer appear in the system prompt; only loadable via `/skill:` or the phase commands. Supporting skills (TDD, debugging, worktrees, etc.) stay model-invocable.

### Changed

- **Skip-confirmation rewired** into the `input` transform (single entry point for phase advancement; recognizes both the new commands and direct `/skill:` invocations).

### Removed

- **`WorkflowTracker.onInputText` + `onSkillFileRead`** — heuristic skill detection removed (command-only; hidden skills can't be auto-detected). `parseSkillName`/`SKILL_TO_PHASE` kept as utilities; `onFileWritten` (artifact detection) kept.

---

## [0.6.0] — 2026-07-29

### Summary

Unified `/superpowers` user command for inspecting and controlling workflow state, subsuming `/workflow-next` and `/workflow-reset`. The plan-tracker migrates to `appendEntry` persistence so slash-command task mutations are durable across session restore/fork.

### Added

- **`/superpowers` command** — unified user command for workflow state:
  - `/superpowers` — full status dashboard (workflow stage, tasks, TDD phase, debug state, verification).
  - `/superpowers tasks [list|add|remove|complete|reset|rewind]` — manipulate plan-tracker tasks directly (mutations persist via `plan_tracker_state` appendEntry).
  - `/superpowers stage [show|<phase>|reset]` — view or advance the workflow stage in place (non-session-spawning counterpart to `/workflow-next`).
  - `/superpowers reset` — reset all workflow state (workflow + TDD + debug + verification + tasks).
  - (`/superpowers query` is not implemented; tracked as future work.)
- **`plan_tracker` tool: `add`/`remove`/`rewind` actions** — the tool can now append a task, remove a task by index, and rewind a task + all later tasks to `pending` (in addition to the existing init/update/status/clear).
- **`plan-tracker-state.ts` shared module** — the single source of truth for the task list, imported by both the `plan_tracker` tool and the `/superpowers tasks` command. Exports mutators + `persistTasks` (appendEntry) + `reconstructTasksFromBranch` (with legacy tool-result-details fallback).
- **`plan-tracker-render.ts`** — shared TUI widget renderer used by both the tool and the command.
- **`resetWorkflowOnly()` handler method** — resets the workflow tracker only (distinct from `resetState`, which resets the monitors too); used by `/superpowers stage reset`.

### Changed

- **Plan-tracker persistence migrated to `appendEntry`** — task state now persists via `pi.appendEntry("plan_tracker_state", tasks)` (mirroring the workflow-monitor's `superpowers_state` pattern), making slash-command task mutations durable across session restore/fork. The `plan_tracker` tool's existing tool-result `details` are preserved for backward compatibility; old sessions reconstruct from legacy `details` until a new mutation appends a `plan_tracker_state` entry.
- **`plan-tracker.ts` refactored** to a thin wrapper over the shared `plan-tracker-state` module (removed duplicate state/types/reconstruction).
- **Package version** bumped to `0.6.0`.

### Deprecated

- **`/workflow-next`** — subsumed by `/superpowers stage <phase>` (still works; deprecation notice in its description).
- **`/workflow-reset`** — subsumed by `/superpowers reset` (still works; deprecation notice in its description). Removal is a future change.

---

## [0.5.0] — 2026-07-28

### Summary

Synced skill content with the original [`obra/superpowers`](https://github.com/obra/superpowers) @ v6.2.0 (commit `3dcbd5c`), with deliberate fork adaptations. Adds a new skill (`using-superpowers`), reworks Subagent-Driven Development to upstream's unified-reviewer model, and ports substantive content into all remaining skills. Driven by the gap analysis in `docs/upstream-sync-analysis.md`.

### Added

- **`using-superpowers` skill** — the bootstrap/meta skill for skill-invocation discipline (Red Flags rationalization table, Skill Priority, User Instructions precedence). Ported Option B trimmed: drops the aggressive "invoke before ANY response" mandate + `<EXTREMELY-IMPORTANT>`/`<SUBAGENT-STOP>` blocks to keep context clean and align with the roadmap's command-driven direction. Includes a pi-specific `references/pi-tools.md` mapping skill actions to the fork's bundled `subagent`/`plan_tracker` tools. Skill count 12 → 13.
- **Reworked Subagent-Driven Development** — replaces the fork's two-stage spec-then-quality review with upstream's model: unified `task-reviewer` (spec + quality in one pass), scoped `re-review` for fix rounds, 5-round fix loop with breaker + adjudication, plan-scoped progress ledger (compaction-survival), context-hygiene scripts (`sdd-workspace`/`task-brief`/`review-package`), pre-flight plan-conflict scan, and a Global Constraints lens for reviewers. Fork adaptations: `subagent({agent, task})` dispatch shape, model selection stripped (deferred to a future change), `plan_tracker` kept alongside the ledger, and the end-of-plan user checkpoint preserved.
- **SDD helper scripts** — `scripts/sdd-workspace` (per-plan git-ignored scratch dir), `scripts/task-brief` (extract one task's text to a file), `scripts/review-package` (commit list + diff to a file). Adapted the `sdd-workspace` comment to drop a Claude-specific rationale.
- **`task-reviewer-prompt.md` + `re-review-prompt.md`** — unified task reviewer and scoped re-reviewer prompt templates, adapted to the fork's `subagent({agent, task})` dispatch form.
- **`writing-good-tests.md`** — replaces `testing-anti-patterns.md` with upstream's two-principle rewrite: Name the Break (derive expectations independently, no change detectors, behavior not text) + Exercise the Real Thing (mock earns no assertions, mock at the right level, mirror real data) + a Mutation Check. The `tdd-anti-patterns` `workflow_reference` topic is repointed to this file (topic name kept for backward compatibility).
- **brainstorming process enforcement** — HARD-GATE (no implementation skill/code until design approved), "Anti-Pattern: This Is Too Simple To Need A Design" callout, 8-item Checklist, Process Flow graphviz, Spec Self-Review, and a User Review Gate between spec and plan. Drops visual-companion + elements-of-style references (fork lacks those assets).
- **using-git-worktrees restructured model** — Step 0 (detect existing isolation via `GIT_DIR`/`GIT_COMMON` + submodule guard), Step 1a (native worktree tools, preferred) / Step 1b (git worktree fallback), sandbox fallback, and a Common Rationalizations table replacing the old Common Mistakes/Red Flags/Example Workflow guard sections.
- **finishing-a-development-branch reworked model** — 6-step process with the worktree-path-capture fix (Step 2 captures `WORKTREE_PATH` before Step 5 changes directory, so Step 6 cleanup can use it), forge-agnostic PR creation (detect remote platform, no hardcoded `gh`), discard only on explicit typed `discard` confirmation, and a Common Rationalizations table.
- **writing-plans structural improvements** — Task Right-Sizing section, Global Constraints header in the plan template, per-task Interfaces blocks (Consumes/Produces), checkbox (`- [ ]`) step syntax, 4-backtick nested fences, and a Self-Review section. Drops the stale "created by brainstorming skill" line (replaced with "at execution time via `/skill:using-git-worktrees`").
- **`[DIFF_FILE]` placeholder in `code-reviewer.md`** — optional placeholder for a pre-generated review package path, resolving the contract gap where the SDD final-review dispatches the template "passing the printed package path" but the template had no placeholder for it. Inline `git diff` fallback preserved for ad-hoc reviews.
- **Upstream-sync documentation** — the gap analysis (`docs/upstream-sync-analysis.md`) plus per-tier design specs and implementation plans under `docs/superpowers/{specs,plans}/`.

### Changed

- **Subagent dispatch shape** — all skills/prompt templates now use the fork's `subagent({ agent, task })` form instead of upstream's `Subagent (general-purpose):` template. No `Subagent (general-purpose):` references remain in `skills/`.
- **Skill references** — all `superpowers:X` syntax converted to `/skill:X` (fork convention). No `superpowers:` references remain in `skills/`.
- **`agents/spec-reviewer.md` → `agents/task-reviewer.md`** — renamed to match the unified task-reviewer role (spec + quality in one pass). Read-only tool set unchanged. README Bundled Agents table + directory tree updated.
- **`pi-tools.md` dispatch ref** — the mapping table now references the fork's `subagent({ agent, task })` form instead of upstream's `Subagent (general-purpose):` template.
- **`implementer-prompt.md`** — replaced with upstream's richer version: report-file contract (write full report to a file, return a <15-line status), structured TDD evidence (RED/GREEN), "When You're in Over Your Head" escalation, and code-organization guidance.
- **`requesting-code-review` + `code-reviewer.md`** — adopted upstream's Common Rationalizations table (review-guards) and context-isolation principle.
- **`dispatching-parallel-agents`** — adopted the context-isolation principle (agents never inherit session context) and converted dispatch examples to `subagent({ agent, task })`.
- **`systematic-debugging`** — dropped the overview filler line, added a Phase 4 `/skill:verification-before-completion` cross-ref.
- **README + ROADMAP** — skill count references bumped 12 → 13 (3 README spots + 1 ROADMAP spot) and the directory-tree markdown-file count 24 → 26.
- **Package version** bumped to `0.5.0`.

### Fixed

- **`find-polluter.sh`** — accepts `./`-prefixed test patterns and matches top-level test files (patterns like `src/**/*.test.ts` no longer skip `src/top.test.ts`). Verbatim port of two upstream bug fixes.
- **`root-cause-tracing.md`** — anonymized an example path (`/Users/jesse/project/...` → `~/project/...`) for privacy/portability.

### Removed

- **`spec-reviewer-prompt.md` + `code-quality-reviewer-prompt.md`** — superseded by the unified `task-reviewer-prompt.md` + `re-review-prompt.md`.
- **`agents/spec-reviewer.md`** — role subsumed by `agents/task-reviewer.md`.
- **`testing-anti-patterns.md`** — replaced by `writing-good-tests.md`.
- **Recap / social-proof sections** — dropped carryover sections the original trimmed, consistent with the fork's own philosophy: "The Bottom Line" (receiving-code-review, verification-before-completion), "Remember" (writing-plans), "Why This Matters" (verification-before-completion). Rationalization tables and red-flags/checklists (the fork's "grew" content) are preserved.
- **Dangling `superpowers:writing-skills` cross-reference** — removed from `writing-good-tests.md` (the `writing-skills` skill is not ported to this fork).

### Deliberate fork choices (not adopted from upstream)

- **executing-plans keeps batch-with-checkpoints** — the fork frames executing-plans as the checkpointed alternative to SDD's continuous execution; removing batching would contradict the fork's own writing-plans/SDD framing.
- **Brainstorming visual companion not ported** (Tier 3) — the fork lacks `visual-companion.md`.
- **Per-role model selection deferred** — the SDD rework keeps one model across all 5 fix rounds; a separate "pick the best model for each phase" change can come later.
- **`writing-skills` meta-skill not ported** — it's a skill-authoring guide, low priority for end-users.

---

## [0.4.0] — 2026-02-20

### Changed

- **Specs/plans path convention** — Design/spec documents now live in `docs/superpowers/specs/` and implementation plans in `docs/superpowers/plans/` (previously both under `docs/plans/`). Skills (`brainstorming`, `writing-plans`), the workflow tracker, thinking-phase write enforcement, and user-facing docs all point at the new locations. Existing artifacts under `docs/plans/` are not moved.
- **Strict per-phase write boundaries** — During **Brainstorm**, writes are restricted to `docs/superpowers/specs/` only; during **Plan**, to `docs/superpowers/plans/` only. Previously any file under `docs/plans/` was allowed during either thinking phase. Cross-directory writes during a thinking phase now trigger a process violation.
- **Directory-based artifact detection** — The workflow tracker now detects phase artifacts by directory (`docs/superpowers/specs/` → brainstorm, `docs/superpowers/plans/` → plan) instead of by filename suffix.

### Fixed

- **Plan artifacts going undetected** — The previous `*-implementation.md` suffix rule did not match the `YYYY-MM-DD-<feature>.md` naming that `writing-plans` instructs agents to use, so most plan writes were never recorded as artifacts and the workflow phase did not advance. Directory-based detection resolves this.

### Removed

- **`tdd-guard` extension** — TDD enforcement is now handled via runtime warnings in `workflow-monitor` and three-scenario TDD instructions embedded in agent profiles and skill text. Agent profiles no longer need `extensions: ../extensions/tdd-guard.ts` in their frontmatter.

---

## [0.3.0] — 2026-02-18

### Summary

Hardening and skill boundary enforcement. Security fixes, resilient subagent lifecycle, and fixes for three behavioral gaps where the agent ignores skill boundaries.

### Security

- **Environment variable filtering** — subagent spawn now uses an allowlist instead of `{ ...process.env }`. Only safe vars (PATH, HOME, SHELL, NODE_*, PI_*, etc.) are forwarded. Secrets like API keys, database URLs, and cloud credentials are no longer leaked to subagent processes.
- **`PI_SUBAGENT_ENV_PASSTHROUGH`** — escape hatch for users who need to forward specific vars (comma-separated names).
- **CWD validation** — subagent spawn now validates the working directory exists before spawning, returning a clear error instead of a cryptic ENOENT.

### Added

- **Configurable subagent timeout** (`PI_SUBAGENT_TIMEOUT_MS`, default 10 min) — absolute timeout that kills subagents regardless of activity. Agent definitions can override via `timeout` field.
- **Cancellation propagation** — active subagent processes are tracked and killed (SIGTERM → SIGKILL) when the parent session exits.
- **Concurrent subagent cap** (`PI_SUBAGENT_CONCURRENCY`, default 6) — semaphore-based limit on parallel subagent spawns. When the cap is hit, new invocations queue until a slot opens.

### Fixed

- **SDD orchestrator codes on subagent failure** — Promoted subagent failure handling from buried bullet points to a gated section with hard rules. Explicit: the orchestrator does NOT write code, only dispatches subagents. 2 failed attempts = stop and escalate to user.
- **Review subagents apply fixes** — Added explicit read-only `## Boundaries` sections to `code-reviewer.md` and `spec-reviewer-prompt.md`. Reviewers produce written reports — they never touch code.
- **SDD auto-finishes without asking** — Added user checkpoint after all tasks complete. Orchestrator must summarize results and wait for user confirmation before dispatching final review or starting the finishing skill.
- Silent catch blocks in workflow-monitor now log warnings via `log.warn` instead of silently swallowing failures (state file read/write errors).

### Changed

- **Package version** bumped to `0.3.0`.

---

## [0.2.0-alpha.1] — 2026-02-13

### Summary

First-class subagent support. Skills now dispatch implementation and review work via a bundled `subagent` tool instead of shell commands. Four default agent definitions ship with the package. The workflow monitor and TDD enforcement both received important correctness fixes.

### Added

- **Subagent extension** (`extensions/subagent/`) — vendored from pi's example extension. Registers a `subagent` tool that spawns isolated pi subprocesses for implementation and review tasks. Supports single-agent and parallel (multi-task) modes.
- **Agent definitions** (`agents/`) — four bundled agent profiles:
  - `implementer` — strict TDD implementation with the tdd-guard extension
  - `worker` — general-purpose task execution
  - `code-reviewer` — production readiness review (read-only)
  - `spec-reviewer` — plan/spec compliance verification (read-only)
- **Agent frontmatter `extensions` field** — agent `.md` files can declare extensions (e.g. `extensions: ../extensions/tdd-guard.ts`), which are resolved and passed as `--extension` flags to the subprocess.
- **TDD guard extension** (`extensions/tdd-guard.ts`) — lightweight TDD enforcement designed for subagents. Blocks production file writes until a passing test run is observed. Tracks violations via `PI_TDD_GUARD_VIOLATIONS_FILE` env var. Exits after 3 consecutive blocked writes.
- **Structured subagent results** — single-agent mode returns `filesChanged`, `testsRan`, `tddViolations`, `agent`, `task`, and `status` fields in tool result details.
- **Shared test helpers** (`tests/extension/workflow-monitor/test-helpers.ts`) — `createFakePi()`, `getSingleHandler()`, `getHandlers()` extracted and shared across all workflow-monitor test files.
- **`parseSkillName()` utility** (`extensions/workflow-monitor/workflow-tracker.ts`) — centralized `/skill:name` and `<skill name="...">` extraction, replacing duplicated regexes.

### Fixed

- **Input event text field** — Workflow monitor now reads `event.text` (primary) with fallback to `event.input` for skill detection in user input. Previously only checked `event.input`, missing skills delivered via the `text` field.
- **Completion gate phase scoping** — Interactive commit/push/PR prompts now only fire during execute+ phases. Previously they could fire during brainstorm/plan, interrupting early-phase work (e.g. committing a design doc).
- **docs/plans allowlist path traversal** — The brainstorm/plan write allowlist now resolves paths against `process.cwd()` and requires the resolved path to be under `${cwd}/docs/plans/`. Previously, an absolute path like `/tmp/evil/docs/plans/attack.ts` would pass the substring check.
- **TDD guard pass/fail semantics** — The tdd-guard extension now requires a *passing* test result (exit code 0) to unlock production writes. Previously, any test command execution — including failures — would unlock writes.

### Changed

- **Skills updated for subagent dispatch** — `subagent-driven-development`, `dispatching-parallel-agents`, and `requesting-code-review` skills now show `subagent()` tool call examples instead of `pi -p` shell commands.
- **Package version** bumped to `0.2.0-alpha.1`.
- **`package.json` `files`** now includes `agents/` directory.
- **`package.json` `pi.extensions`** now includes `extensions/subagent/index.ts`.

### Internal

- Deduplicated ~180 lines of test helper boilerplate across 6 workflow-monitor test files.
- Added 8 new test files (67 new tests) covering subagent discovery, frontmatter extensions, structured results, tdd-guard behavior, completion gate phasing, path traversal, and input event handling.
- Total test count: **29 files, 251 tests**.

---

## [0.1.0-alpha.3] — 2026-02-12

### Summary

Warning escalation guardrails, branch safety, workflow tracking with phase boundaries, and the initial release of active enforcement extensions.

### Added

- Workflow Monitor extension with TDD, debug, and verification enforcement
- Plan Tracker extension with TUI widget
- 12 workflow skills ported and trimmed from pi-superpowers
- Branch safety notices (current branch on first tool result, confirm-branch on first write)
- Workflow phase tracking with boundary prompts and `/workflow-next` command
- Warning escalation: soft → hard block → user override
- `workflow_reference` tool for on-demand TDD/debug reference content

---

## [0.1.0-alpha.1] — 2026-02-10

Initial alpha release. Skills only, no extensions.
