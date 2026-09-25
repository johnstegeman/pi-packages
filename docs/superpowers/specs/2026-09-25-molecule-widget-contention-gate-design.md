# Molecule widget embedded-Dolt contention — design

- **Date:** 2026-09-25
- **Issue:** `pi-packages-33j5` (task, P2) — "reduce bd query cost / eliminate embedded-Dolt contention for molecule widget"
- **Follow-up from:** `pi-packages-149j` (closed) — targeted resilience fix (adaptive timeout, transient-cancellation retry, warning dedupe)
- **Molecule:** `pi-packages-mol-yvn1` (superpowers-workflow)

## Problem

Two worktrees sharing one beads workspace contend on the **embedded** Dolt backend. Embedded
mode takes an exclusive lock on the data directory for the duration of **every** `bd`
invocation:

```
embeddeddolt: another process holds the exclusive lock on <dir>;
the embedded backend supports only one writer at a time
```

Observed live: working in two worktrees, lock/cancellation warnings surfaced directly in the
pi session log.

The widget's refresh path is what drives the pressure. It is an event-driven loop (10 s
coalesced `beads:changed` window) that, per refresh, runs:

1. `bd list --type molecule --label ws:<key> --json` (~0.8 s), then
2. `bd mol current <root> --json` **per candidate root** (~3.4 s each — the dominant cost;
   `--limit` does not reduce it).

On top of that, 149j's retry budgets **re-take the lock on every attempt**:
`lock ×5` (delays `50/150/400/900` ms) and `cancel ×2` (`[250]`). Under contention, that is
a retry storm aimed at the exact resource the other worktree holds.

### Measured baseline (this repo, `pi-packages-mol-yvn1`)

| command | wall time | payload |
|---|---|---|
| `bd mol current <mol> --json` | **~3.3–3.5 s** | full steps + `step_status` + current/next (what the widget renders) |
| `bd mol progress <mol> --json` | 0.45 s | `current_step_id`, `completed`, `total` — no steps array |
| `bd show <id> --json` | 0.73 s | issue + dependencies |
| `bd list --parent <mol> --json` | 0.83 s | 12 task steps w/ deps (gates excluded) |
| `bd dep tree <mol>` | 0.49 s | dependency tree |
| `bd list --type molecule --json` | ~0.8 s | molecule roots |

### Why not a Dolt server?

A persistent Dolt server structurally removes the exclusive-lock contention
(`bd init --shared-server`, or `--server` / `--proxied-server`). **Verified:** every server
mode requires a **separate `dolt` binary on `PATH`**:

```
$ bd init --shared-server
Error: failed to start shared Dolt server: dolt is not installed (not found in PATH)

$ bd init --proxied-server
Error: resolving dolt binary (source: PATH): dolt binary not found ... install from https://docs.dolthub.com/introduction/installation
```

The bd binary embeds Dolt only as a **library for embedded mode**; sql-server modes shell out
to an external `dolt`. Requiring an install contradicts the goal that others can use this repo
with no extra setup.

## Goals / non-goals

**Goals**

- Remove the observed contention symptom (raw lock/cancel errors in the session log) with the
  **embedded** backend as the repo default — **no new dependency**.
- Stop the widget from re-taking the embedded lock while another process holds it.
- **No regression** on the happy path: uncontended refreshes re-query exactly as today, with
  no added calls or latency.
- `dolt-lock-retry.mjs` and `pi-beads` behavior unchanged (149j intact).
- Document the **opt-in** server mode as a repo-level runbook.

**Non-goals**

- Reducing per-refresh query cost (`bd mol current` stays as-is). Cheaper-query substitution
  and general frame caching were explicitly considered and rejected for this issue.
- Making server mode work without installing `dolt`.
- Any change to `pi-beads` tools (user-invoked one-shots; no refresh loop, so a cooldown is
  meaningless there).
- A manual two-worktree verification harness or a lock-holder helper script.

## Decisions (from brainstorming)

1. **Direction:** code fix as the repo default; server mode documented as opt-in. Contention
   first — a similar per-refresh cost is acceptable.
2. **Scope:** *(1) frame reuse as a contention fallback* + *(3) contention-aware backoff*.
   Per-refresh query cost unchanged.
3. **Freshness:** the cache is **not** a general staleness mechanism — it is a **contention
   cooldown**. The happy path always re-queries; only an actual contention episode keeps the
   last good frame. Cooldown ~5–10 s.
4. **Retry policy on lock:** one quick retry (~150 ms), then cooldown. Adaptive: short first,
   doubling, capped at 10 s.
5. **Logging:** **silent** during an episode — zero lines. Real contention is visible only as
   a frame that stops updating.
6. **Verification:** deterministic tests only (injected `exec` + fake clock).
7. **Package scope:** `pi-superpowers-plus` widget only.
8. **Docs:** repo-level server-mode runbook, part of this deliverable.

## Design

### 1. `molecule-contention-gate.mjs` (new module)

`packages/pi-superpowers-plus/extensions/molecule-contention-gate.mjs`

