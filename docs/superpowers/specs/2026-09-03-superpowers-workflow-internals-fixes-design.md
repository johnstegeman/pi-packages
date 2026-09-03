# Superpowers Workflow Internals Fixes — Design

Date: 2026-09-03
Molecule: `pi-packages-mol-7xq0` (topic: "Superpowers workflow internals fixes")

## Problem

Four symptoms observed while running the superpowers-workflow formula against this
monorepo (all at runtime; none originated as a commit in this repo):

1. **Gate resolved, but the step bead it gated stays open.** When a gate is resolved
   (e.g. the `Gate: human` for step `spec-approved`, id `h3ib`), the step it was gating
   ("User reviews written spec", `my7z`) remained open. A later `beads_close` on a
   dependent step then failed with `blocked by open issues [my7z]` and the skill had to
   reverse-engineer the graph to close a bead that was already logically done
   (`review.verdict=done` was recorded). Related: `beads_gate_resolve` runs
   `bd gate resolve <id>` **then** a second `bd close <id>`; on bd 1.2.2 `bd gate resolve`
   is itself "equivalent to `bd close <id>`", so the follow-up close is redundant and can
   return the confusing `gate resolved but close failed (retry beads_close)` path.

2. **Phase skills missing from the system prompt.** Seven phase skills
   (`brainstorming`, `writing-plans`, `executing-plans`, `subagent-driven-development`,
   `verification-before-completion`, `requesting-code-review`,
   `finishing-a-development-branch`) carry `disable-model-invocation: true` in their
   frontmatter, so they no longer appear in the system prompt. The `input`-transform
   loading mechanism planned to replace them (2026-07-29 command-driven phase advancement;
   `extensions/workflow-monitor.ts`) was never shipped in main — only the frontmatter
   flags landed. Result: the workflow agent doesn't see `writing-plans` /
   `finishing-a-development-branch` and improvises those steps instead of following them.

