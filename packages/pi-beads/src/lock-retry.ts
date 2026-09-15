// Dolt-lock retry helper for pi-beads.
//
// The embedded-dolt backend can be transiently locked by a concurrent process,
// which surfaces as a non-zero `bd` exit carrying lock text in stderr/message.
// This module provides a bounded, injectable retry for exactly that case.
// Detection is text-only and deliberately narrow: any other error is left
// untouched (never retried, swallowed, or downgraded).
const LOCK_RE = /database is locked|locked by another dolt process|embeddeddolt/i;

export function isDoltLockError(text: string): boolean {
  return LOCK_RE.test(String(text ?? ""));
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

export async function withDoltLockRetry<T>(
  attempt: (n: number) => Promise<Attempt<T>>,
  opts: LockRetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const delays = opts.delaysMs ?? [50, 150, 400, 900];
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last: Attempt<T> | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await attempt(i);
    if (!last.lock || i === attempts - 1) return last.value;
    await sleep(delays[Math.min(i, delays.length - 1)]);
  }
  return (last as Attempt<T>).value;
}
