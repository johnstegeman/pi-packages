# Molecule widget bd timeout / "context canceled" — design

- **Date:** 2026-09-25
- **Issue:** `pi-packages-149j` (bug, P2)
- **Follow-up (out of scope here):** `pi-packages-33j5` — reduce bd query cost / eliminate embedded-Dolt contention
- **Molecule:** `pi-packages-mol-bfa4` (superpowers-workflow)

## Problem

The pi-superpowers-plus molecule widget issues `bd` queries with a hard **5000 ms** `pi.exec`
timeout (`packages/pi-superpowers-plus/extensions/beads-molecule-widget-controller.mjs`).
On larger molecules — and especially under embedded-Dolt lock contention — bd is killed
mid-run (SIGTERM), which cancels its Go context and surfaces as `context canceled`. That
text does **not** match the Dolt-lock retry predicate, so the killed run is never retried and
is logged as a raw warning.

Observed live (repo `pmm-iris`, molecule `pmm-iris-mol-53g`):

```
[pi-superpowers-plus] molecule workspace query error: 1  Error: load custom types: context canceled
[pi-superpowers-plus] molecule workspace root query error: pmm-iris-mol-53g 1 { "error": "loading molecule: failed to get dependencies for pmm-iris-mol-cl4.3: context canceled", ... }
```

Findings from investigation (reproduced):

- `exec("bd", args, { cwd, timeout: 5000 })` is the single cap shared by every widget query
  (`bd list --type molecule …`, `bd mol current <root> --json`, `bd mol current --json`).
- `pi.exec` reports timeouts as a result `{ stdout, stderr, code, killed:true }`; bd's signal
  handler prints `context canceled`.
- Baseline `bd mol current pmm-iris-mol-53g --json` is ~2.7 s — already near the cap.
- bd's embedded-Dolt readiness wait defaults to **10 s**
  (`BEADS_DOLT_READY_TIMEOUT`, a positive integer **in seconds**; verified in
  `internal/doltserver/doltserver.go`), so the widget's 5 s cap fires before bd would give up.
- `isDoltLockError` = `/database is locked|locked by another dolt process|embeddeddolt/i`
  does not match `context canceled`, so the killed run is never retried.
- **pi-beads has the same latent bug class**: its `bd()` runner uses `timeout = 15000` and the
  same narrow lock-only predicate (a deliberate hand-copy of the helper).

Not data corruption: `bd show`, `bd dep tree`, `bd mol current` complete fine outside the cap.

## Goals / non-goals

**Goals**

- The widget's timeout budget must no longer sit below bd's readiness wait.
- A timed-out/killed bd must be treated as **transient** (retried once), not logged as a hard error.
- A transient cancellation must not spam the log; at most **one** warning per real (exhausted) failure.
- No regression to the existing Dolt-lock retry behavior.
- Apply the same transient-cancellation semantics to **pi-beads** (parallel copy — the two
  packages must not import from one another; see AGENTS.md).

**Non-goals (→ `pi-packages-33j5`)**

- Persistent Dolt server, scoping the molecule query, or frame caching.
- Changing pi-beads' 15000 ms budget (it already exceeds bd's readiness wait).

## Decisions (from brainstorming)

1. **Scope:** targeted resilience fix (direction A) now; cost/contention work (direction B) split
   to a follow-up bead. **Both** pi-superpowers-plus and pi-beads receive the classifier.
2. **Timeout:** env-configurable, with the default **derived from bd's readiness wait + margin**.
3. **Classification:** both signals — structured `killed` **and** text (`context canceled` /
   `context deadline exceeded`) — as a distinct classifier, not folded into the lock regex.
4. **Retry budget:** a separate, smaller budget for the cancellation class; lock budget unchanged.
5. **Logging:** happy retry is silent; exhausted cancellation logs exactly one concise, distinct
   line; genuine errors keep their existing warn paths.
6. **Helper shape:** Approach 1 — a class-aware `withTransientRetry`, with `withDoltLockRetry`
   kept as a signature-compatible wrapper.

