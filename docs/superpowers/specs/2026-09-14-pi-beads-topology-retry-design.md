# pi-beads topology resolution retry — Design

Date: 2026-09-14
Molecule: `pi-packages-mol-e8x8` (topic: "pi-beads topology resolution retry")
Issue: `pi-packages-mvoy`

## Problem

`resolveTopology()` (`packages/pi-beads/src/index.ts:223`) is the only writer of the
module's routing state: `prefixToDir`, `basenameToDir`, `defaultRepoDir`, `umbrella`,
`isUmbrella`, and `beadsReady`. It is run once from `session_start` (behind the usable-DB
probe added in `pi-packages-vle7`).

If that one pass fails — a transient `bd`/DB failure such as the pi-managed git package's
`git pull` + `npm install` window, a locked or mid-migration Dolt database — the session is
poisoned for its entire lifetime:

- `beadsReady` stays `false` and `prefixToDir` stays empty.
- Every routed `beads_*` write then fails with
  `unknown repo for id '<id>' (known prefixes: )`
  (`beads_update`, `beads_close`, `beads_dep`, `beads_undep`, `beads_gate_resolve`,
  `beads_mol_pour`, `beads_create_list`, ...).
- There is no retry of any kind for the life of the session.

Observed live: a pi session started at 15:46 EDT (inside the 15:44–15:49 package-update
window) had `beads_update({ id: "pi-packages-mol-ixd4.3" })` fail all session with
`unknown repo ... (known prefixes: )`. `beads_show` (a read) and `beads_create` with an
explicit `repo` kept working, so the breakage was silent unless a routed write was tried.
Restarting pi fixed it immediately.

Knock-on effect: SDD's controller, unable to use `beads_*` for claim/close/dep, fell back to
raw `bd`; raw `bd` emits no `beads:changed`, so the event-driven molecule widget went stale.

## Decisions

- **Trigger:** retry is gated on the topology not being known-good (`!topologyReady`). A
  miss/route in a healthy topology does not re-resolve, so a genuine "unknown repo" still
  fails fast with no `bd` walk.
- **Shape:** a memoized, single-flight `ensureTopology()` awaited by every `beads_*` tool,
  not async routing wrappers.
- **Readiness:** `topologyReady` means "a resolve pass completed against a reachable DB"
  (`beadsReady`), not "the routing maps are non-empty".
- **Failure throttle:** after a failed pass, retry at most once per 5 s so a beads-less
  session does not spawn a resolve walk per tool call.

## Design

### Resolver state

Inside `piBeadsLean`:

```ts
let topologyReady = false;        // resolveTopology completed against a reachable DB
let topologyInFlight: Promise<void> | null = null;
let lastResolveFailedAt = 0;      // Date.now() of the last failed pass
const RESOLVE_RETRY_MS = 5000;    // failure throttle
```

`resolveTopology()` is unchanged except for two lines:

- `topologyReady = false;` at the top, so a partial/failed pass never reads as ready.
- `topologyReady = beadsReady;` immediately after
  `beadsReady = (await bd(["info"], umbrella)).ok;`.

### Single-flight gate

```ts
async function ensureTopology(): Promise<void> {
  if (topologyReady) return;                       // cache hit (no-op)
  if (topologyInFlight) return topologyInFlight;   // share one pass
  if (Date.now() - lastResolveFailedAt < RESOLVE_RETRY_MS) return; // throttle
  topologyInFlight = resolveTopology()
    .catch(() => {})                               // bd() never throws; guard only
    .finally(() => {
      topologyInFlight = null;
      if (!beadsReady) lastResolveFailedAt = Date.now();
    });
  return topologyInFlight;
}
```

### Call sites

`await ensureTopology();` is the first statement of every `beads_*` tool's `execute` (all
of them, not only the routed ones): each tool reads `umbrella`/routing state, the call is a
zero-cost no-op when ready, and uniformity prevents a missed routed path.
`dirForPrefix` / `resolveRepoTarget` / `resolveCreateTarget` are unchanged.
`/beads-init` and `/beads-mode` are commands and keep their existing direct
`resolveTopology()` calls.

## States

| Situation | Behavior |
|---|---|
| Startup probe fails (no DB / transient) | `session_start` returns silently; `topologyReady` stays false |
| First routed tool call after a failure | `ensureTopology()` re-resolves (throttled) then the tool proceeds |
| Healthy topology | `ensureTopology()` is a no-op; invocation logs unchanged |
| Genuine unknown repo (healthy topology) | no re-resolve; fast `unknown repo ...` error |
| Persistent no-beads | at most one resolve attempt per 5 s; the tool then fails normally |
| `/beads-init` | direct `resolveTopology()` updates the flags |

## Error handling

- `resolveTopology()` and `bd()` never throw (they return `{ ok, out, err }`); the
  `ensureTopology` `.catch` is a guard only.
- A failed resolve leaves `topologyReady = false` and stamps `lastResolveFailedAt`, so the
  next attempt is throttled rather than immediate.
- Tool-level error messages are unchanged; retry never turns a real failure into a silent
  success.

## Testing

All tests are plain Node `.mjs` in `packages/pi-beads/test/pi-beads.test.mjs`, run by
`npm test`.

- New fixture mode `transient`: `bd info` fails the first time (a marker file, env
  `FAKE_BD_TRANSIENT_MARKER`) and succeeds thereafter; `where`/`repo`/`list` behave as in
  `single`.
- **Test A (recovery):** open in `transient`; assert startup is silent (no status segment,
  no emit); then `beads_create` succeeds and the log shows a `where` (re-resolution) before
  the `create`.
- **Test B (throttle):** open in `none` (`info` always fails); two immediate routed calls
  invoke the resolve walk (`where`) exactly once.
- Existing success-mode tests stay green: every `openSession` path sets
  `topologyReady = true`, so `ensureTopology` is a no-op and invocation assertions are
  unchanged.

## Acceptance criteria

- A transient `resolveTopology()` failure no longer disables routed writes for the session:
  the next `beads_*` call re-resolves and succeeds.
- A healthy topology pays no extra `bd` call.
- A persistently absent DB costs at most one resolve attempt per 5 s.
- `cd packages/pi-beads && npm test` passes, including the new recovery and throttle tests.

## Out of scope

- Detecting mid-session topology drift (newly hydrated repo, moved workspace) when the
  topology is known-good.
- Async routing wrappers (`routeFor`, `resolveCreateTargetAsync`).
- Changing `resolveTopology`'s algorithm or the routing-map contents.
- The event-driven molecule widget.

## Files changed

| File | Change |
|---|---|
| `packages/pi-beads/src/index.ts` | `topologyReady`/single-flight/throttled `ensureTopology()`; two lines in `resolveTopology`; `await ensureTopology()` in every `beads_*` tool |
| `packages/pi-beads/test/pi-beads.test.mjs` | `transient` fixture mode; recovery + throttle tests |
