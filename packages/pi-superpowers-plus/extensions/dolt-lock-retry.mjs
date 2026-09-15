// Dolt-lock retry helper for pi-superpowers-plus.
//
// The embedded-dolt backend can be transiently locked by a concurrent process,
// which surfaces as a non-zero `bd` exit carrying lock text in stderr/message.
// This module provides a bounded, injectable retry for exactly that case.
// Detection is text-only and deliberately narrow: any other error is left
// untouched (never retried, swallowed, or downgraded).
//
// This is a deliberate copy of pi-beads' helper (src/lock-retry.ts): the two
// packages are independent and must not import from one another.
const LOCK_RE = /database is locked|locked by another dolt process|embeddeddolt/i;

export function isDoltLockError(text) {
  return LOCK_RE.test(String(text ?? ""));
}

export async function withDoltLockRetry(attempt, opts = {}) {
  const attempts = opts.attempts ?? 5;
  const delays = opts.delaysMs ?? [50, 150, 400, 900];
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await attempt(i);
    if (!last.lock || i === attempts - 1) return last.value;
    await sleep(delays[Math.min(i, delays.length - 1)]);
  }
  return last.value;
}
