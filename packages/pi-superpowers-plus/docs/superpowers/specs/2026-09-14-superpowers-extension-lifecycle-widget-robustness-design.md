# Superpowers Extension Lifecycle & Widget Robustness — Design

Date: 2026-09-14
Molecule: `pi-packages-mol-s3wp` (topic: "Superpowers extension lifecycle & widget robustness")
Issue: `pi-packages-3iej.5`

## Problem

The Superpowers extension bundle has two classes of lifecycle/robustness defects,
plus low-severity correctness and reliability gaps in the molecule widget:

1. **M10 — healthy widget blanked by a transient error.**
   `applyErrorFrame` (`extensions/beads-molecule-widget.mjs`, `:162`) clears the
   frame and the lock on `/no active molecule|not found/i`. The bare `not found`
   also matches `bd: command not found`, so an unreachable `bd` binary blanks a
   widget that was showing real progress. The `.ts` comment (`:45-55`) already
   states the intent: only clean not-found/no-active signals may clear; transient
   failures must not.

2. **M11 — no `session_shutdown` cleanup.**
   `beads-molecule-widget.ts` creates a `createChangeCoalescer(doRefresh, 10000)`
   timer (`:89`) and registers a `beads:changed` listener (`:91`) but never tears
   them down. There is no `cancel()` on the coalescer, no unsubscribe, and no
   reset of session state across the extension reload that pi performs per
   session.

3. **Finished-molecule lock release can never fire on malformed input.**
   `parseMoleculeCurrent` sets `total: obj.steps.length` from the **raw** array
   (`:101`) while `doneCount` counts only **filtered** steps (those with
   `issue.id`). A single raw step lacking `issue` makes `doneCount === total`
   permanently false, so `applyMoleculeFrame` never releases the lock.

4. **Swallowed refresh failures.**
   `doRefresh` (`:36`), `session_start` (`:95`), and `agent_start` (`:105`) use
   empty rejection handlers; `renderMolecule`'s catch (`:79`) is empty. Failures
   are invisible.

5. **Coalescer is un-cancellable and throw-fragile.**
   `createChangeCoalescer` has no `cancel()`, and a throwing `onFire` kills the
   trailing-timer chain, wedging all future refreshes.

6. **Concurrent-refresh race.**
   Overlapping `refreshMolecule` calls (direct `session_start`/`agent_start`
   calls plus an immediate coalesced `beads:changed` fire) capture
   `lockedMoleculeId`, await, then apply — so a slower older response can pin a
   stale molecule over a newer one.

7. **`set_phase` has no session boundary.**
   `extensions/set-phase.ts` emits `{ phase }` with no clearing signal, and
   consumers (`bifrost`, `langfuse`) retain the last phase in memory. A new
   session inherits the previous session's phase.

## Scope

- **A (widget robustness):** M10, M11, and low items 3–6 above.
- **B (`set_phase` session boundary):** clear-signal emission, **confined to
  `set-phase.ts` + a new `set-phase.mjs`**. `bifrost` and `langfuse` are not
  modified — both already reduce an empty phase to "clear".

## Goals

- A transient `bd` failure (including `bd: command not found`) never blanks a
  widget that is showing a real molecule.
- Every session-scoped resource the widget creates (timer, event-bus listener,
  `ui`, molecule state, lock) is released on `session_shutdown` and re-established
  on `session_start`.
- A finished molecule reliably releases its lock, even when the raw `bd` payload
  contains malformed steps.
- Refresh failures are visible (`console.warn`) without being fatal and without
  log noise on the expected not-found clear.
- Overlapping refreshes resolve last-write-wins; a superseded response can never
  be applied.
- `set_phase` emits a clear (`{ phase: "" }`) on both `session_start` and
  `session_shutdown`, so no session inherits a prior session's phase.
- All behaviors named by the issue's acceptance are covered by dependency-free
  Node unit tests.

## Non-Goals

- **Multi-worktree molecule disambiguation.** Two concurrent superpowers cycles
  in separate git worktrees of one repo share a beads DB and the same
  `git user.name`; `bd mol current --json` can return multiple molecules and the
  widget shows only `arr[0]`. This is a distinct feature, filed as
  `pi-packages-3iej.10`. Behavior here is unchanged.
- Changing the `set_phase` tool's registration, name, description, or parameters.
- Any change to `bifrost` or `langfuse`.
- Changing the widget's rendering, phase views, or the coalescer's
  leading-edge/single-trailing-timer semantics.

## Architecture

pi-specific concerns stay in thin `.ts` adapters; every behavior this issue names
lives in dependency-free `.mjs` cores that Node can unit-test directly. This
follows the package's existing twin-file pattern (`phase-commands.mjs/.ts`,
`formula-seed.mjs/.ts`, `beads-molecule-widget.mjs/.ts`).

```
pi  ──►  beads-molecule-widget.ts  ──►  beads-molecule-widget-controller.mjs
                                                 │
                                                 └──►  beads-molecule-widget.mjs
                                                       (pure parse/render + coalescer)

pi  ──►  set-phase.ts  ──►  set-phase.mjs (createPhaseLifecycle)
```

