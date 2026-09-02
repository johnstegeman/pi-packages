# Design: Superpowers molecule widget — live refresh + header + current-phase subtree

Date: 2026-09-02 · Source: `pi-packages-pin` learnings (R3 + R7) · Molecule: `pi-packages-mol-vn4` (scope = sub-project A only).

## Goal

Upgrade the pi-superpowers-plus **beads-molecule-widget** so it (1) stays current as beads change
during a run (live refresh instead of `session_start`/`agent_start`-only), and (2) shows a
**compact current-phase view**: a `Superpowers: <topic>` header plus the current molecule step and
its child task beads as a hierarchy, with status markers that visibly flip to `✓` when a bead
closes — the user's R7 feature requests from the sync-hardening run.

## Context

- The widget lives in `packages/pi-superpowers-plus/extensions/beads-molecule-widget.ts` (extension
  entry: fetches via `pi.exec("bd", ["mol", "current", "--json"])`, registers the widget only on
  `session_start`/`agent_start`, and currently has a **no-op** `invalidate`). Rendering is pure JS in
  `beads-molecule-widget.mjs` (`moleculeWidgetLines`, width-safe `assemble`/`displayWidth`/
  `truncToWidth`), which is node-testable (`beads-molecule-widget.test.mjs`).
- Observed problems (from the sync-hardening run, `pi-packages-pin`):
  - A freshly poured molecule appears only later (no mid-session re-read) — Obs #1.
  - The widget does not visibly update as beads close/resolve during a long run — Obs #11.
  - Real `bd mol current --json` carries **no `formula_step_id`** (the renderer's `phaseOf` reads it,
    so the header's phase label silently renders "Implementing"); step objects DO carry
    `priority`/`status`/`started_at`, and `current_step`/`next_step`.
  - `bd mol current --json` has no child-bead data; the full graph (root/issues/dependencies with
    `parent-child` edges) comes from `bd mol show <step-id> --json`.
- User decisions (approved): **view B** — header + current-phase subtree only (view A, the whole
  molecule tree, was rejected as too tall); **refresh A** — a ~5s timer poll, dormant outside an
  interactive TUI / when no molecule is active (interpreted as: the single cheap `mol current` call
  still runs to catch new pours; the heavier `mol show` is gated); implementation **Approach 1** —
  augment the existing widget in place, making `invalidate` real.

## Decision

### 1. Data layer (`beads-molecule-widget.ts`)

- One module-level `setInterval(5000)` started when `uiRef` first becomes available (in
  `session_start`), guarded per tick with `if (!uiRef?.setWidget) return` (dormant outside
  interactive runs). Single interval for the widget's lifetime; guard against double-registration.
- Each tick: run the existing `bd mol current --json` fetch (`refreshMolecule`). This runs even with
  no active molecule — a single cheap call — so a fresh `bd mol pour` appears within ~5s (fixes
  Obs #1). "Dormant" applies to the *second* call only.
- When a molecule is active, run `bd mol show <current_step.id> --json` for the phase subtree, but
  **only when `current_step.id` changed since the last tick** (or on invalidate) — steady state is
  one bd call per tick. Children are cached alongside `activeMolecule`.
- `invalidate` becomes a real callback: force an immediate `refreshMolecule` + `mol show` (fresh
  children) + `renderMolecule`. It is the seam a future tool-initiated refresh
  (`pi-packages-48r`) will use; nothing calls it yet.
- Error handling (unchanged rule): only clear the widget on a clean "no active molecule" bd signal;
  transient failures keep the last state (an unreachable `bd` must not blank a working widget).
  A failed `mol show` keeps the last children.

### 2. Renderer (`beads-molecule-widget.mjs` — view B)

Rebuilt `moleculeWidgetLines(state, children, width, theme)` on the existing fragment machinery:

1. **Header line:** accent `Superpowers:` + muted `molecule_title`, plus a small muted
   `· <done>/<total>` suffix. Drops the unreliable `⦿ <phase>` label.
2. **Trunk (current step):** `<status-marker> <id> ● P<priority> <title>` (bd-list/R7 shape). If the
   current step is a **gate**, show `⏸ Waiting on you: <title>` instead (no children). With no
   current step, fall back to `○ Next: <title>`.
3. **Subtree:** when the current step has children (task beads), each child row is
   `<glyph> <marker> <id> ● P<prio> <title>`; last child uses `└── `, earlier ones `├── `.
4. **Status markers:** `○` open, `◐` in_progress, `●` blocked, `✓` closed, `❄` deferred — from each
   child's `status` in `mol show --json`. Closed beads visibly flip to `✓` each tick.
5. **15-line cap:** header + trunk always win the budget; children fill the rest; if children exceed
   the remaining budget the final line is a muted `└── +N more…`. Every line is width-truncated by
   `truncToWidth` so the widget never overruns the pane.
6. Drop today's `+N pending` line (header `done/total` covers progress).

### 3. Files

- Modify: `packages/pi-superpowers-plus/extensions/beads-molecule-widget.ts` (poll + real
  invalidate + gated child fetch; stays a thin entry).
- Modify: `packages/pi-superpowers-plus/extensions/beads-molecule-widget.mjs` (add
  `parseMoleculeShow`; rebuild `moleculeWidgetLines`).
- Modify: `packages/pi-superpowers-plus/extensions/beads-molecule-widget.test.mjs` (extend).

### 4. Testing / verification

TDD on the pure `.mjs` layer (the split is what makes the widget testable):
- `parseMoleculeShow`: malformed input → null; children extracted via `parent-child` edges from
  `mol show --json`; deterministic sort (by `created_at`, then `id`).
- `moleculeWidgetLines`: header format; trunk task vs gate vs `Next:` fallback; no-children → no
  subtree; `├──`/`└──` glyphs; status markers incl. the `✓` closed flip across two states; 15-line
  cap with `+N more` tail; width truncation; theme passthrough.
- The `.ts` polling wiring is verified interactively in a pi session: pour/close/resolve a bead and
  observe the widget reflect it within ~5s. Existing `displayWidth`/`truncToWidth` tests keep
  passing.

## Scope

- **In:** the three widget files above.
- **Out (tracked separately):** formula auto-seed `pi-packages-fak` (B); surface step ids in `bd mol
  output` `pi-packages-826` (C, likely upstream — CLI not editable in-tree); skills-text updates
  `pi-packages-i85` (D); explore-agent override `pi-packages-78y` (E); tool-initiated invalidate
  `pi-packages-48r` (future, pursued only if the 5s poll proves insufficient).

## Risks

- Timer availability in the pi extension runtime: assume module-level `setInterval` is usable in the
  extension process; if the runtime forbids it, the plan must pick an equivalent tick source (e.g.
  an api-scheduled callback); verify before committing to the mechanism.
- `mol show --json` graph shape is the widget's only new data dependency; if bd renames/changes the
  `parent-child` edge or the `issues` field set, `parseMoleculeShow` is the single place to adapt.
- Re-running `bd` every 5s is a steady subprocess per tick; acceptable for an interactive TUI
  widget, and the gated `mol show` keeps the common case to one call.
