# Migrate to @tintinweb/pi-subagents + @tintinweb/pi-tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace this repo's bundled `subagent` and `plan_tracker` extensions (and their tests/build infra) with two user-installed companion packages — `@tintinweb/pi-subagents` (`Agent` tool) and `@tintinweb/pi-tasks` (`TaskCreate`/`TaskUpdate`/etc.) — and rewrite every skill/agent/README reference to the new tools' real call shapes.

**Architecture:** A clean break, no fallback. The `extensions/` and `tests/` directories are deleted entirely; `agents/` is renamed to `agent-templates/` (copy-in only, reformatted to the `pi-subagents` frontmatter schema). Skill files are rewritten directly to `Agent({...})` / `TaskCreate({...})` / `TaskUpdate({...})` call syntax — no abstraction layer. Rollout is staged across 3 PRs: (1) remove code layer + agent-templates + full README rewrite; (2) rewrite dispatch-related skills; (3) rewrite tracking-related skills + CHANGELOG + final verification.

**Tech Stack:** Markdown skills, YAML frontmatter, JSON package config, GitHub Actions YAML, biome (lint/quality gate). No compiled TypeScript or unit tests remain after Phase 1 — the package ships skills + agent templates only.

## Global Constraints

- **Branch:** create off `main` (which contains the merged `johnstegeman/timeouts` inactivity-timer fix, PR #11). Name it `feat/tintinweb-migration`.
- **Prerequisite packages are user-managed, not vendored:** `@tintinweb/pi-subagents` and `@tintinweb/pi-tasks` are installed by the user via `pi install npm:@tintinweb/pi-subagents` and `pi install npm:@tintinweb/pi-tasks`. This repo never bundles, forks, or redistributes them.
- **Clean break — no fallback path:** skill files reference `Agent(...)` / `TaskCreate(...)` etc. directly with no branching logic for "old tool vs. new tool." Both packages are hard prerequisites.
- **`lsp` is dropped from agent template `tools:` frontmatter** (it was a silent no-op — not a real pi 0.82.1 built-in tool; pi 0.82.1 built-ins are `read, bash, edit, write, grep, find, ls`). A real LSP extension is an explicit fast-follow, out of scope here.
- **No `postinstall` script:** agent templates are copied manually by the user; nothing writes outside the package directory without the user doing it deliberately.
- **Direct tool-call rewrite, no abstraction layer:** skills show real tool names and parameter shapes. `skills/using-superpowers/references/pi-tools.md` shrinks to a prerequisites note pointing at each package's own docs.
- **`pi-tasks` is used for tracking/visibility only** (the role `plan_tracker` plays today); dispatch stays a direct controller-driven `Agent(...)` call per task. `TaskExecute`/auto-cascade is NOT adopted (the SDD review/fix loop is judgment-heavy controller work with no natural home in a forward-only DAG-cascade).
- **Agent template frontmatter (pi-subagents schema):** `name:` dropped (type is derived from the filename); `tools:` is a comma-separated built-in list (no `lsp`); no template sets `timeout:`, so nothing maps to `max_turns`; body prompt text is unchanged for all 4 templates.
- **Verification after each PR:** `npx biome check .` clean (the quality gate after Phase 1 removes vitest/tsc). After Phase 1, `npm test` runs `biome check .`.
- **Historical docs left as-is:** `docs/plans/*.md` historical records and `ROADMAP.md` historical roadmap items are not edited (prior changes are treated as historical record, same as `CHANGELOG.md`).

---

## File Structure

**Deleted entirely (Phase 1):**
- `extensions/` — `logging.ts`, `plan-tracker.ts`, `plan-tracker-state.ts`, `plan-tracker-render.ts`, `subagent/` (`index.ts`, `agents.ts`, `concurrency.ts`, `env.ts`, `lifecycle.ts`, `timeout.ts`). All bundled tool code.
- `tests/` — `extension/` (14 files: logging, subagent/, plan-tracker/) and `helpers/mock-logger.ts`. All tests for the removed extensions.
- `tsconfig.json` — no compiled TS remains after the deletions.
- `vitest.config.ts` — no tests remain.

**Renamed + reformatted (Phase 1):**
- `agents/` → `agent-templates/` — `implementer.md`, `worker.md`, `task-reviewer.md`, `code-reviewer.md`. Frontmatter: drop `name:`, drop `lsp` from `tools:`; body unchanged. Copy-in only.

**Modified (Phase 1):**
- `package.json` — drop `pi.extensions` (keep `pi.skills`); `files` swaps `extensions/`+`agents/` → `agent-templates/`; remove all `@earendil-works/*`, `typebox`, `typescript`, `vitest` deps (nothing imports them post-deletion); scripts reduce to `biome check .`.
- `biome.json` — remove the `tests/**` override (directory gone).
- `.github/workflows/ci.yml` — remove `tsc --noEmit` and `vitest run` steps; keep `biome check .`.
- `.github/workflows/publish.yml` — replace `npx vitest run` with `npx biome check .`.
- `package-lock.json` — regenerated by `npm install` after `package.json` dep changes.
- `README.md` — full rewrite (Prerequisites section, `Agent(...)` examples, architecture tree, attribution).

**Modified (Phase 2 — dispatch-related skills):**
- `skills/subagent-driven-development/SKILL.md` — fix-loop resume mechanic (`resume: <agent_id>` for rounds 1-3; drop `resume:` rounds 4-5). (Tracking call sites in this file are Phase 3.)
- `skills/subagent-driven-development/implementer-prompt.md` — `subagent({agent, task})` → `Agent({subagent_type, prompt, description})`.
- `skills/subagent-driven-development/task-reviewer-prompt.md` — same swap.
- `skills/subagent-driven-development/re-review-prompt.md` — same swap.
- `skills/dispatching-parallel-agents/SKILL.md` — 3 example calls → `Agent(...)`; add `run_in_background` note.
- `skills/requesting-code-review/code-reviewer.md` — single `subagent({...})` → `Agent({...})` swap.
- `skills/using-superpowers/references/pi-tools.md` — shrinks to a prerequisites note naming both packages.

**Modified (Phase 3 — tracking-related skills + CHANGELOG):**
- `skills/subagent-driven-development/SKILL.md` — 2 `plan_tracker` tracking call sites → `TaskCreate` / `TaskUpdate`.
- `skills/executing-plans/SKILL.md` — `plan_tracker` init + 2 update call sites → `TaskCreate` per task + `TaskUpdate`.
- `skills/test-driven-development/SKILL.md` — 1 phase-completion call site → `TaskUpdate`.
- `skills/brainstorming/SKILL.md` — 1 phase-completion call site → `TaskUpdate`.
- `skills/writing-plans/SKILL.md` — 1 phase-completion call site → `TaskUpdate`.
- `skills/verification-before-completion/SKILL.md` — 1 phase-completion call site → `TaskUpdate`.
- `CHANGELOG.md` — new `[Unreleased]` entry documenting the removal/migration.

**Checked, no edit expected (confirmed in final verification):**
- `skills/using-git-worktrees/SKILL.md`, `skills/finishing-a-development-branch/SKILL.md` — only *name* `subagent-driven-development` as a skill to invoke; no direct `subagent(...)`/`plan_tracker(...)` call syntax.
- `CONTRIBUTING.md` — `npm test` still works (it becomes `biome check .`).
- `ROADMAP.md` — historical roadmap items referencing the old subagent extension are historical record; left as-is.

---

## Phase 1 — Remove code layer, add agent-templates, rewrite README (PR 1)

### Task 1: Remove the bundled code layer + build/test infrastructure

**TDD scenario:** Trivial change — deletion + config edits. No production behavior to test; verify by file absence + `biome check .` clean + grep.

**Files:**
- Delete: `extensions/` (whole directory), `tests/` (whole directory), `tsconfig.json`, `vitest.config.ts`
- Modify: `package.json`, `biome.json`, `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `package-lock.json` (regenerated)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a repo with no compiled code, no tests, no `extensions/`/`tests/`/`agents/`-referencing build config. Later tasks rely on `npm test` = `biome check .` being the quality gate.

**Rationale for decisions the spec deferred:** (a) Keep `pi.skills`, drop `pi.extensions` — the package still ships skills. (b) Remove the entire build/test infra (`tsconfig.json`, `vitest.config.ts`, `@earendil-works/*`, `typebox`, `typescript`, `vitest`) — nothing imports these post-deletion (verified: the only importers are `extensions/*.ts`, which are deleted; no skill or test imports them). YAGNI: don't keep tooling for code that no longer exists. (c) `npm test` becomes `biome check .` so `CONTRIBUTING.md`'s `npm test` instruction and the publish pre-gate stay valid.

- [ ] **Step 1: Delete the bundled code and tests**

```bash
git rm -r extensions tests
git rm tsconfig.json vitest.config.ts
```

- [ ] **Step 2: Replace `package.json` with this exact content**

```json
{
  "name": "pi-superpowers-plus",
  "version": "0.7.0",
  "description": "Superpowers workflow skills adapted for pi",
  "keywords": [
    "pi-package"
  ],
  "scripts": {
    "test": "biome check .",
    "lint": "biome check .",
    "check": "biome check ."
  },
  "license": "MIT",
  "author": "coctostan",
  "repository": {
    "type": "git",
    "url": "https://github.com/coctostan/pi-superpowers-plus.git"
  },
  "files": [
    "agent-templates/",
    "skills/",
    "banner.jpg",
    "LICENSE",
    "README.md"
  ],
  "pi": {
    "skills": [
      "skills"
    ]
  },
  "devDependencies": {
    "@biomejs/biome": "^2.3.15"
  }
}
```

- [ ] **Step 3: Replace `biome.json` with this exact content** (drops the `tests/**` override — that directory no longer exists)

```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.15/schema.json",
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 120
  },
  "linter": {
    "rules": {
      "recommended": true
    }
  },
  "files": {
    "includes": ["**", "!**/node_modules", "!**/docs", "!**/*.md", "!**/*.json"]
  }
}
```

- [ ] **Step 4: Replace `.github/workflows/ci.yml` with this exact content** (drops the `tsc --noEmit` and `vitest run` steps)

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx biome check .
```

