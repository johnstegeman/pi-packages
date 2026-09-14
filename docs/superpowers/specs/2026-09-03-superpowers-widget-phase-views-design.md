# Superpowers Widget: Topic Header + Phase-Aware Views — Design Spec

**Date:** 2026-09-03
**Source:** Rework the superpowers molecule widget (`beads-molecule-widget`) so its header
shows the real brainstorming topic instead of the generic formula name, and so its body
expands into three phase-specific views (Brainstorming / Implementing / Finishing) that
survive a 15-line cap with an "open beads over closed beads" overflow preference.

## Motivation

Today the widget renders a generic header (`Superpowers: superpowers-workflow · n/total`)
followed by the current step and up to 13 children drawn from a separate `bd mol show`
call. Two gaps this spec closes:

1. **Header is generic.** The molecule root title is the formula name
   (`superpowers-workflow`) — `bd mol pour` does not template the root title with the
   `topic` var (verified against bd 1.2.2: root title = formula name; a `[meta] title =
   "{{topic}}"` formula field is ignored). The actual topic lives only inside step titles
   (`Explore project context: <topic>`, `Implement <topic>`). Result: the header never
   reflects what is being worked on.
2. **Too little / wrong scope shown per phase.** The body only ever shows children of the
   current step; during brainstorming the current step has no children (so just the
   header + a trunk line show), during implementation it shows whichever task happens to
   be current rather than the whole plan gate + task set, and after implementation there
   is nothing useful to look at.

## Goals

1. Header shows `Superpowers: <topic> · <Phase> · <done>/<total>` where `<topic>` is the
   brainstorming topic (e.g. "Superpowers widget changes" → `Superpowers: Superpowers
   widget changes · Brainstorming · 3/8`).
2. Three phase-specific views, each rendered exclusively per phase:
   - **Brainstorming** — the full pre-implementation checklist (brainstorm + spec tasks),
     including done ones.
   - **Implementing** — the plan-approval gate + implementation task beads.
   - **Finishing** — the remaining close-out steps after implementation.
3. A dim "finished" line when the molecule is fully complete.
4. Never more than 15 lines; on overflow prefer open beads over closed beads; always keep
   the current bead on screen.

## Approach

Single `bd mol current --json` call per refresh. Its `steps[]` field already flattens
every descendant reachable from the molecule root over `parent-child` edges — the formula
steps, the `Gate: human` beads, AND the implement step's dynamically created children
(plan-approval gate + task beads), each with the full issue object and a step-level
`status` (`done|current|ready|blocked|pending`) plus `is_current`. Verified live against
bd 1.2.2 in a throwaway repo: children created under `implement` via `bd create --parent`
appear in `steps[]`; assigning/in-progressing a child task surfaces it as
`current_step`/`is_current`.

This makes the separate `bd mol show` children path redundant for all three views, so it
is deleted. No formula changes are required (Approach 1; the title-keyword coupling is
accepted and documented — widget and formula ship in the same package).

## Design

### 1. Data model (`parseMoleculeCurrent`)

Stop reducing `steps[]` to `{ issue: { id, issue_type }, status }`. Preserve each entry as:

```ts
{
  issue: { id, title, priority, issue_type, status },  // full issue object
  status: "done" | "current" | "ready" | "blocked" | "pending",
  is_current: boolean,
}
```

Top-level `current_step`, `next_step`, `molecule_id`, `molecule_title`, `doneCount`,
`total` are kept. `parseMoleculeShow`, the `children` field, `refreshChildren` and the
children-carrying logic are removed from the render pipeline.

### 2. Header topic

Derive the topic from the step whose title starts with `Explore project context: `; the
topic is the remainder, trimmed. Fallback to `molecule_title` when no such step exists
(foreign/non-superpowers molecule). This works for existing pours too — their explore
step carries the topic verbatim — so no migration or formula change is needed.

Header assembly (accent label + text/muted topic + muted suffix):

```
Superpowers: <topic> · <Phase> · <done>/<total>
```

### 3. Phase label

Phase is derived from the implement step's own step-status in `steps[]` (found by title
prefix `Implement `):

| implement step status  | phase        |
|------------------------|--------------|
| `pending` (or missing) | Brainstorming |
| `ready` / `current`    | Implementing  |
| `done`                 | Finishing     |