```js
import { classifyBdFailure } from "./dolt-lock-retry.mjs";

export function createContentionGate({
  exec,
  now   = () => Date.now(),                 // injectable clock (determinism)
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  retryDelayMs      = 150,                  // the single quick retry
  initialCooldownMs = 2500,                 // "short first"
  maxCooldownMs     = 10000,                // cap
  classify = classifyBdFailure,             // reuse the 149j classifier
} = {}) { /* ... */ }
```

Single entry point, replacing the controller's direct `exec` call:

```js
run(args, execOpts) →
    { status: "ok",        result }        // not transient; result passed through
  | { status: "contended", retryAfterMs }  // lock/cancel; skipped, no result
  | { status: "error",     error }         // unclassified throw
```

**Policy (state machine).** All state is deadline-based and evaluated lazily on `run`; the
gate holds **no timers** of its own.

1. **Cooldown check first.** If `now() < cooldownUntil`, return `contended` **without invoking
   `exec`**. Because the gate sits at the single exec boundary, this suppresses the workspace
   probe *and* the per-root `mol current` loop.
2. **Attempt** `exec(args, execOpts)`.
   - Success → **reset** (`currentCooldownMs = 0`, `cooldownUntil = 0`) → `ok`.
   - **Classified transient** (`lock` or `cancel`, via `classifyBdFailure`) →
     `sleep(retryDelayMs)` → **one** retry.
     - retry succeeds → reset → `ok`.
     - still transient → **enter cooldown**:
       `currentCooldownMs = currentCooldownMs ? min(currentCooldownMs * 2, maxCooldownMs) : initialCooldownMs`;
       `cooldownUntil = now() + currentCooldownMs`; return `contended` with `retryAfterMs`.
   - **Genuine** error (`code !== 0` unclassified) → return `ok` with the raw result (the
     controller keeps its existing error-frame + warn path). **No cooldown.**
   - **Throw** → classified the same way as a result: a `killed` flag, or `context canceled` /
     `context deadline exceeded` text, is transient (step 2's retry/cooldown path, using the
     thrown text for classification); an **unclassified throw** → return `error`. **No cooldown.**

**Adaptive ramp:** 2.5 s → 5 s → 10 s (capped). Persistent across refreshes; reset by any
clean result.

**Deliberate non-goals:** no logging, no timers, no UI/frame awareness, no changes to
`dolt-lock-retry.mjs`.

**Edge cases pinned**

- Lazy deadline: nothing fires while idle (the widget is event-driven).
- `contended` carries `retryAfterMs`; the controller need not schedule anything with it.
- A genuine error neither enters nor extends the cooldown. If a cooldown is already active,
  step 1 returns `contended` without attempting `exec` at all, so no genuine error can be
  observed mid-cooldown.

### 2. Controller wiring

`packages/pi-superpowers-plus/extensions/beads-molecule-widget-controller.mjs` (modified).
`beads-molecule-widget.ts` and `beads-molecule-widget.mjs` are **unchanged** — the gate is
constructed inside the controller from the already-injected `exec` + timer hook, so the
extension entry point needs no change.

- New options: `contentionGate` (optional, tests) and `now` (clock, default `Date.now`). When
  no gate is injected the controller builds one:
  `createContentionGate({ exec, now, sleep: (ms) => new Promise((r) => (timers?.setTimeout ?? setTimeout)(r, ms)) })`.
- `safeExec(args, gen)` becomes a thin adapter over `gate.run(args, { cwd, timeout: timeoutMs })`,
  mapping the gate's three outcomes onto the controller's **existing three shapes**:
  - `ok` → return the result → `applySingleResult` / `applyErrorFrame` proceed as today
    (including the genuine `code !== 0` warn path).
  - `contended` → return the **`null` sentinel** → every existing call site
    (`if (!r) return` / `continue`) keeps the prior frame with **no warn**. No new control flow.
  - `error` → existing catch path: `if (gen === refreshGen) warn("… molecule refresh failed:")`,
    return `null`.
- **Removed:** `safeExec`'s inline `withTransientRetry` loop and its cancel-exhausted warning
  line. `timeoutMs` (30 s default, `resolveBdTimeout`) is unchanged and still passed to `exec`.
- **`agent_start` bypass:** `agent_start` → `setCwd` → `refresh` is a **new user turn**, so it
  is allowed **one** probe even during an active cooldown. If that probe fails it stays silent,
  keeps the prior frame, and **re-arms the cooldown at the next ramp step** (not reset) — the
  failed probe re-enters cooldown with the **doubled** duration and a fresh deadline. The
  generation guard is preserved; the bypass is bounded to one probe per turn, so it cannot
  storm. All other refreshes during cooldown remain fully suppressed.

**149j interaction — explicit**