- [ ] **Step 5: Replace `.github/workflows/publish.yml` with this exact content** (replaces `npx vitest run` with `npx biome check .`)

```yaml
name: Publish

on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npx biome check .
      - run: npm publish --provenance --access public
```

- [ ] **Step 6: Regenerate the lockfile**

```bash
npm install
```

This rewrites `package-lock.json` to drop the removed `@earendil-works/*`, `typebox`, `typescript`, and `vitest` entries and keep only `@biomejs/biome` (+ its platform binary packages).

- [ ] **Step 7: Verify**

```bash
# No stale build/test files tracked:
git ls-files | grep -E '^extensions/|^tests/|tsconfig|vitest' ; echo "matched: $?"
# Expected: no output, "matched: 1" (grep found nothing)

# package.json has no removed deps:
grep -E '@earendil-works|typebox|typescript|vitest|peerDependencies' package.json ; echo "matched: $?"
# Expected: no output, "matched: 1"

# Quality gate is clean:
npm test
# Expected: "biome check ." passes (0 errors). Infos about biome.json schema migration are fine (exit 0).
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor!: remove bundled subagent/plan-tracker extensions and build/test infra

Extensions/, tests/, tsconfig.json, vitest.config.ts deleted. package.json
trimmed to skills + agent-templates (no compiled code, no tests): pi.extensions
dropped (pi.skills kept), @earendil-works/* + typebox + typescript + vitest
deps removed, scripts reduced to biome check . . CI/publish workflows drop
tsc/vitest steps. Replaced by @tintinweb/pi-subagents + @tintinweb/pi-tasks
(user-installed). Breaking change — README + skills rewritten in follow-up tasks."
```

---

### Task 2: Relocate `agents/` → `agent-templates/` with frontmatter reformat

**TDD scenario:** Trivial change — rename + frontmatter edit. Verify by file presence + grep.

**Files:**
- Rename: `agents/implementer.md` → `agent-templates/implementer.md`
- Rename: `agents/worker.md` → `agent-templates/worker.md`
- Rename: `agents/task-reviewer.md` → `agent-templates/task-reviewer.md`
- Rename: `agents/code-reviewer.md` → `agent-templates/code-reviewer.md`
- Modify (frontmatter only): all 4 files. Body prompt text unchanged.

**Interfaces:**
- Consumes: Task 1 (tests/ gone, so `agents-discovery.test.ts` no longer references `agents/`).
- Produces: `agent-templates/*.md` in the `pi-subagents` frontmatter schema. README (Task 3) and skills (Phase 2/3) reference these by filename-derived type names (`implementer`, `worker`, `task-reviewer`, `code-reviewer`).

- [ ] **Step 1: Move the directory and create the 4 reformatted files**

```bash
mkdir -p agent-templates
git mv agents/implementer.md agent-templates/implementer.md
git mv agents/worker.md agent-templates/worker.md
git mv agents/task-reviewer.md agent-templates/task-reviewer.md
git mv agents/code-reviewer.md agent-templates/code-reviewer.md
```

- [ ] **Step 2: Replace `agent-templates/implementer.md` with this exact content** (dropped `name:`, dropped `lsp` from `tools:`; body unchanged)

```markdown
---
description: Implement tasks via TDD and commit small changes
tools: read, write, edit, bash
---

You are an implementation subagent.

## TDD Approach

Determine which scenario applies before writing code:

**New files / new features:** Full TDD. Write a failing test first, verify it fails, implement minimal code to pass, refactor.

**Modifying code with existing tests:** Run existing tests first to confirm green. Make your change. Run tests again. If the change isn't covered by existing tests, add a test. If it is, you're done.

**Trivial changes (typo, config, rename):** Use judgment. Run relevant tests after if they exist.

**If you see a ⚠️ TDD warning:** Pause. Consider which scenario applies. If existing tests cover your change, run them and proceed. If not, write a test first.

## Rules
- Keep changes minimal and scoped to the task.
- Run the narrowest test(s) first, then the full suite when appropriate.
- Commit when the task's tests pass.
- Report: what changed, tests run, files changed, any concerns.
```

- [ ] **Step 3: Replace `agent-templates/worker.md` with this exact content** (dropped `name:`, dropped `lsp` from `tools:`; body unchanged)

```markdown
---
description: General-purpose worker for isolated tasks
tools: read, write, edit, bash
---

You are a general-purpose subagent. Follow the task exactly.

## TDD (when changing production code)

- New files: write a failing test first, then implement.
- Modifying existing code: run existing tests first, make your change, run again. Add tests if not covered.
- Trivial changes: run relevant tests after if they exist.
- If you see a ⚠️ TDD warning, pause and decide which scenario applies before proceeding.

Prefer small, test-backed changes.
```

- [ ] **Step 4: Replace `agent-templates/task-reviewer.md` with this exact content** (dropped `name:`; `tools:` already had no `lsp`; body unchanged)

```markdown
---
description: "Review one task: spec compliance + code quality (read-only)"
tools: read, bash, find, grep, ls
---

You are a task reviewer. You review one task's implementation in two parts: spec compliance first, then code quality.

## Boundaries

- **Read code, run git commands, run focused tests: yes**
- **Edit, create, or delete any files: NO**
- You are a reviewer. Your output is a written report. You never touch the code.

## Spec Compliance

Check the implementation against the provided requirements.
- Identify missing requirements.
- Identify scope creep / unrequested changes.
- Point to exact files/lines.

## Code Quality

Check for: clean separation of concerns, proper error handling, DRY without premature abstraction, edge cases handled, tests verify real behavior (not mocks), file structure follows the plan.

## Output

Begin directly with the spec-compliance verdict. Every line is a verdict, a finding with file:line, or a check you ran — no preamble, no process narration, no closing summary.

### Spec Compliance
- ✅ Spec compliant | ❌ Issues found: [what's missing/extra/misunderstood, with file:line]
- ⚠️ Cannot verify from diff: [requirements you could not verify from the diff alone]

### Strengths
[What's well done? Be specific.]

### Issues
#### Critical (Must Fix)
#### Important (Should Fix)
#### Minor (Nice to Have)

### Assessment
**Task quality:** [Approved | Needs fixes]
**Reasoning:** [1-2 sentence technical assessment]
```

- [ ] **Step 5: Replace `agent-templates/code-reviewer.md` with this exact content** (dropped `name:`; `tools:` already had no `lsp`; body unchanged)

```markdown
---
description: "Production readiness review: quality, security, testing (read-only)"
tools: read, bash, find, grep, ls
---

You are a code quality reviewer.

Review for:
- correctness, error handling
- maintainability
- security and footguns
- test coverage quality

Return:
- Strengths
- Issues (Critical/Important/Minor)
- Clear verdict (ready or not)
```

- [ ] **Step 6: Verify**