This is robust to the fact that `bd mol current`'s top-level `current_step` points at the
deepest in-progress bead (during implementation that is often a child *task*, not the
implement step), because we never key phase off `current_step.title`.

### 4. General rendering rules

- `MAX_LINES = 15` including the header.
- Each view builds an ordered list of candidate rows, then:
  1. **Pin the current bead** — the row for the `is_current` step is always shown and is
     never the truncation victim.
  2. **Prefer open over closed** — when candidates exceed the slot budget, drop `done`
     rows before `open`/`current`/`blocked` rows (drop from the tail of each partition).
  3. **Overflow tail** — remaining overflow becomes a dim `└── +N more…` row; total lines
     never exceed `MAX_LINES`.
- Rows keep display-width truncation and status markers: `✓ closed · ◐ current ·
  ○ open/ready/pending · ● blocked`.

### 5. Brainstorming view (implement pending)

Checklist of all 8 pre-implementation tasks in formula order, **including done ones**:
Explore project context · Ask clarifying questions · Propose approaches · Present design
sections · User approves design · Write spec to docs/superpowers/specs/ · Spec
self-review · User reviews written spec. Markers: `✓` done, `◐` current, `○` unblocked,
`●` blocked. The `Gate: human` beads are not checklist rows; when a gate is the current
step the existing `⏸ Waiting on you: …` line shows instead. No separate trunk line (the
checklist itself marks the current item).

### 6. Implementing view (implement ready/current)

1. Implement step head row (`◐`/`○` `Implement <topic>`).
2. The implement step's children, in creation order (created_at, then id): the
   plan-approval gate bead (`Plan reviewed / ready to execute`, from writing-plans) first,
   then the `Task N: …` beads.
3. The current task bead is pinned (`◐` stays on screen under truncation).

### 7. Finishing view (implement done)

The close-out steps in formula order: `Verify` · `Smoke test / manual QA sign-off` ·
`Finish development branch`, with normal markers; a waiting gate shows `⏸ Waiting on
you`. Done implementation tasks are not listed (phase exclusivity).

### 8. Fully complete

When every step in `steps[]` is `done`, render a single dim line
`✓ Superpowers: <topic> — finished`. Note `bd mol current` (inference, no id) returns
nothing once no step is in progress, so this finished line renders within the completing
session, then the widget naturally goes quiet on later sessions.

### 9. Extension wiring (`beads-molecule-widget.ts`)

- `refreshMolecule` unchanged (parses `bd mol current --json`).
- `doRefresh` becomes `refreshMolecule(cwd).then(renderMolecule)`; same for
  `session_start` / `agent_start` (one call per refresh instead of two).
- Remove `refreshChildren`, its `bd mol show` call, the children-carry logic, and the
  `parseMoleculeShow` import.
- Error handling unchanged: transient failure keeps last-known state; a clean "no active
  molecule" clears; malformed input never blanks a live widget.

## Testing

Extend `beads-molecule-widget.test.mjs` (pure assertions, run via
`cd packages/pi-superpowers-plus && npm test` — biome + widget tests):

- Parser: `steps[]` keeps `issue.title`/`priority`/`issue_type` and step `status` +
  `is_current`.
- Header topic: derived from `Explore project context: X`; fallback to `molecule_title`
  when absent; phase label Brainstorming/Implementing/Finishing for the three implement
  statuses; `done/total` still present.
- Brainstorming: all 8 tasks incl. done, in formula order, `✓`/`◐` markers; gate-as-
  current yields `Waiting on you` and no checklist rows dropped.
- Implementing: implement head row + plan gate first + tasks by creation order; current
  task pinned.
- Finishing: verify/smoke/finish rows only.
- Fully complete: single finished line.
- Cap: constructing >15 candidate rows produces exactly 15 lines, closed rows dropped
  before open ones, `+N more` tail present; current bead never dropped; every line still
  `displayWidth(line) <= width`.

## Out of scope

- Changing `bd mol pour` / the formula (root title not templatable; title-keyword phase
  mapping accepted instead).
- Changing the `beads:changed` coalescing refresh model.
- Internationalizing or renaming formula step titles.
