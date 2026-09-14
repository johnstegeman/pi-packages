# Migrate to @tintinweb/pi-subagents + @tintinweb/pi-tasks — Design Spec

**Date:** 2026-07-29
**Branch:** to create off `main` (branches from the merged `johnstegeman/timeouts` inactivity-timer fix)
**Source:** Follow-up to the subagent inactivity-timeout bug fix (PR #11) — replacing the homegrown `subagent`/`plan_tracker` extensions entirely rather than continuing to maintain them.

## Motivation

While fixing a subagent inactivity-timeout bug (`extensions/subagent/index.ts`
killing subagents mid-work because its watchdog only reset on `message_end`
events, not `tool_execution_*` events), it became clear the underlying
architecture — spawning a separate `pi` subprocess per subagent and parsing
its stdout JSON stream — is why that bug class exists at all: it requires a
hand-rolled process watchdog with its own failure modes.

[`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) runs
subagents **in-process** via `createAgentSession` from the pi SDK, subscribing
directly to `AgentSessionEvent` — no subprocess, no stdout parsing, no
inactivity watchdog needed. It also brings real UX upgrades our bundled
`subagent` tool lacks: a persistent widget, FleetView (navigable list of
running agents), mid-run steering, background/scheduled dispatch, and agent
resume.

[`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) replaces our
flat `plan_tracker` tool with a dependency-graph task system (blocking/blocked-by
edges, persistent widget, multiple storage scopes) and can optionally integrate
with `pi-subagents` for task-driven dispatch (not used in this design — see
Decision 5).

**Goals:**
1. Eliminate the inactivity-timeout bug class by construction (no subprocess
   lifecycle management left in this repo).
2. Bring the UX upgrades (widget, FleetView, steering, resume, background
   agents) to the workflow skills.
3. Depend on packages with active maintenance and existing user bases instead
   of code we personally maintain.

## Decisions

### 1. Dependency model: user-managed peer requirement, not vendored

`pi-superpowers-plus` does **not** bundle, fork, or redistribute
`@tintinweb/pi-subagents` / `@tintinweb/pi-tasks`. They are prerequisites the
user installs separately (`pi install npm:@tintinweb/pi-subagents`, `pi
install npm:@tintinweb/pi-tasks`). This avoids ever having to sync a vendored
copy against upstream changes. Since this repo currently has exactly one user,
the simplicity of "install once, done" outweighs the friction of an extra
manual step.

### 2. Clean break — no fallback path

Our own `extensions/subagent/` and `extensions/plan-tracker*.ts` are removed
entirely, not kept as a fallback for users who haven't installed the
prerequisite packages. Skill files reference `Agent(...)` / `TaskCreate(...)`
etc. directly with no branching logic for "old tool vs. new tool." This is a
breaking change for this package's only user, made consciously to avoid
maintaining two tool surfaces and skills that branch on which is available.

### 3. Keep the 4 specialized agent roles as manual copy-in templates

`pi-subagents` only discovers custom agents from `.pi/agents/` (project),
`.agents/agents/` (project), or `$PI_CODING_AGENT_DIR/agents/` (global) — not
from an arbitrary installed package's own directory (pi packages can declare
`extensions`, `skills`, `prompts`, `themes`; "agents" isn't a package resource
type). So the 4 existing specialized roles (`implementer`, `worker`,
`task-reviewer`, `code-reviewer`) are kept, reformatted to `pi-subagents`'
frontmatter schema, and relocated to a new `agent-templates/` directory in
this package — copy-in only, never auto-loaded. The README documents the
manual copy step explicitly (no `postinstall` script) so nothing writes
outside the package directory without the user doing it deliberately, and
existing customizations to those files are never silently clobbered by a
package update.

### 4. Full skill-file rewrite, staged rollout

