# Command-Driven Phase Advancement — Design Spec

**Date:** 2026-07-29
**Branch:** to create off `main` (PR #3 merged; `feat/skills-upstream-sync` is stale)
**Source:** ROADMAP.md "Future" → "Command-driven phase advancement" (reframed per user direction)

## Goal

Make the superpowers workflow fully command-driven: the 7 phase skills leave
the system prompt (context-clean), and the user enters each phase via short
commands (`/brainstorm`, `/plan`, `/execute`, `/verify`, `/review`, `/finish`)
that transparently load the skill on demand. Drop the heuristic skill-detection
fallback — the tracker advances only via commands. Supporting skills (TDD,
debugging, etc.) stay model-invocable.

## Reframing vs. the roadmap

The roadmap says "Skill detection stays as a fallback so tracking isn't lost if
someone bypasses the command." **Per user direction, drop that fallback** —
command-only, no skill detection. This is clean because the mechanism that
enables it (`disable-model-invocation`) also makes heuristic detection
impossible: hidden skills aren't in the system prompt, so the agent can't
auto-match them. The tracker advances *only* via the commands.

## Decision: B2 — hide the 7 phase skills, keep 6 supporting skills model-invocable

**`disable-model-invocation: true`** on the 7 phase skills (they leave the
system prompt; still `/skill:`-invocable). The 6 supporting skills keep default
model-invocation (agent auto-loads them when relevant).

The "list of skills" in the context window is just name + description (progressive
disclosure: descriptions always in context, full SKILL.md on-demand). Hiding the
7 phase skills removes ~7 description lines from every message's system prompt.
The 6 supporting skills (TDD when implementing, debugging when stuck, worktrees
before execution, parallel dispatch, receiving review) stay auto-discoverable —
genuinely useful for the agent to self-invoke, and cheap (6 short descriptions).

### The 7 phase skills to hide

| Phase | Skill | Command |
|-------|-------|---------|
| brainstorm | `brainstorming` | `/brainstorm` |
| plan | `writing-plans` | `/plan` |
| execute | `executing-plans` | `/execute` (choice) |
| execute | `subagent-driven-development` | `/execute` (choice) |
| verify | `verification-before-completion` | `/verify` |
| review | `requesting-code-review` | `/review` |
| finish | `finishing-a-development-branch` | `/finish` |

(`executing-plans` and `subagent-driven-development` both map to the `execute`
phase. `/execute` offers the choice — see Decision A below.)

### The 6 supporting skills to keep model-invocable

`using-superpowers`, `test-driven-development`, `systematic-debugging`,
`using-git-worktrees`, `dispatching-parallel-agents`, `receiving-code-review`.

## Decision: A — `/execute` offers the SDD-vs-executing-plans choice

`/execute` advances the tracker to `execute` and presents the same two-option
choice the `writing-plans` handoff offers:
- `/skill:subagent-driven-development` (recommended, same session)
- `/skill:executing-plans` (parallel session, batched)

The user submits their choice. (Mirrors the existing writing-plans handoff UX.)

## Decision: C — top-level commands that delegate to shared advance+invoke logic

6 top-level slash commands (`/brainstorm`, `/plan`, `/execute`, `/verify`,
`/review`, `/finish`) as the primary, friendly entry points. They delegate to
shared advance+invoke logic. `/superpowers stage <phase>` stays as the
advance-only power-user path (no skill invocation; already shipped in v0.6.0,
behavior unchanged).

## Decision: B — `input` event transform (in-session, auto-invoke, one step)

The 6 commands are implemented via the `input` event, not `registerCommand`,
because the `input` event fires *before* skill expansion and can transform
`/brainstorm` → `/skill:brainstorming` so the skill loads directly with no
editor-submit step. The transform handler:
1. Recognizes the 6 commands (`/brainstorm`, `/plan`, `/execute`, `/verify`,
   `/review`, `/finish`) — match `event.text` trimmed, first token only
   (ignore trailing args for now).
2. Advances the tracker: `handler.advanceWorkflowTo(phase)` + `persistState()`.
3. Returns `{ action: "transform", text: <expanded> }`:
   - For 5 of 6: `text: "/skill:<skill-name>"` (e.g. `/brainstorm` →
     `/skill:brainstorming`).
   - For `/execute`: `text` = a prompt string asking the user to pick SDD vs
     executing-plans (NOT a `/skill:` transform — the user submits their
     choice, which is then a `/skill:` command processed normally). Advance the
     tracker to `execute` regardless; the skill loads on the user's choice
     submission.
4. Skip extension-source messages (`event.source === "extension"`) to avoid
   loops.
5. If the text doesn't match a phase command, return `{ action: "continue" }`
   (pass through unchanged — don't interfere with other input).

**Why `input` event, not `registerCommand`:** a registered command runs at step
1 (before `input`), can `setEditorText` but can't itself trigger skill expansion
— the user would have to submit (two-step). The `input` transform at step 2
rewrites the text *before* step 3 (skill expansion), so `/brainstorm` becomes
`/skill:brainstorming` and loads in one step. This is the documented
input-transform pattern (extensions.md `input` event examples).

**In-session (not new-session):** the transform keeps the user in the current
session (context continuity across phases). `/workflow-next` (deprecated)
spawns a new session; the new commands do not.

## Decision: C — refactor; the input transform is the single entry point

**One place** decides "should the tracker advance, and should skip-confirmation
fire?": the `input` transform handler. It recognizes BOTH the new friendly
commands (`/plan`, `/brainstorm`, etc.) AND direct `/skill:writing-plans`
invocations (via `parseSkillName` + `SKILL_TO_PHASE`), routes both through the
same advance + skip-confirmation logic, and the tracker's `onInputText`/
`onSkillFileRead` methods disappear (no more skill detection scattered across
the tracker). Single source of truth for phase entry.

### What's removed
- `WorkflowTracker.onInputText()` (and its call site `handleInputText` in
  `workflow-handler.ts`).
- `WorkflowTracker.onSkillFileRead()` (and its call site `handleSkillFileRead`).
  Rationale: `onSkillFileRead` fires on `tool_result` for `read` of a
  `SKILL.md` — i.e. the agent manually reading a skill file. With phase skills
  hidden, the agent won't spontaneously read them (can't see them); and skill
  *expansion* (`/skill:name` → content injected) does NOT go through the `read`
  tool, so it doesn't trigger `onSkillFileRead` anyway. So it's dead for phase
  skills. Supporting-skill reads shouldn't advance the workflow phase anyway.
- The `parseSkillName` test cases for `onInputText`/`onSkillFileRead` behavior
  (the `parseSkillName` unit test itself stays — the transform uses it).

### What's kept
- `parseSkillName` + `SKILL_TO_PHASE` exports — the input transform uses them
  to recognize direct `/skill:` invocations and map to phases.
- `onFileWritten` (artifact detection: `docs/superpowers/specs/` → brainstorm,
  `docs/superpowers/plans/` → plan). NOT skill detection — it's how the tracker
  learns a phase produced its artifact. Stays.
- `phaseToSkill` (phase→skill name) — reused by the transform.

### Rewiring the skip-confirmation flow

The existing `input` handler (workflow-monitor.ts ~line 218) is the
skip-confirmation flow: when the user invokes a skill that jumps ahead (e.g.
`/skill:writing-plans` while `brainstorm` is unresolved), it offers "Do
brainstorm now / Skip / Cancel" via `selectValue`. Today it uses
`parseTargetPhase(text)` (which uses `parseSkillName`/`SKILL_TO_PHASE`) to
detect the target phase, then `handleInputText` to advance. Under C, this flow
is **rewired to be triggered by the transform handler's phase detection**
rather than `parseTargetPhase` + `handleInputText`. The transform handler:
1. Detects the target phase (from `/plan` OR `/skill:writing-plans`).
2. If the target phase has unresolved phases before it → fire skip-confirmation
   (the existing `selectValue` "Do X now / Skip / Cancel" logic, moved into the
   transform handler or a shared helper).
3. On confirm/skip → advance the tracker + persist; on cancel → return
   `{ action: "handled" }` (block).
4. On no unresolved phases → advance + persist + return the transform text
   (`/skill:<name>` for 5 commands; the execute-choice prompt for `/execute`).

This is the bulk of the refactor (~80 lines of skip-confirmation logic moves
from the `input` handler into the new transform handler, or a shared helper
both call). The existing skip-confirmation tests get updated to exercise the
new entry path.

## The `input` transform — detailed design

```typescript
// extensions/workflow-monitor.ts (added near the existing input handler, if any)

const PHASE_COMMAND_TO_PHASE: Record<string, Phase> = {
  "/brainstorm": "brainstorm",
  "/plan": "plan",
  "/execute": "execute",
  "/verify": "verify",
  "/review": "review",
  "/finish": "finish",
};

pi.on("input", async (event, ctx) => {
  if (event.source === "extension") return { action: "continue" };

  const trimmed = (event.text ?? "").trim();
  const firstToken = trimmed.split(/\s+/, 1)[0];
  const phase = PHASE_COMMAND_TO_PHASE[firstToken];

  if (!phase) return { action: "continue" };

  // Advance the tracker + persist
  handler.advanceWorkflowTo(phase);
  persistState();
  updateWidget(ctx);

  // /execute: present the choice (don't transform to a skill — let the user pick)
  if (phase === "execute") {
    const choice =
      "Implementation phase. Two execution options:\n\n" +
      "1. /skill:subagent-driven-development (recommended, same session)\n" +
      "2. /skill:executing-plans (parallel session, batched)\n\n" +
      "Type the /skill: command for your chosen approach.";
    if (ctx.hasUI) {
      ctx.ui.setEditorText(choice);
      ctx.ui.notify("Stage set to execute. Pick an execution approach.", "info");
    }
    return { action: "handled" }; // don't pass through to skill expansion
  }

  // Other 5: transform to the /skill: command (skill expansion loads it)
  const skill = phaseToSkill[phase]; // brainstorm→brainstorming, etc.
  return { action: "transform", text: `/skill:${skill}` };
});
```

Notes:
- `phaseToSkill` already exists in `workflow-monitor.ts` (maps phase→skill
  name). Reuse it. For `execute` it maps to `executing-plans` (the default), but
  `/execute` doesn't use the transform path — it presents the choice.
- `handler.advanceWorkflowTo` + `persistState` + `updateWidget` are the same
  primitives `/superpowers stage <phase>` uses (Task 3 wired these).
- Return `{ action: "handled" }` for `/execute` (we set the editor text + notify;
  don't pass through to skill expansion). Return `{ action: "transform" }` for
  the other 5 (skill expansion loads the skill).
- Trailing args (e.g. `/brainstorm some topic`) — for now, ignore (first-token
  match only). The skill content loads; the agent sees the user's original
  input via the skill-command args mechanism (pi appends args to skill content).
  Actually — the transform replaces the *whole* text, so args would be lost.
  Decide: strip args (simplest) or preserve them (`text: `/skill:${skill}
  ${trimmed.slice(firstToken.length).trim()}``). Recommend preserve — see
  Question for user below.

## Open question for user (args preservation)

When the user types `/brainstorm build a chat app`, should the `build a chat
app` args be passed to the brainstorming skill (so the skill loads with the
topic as context), or stripped (the skill loads generic, user re-states the
topic)?

**Recommend: preserve.** Pi's skill-command expansion appends args to skill
content as `User: <args>`. The transform should produce
`/skill:brainstorming build a chat app` (preserve the trailing args) so the
skill loads with the topic. This matches how `/skill:brainstorming build a chat
app` would work if typed directly.

## Scope — what's in this effort

### Phase-skill hiding (7 skills)
Add `disable-model-invocation: true` to the frontmatter of:
- `skills/brainstorming/SKILL.md`
- `skills/writing-plans/SKILL.md`
- `skills/executing-plans/SKILL.md`
- `skills/subagent-driven-development/SKILL.md`
- `skills/verification-before-completion/SKILL.md`
- `skills/requesting-code-review/SKILL.md`
- `skills/finishing-a-development-branch/SKILL.md`

### The `input` transform command handler
- Add the `pi.on("input", …)` handler above to `extensions/workflow-monitor.ts`.
- Reuse `phaseToSkill`, `handler.advanceWorkflowTo`, `persistState`,
  `updateWidget`.
- Preserve trailing args (per recommendation above — confirm with user).

### Remove skill-detection fallback (Decision C)
- Remove `WorkflowTracker.onInputText()` + `onSkillFileRead()` + call sites
  (`handleInputText`/`handleSkillFileRead` in workflow-handler.ts).
- Rewire the skip-confirmation `input` handler to be driven by the transform
  handler's phase detection (move the ~80-line `selectValue` flow into the
  transform handler or a shared helper).
- Keep `parseSkillName`/`SKILL_TO_PHASE` (the transform uses them for direct
  `/skill:` recognition). Keep the `parseSkillName` unit test; remove the
  `onInputText`/`onSkillFileRead` behavior tests.
- Keep `onFileWritten` (artifact detection).

### Update skills that reference the removed detection
- The `using-superpowers` skill tells agents to "invoke skills before acting" —
  with phase skills hidden, this guidance still works for the 6 supporting
  skills but the phase skills are command-only. Update the skill text to reflect
  command-driven phase entry (e.g. "use `/brainstorm` to start a design, not
  `/skill:brainstorming`"). Light edit.
- The `writing-plans` execution handoff mentions `/skill:subagent-driven-
  development` and `/skill:executing-plans` — these still work (hidden skills
  are `/skill:`-invocable), but the handoff could also mention `/execute`. Light
  edit.
- The `subagent-driven-development` skill's prerequisites mention skill
  invocation — fine (it's loaded via `/execute`'s choice).

### Docs
- ROADMAP: mark "Command-driven phase advancement" as shipped; note the
  skill-detection fallback was dropped (command-only).
- README: document the 6 phase commands + the supporting-skills-still-auto
  behavior.
- CHANGELOG: `[0.7.0]` entry.
- `package.json`: version bump `0.6.0` → `0.7.0`.

## Out of scope

- Hiding supporting skills (B2 keeps them model-invocable).
- Removing `/workflow-next` / `/workflow-reset` (already deprecated; removal is
  a future change).
- The `/superpowers query` command (still future).
- Auto-spawning new sessions per phase (the new commands are in-session).

## Verification

- `npm test` (vitest) — all existing tests pass + new tests for:
  - The `input` transform: each of the 6 commands → tracker advances + correct
    transform text (or execute-choice for `/execute`).
  - Non-command input passes through unchanged (`{ action: "continue" }`).
  - Extension-source messages skipped.
  - Args preserved (`/brainstorm topic` → `/skill:brainstorming topic`).
  - Removed skill detection: `onInputText`/`onSkillFileRead` no longer called
    (remove their tests too).
- `npm run lint` (biome) — clean.
- Manual: confirm the 7 phase skills no longer appear in the system prompt
  (check via a session's system prompt); confirm `/brainstorm` etc. load the
  skills; confirm supporting skills still auto-invoke.

## Setup

New branch `feat/command-driven-phase-advancement` off `main` (PR #3 merged;
created during planning). This is a real feature (input transform + skill
frontmatter changes + skill-detection removal + skip-confirmation rewire) —
implement via TDD (the input transform + skip-confirmation are testable; the
frontmatter changes are config). Use subagent-driven-development. Larger than
the spec first implied due to the skip-confirmation rewire — budget for it.
