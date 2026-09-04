# Phase-Skill Visibility + Command-Driven Phase Entry — Design

**Date:** 2026-09-04
**Molecule:** `pi-packages-mol-tw71` (topic: "Decide and build on-demand phase-skill loading for superpowers")
**Source:** follow-up epic `pi-packages-i7ar` ("Follow-up: decide/build on-demand phase-skill loading (was disable-model-invocation hiding)")

## Problem

The superpowers phase skills were hidden from the system prompt in v0.7.0 via
`disable-model-invocation: true`, but the `input`-transform loading mechanism planned to
replace them (2026-07-29 "command-driven phase advancement"; `extensions/workflow-monitor.ts`)
was never shipped in main — only the frontmatter flags landed. The result: the workflow agent
could not see `writing-plans` / `finishing-a-development-branch` etc., and when a phase skill
handed off ("continue with writing-plans?"), nobody could load the next skill, so the agent
improvised that phase instead of following the real skill.

A later session restored the 7 phase skills to the system prompt (reverted the flags) as a
temporary fix. This epic decides the durable direction and builds it.

**User's stated goal:** keep the system prompt clean (hide the phase skills) **while still
enabling the real superpowers workflow** — the next skill must actually be loaded at the start
of each phase, never improvised. Reliability is the top priority.

## Decisions

### Decision 1 — Approach: command-driven phase entry (`input` transform), not a runtime monitor

- The 7 phase skills get `disable-model-invocation: true` again (out of the system prompt).
- Phase entry is via short commands (`/brainstorming`/`/brainstorm`, `/plan`, `/execute`,
  `/verify`, `/review`, `/finish`) implemented as a **`pi.on("input")` transform** that rewrites
  the command to `/skill:<name>` (args preserved) before skill expansion. This is the
  documented pi input-transform pattern — direct, one-step skill loading.
- **No runtime workflow monitor is brought back.** The workflow-monitor extension was removed
  because its phase tracker misread tool calls (inferred `plan_tracker` init as "entering the
  execute phase"). The failure class (stateful inference over tool calls → confusion and lost
  trust) is the reason to keep discipline in the skill instructions, not in runtime code.
  Skill visibility (declarative frontmatter) + command transforms (pure text rewriting, no
  tool-call inference) do NOT reproduce that failure class.
- **No warning injection** (`⚠️ TDD: source before test`) is rebuilt. It is the same
  tool-call-inference pattern that was removed. Stale "runtime warning" text in
  `test-driven-development`, `subagent-driven-development`, and `agent-templates/implementer.md`
  is scrubbed instead; the three-scenario TDD discipline already lives in the skill text.

### Decision 2 — Visibility set

**Hidden (`disable-model-invocation: true`), loaded on-demand:**
- 7 phase skills: `brainstorming`, `writing-plans`, `executing-plans`,
  `subagent-driven-development`, `verification-before-completion`, `requesting-code-review`,
  `finishing-a-development-branch`.
- 4 supporting skills that only matter inside a phase (loaded on-demand from within the
  implement/review skills via `/skill:`): `test-driven-development`, `using-git-worktrees`,
  `dispatching-parallel-agents`, `receiving-code-review`.

**Remain model-invocable (visible in system prompt):**
- `using-superpowers` — carries the "invoke relevant skills before acting" rule + Red Flags;
  the only thing that generalizes skill-discipline outside a poured workflow (bugfixes,
  one-off tasks). Cheap (one description line).
- `systematic-debugging` — standalone bugfixing at session start with no workflow running.

### Decision 3 — Handoffs always print the command (the actual fix)

With phase skills hidden, every place a skill says "continue with writing-plans" is changed so
the **agent prints the exact command the user types** (e.g. `Type /plan when ready`). The next
skill then arrives as real loaded content via pi expansion — never as the agent improvising.
Direct `/skill:<name>` invocation remains valid everywhere (hidden ≠ uninvocable), giving two
redundant paths to the same deterministic load.

### Decision 4 — Close-as-you-go at each handoff (addendum)

When the agent claims step N+1's bead, it must close step N in the same turn — otherwise the
widget shows a stale open step (observed live this session: `approaches` left open when
`design` was claimed). One-line reminder added to handoff points in `brainstorming` and
`writing-plans` skill text.

## Command table