Every skill/agent file that references `subagent(...)` or `plan_tracker(...)`
call syntax is rewritten to the new tools' real call shapes (direct rewrite,
not a translation/abstraction layer — see Decision 6). This is scoped as part
of the same overall change, not deferred, since a partial swap would leave
skills referencing removed tools. Rollout is staged across 3 PRs for
reviewability:

1. Remove old extensions/tests, add `agent-templates/`, and do the **full**
   README rewrite (all bullets under "README rewrite" below) — none of it
   depends on the skill files being rewritten first, since it's describing
   tool call syntax and architecture, not the skill prose itself.
2. Rewrite dispatch-related skills (`subagent-driven-development`,
   `dispatching-parallel-agents`, `requesting-code-review`).
3. Rewrite tracking-related skills (the 5 phase-completion `plan_tracker`
   call sites), final verification pass, CHANGELOG entry.

Between stages, skills may reference tools not yet fully wired up in prose —
acceptable for a single-user repo with no other consumers mid-migration.

### 5. Controller-driven dispatch, not `TaskExecute`/auto-cascade

`pi-tasks`' `TaskExecute` tool can auto-dispatch a task directly to a subagent
and, in auto-cascade mode, chain to a task's unblocked dependents
automatically. This is **not adopted** for `subagent-driven-development`: that
skill's value is a judgment-heavy review/fix loop (resume vs. fresh implementer
by round number, adjudicate findings at the round-5 breaker, escalate
load-bearing issues to the human) that has no natural home in a forward-only
DAG-cascade model. Forcing it there would mean modeling review as its own DAG
node and hacking retries via task-status resets — reintroducing the same
controller-side judgment through clumsier state management.

Instead: `pi-tasks` (`TaskCreate`/`TaskUpdate`/`TaskList`) is used purely for
tracking/visibility, exactly the role `plan_tracker` plays today. Dispatch
stays a direct, controller-driven `Agent(...)` call per task, with the
review/fix loop mechanics unchanged.

(Other skills — e.g. `dispatching-parallel-agents`, `executing-plans` — may be
legitimate future fits for `TaskExecute`/auto-cascade since they lack this
review-loop complexity, but that's out of scope here; call it per-skill later
if desired.)

### 6. Direct tool-call rewrite, no abstraction layer

Skill files show the real tool names and parameter shapes (`Agent({...})`,
`TaskCreate({...})`) rather than routing through an internal
action-language-to-tool mapping. The existing `skills/using-superpowers/
references/pi-tools.md` shrinks to a prerequisites/install note pointing at
each package's own docs, rather than re-documenting their APIs — skills
already show concrete call syntax today, so a translation layer would just be
duplicated content with drift risk, not real indirection.

### 7. LSP tool for agent templates — explicitly deferred

