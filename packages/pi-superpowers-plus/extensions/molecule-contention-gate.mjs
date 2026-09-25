// Transient-contention gate for the molecule widget's bd queries.
//
// Embedded Dolt takes an exclusive lock on the data directory for the duration
// of every bd invocation, so a refresh that keeps retrying while another
// worktree holds the lock makes contention worse. This gate sits at the single
// exec boundary and, once one quick retry still sees a transient failure, stops
// issuing bd calls until a lazily-evaluated cooldown deadline passes.
//
// No logging, no timers: callers keep rendering their last good frame while a
// cooldown is active ("contended").
import { classifyBdFailure } from "./dolt-lock-retry.mjs";

export const DEFAULT_GATE = {
  retryDelayMs: 150,
  initialCooldownMs: 2500,
  maxCooldownMs: 10000,
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns {{ run(args: string[], execOpts?: object, opts?: { force?: boolean }): Promise<object>, isCoolingDown(): boolean }}
 */
export function createContentionGate({
  exec,
  now = () => Date.now(),
  sleep = defaultSleep,
  retryDelayMs = DEFAULT_GATE.retryDelayMs,
  initialCooldownMs = DEFAULT_GATE.initialCooldownMs,
  maxCooldownMs = DEFAULT_GATE.maxCooldownMs,
  classify = classifyBdFailure,
} = {}) {
  let cooldownUntil = 0; // epoch ms; 0 means "not cooling down"
  let currentCooldownMs = 0; // 0 means "next episode starts at initialCooldownMs"

  function reset() {
    cooldownUntil = 0;
    currentCooldownMs = 0;
  }

  function enterCooldown() {
    currentCooldownMs =
      currentCooldownMs > 0 ? Math.min(currentCooldownMs * 2, maxCooldownMs) : initialCooldownMs;
    cooldownUntil = now() + currentCooldownMs;
    return currentCooldownMs;
  }

  // One exec attempt, reduced to a transient/genuine verdict. A successful run
  // is never classified: its output may mention locks without being a failure.
  async function attempt(args, execOpts) {
    let res;
    let killed = false;
    let text;
    try {
      res = await exec("bd", args, execOpts);
      killed = res?.killed === true;
      text = `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`;
    } catch (err) {
      const cls = classify(String(err?.stderr || err?.message || err), { killed: err?.killed === true });
      return cls ? { verdict: "transient" } : { verdict: "error", error: err };
    }
    const cls = res?.code === 0 && killed !== true ? null : classify(text, { killed });
    return cls ? { verdict: "transient" } : { verdict: "ok", result: res };
  }

  async function run(args, execOpts = {}, { force = false } = {}) {
    // Read the clock once so the suppression decision and the reported
    // retryAfterMs are derived from the same instant.
    const nowMs = now();
    const cooling = nowMs < cooldownUntil;
    if (cooling && !force) {
      return { status: "contended", retryAfterMs: cooldownUntil - nowMs };
    }

    if (cooling && force) {
      // New user turn: one probe only, so a persistent lock cannot stampede.
      const only = await attempt(args, execOpts);
      if (only.verdict === "ok") {
        reset();
        return { status: "ok", result: only.result };
      }
      if (only.verdict === "error") return { status: "error", error: only.error };
      return { status: "contended", retryAfterMs: enterCooldown() };
    }

    const first = await attempt(args, execOpts);
    if (first.verdict === "ok") {
      reset();
      return { status: "ok", result: first.result };
    }
    if (first.verdict === "error") return { status: "error", error: first.error };

    await sleep(retryDelayMs);

    const second = await attempt(args, execOpts);
    if (second.verdict === "ok") {
      reset();
      return { status: "ok", result: second.result };
    }
    if (second.verdict === "error") return { status: "error", error: second.error };

    return { status: "contended", retryAfterMs: enterCooldown() };
  }

  return { run, isCoolingDown: () => now() < cooldownUntil };
}
