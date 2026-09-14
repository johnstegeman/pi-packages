# Command-Driven Phase Advancement Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make the superpowers workflow command-driven: hide the 7 phase skills from the system prompt (context-clean), add `/brainstorm`-style commands that load skills on demand via an `input` transform, and refactor phase advancement + skip-confirmation into the transform as the single entry point (Decision C). Supporting skills stay model-invocable.

**Architecture:** (1) Add `disable-model-invocation: true` to 7 phase-skill frontmatters. (2) Add an `input` event handler that recognizes the 6 commands + direct `/skill:` invocations, advances the tracker, runs skip-confirmation when phases are unresolved, and transforms `/brainstorm`→`/skill:brainstorming` (preserving args) before skill expansion. (3) Remove `onInputText`/`onSkillFileRead` from the tracker; rewire the existing skip-confirmation `input` handler into the new transform. (4) Light skill-text + docs updates.

**Tech Stack:** TypeScript, vitest, biome, pi ExtensionAPI (`pi.on("input", …)` transform, skill frontmatter).

**Branch:** `feat/command-driven-phase-advancement` (created off `main` at v0.6.0).

**Design spec:** `docs/superpowers/specs/2026-07-29-command-driven-phase-advancement-design.md`.

**Key references:**
- `input` event transform contract: extensions.md ~line 888 (`{ action: "transform"|"handled"|"continue", text }`).
- Existing skip-confirmation `input` handler: `extensions/workflow-monitor.ts:218-327` (the ~110-line flow to rewire).
- `phaseToSkill` map: `extensions/workflow-monitor.ts` (phase→skill name; reuse).
- `parseSkillName`/`SKILL_TO_PHASE`: `extensions/workflow-monitor/workflow-tracker.ts:57,63` (keep as utilities).
- Command test pattern: `tests/extension/workflow-monitor/superpowers-command.test.ts` (fake pi capturing input transforms).

---

## Phase 1 — Hide the phase skills

### Task 1: Add `disable-model-invocation: true` to the 7 phase-skill frontmatters

**TDD scenario:** Trivial change — frontmatter config, no logic to test (verify by grep + test/lint non-regression).

**Files:** Modify 7 `SKILL.md` files:
- `skills/brainstorming/SKILL.md`
- `skills/writing-plans/SKILL.md`
- `skills/executing-plans/SKILL.md`
- `skills/subagent-driven-development/SKILL.md`
- `skills/verification-before-completion/SKILL.md`
- `skills/requesting-code-review/SKILL.md`
- `skills/finishing-a-development-branch/SKILL.md`

**Step 1:** In each of the 7 files, add `disable-model-invocation: true` to the YAML frontmatter (after the `description` line). Example for brainstorming:
```yaml
---
name: brainstorming
description: "You MUST use this before any creative work..."
disable-model-invocation: true
---
```
Do NOT add it to the 6 supporting skills (`using-superpowers`, `test-driven-development`, `systematic-debugging`, `using-git-worktrees`, `dispatching-parallel-agents`, `receiving-code-review`).

**Step 2: Verify**
- `grep -L "disable-model-invocation: true" skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md skills/executing-plans/SKILL.md skills/subagent-driven-development/SKILL.md skills/verification-before-completion/SKILL.md skills/requesting-code-review/SKILL.md skills/finishing-a-development-branch/SKILL.md` → no output (all 7 have it).
- `grep -l "disable-model-invocation: true" skills/using-superpowers/SKILL.md skills/test-driven-development/SKILL.md skills/systematic-debugging/SKILL.md skills/using-git-worktrees/SKILL.md skills/dispatching-parallel-agents/SKILL.md skills/receiving-code-review/SKILL.md` → no output (none of the 6 supporting have it).
- `npm test` + `npm run lint` → pass (frontmatter is config; no behavioral test impact).

