# pi-beads widget: DB-derived, turn-refreshed "done" rows — Design

**Date:** 2026-08-27
**Status:** Approved (design sections reviewed 2026-08-27)
**Branch:** `johnstegeman/beads-debug`

## Goal

Change the pi-beads in-progress widget from an in-memory, one-agent-turn
"recently closed" list to a **DB-derived done list** — the closed wisps of the
current phase — that **persists on screen** for as long as those wisps stay in
the database. When superpowers (pi-superpowers-plus) ends the phase it runs
`bd mol wisp gc --closed --force` (a bare `bd` call), which purges the closed
wisps, and the widget's done section empties on the next turn boundary.

## Context

- Merged in PR #14: the widget draws a mini board of three groups — active (◐),
  to-do (○, open/unblocked incl. wisps), and done (✓) — with an `N done`
  counter in the header.
- Today `closedShown` is an in-memory map populated **only** by `beads_close`
  and cleared on every `agent_start` (done rows live exactly one agent turn);
  the `N done` header is a session-long counter (`closedCount`).
- Motivation (from brainstorming 2026-08-27): during a superpowers brainstorm,
  checklist items are wisps closed one at a time; the ✓ rows should accumulate
  and stay visible until the phase ends, then clear. Superpowers performs the
  cleanup itself with bare `bd mol wisp gc --closed --force` (no pi event, no
  `beads_*` call), so the widget must observe the **DB**, not an in-memory
  accumulator.
- Read primitive (verified on bd 1.2.2): `bd mol wisp list --all --json`
  returns `{ "count": N, "schema_version": 1, "wisps": [{ id, title, status,
  priority, type, created_at, updated_at }] }`. `--all` is required to include
  closed wisps; `bd mol wisp gc --closed --force` deletes closed wisps.

## Design

### 1. State (`src/index.ts`)

- Remove the `closedShown` map and the `closedCount` accumulator.
- Add `done: Map<string, WipEntry>` keyed by wisp id → `{ repo, title,
  priority }`, repopulated from the DB on every refresh.
- Header counter = `done.size` (so it empties after the phase-end purge too).

### 2. Reading — new `refreshDone()`

Runs `bd mol wisp list --all --json`, keeps `status === "closed"`, maps each
wisp to an entry (repo = basename of the dir it was read from). The wire shapes
are parsed defensively by a pure helper (see §5).

Refresh points — the same cadence as the existing widget reads, plus turn end:

- `session_start` — alongside `loadWip()` / `refreshReady()` in the existing
  fire-and-forget `Promise.allSettled(...)`.
- `afterWrite` — after every `beads_*` write, so a `beads_close` shows its ✓
  promptly (same pattern as `refreshReady` today).
- `agent_start` — the current one-turn `closedShown.clear()` handler becomes
  `void refreshDone().then(renderWip, noop)` (fire-and-forget, never blocks the
  turn). This is what observes bare-`bd` closes mid-phase and the phase-end
  purge.
- Umbrella mode: union the read across the umbrella and each additional repo
  (wisps are per-repo-local, not in the aggregate view); single-repo is one
  read.

### 3. `beads_close`

Drop the synchronous `closedShown.set(...)` + `metaOf` title-enrichment block
and the `closedCount++`. `afterWrite → refreshDone → renderWip` picks up the
just-closed wisp (title included) and repaints. Strictly less code, one source
of truth.

### 4. Rendering (`src/widget-lines.mjs`)

- `MAX_ROWS` 6 → 10.
- Ordering stays `active → to-do → done`.
- Eviction flips so done and active win and to-do is evicted first:
  `keptTodo = todo.slice(0, MAX_ROWS − active.length − done.length)`; the
  `+N more` tail counts evicted to-do.
- The "done" header segment already hides at 0, so an empty phase leaves a clean
  header.

### 5. Parser helper

Pure exported `parseClosedWisps(json, repo)` in `widget-lines.mjs` handling the
wrapper shape (`{ count, wisps: [] }`) and the `status === "closed"` filter, so
the wire format is unit-testable.

### 6. Error handling

Missing/old `bd`, or a `mol wisp` subcommand that doesn't exist on the
installed version → `refreshDone` returns quietly; the done list stays as-is or
empty. Never fatal, never blocks the turn — identical posture to `refreshReady`.

## Behavior changes (intentional)

- Done rows **persist** instead of flashing for one turn.
- `N done` is the **current closed-wisp count**, not a session total.
- Non-wisp tasks closed mid-phase no longer appear as ✓ rows (the done section
  is wisp-scoped to match the `bd mol wisp gc` purge semantics).

## Testing (`src/widget-lines.test.mjs`)

- Update the cap/eviction tests for `MAX_ROWS` 10 and the new rule (done
  survives; to-do evicted).
- Add a "done accumulates while to-do is pushed out" case.
- Cover `parseClosedWisps` (wrapper shape, status filter, empty input).
- The existing width + ANSI/plain invariants loop is preserved.

## Docs

- README widget legend: "a closed row survives one agent turn" → "closed wisps
  persist as ✓ rows until purged (superpowers ends the phase with
  `bd mol wisp gc --closed --force`); `N done` = current closed wisps, not a
  session total".
- Update the `SPEC-ui.md` addendum to match the new behavior.

## Verification

1. `cd packages/pi-beads && npm test` — green.
2. `node --experimental-strip-types --check packages/pi-beads/src/index.ts` — OK.
3. Manual smoke: run a real brainstorming flow; close checklist wisps one at a
   time → ✓ rows accumulate across turns; run
   `bd mol wisp gc --closed --force` against the DB → on the next turn the done
   section (and `N done`) empty.