The current `implementer`/`worker` templates list `lsp` in their `tools:`
frontmatter. This isn't a real pi built-in tool in either the old system or
`pi-subagents` (pi 0.82.1's built-ins are `read, bash, edit, write, grep,
find, ls` — confirmed via `pi --help`); it has been a silent no-op. Two real
candidate LSP extensions exist (`@narumitw/pi-lsp` — narrow diagnostics/fix
tools; `pi-lsp-extension` by samfoy — broader definition/hover/references/
rename/etc.), but adding either means a third user-managed peer dependency and
its own tool-name decisions. **Deferred as a fast-follow** after this
migration lands; `lsp` is simply dropped from the `tools:` frontmatter in this
change (dead reference removed, nothing added yet).

## Scope

### Removed entirely

- `extensions/` — the whole directory:
  - `logging.ts` (only consumer was `extensions/subagent/`; becomes dead code
    once that's gone)
  - `plan-tracker.ts`, `plan-tracker-state.ts`, `plan-tracker-render.ts`
  - `subagent/` — `index.ts`, `agents.ts`, `concurrency.ts`, `env.ts`,
    `lifecycle.ts`, `timeout.ts`
- `tests/extension/` — the whole directory:
  - `logging.test.ts`, `logging-error-handling.test.ts`
  - `subagent/` (10 files, 54 tests)
  - `plan-tracker/` (2 files)
- `tests/helpers/mock-logger.ts` (only used by the deleted logging tests)
- `package.json`:
  - `pi.extensions` array (evaluate during implementation whether to drop the
    whole `pi` key or keep `pi.skills`)
  - `@earendil-works/pi-tui`, `typebox` from `peerDependencies`/
    `devDependencies` if nothing else imports them post-deletion (re-grep
    required)
  - `tsc --noEmit` / `vitest run` from `check`/`test` scripts if no code/tests
    remain (or keep as harmless no-ops for future contributions — decide
    during implementation)
- Any `biome.json` / `tsconfig.json` path references tied to removed
  directories

### Left as-is (historical record)

- `docs/plans/2026-02-17-ux-fixes.md`, `docs/plans/2026-02-18-v030-hardening.md`,
  and other historical plan docs describing the now-removed extensions — kept
  as past-work record, same treatment `CHANGELOG.md` already gives prior
  changes.

### Added

- `agent-templates/` (renamed from `agents/`):
  - `implementer.md`, `worker.md`, `task-reviewer.md`, `code-reviewer.md`
  - Frontmatter changes: drop `name:` (pi-subagents derives type from
    filename), drop invalid `lsp` from `tools:`, otherwise unchanged (`tools:`
    format is compatible; no templates currently set a `timeout:` so nothing
    maps to `max_turns`). Body prompt text unchanged for all 4 files.
- README `Prerequisites` section with install commands for both packages and
  the manual `agent-templates/*.md` copy step.
- `CHANGELOG.md` entry documenting the removal/migration, in the existing
  `[Unreleased]` style.

### Skill/agent files rewritten

**Dispatch-related (subagent → Agent):**
- `skills/subagent-driven-development/SKILL.md` — process narrative +
  `plan_tracker` tracking call sites (see below); the fix-loop resume
  mechanic gets *more* precise: `resume: <agent_id>` is a real
  `pi-subagents` parameter (today's "resume this agent" instruction had no
  actual tool support — every dispatch was a fresh subprocess). Rounds 1-3
  of the fix loop use `Agent({ subagent_type: "implementer", resume:
  <agent_id>, prompt: "<findings>" })`; rounds 4-5 drop `resume:` and dispatch
  fresh, as today.
- `skills/subagent-driven-development/implementer-prompt.md`,
  `task-reviewer-prompt.md`, `re-review-prompt.md` — each's opening
  `subagent({ agent: "X", task: ... })` becomes `Agent({ subagent_type: "X",
  prompt: ..., description: "<short 3-5 word desc>" })` (description is a new
  required field in the tintinweb schema).
- `skills/dispatching-parallel-agents/SKILL.md` — 3 example calls become
  `Agent(...)` calls, staying foreground (relies on pi's existing sibling
  parallel-tool-call execution, same mechanism as today — no behavior
  change). Add one note mentioning `run_in_background: true` as an option
  for long-running independent work where the controller wants to keep
  working, since that capability is new.
- `skills/requesting-code-review/code-reviewer.md` — single foreground
  `subagent({...})` → `Agent({...})` swap, no new mechanics (no
  resume/parallel/tracking involved).
- `agent-templates/worker.md`, `implementer.md` (moved from `agents/`) — body
  prose ("You are a general-purpose subagent...") needs no change; only
  frontmatter is reformatted per Decision 3/7.

**Tracking-related (plan_tracker → pi-tasks):**
- `skills/subagent-driven-development/SKILL.md` — "create a todo per task"
  → `TaskCreate({ subject: ..., description: ... })` per task at setup;
  "mark the todo complete" → `TaskUpdate({ taskId: ..., status: "completed"
  })`. Optional/non-blocking: use `addBlockedBy`/`addBlocks` for tasks the
  plan states depend on each other (additive value pi-tasks provides that
  `plan_tracker` never had — not required for functional parity, add if
  straightforward during implementation).
- `skills/test-driven-development/SKILL.md`, `skills/executing-plans/SKILL.md`,
  `skills/brainstorming/SKILL.md`, `skills/writing-plans/SKILL.md`,
  `skills/verification-before-completion/SKILL.md` — each's "call
  `plan_tracker` with `{action: "update", status: "complete"}` for the current
  phase" becomes an explicit `TaskUpdate({ taskId: ..., status: "completed"
  })`, noting the task ID comes from whatever task list the invoking context
  already created (pi-tasks has no implicit "current task" pointer the way
  `plan_tracker` did). `executing-plans` additionally has its own
  `TaskCreate`-per-step call replacing its `plan_tracker` init-equivalent.

**Reference/prerequisite docs:**
- `skills/using-superpowers/references/pi-tools.md` — shrinks to naming the
  two required packages + pointing at their own docs (per Decision 6).

**Checked, no edit expected:**
- `skills/using-git-worktrees/SKILL.md`, `skills/finishing-a-development-branch/
  SKILL.md`, `skills/writing-plans/SKILL.md` (related-skills cross-references)
  — only *name* `subagent-driven-development` as a skill to invoke, no direct
  tool-call syntax. Confirm during implementation none has a stale inline
  example.

### README rewrite

- Intro paragraph: "a couple of small extensions" → two companion packages,
  installed separately.
- "What You Get" section: "2 extensions that run silently in the background"
  → **Prerequisites** section with `pi install` commands for both packages
  and a note that skills require them (no fallback).
- Install section: add the manual `agent-templates/*.md` copy step
  (`~/.pi/agent/agents/` global or `.pi/agents/` project-local).
- "Upgrading from pi-superpowers" / "What's new" bullets: rename bundled-tool
  bullets to name the two external packages.
- "How the skills differ (leveraging pi)": same swap; TUI-widget bullet
  credits `pi-tasks`'/`pi-subagents`' own widgets.
- "Extensions" section (`### Plan Tracker` with ASCII widget + code block):
  deleted, replaced by the Prerequisites section (no API re-documentation,
  per Decision 6).
- "How the Skills Work Together" table: "uses the `subagent` tool" → "uses
  the `Agent` tool from `@tintinweb/pi-subagents`".
- "Subagent Dispatch" section: bundled-agents table stays (4 templates, drop
  `lsp` from Tools column); single/parallel examples become `Agent(...)`
  calls; "Custom Agents" instructions point at `.pi/agents/` (pi-subagents'
  own discovery convention) instead of describing removed discovery logic.
- "Compared to Superpowers" table: rows referencing bundled tooling updated
  to credit the two external packages.
- Architecture tree: `extensions/` block removed; `agents/` → `agent-templates/`;
  `tests/` line updated to reflect remaining test count (likely zero).
- Development section: remove/replace the
  `npx vitest run tests/extension/plan-tracker/...` example command if no
  tests remain.
- Attribution section: rephrase to credit the tintinweb packages as the
  current tooling layer.

## Out of scope

- Adding a real LSP tool to agent templates (Decision 7 — fast-follow).
- Adopting `TaskExecute`/auto-cascade anywhere (Decision 5 — not planned,
  could be reconsidered per-skill later for `dispatching-parallel-agents` or
  `executing-plans` specifically).
- Any change to `docs/plans/*.md` historical records.

## Verification

- After each staged PR: `npx vitest run`, `npx tsc --noEmit`, `npx biome
  check .` all clean (matching the discipline used for the inactivity-timer
  fix in PR #11).
- Manual smoke test: install both prerequisite packages fresh, copy
  `agent-templates/*.md` into `.pi/agents/`, run through
  `subagent-driven-development` on a small real plan to confirm `Agent(...)`
  dispatch, `resume:` fix-loop behavior, and `pi-tasks` tracking all work
  end-to-end.
- README prerequisites/install instructions followed literally from a clean
  environment to confirm no missing steps.
