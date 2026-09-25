// Transient-failure retry helper for pi-beads.
//
// Two transient classes are recognized and retried with bounded, injectable
// backoff:
//   - "lock":   the embedded-dolt backend is transiently locked by a concurrent
//               process (surfaces as a non-zero `bd` exit + lock text).
//   - "cancel": a `bd` run was killed at its timeout (SIGTERM -> Go context
//               canceled). `killed` is the structured signal on the thrown
//               execFile error; the text fallback covers non-flagged variants.
// Any other error is left untouched (never retried, swallowed, or downgraded).
//
// This is a deliberate copy of pi-superpowers-plus' helper
// (extensions/dolt-lock-retry.mjs): the two packages are independent and must
// not import from one another. Keep the two files' semantics in sync by hand.
const LOCK_RE = /database is locked|locked by another dolt process|embeddeddolt/i;
const CANCEL_RE = /context canceled|context deadline exceeded/i;

export type RetryClass = "lock" | "cancel" | null;

export interface RetryBudget {
  attempts: number;
  delaysMs: number[];
}

/** Per-class retry budgets. `lock` is unchanged from the original helper. */
export const DEFAULT_BUDGETS: Record<"lock" | "cancel", RetryBudget> = {
  lock: { attempts: 5, delaysMs: [50, 150, 400, 900] },
  cancel: { attempts: 2, delaysMs: [250] },
};

export function isDoltLockError(text: unknown): boolean {
  return LOCK_RE.test(String(text ?? ""));
}

/**
 * True when a bd run was cancelled/killed (transient), from either the
 * structured `killed` flag or the cancellation text. Lock text is NOT a
 * cancellation (see classifyBdFailure for precedence).
 */
export function isTransientCancellation(text: unknown, killed = false): boolean {
  if (killed === true) return true;
  return CANCEL_RE.test(String(text ?? ""));
}

/**
 * Classify a bd failure into a transient class or null (genuine error).
 * Precedence: lock text wins over cancellation — if bd reports a lock and we
 * killed it while waiting, the underlying condition is still a lock.
 */
export function classifyBdFailure(
  text: unknown,
  { killed = false }: { killed?: boolean } = {},
): RetryClass {
  const t = String(text ?? "");
  if (LOCK_RE.test(t)) return "lock";
  if (killed === true || CANCEL_RE.test(t)) return "cancel";
  return null;
}

/** Concise, raw-text-free timeout message for the tool result. */
export function formatBdTimeout(attempts: number, timeoutMs: number): string {
  return `bd timed out after ${attempts} attempts (timeout ${timeoutMs}ms)`;
}

export interface TransientAttempt<T> {
  value: T;
  class: RetryClass;
}

export interface TransientRetryOptions {
  budgets?: Partial<Record<"lock" | "cancel", RetryBudget>>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retry `attempt` while it returns a non-null `class`, using that class's
 * budget. `attempt(n)` returns `{ value, class }`. Per-class counters bound
 * the worst case to sum(budgets[cls].attempts) executions.
 */
export async function withTransientRetry<T>(
  attempt: (n: number) => Promise<TransientAttempt<T>>,
  opts: TransientRetryOptions = {},
): Promise<T> {
  const B = { ...DEFAULT_BUDGETS, ...opts.budgets };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const used = { lock: 0, cancel: 0 };
  let n = 0;
  for (;;) {
    const { value, class: cls } = await attempt(n);
    n += 1;
    if (!cls) return value;
    const b = B[cls];
    if (!b || used[cls] >= b.attempts - 1) return value;
    await sleep(b.delaysMs[Math.min(used[cls], b.delaysMs.length - 1)]);
    used[cls] += 1;
  }
}

export interface LockRetryOptions {
  attempts?: number;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export interface Attempt<T> {
  value: T;
  lock: boolean;
}

/**
 * Backward-compatible lock-only wrapper. Signature and behavior unchanged from
 * the original helper; existing callers/tests keep working.
 */
export async function withDoltLockRetry<T>(
  attempt: (n: number) => Promise<Attempt<T>>,
  opts: LockRetryOptions = {},
): Promise<T> {
  return withTransientRetry(
    async (n: number) => {
      const { value, lock } = await attempt(n);
      return { value, class: lock ? ("lock" as const) : null };
    },
    {
      budgets: {
        lock: { attempts: opts.attempts ?? 5, delaysMs: opts.delaysMs ?? [50, 150, 400, 900] },
      },
      sleep: opts.sleep,
    },
  );
}