## Design

### 1. Retry engine and classifiers (both packages)

Applied identically to `packages/pi-superpowers-plus/extensions/dolt-lock-retry.mjs` and
`packages/pi-beads/src/lock-retry.ts` (parallel copies; header updated to note the deliberate
duplication).

```js
const LOCK_RE   = /database is locked|locked by another dolt process|embeddeddolt/i;
const CANCEL_RE = /context canceled|context deadline exceeded/i;

// unchanged, still exported, still narrow
export function isDoltLockError(text) { return LOCK_RE.test(String(text ?? "")); }

// NEW — pure, separately testable
export function isTransientCancellation(text, killed = false) {
  if (killed === true) return true;               // structured signal
  return CANCEL_RE.test(String(text ?? ""));       // text fallback (throw path / variants)
}

// NEW — the single classifier the retry loop consumes
export function classifyBdFailure(text, { killed = false } = {}) {
  const t = String(text ?? "");
  if (LOCK_RE.test(t)) return "lock";              // lock precedence: cheaper retry
  if (killed === true || CANCEL_RE.test(t)) return "cancel";
  return null;                                     // genuine error → never retried
}
```

**Precedence:** lock text wins over cancellation (if bd reports a lock and we killed it while
waiting, the underlying condition is still a lock; the lock budget's fast 50 ms first retry is
the right response). `killed` alone → `cancel`. Genuine errors match nothing → `null`.

```js
const DEFAULT_BUDGETS = {
  lock:   { attempts: 5, delaysMs: [50, 150, 400, 900] },  // unchanged
  cancel: { attempts: 2, delaysMs: [250] },                // one retry, bounded
};

export async function withTransientRetry(attempt, { budgets, sleep = defaultSleep } = {}) {
  const B = { ...DEFAULT_BUDGETS, ...budgets };   // merge so a partial override keeps both classes
  const used = { lock: 0, cancel: 0 };
  for (;;) {
    const { value, class: cls } = await attempt();
    if (!cls) return value;
    const b = B[cls];
    if (used[cls] >= b.attempts - 1) return value;
    await sleep(b.delaysMs[Math.min(used[cls], b.delaysMs.length - 1)]);
    used[cls] += 1;
  }
}
```

- Per-class counters → worst case `5 + 2 = 7` attempts, bounded and documentable.
- Cancel budget = 2 attempts (one retry), 250 ms delay — deliberately not the lock backoff,
  since each cancel retry already costs a full timeout.

Backward-compatible wrapper (signature unchanged — existing tests pass untouched):

```js
export async function withDoltLockRetry(attempt, opts = {}) {
  return withTransientRetry(async () => {
    const { value, lock } = await attempt();
    return { value, class: lock ? "lock" : null };
  }, {
    budgets: { lock: { attempts: opts.attempts ?? 5, delaysMs: opts.delaysMs ?? [50, 150, 400, 900] } },
    sleep: opts.sleep,
  });
}
```

### 2. Timeout budget resolution (widget only)

```js
// beads-molecule-widget-controller.mjs — exported for testing
const DEFAULT_READY_TIMEOUT_MS = 10_000;   // bd's documented default (10s)
const READINESS_MARGIN_MS      = 20_000;   // budget for the query itself, post-readiness
const MIN_TIMEOUT_MS           = 30_000;   // floor

export function resolveBdTimeout(env = process.env) {
  const override = Number.parseInt(env?.PI_BEADS_MOLECULE_TIMEOUT_MS ?? "", 10);
  if (Number.isInteger(override) && override > 0) return override;   // explicit override wins

  const readySecs = Number.parseInt(env?.BEADS_DOLT_READY_TIMEOUT ?? "", 10);
  const readyMs = Number.isInteger(readySecs) && readySecs >= 1 ? readySecs * 1000
                                                                : DEFAULT_READY_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, readyMs + READINESS_MARGIN_MS);
}
```