| 149j element | Fate |
|---|---|
| `classifyBdFailure` / `isDoltLockError` in `dolt-lock-retry.mjs` | **unchanged**, now also consumed by the gate |
| `withTransientRetry` / `withDoltLockRetry` | **unchanged** (still exported; pi-beads still uses it) |
| `resolveBdTimeout` + 30 s budget | **unchanged** |
| Widget's lock ×5 / cancel ×2 retry budgets | **superseded** by the gate's single retry → cooldown |
| Widget's "timed out after N attempts" warn line | **removed** (decision 5) |

**Accepted consequence:** a genuine hang (bd killed at the 30 s cap) now looks identical to a
lock from the widget's perspective — silent, cooldown, last frame retained. The only
user-visible signal is a frame that stops updating.

## Tests

**New — `packages/pi-superpowers-plus/test/molecule-contention-gate.test.mjs`** (added to the
package `test` script after `dolt-lock-retry.test.mjs`). Pure fake-clock + scripted `exec`:

| case | assertion |
|---|---|
| clean exec | `ok`, exec **1×**, no cooldown |
| transient then success | `ok`, exec **2×**, one `sleep(150)`, no cooldown |
| transient, both attempts | `contended`, exec **2×**, cooldown = `initialCooldownMs` |
| call while cooling down | `contended` with `retryAfterMs`, exec **not called** |
| adaptive ramp | 2.5 s → 5 s → 10 s, then capped |
| reset on clean | after a clean result the next episode starts at 2.5 s |
| genuine bd error (`code:1`, unclassified) | result passed through, **no cooldown** |
| unclassified throw | `error`, **no cooldown** |
| `lock` text and `cancel`/`killed` | both classified transient |
| no internal timers | only advancing the fake clock clears the cooldown |

**Extend — `test/beads-molecule-widget-controller.test.mjs`:**

- Contended: prior frame kept, **zero** warns, and a subsequent `refresh()` makes **no** `exec`
  call (call count frozen during cooldown).
- After the fake clock passes the cooldown, `refresh()` calls `exec` again and adopts the new
  frame.
- `agent_start` bypass: during cooldown `setCwd` issues exactly **one** probe; on failure zero
  warns and the cooldown re-arms at the **next ramp step**.
- Happy path: an uncontended refresh makes the same number of `exec` calls as today.
- **Revised:** 149j's *"always `context canceled` → exactly one concise warn"* case becomes
  *"always transient → zero warns, exec 2×, cooldown entered"* (decision 5 supersedes it).
- Preserved: transient-then-success (no warn, exec 2×); genuine bd error → existing
  `molecule refresh error:` warn; unclassified throw → `molecule refresh failed:` warn.

`test/dolt-lock-retry.test.mjs` and all `pi-beads` tests are **untouched**.

## Documentation

**New — `docs/beads-dolt-server.md`** (repo-level; `docs/` currently holds only `superpowers/`).
Server-mode only. Contents:

1. **Why embedded contends** — one exclusive lock per `bd` invocation, one writer at a time.
2. **Symptom** — lock/cancel text surfacing in the session log.
3. **When it's worth it** — multi-worktree / multi-agent sessions, not single-worktree use.
4. **Cost** — requires installing the standalone `dolt` binary; `bd init --shared-server` fails
   without it. The repo default stays embedded and dependency-free.
5. **Setup** — install `dolt`, `bd init --shared-server` (server at `~/.beads/shared-server/`),
   verify with `bd dolt status` / `bd dolt show`.
6. **Lifecycle / teardown** — `bd dolt start|stop`, `bd dolt killall`.
7. **Trade-offs** — no lock contention vs. an extra install and a background server to manage.

No `AGENTS.md` / README pointer (decision 8: runbook-only).

## Acceptance criteria mapping

| AC | Satisfied by |
|---|---|
| Simulated lock: ≤1 retry per bd op, then zero bd calls until cooldown expiry; last frame still rendered | gate + controller tests |
| Cooldown adapts (short first, doubles, ~10 s cap), resets after a clean refresh | gate ramp tests |
| No raw lock/cancel text ever reaches the widget log during an episode (**zero** lines) | controller contended tests |
| Happy path unchanged — no new bd calls, no added latency | controller happy-path test |
| `pi-beads` and `dolt-lock-retry.mjs` behavior unchanged; 149j tests pass | untouched helper + unchanged suites |
| Repo-level server-mode runbook added | `docs/beads-dolt-server.md` |

Note: `pi-packages-33j5`'s original "measured reduction in `bd mol current` wall-time" AC does
**not** apply under decision 2 (per-refresh cost stays as-is) and is superseded by the bounded
call-rate + silent-contention criteria above. Its "real-world two-worktree check recorded"
clause is superseded by decision 6 (deterministic tests only).

## Files touched

- `packages/pi-superpowers-plus/extensions/molecule-contention-gate.mjs` (new)
- `packages/pi-superpowers-plus/extensions/beads-molecule-widget-controller.mjs`
- `packages/pi-superpowers-plus/test/molecule-contention-gate.test.mjs` (new)
- `packages/pi-superpowers-plus/test/beads-molecule-widget-controller.test.mjs`
- `packages/pi-superpowers-plus/package.json` (add the new test file to `test`)
- `docs/beads-dolt-server.md` (new)