**Changed core — `extensions/beads-molecule-widget.mjs`** (pure / self-contained):
- `applyErrorFrame` narrowed (see Error Handling).
- New exported `isCleanNotFound(r)` predicate — the single source of truth for
  the clear pattern, used by both `applyErrorFrame` and the controller's logging
  decision.
- `createChangeCoalescer` gains `cancel()` and catches a throwing `onFire`.
- `parseMoleculeCurrent` derives `total` from the **filtered** step count.

**New core — `extensions/beads-molecule-widget-controller.mjs`:**
`createMoleculeWidgetController({ exec, setWidget, getTheme, subscribeChanges, warn, windowMs = 10000, timers })`.
Owns all session-scoped mutable state (`ui`, `cwd`, `activeMolecule`,
`lockedMoleculeId`, `refreshGen`, `coalescer`, `unsubscribe`). Knows nothing about
`pi`. Exposes `bindSession`, `unbindSession`, `refresh`, `render`,
`triggerChange`.

**New core — `extensions/set-phase.mjs`:**
`createPhaseLifecycle({ emit, on })` registers the clear-on-`session_start` and
clear-on-`session_shutdown` behavior and returns `{ clear }`. The
`set_phase` tool registration (Typebox schema) stays in the `.ts` adapter.

**Thin adapters — `.ts`:**
- `extensions/beads-molecule-widget.ts`: builds the controller with `pi.exec`, a
  `setWidget` callback, and `subscribeChanges: (fn) => pi.events.on("beads:changed", fn)`;
  wires `pi.on("session_start" | "agent_start" | "session_shutdown")` into
  controller methods. No business logic.
- `extensions/set-phase.ts`: keeps `pi.registerTool` + schema and delegates the
  session-clearing wiring to `createPhaseLifecycle`.

**Dependency direction:** adapters → cores; cores → Node stdlib only. No core
imports `pi`, `typebox`, or `@earendil-works`.

## Controller Behavior

**State:** `ui`, `cwd`, `activeMolecule`, `lockedMoleculeId`, `refreshGen`
(monotonic int), `coalescer`, `unsubscribe`.

**`bindSession({ ui, cwd })`** (called from `session_start`):
1. store `ui`, `cwd`;
2. if not subscribed, `unsubscribe = subscribeChanges(() => coalescer?.trigger())`;
3. if no coalescer, `coalescer = createChangeCoalescer(refresh, windowMs, timers)`;
4. fire an immediate `refresh()`.

**`unbindSession()`** (called from `session_shutdown`):
1. `coalescer?.cancel()`; `coalescer = null`;
2. `unsubscribe?.()`; `unsubscribe = null`;
3. `ui = null`;
4. reset `activeMolecule = null`, `lockedMoleculeId = null`;
5. `refreshGen++` so any in-flight refresh that resolves later is discarded.

**`refresh()`** (generation-guarded, last-write-wins):
1. `const gen = ++refreshGen;`
2. capture `queriedById = hasLockedMolecule(lockedMoleculeId)` and
   `args = nextRefreshArgs(lockedMoleculeId)`;
3. `await exec("bd", args, { cwd, timeout: 5000 })`;
4. if `gen !== refreshGen`, discard (a newer refresh superseded this one) and
   return;
5. on thrown exception: `warn(...)`, keep the frame, return;
6. on non-zero code: apply `applyErrorFrame`; if `!isCleanNotFound(r)`, `warn(...)`;
7. on zero code: apply `applyMoleculeFrame(activeMolecule, lockedMoleculeId, parsed, queriedById)`.

The `gen` check is re-evaluated after every `await` before mutating state.

**`render()`:** call `setWidget(lines | undefined)`; a throw is caught, `warn`ed,
and non-fatal (non-interactive runs must not break).

**`triggerChange()`:** no-op when unbound; otherwise `coalescer.trigger()`.

**`agent_start` adapter path:** update `cwd` (via `bindSession`-style setter or a
dedicated `setCwd`) then `refresh()`. The cwd is read from `ctx.cwd` when present.

**Data flow:** `session_start → bindSession → refresh → render`;
`agent_start → update cwd → refresh`; any `beads:changed` → coalesced `refresh`;
`session_shutdown → cancel timer + unsubscribe + reset`. Coalescer leading-edge
fire is unchanged.

## Error Handling

`applyErrorFrame` clears the frame **and** the lock only when **either**:
- `/no active molecule/i`, or
- `/\bmolecule\b[^\n]*\bnot found\b/i` (requires "molecule" and "not found" on the
  same line, so `molecule` in stdout and `not found` in stderr cannot pair up).

The single `isCleanNotFound(r)` predicate expresses that pattern; the controller
uses it only to decide whether to log.

| Signal | Frame | Lock | Log |
|---|---|---|---|
| clean not-found / no-active (stdout or stderr) | cleared | released | silent |
| `bd: command not found`, connection error, other non-zero | kept | kept | `warn` |
| `exec` throws | kept | kept | `warn` |
| stale response (superseded `gen`) | untouched | untouched | silent |
| `render` throws | kept | kept | `warn` |
| `onFire` throws inside coalescer | untouched | untouched | `warn`, timer reschedules |

