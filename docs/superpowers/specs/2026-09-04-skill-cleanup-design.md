# Skill Cleanup: hand-read findings from visibility/commands work — Design

Date: 2026-09-04
Tracking: epic `pi-packages-lk5q`, molecule `pi-packages-mol-qgn3`
Target package: `packages/pi-superpowers-plus`

## Context

The phase-skill-visibility / command-layer work (molecule `pi-packages-mol-tw71` / issue `pi-packages-i7ar`) was
landed without folding in a set of deferred, non-build cleanup findings from the hand-read of
the pi-superpowers-plus skills. Those findings are captured on epic `pi-packages-lk5q`. This
spec scopes the cleanup cycle for them.

Scope boundary (from the epic): findings here are **not** part of the visibility + command-layer
change, and **not** the stale workflow-monitor/runtime-warning scrubs (which shipped with the
visibility work). This cycle covers the remaining findings plus a bounded, like-kind sweep.

## Scope

- **Fix all 7 findings** currently logged on `pi-packages-lk5q` (listed per-area below).
- **Sweep** for like-kind issues, bounded to **skills-text only**: stale references to removed
  tools/artifacts (`plan file`, `plan.md`, `brief file`, workflow-monitor, runtime-warning) and
  internal contradictions that read like the pre-visibility workflow.
- **Exclusions (explicit):** no changes to other packages (`pi-beads`, `pi-subagents`, etc.); no
  changes to formula/skill titles or the workflow molecule structure; no behavioral/API changes;
  widget changes are display-only. A permanent lint is **out of scope** (the sweep is a one-time
  verification step).

All changes land in `packages/pi-superpowers-plus`.

## Approach

Single audit-first plan under the molecule's `implement` step:

1. **Audit task (first)** — produce the definitive work list: every stale reference/contradiction
   across the skills, starting from findings 1/3/4/5 and extended by grepping the offending
   vocabulary. This task only enumerates; nothing is fixed here.
2. **Fix tasks** — one per area, each independently verifiable.
3. **Final verification** — one-time grep sweep + widget tests (see Verification).

## Per-area changes

### 1. writing-plans — remove plan-file vestiges (finding 5)

The skill already states the plan output is task beads, not a file (lines ~27, ~31, ~185, ~265),
but three sections still describe authoring a markdown plan **document**:

- **`## Plan Document Header`** — delete. There is no document to carry a `# <Feature> Implementation
  Plan` header. `## Global Constraints` survives but is re-homed: authored **directly into the gate
  bead's description** (where it already lands at plan-approval), not described as part of a file
  header.
- **`## Task Structure`** — recast as the **task-bead description template**. The `Files:` /
  `Interfaces:` / `- [ ] Step N:` format is retained verbatim, but as the shape of each task bead's
  `description` (what `beads_create` writes), not as markdown sections in a document. The
  `### Task N: [Component Name]` headings become the bead **titles**.
- **`## Task Separation`** — delete. The `---`-between-tasks rule only delimited sections in a
  file; there is no file, so there are no separators. The "no `---` inside a task body" foot rule
  goes with it.
- **Inline phrasing** — line ~151 "…written out in the plan document…" becomes "…authored in the
  task breakdown…"; every `beads_create(…, description: "<full step-by-step instructions from the
  plan's Task N body>")` reads "from the Task N breakdown above", since beads are created directly
  from the breakdown and nothing is "mirrored" from a file.
- **`## Creating Tasks as Beads` / `## Execution Handoff`** — stay as-is (already bead-correct);
  only dangling "plan document" references get aligned.

### 2. SDD + brainstorming text (findings 1, 3, 4)

- **implementer-prompt.md (finding 3)** — make the toolset expectation explicit: implementers **do**
  have `beads_show` (extension tools stay available in subagents; the Agent-tool "Tools:" summary
  reflects only the default no-extensions case). Add a line telling controllers to hand the task
  bead id to the implementer per the template and **not** inline the full task text out of concern
  the implementer can't read their own bead.
- **SDD task loop (finding 4)** — add an explicit controller step at dispatch: mark the task bead
  `in_progress` (`beads_update({ id, claim: true })`) when dispatching a task's implementer, so the
  widget shows active ◐ instead of a future ○. (The template already has the reviewer close it after
  review; this adds the missing open-side of the lifecycle.)
- **brainstorming + writing-plans (finding 1)** — harden close-as-you-go with an explicit reminder
  at each checklist handoff: *"when you claim step N+1, close step N you just completed in the same
  turn."* (Compatible with the widget staleness fix: the widget no longer needs "claim-first"
  gymnastics because it renders the deepest open/ready step even when nothing is `in_progress`.)

### 3. Widget — display fixes (findings 2, 6, 7)

All in `extensions/beads-molecule-widget.ts` / `.mjs`, display-only:

- **Bead ids on rows (finding 7)** — each step row appends its bead id (muted), e.g.
  `pi-packages-mol-sm3f`, after the title. Apply to gates/awaiting line where relevant.
- **Footer clarity (finding 6)** — render the **gated step** the ready gate leads to instead of the
  raw gate title. The widget already computes `awaitingStep` (nearest pending/open non-gate step
  before the ready gate; ~lines 346–354), so the line becomes `⏸ Waiting on you: <gated step
  title>`, e.g. "Waiting on you: User approves design". Gate beads are **not** retitled at creation
  (that would touch `pi-beads` — out of scope).
- **Staleness fix (finding 2)** — the active/current row keys on the deepest **open/ready** step,
  not on whether a step is `in_progress`. When nothing is `in_progress` (the close-then-claim gap),
  render the deepest open step as the current row instead of freezing the last `in_progress` one.

### 4. Sweep (skills-text only)

Extends the audit and subsequent fix tasks: grep all skills for stale references/contradictions
(`plan file`, `plan.md`, `brief file`, `divider`, workflow-monitor/runtime-warning leftovers, and
any other wording that implies the removed pre-visibility workflow). Each finding is either a
fix-now (added to the relevant fix task) or a documented legitimate transitional/historical mention
triaged explicitly.

## Testing

- `cd packages/pi-superpowers-plus && npm test` (runs `biome check .` +
  `extensions/beads-molecule-widget.test.mjs` + `extensions/phase-commands.test.mjs`).
- New widget test cases: id suffix on rows; footer shows gated-step title; current-row behavior
  across the no-`in_progress` gap.

## Verification

1. **Widget tests green** (above).
2. **One-time grep sweep** — last plan task greps all skills for the offending vocabulary and
   confirms **zero remaining**; every hit triaged (fixed-now or a documented legitimate mention).
3. **Smoke test / manual sign-off** (molecule's `smoke-test-approved` gate) — run pi with the widget
   and confirm: bead ids visible on rows; footer reads descriptively; the current row advances
   correctly through a close-then-claim cycle.

## Out of scope

- Other packages (`pi-beads`, `pi-subagents`, ayu, bifrost, hashline-edit, langfuse, statusline).
- Formula/skill titles and molecule structure.
- Behavioral/API changes (anything beyond skill text and widget display).
- Retitling gate beads at creation (would require a `pi-beads` change).
- A permanent lint/CI guard for the swept vocabulary.