**Step 3: Commit**
```bash
git add skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md skills/executing-plans/SKILL.md skills/subagent-driven-development/SKILL.md skills/verification-before-completion/SKILL.md skills/requesting-code-review/SKILL.md skills/finishing-a-development-branch/SKILL.md
git commit -m "feat(skills): hide phase skills from system prompt (disable-model-invocation)

Set disable-model-invocation: true on the 7 phase skills (brainstorming,
writing-plans, executing-plans, subagent-driven-development,
verification-before-completion, requesting-code-review,
finishing-a-development-branch) so they leave the system prompt and are
only loadable via /skill: invocation or the new /brainstorm-style
commands. Supporting skills (TDD, debugging, worktrees, etc.) stay
model-invocable. Context-clean: ~7 skill descriptions removed from every
system prompt."
```

---

## Phase 2 — The `input` transform (command-driven entry + skip-confirmation rewire)

### Task 2: Add the `input` transform handler with phase-command recognition + advance + transform (TDD)

**TDD scenario:** New feature — full TDD. Write failing tests for the transform's recognition + advance + transform behavior (skip-confirmation comes in Task 3).

**Files:**
- Modify: `extensions/workflow-monitor.ts`
- Create test: `tests/extension/workflow-monitor/command-driven-input.test.ts`

**Step 1: Write the failing test** (`tests/extension/workflow-monitor/command-driven-input.test.ts`)

Boot the workflow-monitor extension with a fake pi that captures `input` event handlers (the extension registers a handler via `pi.on("input", …)`). The fake pi: `{ on(event, handler){ if(event==="input") inputHandlers.push(handler) }, registerTool(){}, registerCommand(){}, appendEntry(){} }`. Then invoke the captured handler with synthetic events + a fake ctx, and assert the return value + side effects.

Cover (for the no-unresolved-phases case — skip-confirmation is Task 3):
- `/brainstorm` → returns `{ action: "transform", text: "/skill:brainstorming" }`; tracker advanced to brainstorm (assert via the persisted `superpowers_state` entry's `workflow.currentPhase` === "brainstorm"); `appendEntry` called.
- `/plan` → `{ action: "transform", text: "/skill:writing-plans" }`; currentPhase "plan".
- `/verify` → `{ action: "transform", text: "/skill:verification-before-completion" }`; currentPhase "verify".
- `/review` → `{ action: "transform", text: "/skill:requesting-code-review" }`; currentPhase "review".
- `/finish` → `{ action: "transform", text: "/skill:finishing-a-development-branch" }`; currentPhase "finish".
- `/execute` → returns `{ action: "handled" }` (NOT a transform — presents the choice); `ctx.ui.setEditorText` called with a string containing both `/skill:subagent-driven-development` and `/skill:executing-plans`; `ctx.ui.notify` called with info; currentPhase "execute".
- **Args preserved:** `/brainstorm build a chat app` → `{ action: "transform", text: "/skill:brainstorming build a chat app" }`.
- **Direct `/skill:` also works (Decision C):** `/skill:writing-plans` → tracker advances to plan; the handler recognizes it via `parseSkillName` + `SKILL_TO_PHASE` and returns `{ action: "continue" }` (let it pass through to skill expansion — DON'T transform, since it's already a `/skill:` command). Assert currentPhase "plan" + return action "continue".
- **Non-command input passes through:** `hello world` → `{ action: "continue" }`; tracker unchanged.
- **Extension-source skipped:** event with `source: "extension"` → returns `{ action: "continue" }` (or undefined) without advancing.

The handler reads `event.text`. The fake ctx: `{ hasUI: true, ui: { notify: vi.fn(), setEditorText: vi.fn(), setWidget: () => {} }, sessionManager: { getBranch: () => [] } }`. To assert tracker state, capture `appendEntry` calls and inspect the `superpowers_state` entry's `data.workflow.currentPhase`.

**Step 2: Run test to verify it FAILS (RED)** — the transform handler doesn't exist yet; `inputHandlers` is empty or the handler returns `{ action: "continue" }` for everything. Report RED.

**Step 3: Implement** in `extensions/workflow-monitor.ts`:
- Add a `PHASE_COMMAND_TO_PHASE` map: `{ "/brainstorm": "brainstorm", "/plan": "plan", "/execute": "execute", "/verify": "verify", "/review": "review", "/finish": "finish" }`.
- Add a NEW `pi.on("input", …)` handler (separate from the existing skip-confirmation handler at line 218 — Task 3 merges them). For now, this handler:
  1. `if (event.source === "extension") return { action: "continue" };`
  2. `const text = (event.text as string) ?? ""; const trimmed = text.trim(); const firstToken = trimmed.split(/\s+/, 1)[0];`
  3. Determine the target phase: `const cmdPhase = PHASE_COMMAND_TO_PHASE[firstToken]; const skillPhase = parseSkillName(trimmed.split(/\r?\n/)[0]) ? SKILL_TO_PHASE[parseSkillName(trimmed.split(/\r?\n/)[0])!] : null; const phase = cmdPhase ?? skillPhase;`
  4. If no phase → `return { action: "continue" };`
  5. Advance: `handler.advanceWorkflowTo(phase); persistState(); updateWidget(ctx);`
  6. If `phase === "execute"`: present the choice (setEditorText + notify) + `return { action: "handled" };`
  7. If `cmdPhase` (a `/brainstorm`-style command): `const skill = phaseToSkill[phase]; const args = trimmed.slice(firstToken.length).trim(); return { action: "transform", text: args ? \`/skill:${skill} ${args}\` : \`/skill:${skill}\` };`
  8. If `skillPhase` (a direct `/skill:writing-plans`): `return { action: "continue" };` (already a `/skill:` command — let skill expansion handle it; we just advanced the tracker).

**Step 4: Run test to verify it PASSES (GREEN).** Report GREEN.

**Step 5: Run full suite + lint.** Note: the existing skip-confirmation `input` handler (line 218) still runs too — both handlers fire (transforms chain). This may cause double-advance or conflicts. **If tests reveal conflicts**, Task 3 (the merge) handles it; for now, confirm the new handler's tests pass and the existing suite doesn't regress. If there's a regression, surface it in the report (don't fix here — Task 3 merges the two handlers).