- Default → **30 000 ms** (`10 s readiness + 20 s margin`, at the 30 s floor). The 5 s cap is gone.
- Scales with bd: `BEADS_DOLT_READY_TIMEOUT=60` → 80 000 ms, so the widget cannot fire before bd
  would give up.
- `PI_BEADS_MOLECULE_TIMEOUT_MS` overrides both; invalid/absent falls through (never throws).
- Worst case with the cancel budget (2 attempts) is ~2× this — acceptable for a background,
  generation-guarded refresh whose stale frames are discarded.

**Wiring:** `createMoleculeWidgetController({ …, timeoutMs = resolveBdTimeout() })` — new option
defaulting to the resolver; the call site becomes `exec("bd", args, { cwd, timeout: timeoutMs })`.
No env read inside `safeExec`, so existing exec fakes keep working. pi-beads keeps 15000 ms.

### 3. Controller wiring and warning semantics

The cancellation-**exhausted** outcome is handled inside `safeExec` and returns the existing
`null` sentinel, so the callers' `if (!r) return/continue` paths keep the prior frame with **zero
duplicate warns** — this is what satisfies "at most one warning per real failure."

```js
async function safeExec(args, gen) {
  const timeoutFn = timers?.setTimeout ?? setTimeout;
  let lastClass = null;
  let attempts = 0;
  try {
    const r = await withTransientRetry(
      async () => {
        attempts += 1;
        let res, killed = false, text;
        try {
          res = await exec("bd", args, { cwd, timeout: timeoutMs });
          killed = res?.killed === true;
          text = `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`;
        } catch (err) {                                   // killed-style throw
          killed = err?.killed === true;
          text = String(err?.stderr ?? err?.message ?? err);
          res = { code: -1, stdout: "", stderr: text };
        }
        const cls = classifyBdFailure(text, { killed });
        lastClass = cls;
        return { value: res, class: cls };
      },
      { sleep: (ms) => new Promise((resolve) => timeoutFn(resolve, ms)) },
    );

    if (lastClass === "cancel") {
      if (gen === refreshGen)
        warn("[pi-superpowers-plus] molecule refresh timed out after", attempts,
             "attempts (timeout", timeoutMs, "ms)");
      return null;
    }
    return r;                                           // lock-exhausted / real error: unchanged
  } catch (err) {
    if (gen === refreshGen)
      warn("[pi-superpowers-plus] molecule refresh failed:", sanitizeLogText(err?.message ?? err));
    return null;
  }
}
```

Behavior matrix:

| Outcome | Retries? | Warning | Frame |
|---|---|---|---|
| Lock, clears on retry | yes (lock budget) | none | updated |
| Cancellation, clears on retry | yes (cancel budget) | none | updated |
| Cancellation, all attempts exhausted | n/a | one concise timeout line (distinct prefix) | prior kept |
| Lock, all attempts exhausted | no more | existing `molecule refresh error:` (unchanged) | prior kept |
| Genuine bd error (no class) | no | existing `molecule refresh error:` (unchanged) | prior kept |
| exec throws, unclassified | no | existing `molecule refresh failed:` (unchanged) | prior kept |

Notes: `attempts`/`lastClass` are closure-tracked, so `withTransientRetry`'s return shape is
unchanged. The concise line carries no raw bd text. The generation guard is preserved on every
warn. The underlying kill is not eliminated here (direction B).

### 4. pi-beads wiring

`src/index.ts` `bd()` switches to `withTransientRetry`, reading `killed` from the thrown
`execFile` error, keeping `timeout = 15000`:

```ts
async function bd(args, cwd = umbrella, timeout = 15000) {
  let lastClass = null, attempts = 0;
  const r = await withTransientRetry(async () => {
    attempts++;
    try {
      const { stdout } = await pexec("bd", args, { cwd: cwd || process.cwd(), maxBuffer: 8*1024*1024, timeout });
      lastClass = null;
      return { value: { ok: true, out: stdout ?? "", err: "" }, class: null };
    } catch (e: any) {
      const err = (e?.stderr || e?.message || "bd failed").toString().trim();
      const cls = classifyBdFailure(err, { killed: e?.killed === true });
      lastClass = cls;
      return { value: { ok: false, out: e?.stdout ?? "", err }, class: cls };
    }
  });
  if (lastClass === "cancel")
    return { ok: false, out: "", err: formatBdTimeout(attempts, timeout) };
  return r;
}
```

