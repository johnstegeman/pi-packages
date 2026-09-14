# Beads optional at pi startup — Design

Date: 2026-09-14
Molecule: `pi-packages-mol-1ej1` (topic: "beads optional at pi startup")
Issue: `pi-packages-vle7`

## Problem

Starting pi in a directory where beads is not set up touches the beads database at
startup and can print an error. Two independent accessors run on every session start:

1. **pi-beads** — `packages/pi-beads/src/index.ts` `session_start` calls
   `resolveTopology()`, which spawns `bd where` (in a walk-up loop), `bd repo list`,
   `bd list` sampling, and `bd info`, then `setStatusLine` (`bd✓`/`bd✗`). From `~`
   this is ~5 `bd` processes, all failing silently.
2. **pi-superpowers-plus** — `extensions/beads-molecule-widget.ts` ran
   `bd mol current --json` on `session_start` (`bindSession`) and on every
   `agent_start` (`setCwd`) via the controller.

From `~`, `~/.beads` exists but is only the global `eventsData/` + `formulas/` dir —
no database. `bd mol current --json` exits 1 with `Error: no beads database found`,
and the widget's `isCleanNotFound()` did not treat that as a clean "nothing to show"
signal, producing:

```
[pi-superpowers-plus] molecule refresh error: 1
```

Running pi from `~` reproduces it. A config-only `.beads/` (e.g. the pi-managed
checkout at `~/.pi/agent/git/.../pi-packages`, whose committed `.beads/` has
config/metadata but no database) has the same effect.

## Decisions

- **Startup model:** one cheap startup probe, then bail if it fails — not full lazy
  resolution (chosen over lazy-on-first-tool-call).
- **Probe validates a usable database:** probe with `bd info`. A workspace that
  resolves (`bd where` exits 0) but has no database is treated as "no bead".
- **No visible trace when there is no bead:** no `notify`, no `bd✗` status segment,
  no `bd` work beyond the single probe, no lean prime.

## Design

### Component A — superpowers molecule widget becomes event-driven

`packages/pi-superpowers-plus/extensions/beads-molecule-widget.ts`:

- `session_start` binds `ui`/`cwd` with `initialRefresh: false`, so it issues no `bd`
  query; beads is optional at startup. `agent_start` updates `cwd` and keeps its
  default per-turn refresh (`setCwd` without a suppression flag). That refresh is
  the backstop that surfaces out-of-band mutations (raw `bd`, another session)
  which never emit `beads:changed`.
- The widget refreshes only in response to events: `beads:changed` (already wired)
  and non-empty `superpowers:phase` (every superpowers skill calls `set_phase` at
  its start, so the widget appears exactly when superpowers runs). The empty phase
  emitted at session boundaries is ignored.
- `subscribeChanges` returns a real unsubscribe for both listeners, so
  `session_shutdown` tears them down (previously leaked).

`extensions/beads-molecule-widget-controller.mjs`:

- `bindSession({ initialRefresh = true })` and `setCwd(cwd, { refresh = true })`
  accept suppression flags; defaults preserve existing behavior for other callers
  and tests.

`extensions/beads-molecule-widget.mjs`:

- `isCleanNotFound` also treats `no beads database found` as a clean no-widget
  signal.

### Component B — pi-beads startup usable-DB gate

`packages/pi-beads/src/index.ts`, `session_start` handler, using the existing
non-throwing `bd()` runner:

```ts
activeCwd = ctx?.cwd ?? process.cwd();
const probe = await bd(["info"], activeCwd);
if (!probe.ok) {
  beadsReady = false;
  return;                 // no resolveTopology(), no setStatusLine(), no output
}
await resolveTopology();
if (beadsReady) setStatusLine(ctx);
```

Everything else is unchanged: tools stay registered, the bundled beads skill stays
discoverable, `/beads-init` still runs `bd init` → `resolveTopology()` →
`setStatusLine()` (a user-triggered action, so its result may still report), and the
shared cost-tracking runtime stays populated.

## States

| Situation | `bd` at startup | Status segment | Lean prime |
|---|---|---|---|
| No workspace / no DB (e.g. `~`, config-only checkout) | one `bd info`, fails | none | skipped |
| Beads workspace | `bd info` + normal `resolveTopology` | `bd✓` | once per segment |
| Umbrella that partially resolves (`beadsReady=false` after resolve) | probe + resolve | none (guarded on `beadsReady`) | skipped |
| `/beads-init` | `bd init` + `resolveTopology` | reported per command | next turn |

## Error handling

- The probe captures stdout/stderr inside `bd()` and never prints. Probe failure is a
  silent early return.
- The existing `try/catch` around `session_start` remains for unexpected throws.
- `setStatusLine` is called only when `beadsReady`, so startup can never paint `bd✗`.

## Testing

- **pi-superpowers-plus**: add `no beads database found` to the `isCleanNotFound`
  table; add a controller test that `bindSession({ initialRefresh:false })` and
  `setCwd(cwd, { refresh:false })` issue no `bd` call, and that the first change
  event paints via the latest `cwd`. (Applied.) The adapter keeps `agent_start`'s
  per-turn `setCwd(cwd)` refresh; only `session_start` suppresses the startup query.
- **pi-beads**: add a fake-bd `none` mode where `info` exits 1; assert session start
  emits nothing, sets no status segment (spy on the fake `ctx.ui.setStatus`), and runs
  only the single `info` invocation — no `where`/`repo`/`list`. Existing success-mode
  tests are unaffected because the harness runs `openSession` before each `resetLog()`.
- **Manual QA**: `cd ~ && pi` → no `molecule refresh error`, no `bd✗`, no multi-second
  delay; a beads repo still shows `bd✓` and primes.
- `cd packages/pi-superpowers-plus && npm test` and `cd packages/pi-beads && npm test`
  green.

## Acceptance criteria

- Starting pi where beads is not set up spawns no more than one `bd` process and
  produces no output and no status segment.
- Starting pi in a beads repo behaves as before (`bd✓`, topology resolved, prime).
- The molecule widget appears/updates during a superpowers run, is resynced on each
  `agent_start` turn, and never queries `bd` on `session_start`.
- Both package test suites pass.

## Out of scope

- Making pi-beads resolve lazily on first `beads_*` tool call.
- Filesystem/worktree-based workspace detection (the usable-DB probe supersedes it).
- Changing tool registration, the beads skill, or the cost-tracking runtime surface.

## Files changed

| File | Change |
|---|---|
| `packages/pi-beads/src/index.ts` | Usable-DB probe gate in `session_start` |
| `packages/pi-beads/test/pi-beads.test.mjs` | `none` mode + no-trace/one-invocation assertions |
| `packages/pi-superpowers-plus/extensions/beads-molecule-widget.ts` | Event-driven, no startup query, real unsubscribe |
| `packages/pi-superpowers-plus/extensions/beads-molecule-widget-controller.mjs` | `initialRefresh`/`refresh` suppression flags |
| `packages/pi-superpowers-plus/extensions/beads-molecule-widget.mjs` | `no beads database found` is clean |
| `packages/pi-superpowers-plus/test/beads-molecule-widget*.test.mjs` | Regression tests |