**Step 6: Commit**
```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/command-driven-input.test.ts
git commit -m "feat(superpowers): input transform for /brainstorm-style phase commands

Add an input event handler that recognizes /brainstorm, /plan, /execute,
/verify, /review, /finish (and direct /skill: invocations), advances the
tracker, and transforms the command to /skill:<name> before skill expansion
(args preserved). /execute presents the SDD-vs-executing-plans choice.
This is the command-driven entry point; skip-confirmation rewire + removal
of the old onInputText handler follows in the next task."
```

---

### Task 3: Rewire skip-confirmation into the transform; remove `onInputText`/`onSkillFileRead` (Decision C)

**TDD scenario:** Refactoring tested code — update the skip-confirmation tests to the new entry path; remove the dead `onInputText`/`onSkillFileRead` tests.

**Files:**
- Modify: `extensions/workflow-monitor.ts` (merge the two `input` handlers; the transform handler now owns skip-confirmation)
- Modify: `extensions/workflow-monitor/workflow-handler.ts` (remove `handleInputText`/`handleSkillFileRead` from interface + impl)
- Modify: `extensions/workflow-monitor/workflow-tracker.ts` (remove `onInputText`/`onSkillFileRead` methods)
- Modify: `extensions/workflow-monitor.ts` (remove the `handleSkillFileRead` call site in the `tool_result` handler at line 544)
- Modify tests: `tests/extension/workflow-monitor/workflow-tracker.test.ts` (remove the 9 `onInputText`/`onSkillFileRead` behavior tests, ~lines 155-225; keep the `parseSkillName` unit test), `tests/extension/workflow-monitor/skip-confirmation.test.ts` + `tests/extension/workflow-monitor/workflow-skip-confirmation.test.ts` (update to exercise the new transform entry path), `tests/extension/workflow-monitor/workflow-handler-tracker.test.ts` (remove `handleInputText`/`handleSkillFileRead` tests if any)

