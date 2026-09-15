# pi-beads startup probe root — Design

Date: 2026-09-15
Molecule: `pi-packages-mol-s47n` (topic: "pi-beads: startup probe vs umbrella readiness (vk8g)")
Issue: `pi-packages-vk8g`
Related: [`2026-09-14-beads-optional-startup-design.md`](./2026-09-14-beads-optional-startup-design.md) (vle7 — the one-probe property to preserve), [`2026-09-14-pi-beads-topology-retry-design.md`](./2026-09-14-pi-beads-topology-retry-design.md) (mvoy — lazy re-resolution)

## Problem

`session_start` gates startup on `bd info` at `activeCwd`, but `resolveTopology()`
decides readiness from `bd info` at `umbrella` — which is `PI_BEADS_ROOT` when set.
When the configured root is not discoverable from `activeCwd` (bd itself does not
read `PI_BEADS_ROOT`), the probe fails and startup returns silently even though the
workspace is valid:

- no `bd✓` status segment;
- no lean prime for the first segment;
- (recoverable) the first `beads_*` tool call lazily re-resolves via
  `ensureTopology()` and a later turn primes.

`bd`'s own upward discovery means an *ancestor* umbrella already satisfies the
`activeCwd` probe, so the defect is specific to a configured root unrelated to cwd.
It also means two different directories could be treated as "the root" by the two
call sites — the class of disagreement this change removes.

## Decisions

- **Move the usable-DB judgment to where readiness is decided.** Probe the candidate
  root (`PI_BEADS_ROOT` when set, else the session cwd) inside `resolveTopology()`,
  and drop the separate `session_start` probe. One source of truth for
  `PI_BEADS_ROOT`; nothing to drift.
- **Preserve vle7.** When beads is absent, startup still costs exactly one `bd` call
  and is silent (no topology walk, no status, no output).
- **Decline the deferred single-flight wrapper** for `resolveTopology()` — see
  [Declined](#declined).

## Design

### `session_start` (`packages/pi-beads/src/index.ts`)

Remove the `activeCwd` probe and its early return. The handler becomes:

```ts
pi.on("session_start", async (_event: any, ctx: any) => {
  try {
    activeCwd = ctx?.cwd ?? process.cwd();
    await resolveTopology();
    if (beadsReady) setStatusLine(ctx);
  } catch (e: any) {
    ctx?.ui?.notify?.(
      `pi-beads-lean init failed: ${e?.message ?? e}`,
      "error",
    );
  }
});
```

Everything else is unchanged: tools stay registered, the bundled beads skill stays
discoverable, and `/beads-init` still runs `bd init` → `resolveTopology()` →
`setStatusLine()`.

### `resolveTopology()`

`resolveTopology()` already computes `root` from `PI_BEADS_ROOT` at the top. Insert
the probe immediately after that computation, before the umbrella-discovery walk:

```ts
async function resolveTopology(): Promise<void> {
  topologyReady = false;
  prefixToDir.clear();
  basenameToDir.clear();
  defaultRepoDir = null;

  // 1) find the umbrella root
  let root = (process.env.PI_BEADS_ROOT || "").trim();
  if (root)
    root = path.resolve(root.replace(/^~(?=$|\/)/, process.env.HOME || "~"));

  // Usable-DB gate at the same root readiness is decided from: PI_BEADS_ROOT when
  // set (the umbrella may be unrelated to cwd), else the session cwd. One cheap
  // probe; when beads is absent, bail before any topology walk (vle7).
  if (!(await bd(["info"], root || activeCwd)).ok) {
    beadsReady = false;
    return;
  }

  if (!root) {
    // ...existing walk-up to a hydrated umbrella, unchanged...
  }

  if (root) {
    // ...existing umbrella branch, unchanged...
  } else {
    // ...existing single-repo branch, unchanged...
  }

  beadsReady = (await bd(["info"], umbrella)).ok;
  topologyReady = beadsReady;
  needSync = true;
  needPrime = true;
}
```

This is the entire functional diff: the split probe becomes one probe, positioned
where readiness is decided. `PI_BEADS_ROOT` is expanded in exactly one place, so the
probe target and the resolved `umbrella` cannot disagree.

## Invariants & error handling

- **Clear before probe.** The routing maps are cleared *before* the probe/early
  return, so a failed pass can never leave a stale prefix table asserting readiness.
  `beadsReady = false` on bail; `topologyReady` stays `false`; `ensureTopology()`'s
  failure throttle records the failure and retries on a later turn/tool call
  (mvoy behavior, unchanged).
- **vle7 preserved.** With `PI_BEADS_ROOT` unset, the candidate is `activeCwd`; absent
  beads costs exactly one `bd info`, then bails with no walk. The existing
  `no workspace: startup probes info once` test holds unchanged.
- **Healthy path unchanged.** The candidate probe replaces the old `session_start`
  probe 1:1; the subsequent `bd info` at `umbrella` is the pre-existing readiness
  call, so the healthy call count is unchanged.
- **Retries benefit.** Because `ensureTopology()` re-runs `resolveTopology()`, a
  `PI_BEADS_ROOT`-set session whose startup probe was transiently failed recovers on
  the next turn or routed call.
- **Explicit edge.** If `PI_BEADS_ROOT` is set to a root with no database while cwd
  does have one, startup is silent. This is intended: readiness follows the
  configured root, exactly as `resolveTopology()` already treats it.

## Testing

`packages/pi-beads/test/pi-beads.test.mjs` (fixture `bd` stub in the same file):

- Add a fixture mode (e.g. `env-root`) where `info` and `where` succeed **only when
  `$CWD` is under `$PI_BEADS_ROOT`**, and `repo list` / `list` answer for that root
  so `resolveTopology()` can complete.
- Regression test: set `PI_BEADS_ROOT` to a directory that is **not** an ancestor of
  `cwd`; run `session_start`; assert
  - `s.status` is non-empty (status set, not silently skipped),
  - the tool set is still registered,
  - a `bd info` was invoked with the configured root as its cwd.
- Keep the existing vle7 test (`no workspace: startup probes info once, sets no
  status, emits nothing`) untouched as the counter-assertion.
- `cd packages/pi-beads && npm test` green.

## Acceptance Criteria

- A transient `resolveTopology()` failure no longer matters here; the startup
  usable-DB judgment is made at the same root readiness is decided from.
- `PI_BEADS_ROOT` pointing at a root that does not contain cwd: startup resolves
  (status set) instead of silently skipping.
- Absent beads still costs exactly one `bd` call at startup and stays silent
  (vle7 not regressed).
- A regression test covers the `PI_BEADS_ROOT`-elsewhere case.
- `cd packages/pi-beads && npm test` passes.

## Declined

**Single-flight wrapper for `resolveTopology()`** (the deferred minor from the vk8g
final review). Declined with reason: the only caller that can interleave with a
tool call is `/beads-init`, which is a user-triggered, awaited action; the race is
low-probability and its sole symptom is a transient `unknown repo for id` error —
the same failure class `mvoy` already made recoverable via lazy re-resolution.
Wrapping every caller would force a throttle-vs-force semantic decision
(`ensureTopology()` would make a rapid personal `/beads-init` silently no-op) for no
demonstrated benefit. Revisit if a concrete interleaving failure is observed.

## Migration / rollout

No behavior change for existing sessions: unset `PI_BEADS_ROOT` takes the same code
path as today (candidate = cwd). Sessions that set `PI_BEADS_ROOT` to a valid root
unrelated to cwd gain their `bd✓` status and first-segment prime immediately instead
of after the first routed call.