3. **Widget no longer renders hierarchy.** The phase-aware widget rework
   (2026-09-03, merged via PR #27) removed `parseMoleculeShow` and the child-subtree
   (`├──`/`└──`) rendering. The implementing phase is now a flat list and no longer shows
   the parent/child (task) relationship as a visual tree.

4. **Widget stays on the Implement bead after implementation completes.** After all
   implement tasks close, the header still read `Implementing · 12/17` and the implement
   parent bead was still `in_progress`, so `phaseFor()` never returned `"finishing"` and
   the finishing steps (Verify / Smoke test / Finish) never rendered. Root cause: the
   implement **parent step bead was never closed** once its last task closed.

## Goals

- The head/tail rule for the close flow: **when a gate is resolved, the step it gated
  closes; when the last child task of a step closes, the step closes** — but **never
  auto-close the molecule root** (the finishing phase must complete first).
- The 7 phase skills are visible in the system prompt again (revert
  `disable-model-invocation`).
- The widget keeps its phase header + phase views and renders the implementing phase as a
  tree again (parent + nested task rows), and advances to finishing once the implement
  parent closes.

## Non-goals

- **No on-demand phase-skill loading mechanism** in this session. The 7 skills simply
  return to the system prompt. The deferred "command-driven phase advancement" idea is
  tracked in follow-up bead `pi-packages-i7ar`.
- No change to the formula itself.
- No `parseMoleculeShow` / `bd mol show` re-introduction; the flattened `steps[]` from
  `bd mol current --json` already carries parent + children in one list.

## Design

### Part A — pi-beads: auto close-cascade (issues 1 + 4)

Package: `packages/pi-beads/src/index.ts`. Both write tools keep their signatures;
behavior changes only add closes that the skill currently has to do by hand.

**A1. `beads_gate_resolve(id)`**
- Run `bd gate resolve <id>` (bd 1.2.2: equivalent to closing the gate).
- Do **not** run the redundant second `bd close <id>`.
- Look up the step(s) the gate blocks: `bd dep list <id> --direction dependents --json`
  against the owning repo, selecting entries whose `issue_type !== "gate"` and whose
  `status` is open. (In this formula each gate gates one step: `h3ib`→`my7z`,
  `r8yw`→`b3my`, `9flc`→`3esj`.)
- Close each such step (`bd close <step>`). Its remaining blockers are the (now resolved)
  gate plus the root parent-child edge, both satisfied, so this should succeed.
- Emit `beads:changed` after each write (as today).
- Success text: `gate <id> resolved and gated step <step> closed`. If a gated step's close
  still fails, return `gate <id> resolved but gated step <step> not closed: <err>
  (blocked by <blockers>)` — a specific reason, not "retry beads_close".

**A2. `beads_close(id)` — cascade child → parent step**
- After a successful `bd close <id>`, look up the closed issue's parent via the
  parent-child edge (`bd dep list <id> --direction blockers` filtered to
  `type === "parent-child"`, taking the issue that is *not* the closed id — i.e. whose
  `depends_on_id` is the parent we want). Equivalent: find the parent whose child list
  includes `<id>`.
- If the parent is a **task step** (`issue_type !== "molecule"` and `issue_type !== "gate"`),
  check whether it still has any **open** children (other `parent-child` children that are
  open). If none remain, close the parent too (`bd close <parent>`), then recurse upward
  with the same rule.
  check whether it still has any **open** children (other open `parent-child` children,
  excluding its own gates). If none remain, close the parent too (`bd close <parent>`),
  then recurse upward with the same rule.
- **Hard stop:** never auto-close the molecule root (`issue_type === "molecule"`). The root
  is closed explicitly at the very end after Verify / Smoke test / Finish complete.
- Emit after each write. This is what closes the implement parent step once its last task
  closes (issue 4), letting the widget advance to finishing.

**Scope guards**
- Only cascade up when the closed child's **parent step has no remaining open children**;
  an open gate (or any open sibling) blocks the cascade.
- Only close steps; never auto-close gates or the root.
- Both tools are already routed to the owning repo by id prefix; lookups use the same
  `bd` runner with the repo dir.

### Part B — skills: restore system-prompt visibility (issue 2)

- Remove the `disable-model-invocation: true` line from the frontmatter of the 7 phase
  skills in `packages/pi-superpowers-plus/skills/*/SKILL.md`:
  `brainstorming`, `writing-plans`, `executing-plans`, `subagent-driven-development`,
  `verification-before-completion`, `requesting-code-review`,
  `finishing-a-development-branch`.
- `using-superpowers` and the 6 supporting skills are already model-invocable; no change.
- The 7 skills appear back in the system prompt (pi reads them from the installed package
  clone's manifest), so the workflow follows `writing-plans` /
  `finishing-a-development-branch` again.
- Follow-up bead `pi-packages-i7ar` already tracks the deferred on-demand loading
  mechanism; it stays open.

### Part C — widget: tree again for implementing, advance to finishing (issues 3 + 4)

Package: `packages/pi-superpowers-plus/extensions/beads-molecule-widget.mjs` (+
`beads-molecule-widget.test.mjs`).

- Keep the phase header (`Superpowers: <topic> · <Phase> · done/total`) and the
  brainstorming / finishing phase views (flat, formula order) from the current renderer.
- **Implementing phase renders as a tree:**
  - Implement parent row (marker + title), e.g. `◐ Implement Superpowers widget internals
    fixes`.
  - Its task children (flattened `steps[]` entries with
    `id.startsWith(\`${impl.id}.\`)`, sorted by `created_at` then `id`, as today) indent
    under it with the old tree connectors: `├── ` for all but the last, `└── ` for the
    last, followed by the status marker and title.
  - Example (tree only; not literal widths):
    ```
    Superpowers: widget internals fixes · Implementing · 17/17
      ◐ Implement Superpowers widget internals fixes
      ├── ✓ Task 1: parser
      ├── ✓ Task 2: renderer
      └── ◐ Task 3: wiring
    ```
- No `parseMoleculeShow`/`bd mol show` — the flattened `steps[]` already contains the
  implement parent and its tasks.
- Keep the 15-line cap and `+N more` tail (they operate on the tree rows like the previous
  flat rows; the tail trims leaves first — same `fitRows` order: pinned current first,
  open before closed).
- Keep `✓`/`◐`/`○` markers and theme passthrough.
- **Issue-4 rendering side needs no widget-logic change**: once Part A closes the
  implement parent step, `phaseFor()` reads `impl.step_status === "done"` → `"finishing"`
  → Verify/Smoke/Finish render and can be claimed.

### Interfaces / impact

- `parseMoleculeCurrent`, `topicFor`, `phaseFor`, `createChangeCoalescer` signatures
  unchanged.
- `moleculeWidgetLines(state, width, theme)` signature and `string[]` contract unchanged.
- `beads_gate_resolve(id)`, `beads_close(id)` signatures unchanged; their side-effect
  surface grows (extra closes) — visible in the pi-beads argv/emit tests.
- The superpowers skills' close instructions (in `brainstorming`, `executing-plans`,
  `writing-plans`, `verification-before-completion`) continue to work unchanged; Part A
  makes the gated-step/parent closes automatic so the skills no longer need to remember
  them (light one-line hints may be added for clarity — optional, non-blocking).

## Testing

- **pi-beads** (`packages/pi-beads/test/pi-beads.test.mjs`):
  - `beads_gate_resolve`: argv order = gate resolve, then dep-list lookup, then step
    close; exactly one emit per write; success text mentions the gated step.
  - `beads_close` cascade: closing the last open child closes the parent step (argv
    order close-child → close-parent); no parent close while a sibling/gate is open; no
    root close ever (fixture where root's last step closes — cascade stops).
  - Existing suite stays green.
- **widget** (`packages/pi-superpowers-plus/extensions/beads-molecule-widget.test.mjs`):
  - implementing-phase fixture asserts tree shape: impl head row present, task rows
    present with `├──`/`└──` connectors, closed `✓` vs current `◐`, ≤ 15 lines.
  - regression: finishing phase with implement parent `done` renders Verify / Smoke test /
    Finish rows (issue-4 advance).
  - `npx biome check` on touched files clean.
- **skills**: `grep -rn disable-model-invocation packages/pi-superpowers-plus/skills/` → no
  matches after Part B.

## Follow-up (tracked, not in scope)

- `pi-packages-i7ar` — decide/build on-demand phase-skill loading mechanism (command-driven
  phase advancement, `input` transform) once skills are visible again.

## Global constraints

- Run commands from the package dir: `cd packages/pi-beads` / `cd packages/pi-superpowers-plus`.
- Test gate: `cd packages/pi-superpowers-plus && npm test` must pass.
- Commit small changes per step; one topic per commit.