**Step 1: Read** the existing skip-confirmation handler (`extensions/workflow-monitor.ts:218-327`) + its 2 test files in full. Understand: `parseTargetPhase(text)` → `getUnresolvedPhasesBefore(targetPhase, currentState)` → single/multiple unresolved → `selectValue` "Do now/Skip/Cancel" → on skip: `skipWorkflowPhases` + advance; on do_now: `setEditorText(/skill:<missing>)` + block; on cancel: block.

**Step 2: Write/update the failing tests.** The skip-confirmation tests currently drive the flow via the old `input` handler recognizing `/skill:writing-plans`. Update them to drive it via the new transform handler (which now owns the flow). Cases:
- `/plan` with `brainstorm` unresolved → `selectValue` called with "Do brainstorm now / Skip brainstorm / Cancel"; on "Skip" → tracker advances to plan, brainstorm marked skipped; on "Do now" → `setEditorText("/skill:brainstorming")` + return `{ action: "handled" }`; on "Cancel" → `{ action: "handled" }`, tracker unchanged.
- `/skill:writing-plans` (direct) with brainstorm unresolved → same skip-confirmation.
- Multiple unresolved phases → the "review one-by-one / skip all / cancel" flow.
- No unresolved phases → advance + transform (no skip-confirmation).
- The `onInputText`/`onSkillFileRead` tests in `workflow-tracker.test.ts` are REMOVED (the methods no longer exist). The `parseSkillName` unit test stays.

**Step 3: Run tests to verify RED** — the new skip-confirmation path doesn't exist yet; the old `input` handler still does it but `handleInputText` is about to be removed.

**Step 4: Implement the merge + removal:**
- In `extensions/workflow-monitor.ts`, **merge** the Task 2 transform handler and the line-218 skip-confirmation handler into ONE `input` handler that:
  1. Skip extension source.
  2. Detect the target phase (command OR direct `/skill:`).
  3. If no phase → `{ action: "continue" }`.
  4. If phase detected + unresolved phases before it → run the skip-confirmation `selectValue` flow (moved from the old handler). On skip/skip-all → `skipWorkflowPhases` + advance + persist; on do_now → `setEditorText(/skill:<missing>)` + `{ action: "handled" }`; on cancel → `{ action: "handled" }`.
  5. If no unresolved phases → advance + persist + return the transform (for commands) or `{ action: "continue" }` (for direct `/skill:`) or `{ action: "handled" }` (for `/execute` choice).
  6. Remove the old line-218 handler entirely.
- Remove the `handleSkillFileRead` call in the `tool_result` handler (~line 544).
- Remove `handleInputText` + `handleSkillFileRead` from `workflow-handler.ts` (interface + impl).
- Remove `onInputText` + `onSkillFileRead` from `workflow-tracker.ts`.
- Keep `parseSkillName` + `SKILL_TO_PHASE` (used by the transform).
- Keep `onFileWritten` (artifact detection).

**Step 5: Run tests to verify GREEN.** Update tests as needed (the skip-confirmation tests now use the new path; the `onInputText`/`onSkillFileRead` tests are gone).

**Step 6: Run full suite + lint.** All pass.

**Step 7: Commit**
```bash
git add extensions/workflow-monitor.ts extensions/workflow-monitor/workflow-handler.ts extensions/workflow-monitor/workflow-tracker.ts tests/extension/workflow-monitor/workflow-tracker.test.ts tests/extension/workflow-monitor/skip-confirmation.test.ts tests/extension/workflow-monitor/workflow-skip-confirmation.test.ts tests/extension/workflow-monitor/workflow-handler-tracker.test.ts
git commit -m "refactor(superpowers): rewire skip-confirmation into input transform; remove onInputText/onSkillFileRead

Decision C: the input transform is now the single entry point for phase
advancement. It recognizes both /brainstorm-style commands and direct
/skill: invocations, advances the tracker, and runs skip-confirmation
when phases are unresolved (the selectValue flow moves from the old
input handler into the transform). Removes WorkflowTracker.onInputText
+ onSkillFileRead (dead under command-driven: hidden skills aren't
heuristic-detected, and skill expansion doesn't trigger onSkillFileRead).
Keeps parseSkillName/SKILL_TO_PHASE (transform uses them) + onFileWritten
(artifact detection)."
```