| Command | Transform | Action |
|---|---|---|
| `/brainstorming`, `/brainstorm` | `/skill:brainstorming` | `transform` |
| `/plan` | `/skill:writing-plans` | `transform` |
| `/verify` | `/skill:verification-before-completion` | `transform` |
| `/review` | `/skill:requesting-code-review` | `transform` |
| `/finish` | `/skill:finishing-a-development-branch` | `transform` |
| `/execute` | (no skill — presents SDD vs executing-plans choice) | `handled` + `setEditorText` |

Trailing args are preserved (`/brainstorm build a chat app` → `/skill:brainstorming build a chat app`).
Non-command input and `event.source === "extension"` messages pass through unchanged
(`{ action: "continue" }`).

## Components

### 1. `packages/pi-superpowers-plus/extensions/phase-commands.ts` (new)

`pi.on("input")` handler implementing the command table. No state tracking, no bead writes,
no `registerCommand` (transform only). Loaded automatically via the package's `./extensions`
directory (loads all `.ts`/`.js`).

Tests: `extensions/phase-commands.test.mjs` — fake pi capturing the `input` handler;
assert each command's `{action, text}`, args preserved, extension-source and non-command pass
through. (Mirrors the `beads-molecule-widget.test.mjs` pattern.)

### 2. Frontmatter edits (11 SKILL.md files)

Re-add `disable-model-invocation: true` to the 7 phase skills; add it to the 4 newly-hidden
supporting skills. `using-superpowers` and `systematic-debugging` are untouched (stay visible).

### 3. Handoff text edits (7 phase skills)

Replace "invoke/continue with <phase skill>" phrasing with "type `/X` when ready." Key sites:
- `brainstorming` terminal state (line ~141) + related-skills refs → `Type /plan to continue`.
- `writing-plans` Execution Handoff (lines ~253-292) → offers both options plus `/execute`;
  the implement-task pointer keeps `/skill:subagent-driven-development` / `/skill:executing-plans`.
- Full grep sweep for any remaining phase-to-phase "invoke" phrasing + stale removed-tool
  references, folded in.
- `using-superpowers`: `/brainstorm` reference already valid once the command exists; may also
  mention the `/brainstorming` spelling.

### 4. Stale runtime-warning scrub

- `test-driven-development/SKILL.md` (~lines 63-77 "Interpreting Runtime Warnings") — remove the
  workflow-monitor framing; the three scenarios + Iron Law + Verify-RED/GREEN already provide
  the checkpoints.
- `subagent-driven-development/SKILL.md` (~line 444) — drop "Runtime warnings on source-before-
  test patterns"; keep "implementer subagents receive three-scenario TDD instructions via agent
  profile and prompt template."
- `agent-templates/implementer.md` (~line 18) — "If you see a ⚠️ TDD warning" → "Pause and
  consider which scenario applies."

### 5. Docs + version

- `README.md`: document the 6 phase commands + the visibility story (11 hidden loaded
  on-demand; 2 in the system prompt).
- `CHANGELOG.md`: `[0.9.0]` entry — command-driven phase entry, visibility set, explicit
  no-runtime-monitor position.
- `ROADMAP.md`: reaffirm the monitor stays removed; mark command-driven entry as shipped.
- `package.json`: version `0.8.0` → `0.9.0`.

## Out of scope

- `pi-packages-lk5q` — the skill-cleanup epic (hand-read findings beyond the monitor scrub +
  close-as-you-go addendum).
- Phase/state tracking, skip-confirmation, warning injection, `/workflow-next`/`/superpowers`
  revival (all kept out per agreement / prior removal).

## Testing / verification

- `extensions/phase-commands.test.mjs` green (command behavior table).
- Existing `beads-molecule-widget.test.mjs` stays green.
- `grep -rn "disable-model-invocation" skills/` → exactly the 11 hidden skills, none of the
  visible 2.
- `npm test` (`biome check .` + widget test) green.
- Manual smoke: `/brainstorming` loads brainstorming; `/execute` presents both options; `/plan`
  (with brainstorm resolved) loads writing-plans; hidden skills absent from system prompt;
  `using-superpowers` + `systematic-debugging` present.

## Global constraints

- Run commands from the package dir: `cd packages/pi-superpowers-plus`.
- Test gate: `cd packages/pi-superpowers-plus && npm test` must pass.
- Commit small changes per step; one topic per commit.
