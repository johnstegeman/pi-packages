// Transient-failure retry helper for pi-superpowers-plus.
//
// Two transient classes are recognized and retried with bounded, injectable
// backoff:
//   - "lock":   the embedded-dolt backend is transiently locked by a concurrent
//               process (surfaces as a non-zero `bd` exit + lock text).
//   - "cancel": a `bd` run was killed at the widget's timeout (SIGTERM -> Go
//               context canceled). `killed` is the structured signal; the text
//               fallback covers the throw path and non-flagged variants.
// Any other error is left untouched (never retried, swallowed, or downgraded).
//
// This is a deliberate copy of pi-beads' helper (src/lock-retry.ts): the two
// packages are independent and must not import from one another. Keep the two
// files' semantics in sync by hand.
const LOCK_RE = /database is locked|locked by another dolt process|embeddeddolt/i;
const CANCEL_RE = /context canceled|context deadline exceeded/i;

/** Per-class retry budgets. `lock` is unchanged from the original helper. */
export const DEFAULT_BUDGETS = {
  lock: { attempts: 5, delaysMs: [50, 150, 400, 900] },
  cancel: { attempts: 2, delaysMs: [250] },
};

export function isDoltLockError(text) {
  return LOCK_RE.test(String(text ?? ""));
}

/**
 * True when a bd run was cancelled/killed (transient), from either the
 * structured `killed` flag or the cancellation text. Lock text is NOT a
 * cancellation (see classifyBdFailure for precedence).
 */
export function isTransientCancellation(text, killed = false) {
  if (killed === true) return true;
  return CANCEL_RE.test(String(text ?? ""));
}

/**
 * Classify a bd failure into a transient class or null (genuine error).
 * Precedence: lock text wins over cancellation — if bd reports a lock and we
 * killed it while waiting, the underlying condition is still a lock.
 */
export function classifyBdFailure(text, { killed = false } = {}) {
  const t = String(text ?? "");
  if (LOCK_RE.test(t)) return "lock";
  if (killed === true || CANCEL_RE.test(t)) return "cancel";
  return null;
}

/**
 * Retry `attempt` while it returns a non-null `class`, using that class's
 * budget. `attempt(n)` returns `{ value, class }`. Per-class counters bound
 * the worst case to sum(budgets[cls].attempts) executions.
 */
export async function withTransientRetry(attempt, { budgets, sleep } = {}) {
  const B = { ...DEFAULT_BUDGETS, ...budgets };
  const doSleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const used = { lock: 0, cancel: 0 };
  let n = 0;
  for (;;) {
    const { value, class: cls } = await attempt(n);
    n += 1;
    if (!cls) return value;
    const b = B[cls];
    if (!b || used[cls] >= b.attempts - 1) return value;
    await doSleep(b.delaysMs[Math.min(used[cls], b.delaysMs.length - 1)]);
    used[cls] += 1;
  }
}

/**
 * Backward-compatible lock-only wrapper. Signature and behavior unchanged from
 * the original helper; existing callers/tests keep working.
 */
export async function withDoltLockRetry(attempt, opts = {}) {
  return withTransientRetry(
    async (n) => {
      const { value, lock } = await attempt(n);
      return { value, class: lock ? "lock" : null };
    },
    {
      budgets: {
        lock: {
          attempts: opts.attempts ?? 5,
          delaysMs: opts.delaysMs ?? [50, 150, 400, 900],
        },
      },
      sleep: opts.sleep,
    },
  );
}