---

## Phase 3 — Skill-text + docs updates

### Task 4: Update skill text + docs to reflect command-driven entry

**TDD scenario:** Trivial change — doc/skill-text edits, no logic.

**Files:**
- Modify: `skills/using-superpowers/SKILL.md` (light edit: phase skills are command-driven now)
- Modify: `skills/writing-plans/SKILL.md` (execution handoff mentions `/execute`)
- Modify: `README.md` (document the 6 phase commands)
- Modify: `ROADMAP.md` (mark command-driven phase advancement shipped; note fallback dropped)
- Modify: `CHANGELOG.md` (`[0.7.0]` entry)
- Modify: `package.json` (version `0.6.0` → `0.7.0`)

**Step 1: Skill text updates (light):**
- `using-superpowers/SKILL.md`: the Skill Priority section says "Let's build X → superpowers:brainstorming first". Update to reflect command-driven: "Let's build X → `/brainstorm` first (loads the brainstorming skill)". Keep the Red Flags table + supporting-skill guidance (those still auto-invoke).
- `writing-plans/SKILL.md`: the execution handoff offers `/skill:subagent-driven-development` and `/skill:executing-plans`. Add a note that `/execute` is the command-driven way to enter execution (presents both). The `/skill:` paths still work.

**Step 2: README** — add the 6 phase commands to the Commands section (near the `/superpowers` commands added in v0.6.0). Note: phase skills are hidden from the system prompt (loaded on-demand via the commands); supporting skills stay auto-invocable.

**Step 3: ROADMAP** — mark "Command-driven phase advancement" as ✅ shipped (v0.7.0). Note: the skill-detection fallback was dropped (command-only, per the reframed design). `/superpowers query` + `/workflow-next`/`/workflow-reset` removal remain future.

**Step 4: CHANGELOG** — add `[0.7.0]` entry:
```
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
```

**Step 5: `package.json`** — `"version": "0.7.0"`.

**Step 6: Verify** — `npm test` + `npm run lint` pass; `grep -c "disable-model-invocation: true" skills/*/SKILL.md | grep -c "true"` → 7; version 0.7.0.

**Step 7: Commit**
```bash
git add skills/using-superpowers/SKILL.md skills/writing-plans/SKILL.md README.md ROADMAP.md CHANGELOG.md package.json
git commit -m "docs: command-driven phase advancement; bump to 0.7.0

Update using-superpowers + writing-plans skill text for command-driven
entry. README documents the 6 phase commands. ROADMAP marks command-
driven phase advancement shipped (fallback dropped). CHANGELOG [0.7.0].
Version 0.6.0 → 0.7.0."
```

---

## Verification (after all tasks)

- `npm test` — all green (existing tests updated; new command-driven-input tests pass; onInputText/onSkillFileRead tests removed).
- `npm run lint` — clean.
- `grep -L "disable-model-invocation: true" <7 phase skills>` → no output (all hidden).
- `grep -l "disable-model-invocation: true" <6 supporting skills>` → no output (none hidden).
- The 6 phase commands transform correctly (args preserved); `/execute` presents the choice.
- Direct `/skill:writing-plans` still advances the tracker (Decision C).
- Skip-confirmation fires on unresolved phases (for both `/plan` and `/skill:writing-plans`).
- `onInputText`/`onSkillFileRead` removed; `parseSkillName`/`SKILL_TO_PHASE`/`onFileWritten` kept.
- Version 0.7.0.