```bash
# Old directory gone, new one has 4 files:
ls agents 2>/dev/null ; echo "agents exists: $?"          # Expected: exists: 1 (not found)
ls agent-templates                                      # Expected: code-reviewer.md implementer.md task-reviewer.md worker.md

# No name: frontmatter, no lsp tool reference:
grep -rn '^name:' agent-templates/ ; echo "name matched: $?"   # Expected: matched: 1 (none)
grep -rn 'lsp' agent-templates/ ; echo "lsp matched: $?"       # Expected: matched: 1 (none)

# Quality gate clean:
npm test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: rename agents/ to agent-templates/, reformat to pi-subagents schema

Frontmatter: name: dropped (type derived from filename), dead lsp tool
dropped from implementer/worker tools:. Body prompt text unchanged.
Templates are copy-in only — pi-subagents discovers custom agents from
.pi/agents/, .agents/agents/, or \$PI_CODING_AGENT_DIR/agents/, not from
an installed package's own directory."
```

---

### Task 3: Full README rewrite

**TDD scenario:** Trivial change — documentation rewrite. Verify by grep (no stale `subagent(`/`plan_tracker`/`extensions/` references) + readability.

**Files:**
- Modify: `README.md` (replace entire contents)

**Interfaces:**
- Consumes: Task 1 (no `extensions/`/`agents/` to describe) + Task 2 (`agent-templates/` exists).
- Produces: README describing the two companion packages, `Agent(...)` call shapes, the manual copy step, and the new architecture. This is the user-facing documentation for the whole migration.

- [ ] **Step 1: Replace `README.md` with this exact content**

````markdown
# pi-superpowers-plus

![pi-superpowers-plus banner](banner-plus.jpg)

Structured workflow skills for [pi](https://github.com/badlogic/pi-mono).

Your coding agent doesn't just know the rules - it follows them. Skills teach the agent *what* to do (brainstorm before building, write tests before code, verify before claiming done). The tooling that supports that workflow — subagent dispatch and task tracking — comes from two companion packages you install alongside this one.

## What You Get When You Install This

**13 workflow skills** that guide the agent through a structured development process - from brainstorming ideas through shipping code.

**Two companion packages** provide the tooling the skills reference (installed separately, see Prerequisites):
- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) — registers the `Agent` / `get_subagent_result` / `steer_subagent` tools for dispatching implementation and review work to isolated in-process subagents, with a persistent widget, FleetView, mid-run steering, and session resume.
- [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) — registers the `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` / `TaskOutput` / `TaskStop` / `TaskExecute` tools for dependency-graph task tracking with a persistent widget.

There's no runtime enforcement layer watching tool calls — the discipline (TDD, verification before claiming done, branch safety, etc.) lives entirely in the skill instructions the agent reads and follows.

## Prerequisites

This package provides skills and agent templates only — it no longer bundles its own tools. Install the two companion packages first:

```bash
pi install npm:@tintinweb/pi-subagents
pi install npm:@tintinweb/pi-tasks
```

The skills reference `Agent(...)`, `TaskCreate(...)`, `TaskUpdate(...)`, etc. directly. There is **no fallback** if these packages aren't installed — the skills assume the tools are available.

## Install

```bash
pi install git:github.com/johnstegeman/pi-superpowers-plus
```