`warn` defaults to `console.warn` and is injected so tests can capture it.
Previously-empty catches (items 4 above) become `warn` calls preserving the
existing non-fatal behavior.

**Coalescer changes:** `cancel()` clears the pending timer and the dirty flag,
leaving the next `trigger()` a fresh leading edge. `onFire` is invoked inside a
`try/catch`; a throw is `warn`ed and the trailing-timer chain reschedules
normally, so one bad render cannot wedge future refreshes.

**Lock-release guard:** `parseMoleculeCurrent` computes `total` after the
`issue.id` filter, so malformed raw steps neither inflate `total` nor block the
`doneCount === total` release. `applyMoleculeFrame`'s done→release rule is
otherwise unchanged.

## set_phase Session Boundary

`createPhaseLifecycle({ emit, on })` in `set-phase.mjs`:
- `on("session_start", clear)` and `on("session_shutdown", clear)`;
- `clear()` emits `emit("superpowers:phase", { phase: "" })`.

`set-phase.ts` keeps the existing `pi.registerTool` call (name, description,
Typebox parameters, and empty-text return unchanged) and wires
`createPhaseLifecycle({ emit: (ch, data) => pi.events.emit(ch, data), on: (ev, h) => pi.on(ev, h) })`.

Empty is already the documented "clear" value: bifrost's `applyPhaseUpdate`
returns `null` for empty, and langfuse's handler passes the value to
`setPhase(...)`. No consumer changes are needed. On `session_start` the clear fires
before any skill calls `set_phase`, so a resumed session begins with no phase.

## Testing

All tests are plain Node `.mjs` files run by `npm test`.

**Extend `extensions/beads-molecule-widget.test.mjs`** (pure core):
- M10: `{ code: 1, stdout: "bd: command not found", stderr: "" }` retains frame
  **and** lock; `"molecule bd-mol-g0z not found"`, `"molecule not found"`, and
  `"no active molecule"` (stdout or stderr) still clear; `isCleanNotFound`
  true/false table.
- Lock-release guard: fixture whose raw `steps` include one entry lacking `issue`
  → `total` counts only parsed steps, and a fully-done frame built from it
  releases the lock.
- Coalescer: existing leading-edge/trailing assertions unchanged; add `cancel()`
  (no fire after cancel; next `trigger()` fires immediately) and throwing-`onFire`
  (caught/logged, timer still reschedules).

**New `extensions/beads-molecule-widget-controller.test.mjs`** (fake `exec`,
`subscribeChanges`, `setWidget`, `warn`; injected `timers`/`windowMs` for a
deterministic `cancel`):
- `bindSession` subscribes once, builds the coalescer, and does an immediate
  refresh+render.
- `unbindSession` cancels the timer, unsubscribes, nulls `ui`, resets
  molecule+lock, and discards an in-flight refresh that resolves after unbind.
- Race: two overlapping refreshes resolve out of order → newest applied, stale
  discarded (both zero-code and non-zero-code paths).
- Error matrix: transient non-zero keeps frame+lock and warns; clean not-found
  clears with no warn; `exec` throw keeps frame and warns; `render` throw is
  non-fatal and warns.

**New `extensions/set-phase.test.mjs`** (fake `on`/`emit`):
- `{ phase: "" }` is emitted on `session_start` **and** `session_shutdown`.

**Wiring:** add the two new test files to the `test` script in
`packages/pi-superpowers-plus/package.json`; `biome check .` must stay green.

## Files Changed

| File | Change |
|---|---|
| `extensions/beads-molecule-widget.mjs` | Narrow clear pattern + `isCleanNotFound`; coalescer `cancel()` + throw-safety; `total` from filtered steps |
| `extensions/beads-molecule-widget-controller.mjs` | New: session-scoped controller (bind/unbind/refresh/render/trigger) |
| `extensions/beads-molecule-widget.ts` | Thin adapter wiring pi events to the controller |
| `extensions/set-phase.mjs` | New: `createPhaseLifecycle` clear-on-start/shutdown |
| `extensions/set-phase.ts` | Delegate session clearing; tool registration unchanged |
| `extensions/beads-molecule-widget.test.mjs` | M10, lock-guard, coalescer tests |
| `extensions/beads-molecule-widget-controller.test.mjs` | New controller/lifecycle/race tests |
| `extensions/set-phase.test.mjs` | New clear-emission tests |
| `package.json` | Add new test files to `test` script |

## Acceptance Criteria

- `cd packages/pi-superpowers-plus && npm test` is green (including the new test
  files).
- New tests cover the not-found narrowing — specifically that
  `bd: command not found` retains frame and lock.
- New tests cover `session_shutdown` cleanup: timer cancelled, listener
  unsubscribed, state reset, in-flight refresh discarded.
- `set_phase` emits `{ phase: "" }` on both `session_start` and
  `session_shutdown`.
- `biome check .` passes.

## Known Limitation

Multiple molecules returned by a single `bd mol current --json` response remain
indistinguishable; the widget still uses the first. Per-worktree disambiguation
is tracked by `pi-packages-3iej.10`.