No `console.warn` — pi-beads renders `err` into the tool result. `withDoltLockRetry` stays exported
as the compat wrapper. Pure pieces (`isTransientCancellation`, `classifyBdFailure`,
`withTransientRetry`, `formatBdTimeout`) live in `lock-retry.ts` and are unit-tested directly.

`formatBdTimeout(attempts, timeout)` returns a concise, raw-text-free string:
`` `bd timed out after ${attempts} attempts (timeout ${timeout}ms)` ``.

## Tests

**New — `packages/pi-superpowers-plus/test/dolt-lock-retry.test.mjs`** (node-assert style,
mirroring pi-beads):
- `isTransientCancellation`: `killed=true` → true; `"context canceled"` → true;
  `"context deadline exceeded"` → true; lock text → false; unrelated/empty → false.
- `classifyBdFailure`: lock text → `"lock"`; `killed` → `"cancel"`; `"context canceled"` →
  `"cancel"`; genuine → `null`; lock text + killed → `"lock"` (precedence pin).
- `withTransientRetry`: cancel budget = 2 attempts / one `[250]` sleep; lock budget unchanged;
  `null` class returns immediately with no sleep; mixed-class run bounded.
- `withDoltLockRetry` compat: locked→success; always-locked → 5 attempts, sleeps `[50,150,400,900]`;
  non-lock throw propagates (one call); defaults.

**Extend — `test/beads-molecule-widget-controller.test.mjs`:**
- exec returns `{code:1, killed:true, stderr:"context canceled"}` then success → no warn, frame
  updated, exec called exactly twice. *(repro AC)*
- exec always returns that → exactly one concise warn, exec called twice, prior frame kept.
- exec always returns a lock error → existing `molecule refresh error:` behavior preserved.
- `resolveBdTimeout`: override wins; default `30_000`; `BEADS_DOLT_READY_TIMEOUT=60` → `80_000`;
  invalid → `30_000`.
- injected `timeoutMs` reaches exec opts (`opts.timeout`).

**Extend — `packages/pi-beads/test/lock-retry.test.mjs`:** same classifier/engine/formatter cases.

**`packages/pi-superpowers-plus/package.json`:** add the new test file to the `test` script.

## Acceptance criteria mapping

| AC (`pi-packages-149j`) | Satisfied by |
|---|---|
| Repro test retries; no raw warning on happy retry path | controller test (happy-retry case) |
| Budget no longer below bd readiness wait | `resolveBdTimeout` default 30 s ≥ 10 s, derived from bd, documented |
| `context canceled` transient; cannot spam | cancel classifier + single warn site + `null`→callers silent |
| No regression to lock retry | `withDoltLockRetry` wrapper untouched; existing tests unchanged |
| Real-world timing + two-worktree concurrency recorded | manual verification below |

## Real-world verification (record during implementation)

- Time `bd mol current <this-molecule> --json` and compare to the 30 s cap.
- Two worktrees against the shared embedded-Dolt DB: confirm no raw `context canceled`/lock text
  reaches the widget log; record observed behavior.

## Files touched

- `packages/pi-superpowers-plus/extensions/dolt-lock-retry.mjs`
- `packages/pi-superpowers-plus/extensions/beads-molecule-widget-controller.mjs`
- `packages/pi-superpowers-plus/test/dolt-lock-retry.test.mjs` (new)
- `packages/pi-superpowers-plus/test/beads-molecule-widget-controller.test.mjs`
- `packages/pi-superpowers-plus/package.json`
- `packages/pi-beads/src/lock-retry.ts`
- `packages/pi-beads/src/index.ts`
- `packages/pi-beads/test/lock-retry.test.mjs`