Then copy the agent templates into a location `pi-subagents` discovers (see its [Custom Agents](https://github.com/tintinweb/pi-subagents#custom-agents) docs):

```bash
# Global (available everywhere) — pick this or the project-local option:
cp agent-templates/*.md ~/.pi/agent/agents/

# Or project-local (this project only):
mkdir -p .pi/agents && cp agent-templates/*.md .pi/agents/
```

The templates are copy-in only — they are never auto-loaded from this package's directory and never overwritten by an update. Re-copy after upgrading if you want the upstream changes, or keep your local edits.

No other configuration required. Skills activate automatically.

## Support

- Questions / support: https://github.com/johnstegeman/pi-superpowers-plus/discussions
- Bugs: https://github.com/johnstegeman/pi-superpowers-plus/issues/new/choose
- Feature requests: https://github.com/johnstegeman/pi-superpowers-plus/issues/new/choose
- Roadmap: [`ROADMAP.md`](ROADMAP.md)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Upgrading from `pi-superpowers`

If you're currently using [`pi-superpowers`](https://github.com/coctostan/pi-superpowers), `pi-superpowers-plus` is intended as a drop-in upgrade: you keep the same skill names and workflow, with pi-specific tooling layered on top.

### What stays the same
- The same core workflow skills (e.g. `/skill:brainstorming`, `/skill:writing-plans`, `/skill:executing-plans`, etc.)
- The same "structured workflow" idea and phase order

### What's new in `pi-superpowers-plus`
- **Three-scenario TDD model** — new feature (full TDD), modifying tested code (run existing tests), trivial change (judgment) — applied consistently across skills, agent templates, and plan templates
- **Subagent dispatch** via [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (`Agent` tool) for delegating implementation/review work to isolated in-process subagents
- **Task tracking** via [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) (`TaskCreate`/`TaskUpdate`/`TaskList` tools) with a dependency graph and TUI widget
- Restored inline red flags, rationalizations, and verification checklists in several skills for more self-contained guidance

### Migration
Replace `pi-superpowers` with `pi-superpowers-plus` in your config, and install the two companion packages (see Prerequisites):

```json
{
  "packages": ["npm:pi-superpowers-plus", "npm:@tintinweb/pi-subagents", "npm:@tintinweb/pi-tasks"]
}
```

Notes:
- If you keep both `pi-superpowers` and `pi-superpowers-plus` enabled, you may get duplicate/competing skill guidance.

### How the skills differ (leveraging pi)

`pi-superpowers-plus` uses pi's runtime capabilities alongside skill content:
- **Three-scenario TDD** — skills, agent templates, and plan templates all use the same model: new feature (full TDD), modifying tested code (run existing tests), trivial change (use judgment).
- The **TUI widgets** from `pi-tasks` and `pi-subagents` show task progress and active agents above the editor.
- Tools like **`TaskCreate`/`TaskUpdate`** and **`Agent`** store execution state and run subagents outside the prompt.
- Reference material that used to bloat a skill's `SKILL.md` was split into separate reference files in the skill's own directory (e.g. `reference/rationalizations.md`), which the agent reads on demand instead of loading everything up front.

To make this concrete, here's the size of each skill's `SKILL.md` compared to the original [`coctostan/pi-superpowers`](https://github.com/coctostan/pi-superpowers) (approximate KB, at time of writing). Across the shared skills, total `SKILL.md` content went from **67.5KB → 66.5KB**. Skills that shrank moved content into separate reference files loaded on demand; skills that grew restored inline red flags, rationalizations, and verification checklists for self-contained guidance.

| Skill | pi-superpowers (KB) | pi-superpowers-plus (KB) | Change |
|---|---:|---:|---:|
| `brainstorming` | 2.5 | 2.9 | +16% |
| `dispatching-parallel-agents` | 6.2 | 6.1 | -2% |
| `executing-plans` | 2.7 | 3.5 | +30% |
| `finishing-a-development-branch` | 4.3 | 4.4 | +2% |
| `receiving-code-review` | 6.2 | 5.8 | -6% |
| `requesting-code-review` | 2.9 | 3.0 | +3% |
| `subagent-driven-development` | 10.2 | 11.3 | +11% |
| `systematic-debugging` | 9.8 | 7.2 | -27% |
| `test-driven-development` | 9.8 | 8.1 | -17% |
| `using-git-worktrees` | 5.5 | 6.1 | +11% |
| `verification-before-completion` | 4.1 | 4.3 | +5% |
| `writing-plans` | 3.3 | 3.8 | +15% |

## The Workflow

The skills guide the agent through a consistent development cycle:

```
Brainstorm → Plan → Execute → Verify → Review → Finish
```

| Phase | Skill | What Happens |
|-------|-------|--------------|
| **Brainstorm** | `/skill:brainstorming` | Refines your idea into a design document via Socratic dialogue |
| **Plan** | `/skill:writing-plans` | Breaks the design into bite-sized TDD tasks with exact file paths and code |
| **Execute** | `/skill:executing-plans` or `/skill:subagent-driven-development` | Works through tasks in batches with review checkpoints |
| **Verify** | `/skill:verification-before-completion` | Runs tests and proves everything works - evidence before claims |
| **Review** | `/skill:requesting-code-review` | Dispatches a reviewer subagent to catch issues before merge |
| **Finish** | `/skill:finishing-a-development-branch` | Presents merge/PR/keep/discard options and cleans up |

Progress through the workflow is tracked with the `TaskCreate`/`TaskUpdate` tools from `@tintinweb/pi-tasks` as the agent works through each phase's checklist; the `pi-tasks` widget renders the task list above the editor.

### Supporting Skills

These skills are used within the main workflow as needed:

| Skill | When It's Used |
|-------|---------------|
| `/skill:test-driven-development` | During execution |
| `/skill:systematic-debugging` | When tests fail repeatedly |
| `/skill:using-git-worktrees` | Before execution - creates isolated branch workspace |
| `/skill:dispatching-parallel-agents` | When multiple independent problems need solving concurrently |
| `/skill:receiving-code-review` | When acting on review feedback - prevents blind agreement |

## How the Skills Work Together

Skills are markdown files the agent reads to learn *what* to do; discipline (TDD, investigating before fixing, verifying before claiming done) is entirely self-enforced by following the skill instructions — there's no runtime monitor watching for violations.

| Agent Behavior | Skill |
|---|---|
| Write test before code | `test-driven-development` (three-scenario) |
| Investigate before fixing | `systematic-debugging` |
| Run tests before claiming done | `verification-before-completion` |
| Follow workflow phases | All skills cross-reference each other |
| Dispatch implementation work | `subagent-driven-development` (uses the `Agent` tool from `@tintinweb/pi-subagents`) |
| Review before merge | `requesting-code-review` (dispatches a `code-reviewer` agent) |

## Subagent Dispatch

Subagent dispatch is provided by [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), which runs subagents **in-process** via the pi SDK — no subprocess, no stdout parsing, no hand-rolled inactivity watchdog. Install it (see Prerequisites) and the `Agent`, `get_subagent_result`, and `steer_subagent` tools become available.

### Agent Templates

This package ships 4 agent templates (copy-in only — see Install):

| Agent | Purpose | Tools |
|-------|---------|-------|
| `implementer` | Strict TDD implementation | read, write, edit, bash |
| `worker` | General-purpose task execution | read, write, edit, bash |
| `code-reviewer` | Production readiness review (read-only) | read, bash, find, grep, ls |
| `task-reviewer` | Task review: spec compliance + code quality (read-only) | read, bash, find, grep, ls |

Templates live in `agent-templates/*.md` and use YAML frontmatter (per the `pi-subagents` schema) to declare tools and a system prompt body. Copy them into `.pi/agents/` (project) or `~/.pi/agent/agents/` (global) so `pi-subagents` discovers them.

### Single Agent

```ts
Agent({
  subagent_type: "implementer",
  prompt: "Implement the retry logic per docs/superpowers/plans/retry-plan.md Task 3",
  description: "Implement retry logic",
})
```

### Parallel Tasks

Dispatch multiple `Agent` calls in the same response — pi runs sibling tool calls concurrently:

```ts
Agent({ subagent_type: "worker", prompt: "Fix failing test in auth.test.ts", description: "Fix auth tests" })
Agent({ subagent_type: "worker", prompt: "Fix failing test in cache.test.ts", description: "Fix cache tests" })
```

For long-running independent work where you want to keep working while agents run, add `run_in_background: true` to each call — you'll be notified on completion and can retrieve results with `get_subagent_result`.

### Resuming an Agent

Round 1-3 of a fix loop resume the original implementer's session:

```ts
Agent({ subagent_type: "implementer", resume: "<agent_id>", prompt: "<findings>" })
```

### Custom Agents

Add `.md` files to `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). `pi-subagents` discovers them automatically (see its [Custom Agents](https://github.com/tintinweb/pi-subagents#custom-agents) docs for the full frontmatter schema). The filename becomes the agent type name.

## Compared to Superpowers

Based on [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent, ported to pi as [pi-superpowers](https://github.com/coctostan/pi-superpowers), then extended with pi-specific tooling.

| | [Superpowers](https://github.com/obra/superpowers) | [pi-superpowers](https://github.com/coctostan/pi-superpowers) | **pi-superpowers-plus** |
|---|---|---|---|
| **Platform** | Claude Code | pi | pi |
| **Skills** | 13 workflow skills | Same 13 skills (pi port) | Same 13 skills (three-scenario TDD, restored inline guidance) |
| **TDD discipline** | Skill tells agent the rules | Skill tells agent the rules | Skill tells agent the rules (three-scenario model) |
| **Debug discipline** | Manual discipline | Manual discipline | Manual discipline |
| **Subagent dispatch** | — | — | `@tintinweb/pi-subagents` (`Agent` tool) + 4 agent templates |
| **TDD in subagents** | — | — | Three-scenario TDD instructions in agent templates + prompt templates |
| **Task tracking** | — | — | `@tintinweb/pi-tasks` (`TaskCreate`/`TaskUpdate`) with dependency graph + TUI widget |
| **Reference content** | Everything in SKILL.md | Everything in SKILL.md | Inline guidance + separate reference files loaded on demand |

## Architecture

```
pi-superpowers-plus/
├── agent-templates/                  # Copy-in agent definitions (4 templates, not auto-loaded)
│   ├── implementer.md                # Strict TDD implementation agent
│   ├── worker.md                     # General-purpose task agent
│   ├── code-reviewer.md              # Production readiness reviewer
│   └── task-reviewer.md              # Task reviewer (spec + code quality)
├── skills/                           # 13 workflow skills (26 markdown files)
│   ├── using-superpowers/
│   ├── brainstorming/
│   ├── writing-plans/
│   ├── executing-plans/
│   ├── subagent-driven-development/
│   ├── test-driven-development/
│   ├── systematic-debugging/
│   ├── verification-before-completion/
│   ├── requesting-code-review/
│   ├── receiving-code-review/
│   ├── dispatching-parallel-agents/
│   ├── using-git-worktrees/
│   └── finishing-a-development-branch/
└── README.md
```

## Development

```bash
npm install
npm test        # biome check .
```

No compiled code or unit tests remain in this package — it ships skills and agent templates only. `npm test` runs `biome check .` (the lint/quality gate). Add tests back alongside any future code.

## Attribution

Skill content adapted from [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT). This package builds on [pi-superpowers](https://github.com/coctostan/pi-superpowers). Subagent dispatch and task tracking are provided by [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) and [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) (installed separately).

## License

MIT - see [LICENSE](LICENSE) for details.
````

- [ ] **Step 2: Verify**

```bash
# No stale tool/extension references in README:
grep -n 'subagent(' README.md ; echo "matched: $?"     # Expected: matched: 1 (none — Agent(...) is the form now)
grep -n 'plan_tracker' README.md ; echo "matched: $?"  # Expected: matched: 1 (none)
grep -n 'extensions/' README.md ; echo "matched: $?"   # Expected: matched: 1 (none)
grep -n '^├── agents/' README.md ; echo "matched: $?"  # Expected: matched: 1 (none — tree uses agent-templates/)

# Quality gate clean:
npm test
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for @tintinweb/pi-subagents + @tintinweb/pi-tasks

Intro/What-You-Get now name the two companion packages. New Prerequisites
section with pi install commands + manual agent-templates copy step. Old
Plan Tracker extensions section deleted (no API re-documentation — Decision 6).
Subagent Dispatch uses Agent(...) call shapes + resume: example; custom-agent
instructions point at .pi/agents/ (pi-subagents discovery). Compared-to-
Superpowers table credits the external packages. Architecture tree drops
extensions/ and renames agents/ -> agent-templates/."
```

- [ ] **Step 4: Open PR 1** (end of Phase 1)

```bash
git push -u origin feat/tintinweb-migration
# Open PR titled "feat!: migrate to @tintinweb/pi-subagents + @tintinweb/pi-tasks (1/3: code layer + README)"
```

---

## Phase 2 — Rewrite dispatch-related skills (PR 2)

### Task 4: Rewrite the 3 SDD prompt templates to `Agent({...})`

**TDD scenario:** Trivial change — mechanical call-shape swap in 3 markdown files. Verify by grep + biome.

**Files:**
- Modify: `skills/subagent-driven-development/implementer-prompt.md`
- Modify: `skills/subagent-driven-development/task-reviewer-prompt.md`
- Modify: `skills/subagent-driven-development/re-review-prompt.md`

**Interfaces:**
- Consumes: the `Agent` tool schema from `@tintinweb/pi-subagents`: required `prompt`, `description` (3-5 word summary), `subagent_type`; optional `resume`, `run_in_background`, `max_turns`, etc.
- Produces: 3 prompt templates whose dispatch example uses `Agent({ subagent_type: "X", prompt: \`...\`, description: "..." })`. The SDD SKILL.md (Task 5) references these templates by path; the implementer/task-reviewer/code-reviewer type names match the `agent-templates/*.md` filenames.

**Conversion rule (applied to all 3):** the opening `subagent({ agent: "X", task: \`` becomes `Agent({ subagent_type: "X", prompt: \``; the closing ` \` })` becomes ` \`, description: "[3-5 word summary]" })`.

- [ ] **Step 1: Edit `skills/subagent-driven-development/implementer-prompt.md`**

Replace this exact text (the opening dispatch line):

```
  subagent({ agent: "implementer", task: `
```

with:

```
  Agent({ subagent_type: "implementer", prompt: `
```

Then replace this exact text (the closing line, last line of the code block):

```
    information that wasn't provided. Never silently produce work you're unsure about.
  ` })
```

with:

```
    information that wasn't provided. Never silently produce work you're unsure about.
  `, description: "Implement task N" })
```

- [ ] **Step 2: Edit `skills/subagent-driven-development/task-reviewer-prompt.md`**

Replace this exact text (the opening dispatch line):

```
  subagent({ agent: "task-reviewer", task: `
```

with:

```
  Agent({ subagent_type: "task-reviewer", prompt: `
```

Then replace this exact text (the closing line):

```
    **Reasoning:** [1-2 sentence technical assessment]
  ` })
```

with:

```
    **Reasoning:** [1-2 sentence technical assessment]
  `, description: "Review task N" })
```

- [ ] **Step 3: Edit `skills/subagent-driven-development/re-review-prompt.md`**

Replace this exact text (the opening dispatch line):

```
  subagent({ agent: "code-reviewer", task: `
```

with:

```
  Agent({ subagent_type: "code-reviewer", prompt: `
```

Then replace this exact text (the closing line):

```
    breakage | Findings remain open] — list the open ones.
  ` })
```

with:

```
    breakage | Findings remain open] — list the open ones.
  `, description: "Re-review task N fix" })
```

- [ ] **Step 4: Verify**

```bash
# No old subagent( dispatch form remains in the 3 templates:
grep -c 'subagent({ agent:' skills/subagent-driven-development/implementer-prompt.md skills/subagent-driven-development/task-reviewer-prompt.md skills/subagent-driven-development/re-review-prompt.md
# Expected: 0 0 0

# New Agent( form present, once each:
grep -c 'Agent({ subagent_type:' skills/subagent-driven-development/implementer-prompt.md skills/subagent-driven-development/task-reviewer-prompt.md skills/subagent-driven-development/re-review-prompt.md
# Expected: 1 1 1

# description: present, once each:
grep -c 'description: "' skills/subagent-driven-development/implementer-prompt.md skills/subagent-driven-development/task-reviewer-prompt.md skills/subagent-driven-development/re-review-prompt.md
# Expected: 1 1 1

npm test
```

- [ ] **Step 5: Commit**

```bash
git add skills/subagent-driven-development/implementer-prompt.md \
        skills/subagent-driven-development/task-reviewer-prompt.md \
        skills/subagent-driven-development/re-review-prompt.md
git commit -m "refactor(sdd): convert 3 prompt templates from subagent() to Agent()

subagent({agent, task}) -> Agent({subagent_type, prompt, description}).
description is a new required field in the pi-subagents Agent schema."
```

---

### Task 5: Rewrite SDD SKILL.md dispatch parts (fix-loop resume mechanic)

**TDD scenario:** Trivial change — prose edit in one markdown file. Verify by grep + biome.

**Files:**
- Modify: `skills/subagent-driven-development/SKILL.md` (two targeted edits: the "record agent identity" line, and the "Rounds 1-3 / 4-5" section). The 2 `plan_tracker` tracking call sites in this file are NOT touched here — they are Task 9 (Phase 3).

**Interfaces:**
- Consumes: the `Agent` tool's `resume: <agent_id>` parameter (real tool support from `pi-subagents`).
- Produces: a fix-loop spec that uses `Agent({ subagent_type: "implementer", resume: <agent_id>, prompt: ... })` for rounds 1-3 and a fresh `Agent({ subagent_type: "implementer", prompt: ... })` (no `resume:`) for rounds 4-5.

- [ ] **Step 1: Edit the "record agent identity" line**

In `skills/subagent-driven-development/SKILL.md`, replace this exact text:

```
- Record the implementer's agent identity from the dispatch result —
  fix-loop rounds 1-3 resume this agent.
```

with:

```
- Record the implementer's agent ID from the `Agent(...)` dispatch result —
  fix-loop rounds 1-3 resume this agent via `Agent({ subagent_type:
  "implementer", resume: <agent_id>, ... })`.
```

- [ ] **Step 2: Edit the "Rounds 1-3 / 4-5" section**

In `skills/subagent-driven-development/SKILL.md`, replace this exact text:

```
**Rounds 1-3 — resume the original implementer.** Send it the open findings
verbatim. Its context is intact: it knows the task, the code, and its own
choices. If your harness cannot send another message to a live subagent,
dispatch a fresh implementer carrying the brief path, the report-file path,
and the findings — the report file is the persistent memory either way.

**Rounds 4-5 — dispatch a fresh implementer**, with the brief path, the
report-file path, the open findings, and this framing: "A prior implementer
attempted this task [N] times; you own it now. Read the report file for what
was tried." A loop that survives three resumes usually means the
implementer cannot see its own problem — fresh eyes in one move.
```

with:

```
**Rounds 1-3 — resume the original implementer.** Dispatch it with
`Agent({ subagent_type: "implementer", resume: <agent_id>, prompt:
"<open findings verbatim>" })`, where `<agent_id>` is the identity you
recorded when you first dispatched this task's implementer. Its context is
intact: it knows the task, the code, and its own choices. The `resume:`
parameter is real tool support from `@tintinweb/pi-subagents` — the old
"resume this agent" instruction had no tool behind it; now it does.

**Rounds 4-5 — dispatch a fresh implementer** (drop `resume:`), with the
brief path, the report-file path, the open findings, and this framing: "A
prior implementer attempted this task [N] times; you own it now. Read the
report file for what was tried." A loop that survives three resumes usually
means the implementer cannot see its own problem — fresh eyes in one move.
```

- [ ] **Step 3: Verify**

```bash
# resume: parameter referenced:
grep -c 'resume: <agent_id>' skills/subagent-driven-development/SKILL.md   # Expected: 2 (the two edits above)

# Old "harness cannot send another message" caveat removed:
grep -c 'harness cannot send' skills/subagent-driven-development/SKILL.md   # Expected: 0

# The tracking call sites are NOT yet touched (still plan_tracker) — that's Task 9:
grep -c 'plan_tracker' skills/subagent-driven-development/SKILL.md          # Expected: 2 (untouched, deferred to Phase 3)

npm test
```

- [ ] **Step 4: Commit**

```bash
git add skills/subagent-driven-development/SKILL.md
git commit -m "refactor(sdd): fix-loop resume mechanic uses real resume: parameter

Rounds 1-3 now specify Agent({subagent_type:'implementer', resume:<agent_id>,
prompt:...}); rounds 4-5 drop resume: and dispatch fresh. Removes the old
'harness cannot send another message to a live subagent' caveat —
pi-subagents resume: is real tool support the bundled subagent tool lacked."
```

---

### Task 6: Rewrite `dispatching-parallel-agents/SKILL.md`

**TDD scenario:** Trivial change — 3 example call swaps + one added note. Verify by grep + biome.

**Files:**
- Modify: `skills/dispatching-parallel-agents/SKILL.md`

**Interfaces:**
- Consumes: `Agent` tool (foreground sibling parallelism via pi's existing parallel-tool-call execution; `run_in_background: true` for long-running independent work).
- Produces: parallel-dispatch examples in `Agent(...)` form.

- [ ] **Step 1: Edit the 3 parallel dispatch example lines**

In `skills/dispatching-parallel-agents/SKILL.md`, replace this exact block:

```text
subagent({ agent: "worker", task: "Fix agent-tool-abort.test.ts failures" })
subagent({ agent: "worker", task: "Fix batch-completion-behavior.test.ts failures" })
subagent({ agent: "worker", task: "Fix tool-approval-race-conditions.test.ts failures" })
# All three run concurrently.
```

with:

```text
Agent({ subagent_type: "worker", prompt: "Fix agent-tool-abort.test.ts failures", description: "Fix abort tests" })
Agent({ subagent_type: "worker", prompt: "Fix batch-completion-behavior.test.ts failures", description: "Fix batch tests" })
Agent({ subagent_type: "worker", prompt: "Fix tool-approval-race-conditions.test.ts failures", description: "Fix race tests" })
# All three run concurrently.
```

- [ ] **Step 2: Add a `run_in_background` note after the "Multiple dispatch calls" line**

In `skills/dispatching-parallel-agents/SKILL.md`, replace this exact text:

```
Multiple dispatch calls in one response = parallel execution. One per response = sequential.
```

with:

```
Multiple dispatch calls in one response = parallel execution. One per response = sequential.

For long-running independent work where you want to keep working while agents run, add `run_in_background: true` to each `Agent(...)` call. You'll be notified on completion and can retrieve results with `get_subagent_result({ agent_id: ..., wait: true })`.
```

- [ ] **Step 3: Verify**

```bash
grep -c 'subagent({ agent:' skills/dispatching-parallel-agents/SKILL.md   # Expected: 0
grep -c 'Agent({ subagent_type:' skills/dispatching-parallel-agents/SKILL.md   # Expected: 3
grep -c 'run_in_background: true' skills/dispatching-parallel-agents/SKILL.md   # Expected: 1
npm test
```

- [ ] **Step 4: Commit**

```bash
git add skills/dispatching-parallel-agents/SKILL.md
git commit -m "refactor: dispatching-parallel-agents uses Agent() calls

3 example dispatches converted to Agent({subagent_type, prompt, description});
added a run_in_background note for long-running independent work."
```

---

### Task 7: Rewrite `requesting-code-review/code-reviewer.md`

**TDD scenario:** Trivial change — single call-shape swap. Verify by grep + biome.

**Files:**
- Modify: `skills/requesting-code-review/code-reviewer.md`

**Interfaces:**
- Consumes: `Agent` tool.
- Produces: the code-reviewer dispatch template in `Agent(...)` form (used by SDD's final whole-branch review and by `requesting-code-review` directly).

- [ ] **Step 1: Edit the opening dispatch line**

In `skills/requesting-code-review/code-reviewer.md`, replace this exact text:

```
  subagent({ agent: "code-reviewer", task: `
```

with:

```
  Agent({ subagent_type: "code-reviewer", prompt: `
```

- [ ] **Step 2: Edit the closing line**

In `skills/requesting-code-review/code-reviewer.md`, replace this exact text (the last lines of the code block):

```
    - Avoid giving a clear verdict
  ` })
```

with:

```
    - Avoid giving a clear verdict
  `, description: "Review completed work" })
```

- [ ] **Step 3: Verify**

```bash
grep -c 'subagent({ agent:' skills/requesting-code-review/code-reviewer.md   # Expected: 0
grep -c 'Agent({ subagent_type:' skills/requesting-code-review/code-reviewer.md   # Expected: 1
grep -c 'description: "' skills/requesting-code-review/code-reviewer.md   # Expected: 1
npm test
```

- [ ] **Step 4: Commit**

```bash
git add skills/requesting-code-review/code-reviewer.md
git commit -m "refactor: requesting-code-review code-reviewer template uses Agent()"
```

---

### Task 8: Shrink `using-superpowers/references/pi-tools.md` to a prerequisites note

**TDD scenario:** Trivial change — replace a reference doc with a short prerequisites pointer. Verify by grep + biome.

**Files:**
- Modify: `skills/using-superpowers/references/pi-tools.md` (replace entire contents)

**Interfaces:**
- Consumes: the two companion packages' own documentation (per Decision 6 — no API re-documentation).
- Produces: a one-screen reference naming both packages and pointing at their docs. Skills already show concrete `Agent(...)` / `TaskCreate(...)` call syntax, so no translation layer.

- [ ] **Step 1: Replace `skills/using-superpowers/references/pi-tools.md` with this exact content**

```markdown
# Pi Tool Prerequisites

Skills speak in actions ("dispatch a subagent", "create a task", "read a file"). On Pi these resolve to tools provided by two companion packages — **installed separately**, not bundled with this package.

## Required packages

```bash
pi install npm:@tintinweb/pi-subagents
pi install npm:@tintinweb/pi-tasks
```

| Action skills request | Package | Tool |
| --- | --- | --- |
| Dispatch a subagent (`Agent({ subagent_type, prompt, description, ... })`) | [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) | `Agent`, `get_subagent_result`, `steer_subagent` |
| Task tracking (`TaskCreate`, `TaskUpdate`, `TaskList`, ...) | [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) | `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TaskOutput`, `TaskStop`, `TaskExecute` |

There is **no fallback** if these packages aren't installed — skills reference the tools directly. For each tool's full parameter schema, see the package's own README (linked above); skills show the concrete call shapes you'll use day to day.
```

- [ ] **Step 2: Verify**

```bash
grep -c 'plan_tracker\|subagent(' skills/using-superpowers/references/pi-tools.md   # Expected: 0
grep -c '@tintinweb/pi-subagents\|@tintinweb/pi-tasks' skills/using-superpowers/references/pi-tools.md   # Expected: 4 (table + install block)
npm test
```

- [ ] **Step 3: Commit**

```bash
git add skills/using-superpowers/references/pi-tools.md
git commit -m "refactor: shrink pi-tools.md to a prerequisites note

Per Decision 6 (no abstraction layer): names the two required packages and
points at their own docs instead of re-documenting their APIs. Skills already
show concrete Agent()/TaskCreate() call syntax."
```

- [ ] **Step 4: Open PR 2** (end of Phase 2)

```bash
git push origin feat/tintinweb-migration
# PR 2 on the same branch (or a follow-up branch off PR 1) titled
# "feat!: migrate to tintinweb tools (2/3: dispatch-related skills)"
```

---

## Phase 3 — Rewrite tracking-related skills + CHANGELOG (PR 3)

### Task 9: Rewrite SDD SKILL.md tracking call sites (`plan_tracker` → `TaskCreate`/`TaskUpdate`)

**TDD scenario:** Trivial change — two prose edits in one markdown file. Verify by grep + biome.

**Files:**
- Modify: `skills/subagent-driven-development/SKILL.md` (two targeted edits: the "create a todo per task" line and the "mark the todo complete" line).

**Interfaces:**
- Consumes: `TaskCreate({ subject, description })` and `TaskUpdate({ taskId, status })` from `@tintinweb/pi-tasks`. pi-tasks has no implicit "current task" pointer — the controller records the task ID returned by `TaskCreate` and passes it to `TaskUpdate`.
- Produces: SDD setup creates one task per plan task; task completion calls `TaskUpdate` with the recorded ID. Optional `addBlockedBy`/`addBlocks` for dependent tasks.

- [ ] **Step 1: Edit the "create a todo per task" line**

In `skills/subagent-driven-development/SKILL.md`, replace this exact text:

```
Read the plan once, note its context and Global Constraints, and create a
todo per task via the `plan_tracker` tool.
```

with:

```
Read the plan once, note its context and Global Constraints, and create a
task per plan task via `TaskCreate({ subject: "Task N: <name>", description:
"<one-line summary>" })` — one `TaskCreate` call per task. Note each returned
task ID; you'll pass it to `TaskUpdate` when the task is complete. If the
plan states tasks depend on each other, wire those with `addBlockedBy` on the
dependent task's `TaskUpdate` (or `addBlocks` on the prerequisite).
```

- [ ] **Step 2: Edit the "mark the todo complete" line**

In `skills/subagent-driven-development/SKILL.md`, replace this exact text:

```
Then mark the todo complete via the `plan_tracker` tool and move on. Never
```

with:

```
Then mark the task complete via `TaskUpdate({ taskId: <id>, status:
"completed" })` and move on. Never
```

- [ ] **Step 3: Verify**

```bash
grep -c 'plan_tracker' skills/subagent-driven-development/SKILL.md   # Expected: 0
grep -c 'TaskCreate(' skills/subagent-driven-development/SKILL.md   # Expected: 1
grep -c 'TaskUpdate(' skills/subagent-driven-development/SKILL.md   # Expected: 1
npm test
```

- [ ] **Step 4: Commit**

```bash
git add skills/subagent-driven-development/SKILL.md
git commit -m "refactor(sdd): plan_tracker tracking -> TaskCreate/TaskUpdate

Setup creates a task per plan task via TaskCreate; task completion calls
TaskUpdate with the recorded task ID. Optional addBlockedBy/addBlocks for
dependent tasks. pi-tasks has no implicit current-task pointer — the
controller records the ID from TaskCreate."
```

---

### Task 10: Rewrite `executing-plans/SKILL.md` (init + 2 update call sites)

**TDD scenario:** Trivial change — three prose edits in one markdown file. Verify by grep + biome.

**Files:**
- Modify: `skills/executing-plans/SKILL.md`

**Interfaces:**
- Consumes: `TaskCreate({ subject, description })`, `TaskUpdate({ taskId, status })`.
- Produces: executing-plans creates a task per plan task at setup, marks each `in_progress` before work, `completed` after.

- [ ] **Step 1: Edit the "Initialize the plan_tracker tool" line**

In `skills/executing-plans/SKILL.md`, replace this exact text:

```
4. If no concerns: Initialize the `plan_tracker` tool and proceed
```

with:

```
4. If no concerns: Create a task per plan task via `TaskCreate({ subject:
   "Task N: <name>", description: "<one-line summary>" })` and proceed
```

- [ ] **Step 2: Edit the per-task "Update task status" lines (Step 2 of the process)**

In `skills/executing-plans/SKILL.md`, replace this exact text:

```
1. Update task status via `plan_tracker` tool
```

with:

```
1. Update task status via `TaskUpdate({ taskId: <id>, status: "in_progress" })`
```

- [ ] **Step 3: Edit the post-task "Update task status" line**

In `skills/executing-plans/SKILL.md`, replace this exact text:

```
4. Update task status via `plan_tracker` tool
```

with:

```
4. Update task status via `TaskUpdate({ taskId: <id>, status: "completed" })`
```

- [ ] **Step 4: Verify**

```bash
grep -c 'plan_tracker' skills/executing-plans/SKILL.md   # Expected: 0
grep -c 'TaskCreate(' skills/executing-plans/SKILL.md   # Expected: 1
grep -c 'TaskUpdate(' skills/executing-plans/SKILL.md   # Expected: 2
npm test
```

- [ ] **Step 5: Commit**

```bash
git add skills/executing-plans/SKILL.md
git commit -m "refactor(executing-plans): plan_tracker -> TaskCreate/TaskUpdate"
```

---

### Task 11: Rewrite the 4 phase-completion call sites (TDD, brainstorming, writing-plans, verification)

**TDD scenario:** Trivial change — one prose edit per file, identical pattern. Verify by grep + biome.

**Files:**
- Modify: `skills/test-driven-development/SKILL.md`
- Modify: `skills/brainstorming/SKILL.md`
- Modify: `skills/writing-plans/SKILL.md`
- Modify: `skills/verification-before-completion/SKILL.md`

**Interfaces:**
- Consumes: `TaskUpdate({ taskId, status: "completed" })`. pi-tasks has no implicit "current task" pointer — the task ID comes from whatever task list the invoking context already created (e.g. the phase command's task, or a `TaskCreate` the controller made).
- Produces: each phase skill marks its own phase complete by updating the task the invoking context created.

**Conversion rule (applied to all 4):** `call \`plan_tracker\` with \`{action: "update", status: "complete"}\` for the current phase` → `call \`TaskUpdate({ taskId: <id>, status: "completed" })\` for the current phase's task (the task ID comes from whatever task list the invoking context already created — pi-tasks has no implicit "current task" pointer)`.

- [ ] **Step 1: Edit `skills/test-driven-development/SKILL.md`**

Replace this exact text:

```
When the TDD implementation cycle is complete (all tests green, code committed), mark the implement phase complete: call `plan_tracker` with `{action: "update", status: "complete"}` for the current phase.
```

with:

```
When the TDD implementation cycle is complete (all tests green, code committed), mark the implement phase complete: call `TaskUpdate({ taskId: <id>, status: "completed" })` for the current phase's task (the task ID comes from whatever task list the invoking context already created — pi-tasks has no implicit "current task" pointer).
```

- [ ] **Step 2: Edit `skills/brainstorming/SKILL.md`**

Replace this exact text:

```
- Mark the brainstorm phase complete: call `plan_tracker` with `{action: "update", status: "complete"}` for the current phase
```

with:

```
- Mark the brainstorm phase complete: call `TaskUpdate({ taskId: <id>, status: "completed" })` for the current phase's task (the task ID comes from whatever task list the invoking context already created — pi-tasks has no implicit "current task" pointer)
```

- [ ] **Step 3: Edit `skills/writing-plans/SKILL.md`**

Replace this exact text:

```
After saving the plan, mark the planning phase complete: call `plan_tracker` with `{action: "update", status: "complete"}` for the current phase.
```

with:

```
After saving the plan, mark the planning phase complete: call `TaskUpdate({ taskId: <id>, status: "completed" })` for the current phase's task (the task ID comes from whatever task list the invoking context already created — pi-tasks has no implicit "current task" pointer).
```

- [ ] **Step 4: Edit `skills/verification-before-completion/SKILL.md`**

Replace this exact text:

```
When all verification passes, mark the verify phase complete: call `plan_tracker` with `{action: "update", status: "complete"}` for the current phase.
```

with:

```
When all verification passes, mark the verify phase complete: call `TaskUpdate({ taskId: <id>, status: "completed" })` for the current phase's task (the task ID comes from whatever task list the invoking context already created — pi-tasks has no implicit "current task" pointer).
```

- [ ] **Step 5: Verify**

```bash
# No plan_tracker references remain in these 4 files:
grep -c 'plan_tracker' skills/test-driven-development/SKILL.md skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md skills/verification-before-completion/SKILL.md
# Expected: 0 0 0 0

# TaskUpdate present, once each:
grep -c 'TaskUpdate({ taskId: <id>, status: "completed" })' skills/test-driven-development/SKILL.md skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md skills/verification-before-completion/SKILL.md
# Expected: 1 1 1 1

npm test
```

- [ ] **Step 6: Commit**

```bash
git add skills/test-driven-development/SKILL.md skills/brainstorming/SKILL.md \
        skills/writing-plans/SKILL.md skills/verification-before-completion/SKILL.md
git commit -m "refactor: phase-completion plan_tracker calls -> TaskUpdate

4 phase skills (tdd, brainstorming, writing-plans, verification) now mark
their phase complete via TaskUpdate({taskId, status:'completed'}). Notes
that the task ID comes from the invoking context's task list — pi-tasks
has no implicit current-task pointer."
```

---

### Task 12: CHANGELOG entry + final verification pass

**TDD scenario:** Trivial change — CHANGELOG addition + repo-wide grep verification. Verify by grep + biome + manual smoke test.

**Files:**
- Modify: `CHANGELOG.md` (add a new `[Unreleased]` entry above the existing one)

**Interfaces:**
- Consumes: all prior tasks (the migration is complete).
- Produces: a CHANGELOG entry documenting the breaking removal/migration; a verified-clean repo.

- [ ] **Step 1: Add the new `[Unreleased]` entry to `CHANGELOG.md`**

Insert this block at the top of `CHANGELOG.md`, immediately after the header lines (`# Changelog` … `Versioning follows Semantic Versioning ...`), and above the existing `## [Unreleased]` section (rename the existing `## [Unreleased]` to `## [0.7.1] — 2026-07-29` is NOT required — instead, merge: place this new content as the FIRST `## [Unreleased]` block and keep the prior `## [Unreleased]` content beneath it under the same heading, since both are unreleased. Simplest: replace the single line `## [Unreleased]` with the new block below, then keep the existing Removed/Changed/Fixed/Added subsections that follow it, so both sets of unreleased changes share one `## [Unreleased]` heading).

Concretely, replace this exact text (the first `## [Unreleased]` heading in the file):

```
## [Unreleased]
```

with:

```
## [Unreleased]

### Removed

- **Removed the bundled `subagent` and `plan_tracker` extensions entirely** (`extensions/` directory, `agents/` bundled definitions, and `tests/`). These are replaced by two companion packages the user installs separately: [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (in-process subagent dispatch via `createAgentSession` — no subprocess, no stdout parsing, no hand-rolled inactivity watchdog) and [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) (dependency-graph task tracking with `TaskCreate`/`TaskUpdate`/`TaskList`). This eliminates the inactivity-timeout bug class by construction (no subprocess lifecycle left in this repo) and brings UX upgrades the bundled tools lacked: a persistent widget, FleetView, mid-run steering, session resume, background/scheduled dispatch, and bidirectional task dependencies. **Breaking change:** skills now reference `Agent(...)` / `TaskCreate(...)` / `TaskUpdate(...)` directly with no fallback path — both prerequisite packages must be installed. See the README Prerequisites section for install commands.
- **Removed `lsp` from agent template `tools:` frontmatter** — it was a silent no-op (not a real pi built-in tool in either the old system or `pi-subagents`). A real LSP extension is a fast-follow.

### Changed

- **Renamed `agents/` → `agent-templates/`.** The 4 specialized roles (`implementer`, `worker`, `task-reviewer`, `code-reviewer`) are now copy-in templates, not auto-loaded agents. `pi-subagents` discovers custom agents from `.pi/agents/`, `.agents/agents/`, or `$PI_CODING_AGENT_DIR/agents/` — not from an installed package's own directory. Copy the templates into one of those locations to use them (see README Install). Frontmatter reformatted to the `pi-subagents` schema: `name:` dropped (type derived from filename), invalid `lsp` tool dropped.
- **Skill files rewritten** to the new tools' real call shapes: `subagent({agent, task})` → `Agent({subagent_type, prompt, description})`; `plan_tracker({action, ...})` → `TaskCreate({...})` / `TaskUpdate({...})`. The `subagent-driven-development` fix loop now uses a real `resume: <agent_id>` parameter (rounds 1-3) instead of an unimplemented "resume this agent" instruction. No abstraction layer — skills show concrete call syntax (per the design spec's Decision 6).
- **Build/test infrastructure trimmed** to match the package's new shape (skills + templates, no compiled code): `tsconfig.json`, `vitest.config.ts`, `tests/`, and the `@earendil-works/*` / `typebox` / `typescript` / `vitest` devDependencies removed. The quality gate is now `biome check .` (the `test`, `lint`, and `check` npm scripts and CI/publish workflows all run it). `package.json` `pi.extensions` dropped; `pi.skills` retained.
- **README rewritten**: the bundled-extensions section is replaced by a Prerequisites section naming both companion packages; the Subagent Dispatch section uses `Agent(...)` call shapes and points custom-agent instructions at `.pi/agents/`; the architecture tree drops `extensions/` and renames `agents/` → `agent-templates/`.

### Added

- **`agent-templates/` directory** with the 4 reformatted agent definitions (copy-in only — never auto-loaded, never clobbered by a package update).

```

- [ ] **Step 2: Final repo-wide verification — no stale references**

```bash
# No old subagent() dispatch form anywhere in skills/:
grep -rn 'subagent({ agent:' skills/ ; echo "matched: $?"   # Expected: matched: 1 (none)

# No plan_tracker references anywhere in skills/:
grep -rn 'plan_tracker' skills/ ; echo "matched: $?"        # Expected: matched: 1 (none)

# No references to the removed extensions/ or old agents/ dir in skills/ or README:
grep -rn 'extensions/' skills/ README.md ; echo "matched: $?"   # Expected: matched: 1 (none)
grep -rn '`agents/`\|^├── agents/\|agents/\*\.md' skills/ README.md ; echo "matched: $?"   # Expected: matched: 1 (none)

# Checked-no-edit files really have no stale tool calls:
grep -n 'subagent(\|plan_tracker' skills/using-git-worktrees/SKILL.md skills/finishing-a-development-branch/SKILL.md ; echo "matched: $?"   # Expected: matched: 1 (none)

# No dead build files tracked:
git ls-files | grep -E '^extensions/|^tests/|^agents/|tsconfig|vitest' ; echo "matched: $?"   # Expected: matched: 1 (none)

# agent-templates clean:
grep -rn '^name:' agent-templates/ ; echo "matched: $?"   # Expected: matched: 1 (none)
grep -rn 'lsp' agent-templates/ ; echo "matched: $?"      # Expected: matched: 1 (none)

# Quality gate clean:
npm test
```

- [ ] **Step 3: Manual smoke test (end-to-end)**

This is the spec's manual verification. Do it on a clean checkout:

1. `pi install npm:@tintinweb/pi-subagents` and `pi install npm:@tintinweb/pi-tasks` (if not already installed).
2. Copy templates: `cp agent-templates/*.md ~/.pi/agent/agents/`.
3. Start a fresh pi session in a scratch repo, run `/skill:subagent-driven-development` on a small real plan (e.g. a 2-task plan).
4. Confirm: `Agent(...)` dispatch works (an implementer subagent runs), the fix loop's `resume:` works on a forced review finding (round 1 resumes the same agent), and `TaskCreate`/`TaskUpdate` tracking shows in the `pi-tasks` widget.
5. Confirm the README prerequisites/install instructions work literally from a clean environment (no missing steps).

If any step fails, fix the relevant skill/template before merging — do not merge a broken migration.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): record migration to @tintinweb/pi-subagents + @tintinweb/pi-tasks"
```

- [ ] **Step 5: Open PR 3 / merge** (end of Phase 3)

```bash
git push origin feat/tintinweb-migration
# PR 3 titled "feat!: migrate to tintinweb tools (3/3: tracking skills + CHANGELOG)"
# After all 3 PRs land on main, tag the next release.
```

---

## Self-Review

**1. Spec coverage** — checked each spec section against the tasks:

- *Removed entirely* (`extensions/`, `tests/extension/`, `tests/helpers/mock-logger.ts`, `package.json` pi.extensions + dead deps + check/test scripts, `biome.json`/`tsconfig.json` path refs): Task 1 (extensions/, tests/, tsconfig, vitest config, package.json deps/scripts, biome.json tests override, CI/publish). ✔
- *Left as-is* (historical `docs/plans/*.md`): Global Constraints state these are untouched; no task edits them. ✔
- *Added* (`agent-templates/` renamed + reformatted, README Prerequisites + copy step, CHANGELOG entry): Task 2 (agent-templates), Task 3 (README Prerequisites/Install), Task 12 (CHANGELOG). ✔
- *Dispatch-related skill rewrites* (SDD SKILL.md narrative + resume, 3 prompt templates, dispatching-parallel-agents, requesting-code-review/code-reviewer.md, worker.md + implementer.md moves): Task 5 (SDD resume), Task 4 (3 prompt templates), Task 6 (parallel), Task 7 (code-reviewer.md), Task 2 (worker.md/implementer.md frontmatter). ✔
- *Tracking-related skill rewrites* (SDD SKILL.md 2 call sites, TDD/executing-plans/brainstorming/writing-plans/verification 5 call sites, executing-plans TaskCreate-per-step): Task 9 (SDD), Task 10 (executing-plans), Task 11 (4 phase-completion). ✔
- *Reference/prerequisite docs* (pi-tools.md shrinks): Task 8. ✔
- *Checked, no edit expected* (using-git-worktrees, finishing-a-development-branch, writing-plans cross-refs): verified in Task 12 Step 2 grep. ✔
- *README rewrite* (12 bullets): Task 3 covers all 12. ✔
- *Out of scope* (LSP tool, TaskExecute/auto-cascade, historical docs): none implemented. ✔
- *Verification* (biome clean per PR, manual smoke test): every task runs `npm test`; Task 12 Step 3 is the manual smoke test. ✔

**2. Placeholder scan** — searched the plan for `TBD`, `TODO`, "implement later", "fill in details", "add appropriate error handling", "handle edge cases", "similar to Task N", and bare "write tests for the above". None present. Every code/edit step contains the exact content or the exact old→new replacement text.

**3. Type consistency** — tool names and parameter shapes are consistent across all tasks:
- `Agent({ subagent_type, prompt, description })` — used in Tasks 3, 4, 6, 7, and the resume variant `Agent({ subagent_type: "implementer", resume: <agent_id>, prompt: ... })` in Tasks 3, 5. `subagent_type` (not `agent`), `prompt` (not `task`), `description` (new required field) — consistent.
- `TaskCreate({ subject, description })` — Tasks 9, 10. `subject`/`description` match the pi-tasks schema.
- `TaskUpdate({ taskId, status })` — Tasks 9, 10, 11. `taskId` (not `index`), `status: "completed"` (not `"complete"`) — matches pi-tasks (`pending`/`in_progress`/`completed`/`deleted`). Consistent across all 4 phase-completion edits and SDD/executing-plans.
- `addBlockedBy`/`addBlocks` — Task 9 (SDD) only; matches pi-tasks `TaskUpdate` params.
- Agent type names (`implementer`, `worker`, `task-reviewer`, `code-reviewer`) match the `agent-templates/*.md` filenames (Task 2) and the prompt templates' `subagent_type` values (Tasks 4, 7). Consistent.
- `plan_tracker` is fully removed (0 occurrences in `skills/` after Task 12 — verified by the Step 2 grep). `subagent({ agent:` is fully removed (0 occurrences). Consistent.
