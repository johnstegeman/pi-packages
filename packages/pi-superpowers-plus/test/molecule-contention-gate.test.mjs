import assert from "node:assert/strict";
import { createContentionGate } from "../extensions/molecule-contention-gate.mjs";

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function makeSleep() {
  const delays = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

const lockResult = () => ({ code: 1, stdout: "", stderr: "database is locked by another dolt process" });
const okResult = (stdout = "[]") => ({ code: 0, stdout, stderr: "" });

// ---------- clean exec: one call, never classified, no cooldown ----------
{
  const clock = makeClock();
  const { delays, sleep } = makeSleep();
  let calls = 0;
  const gate = createContentionGate({
    exec: async () => {
      calls += 1;
      return okResult();
    },
    now: clock.now,
    sleep,
  });
  const r = await gate.run(["mol", "current", "--json"], { cwd: "/repo" });
  assert.equal(r.status, "ok");
  assert.equal(calls, 1, "a clean run is issued exactly once");
  assert.equal(delays.length, 0, "no retry sleep on a clean run");
  assert.equal(gate.isCoolingDown(), false, "no cooldown after a clean run");
}

// ---------- transient then success: one retry, no cooldown ----------
{
  const clock = makeClock();
  const { delays, sleep } = makeSleep();
  let calls = 0;
  const gate = createContentionGate({
    exec: async () => {
      calls += 1;
      return calls === 1 ? lockResult() : okResult("A");
    },
    now: clock.now,
    sleep,
  });
  const r = await gate.run(["mol", "current", "--json"], {});
  assert.equal(r.status, "ok");
  assert.equal(r.result.stdout, "A", "the successful retry result is returned");
  assert.equal(calls, 2, "one quick retry");
  assert.deepEqual(delays, [150], "the retry delay is retryDelayMs");
  assert.equal(gate.isCoolingDown(), false, "a cleared transient never enters cooldown");
}

// ---------- transient, both attempts: contended + first cooldown ----------
{
  const clock = makeClock();
  const { sleep } = makeSleep();
  let calls = 0;
  const gate = createContentionGate({
    exec: async () => {
      calls += 1;
      return lockResult();
    },
    now: clock.now,
    sleep,
  });
  const r = await gate.run(["list"], {});
  assert.equal(r.status, "contended");
  assert.equal(r.retryAfterMs, 2500, "the first episode uses initialCooldownMs");
  assert.equal(calls, 2, "one quick retry, then it stops");
  assert.equal(gate.isCoolingDown(), true);
}

// ---------- cooldown suppresses exec, then resumes ----------
{
  const clock = makeClock();
  const { sleep } = makeSleep();
  let calls = 0;
  const gate = createContentionGate({
    exec: async () => {
      calls += 1;
      return lockResult();
    },
    now: clock.now,
    sleep,
  });
  await gate.run(["list"], {});
  const frozen = calls;
  const r = await gate.run(["list"], {});
  assert.equal(r.status, "contended");
  assert.equal(calls, frozen, "no bd call while cooling down");
  clock.advance(2500);
  await gate.run(["list"], {});
  assert.equal(calls, frozen + 2, "refresh resumes after the cooldown expires");
}

// ---------- the deadline is evaluated lazily against the clock ----------
{
  const clock = makeClock();
  const { sleep } = makeSleep();
  let calls = 0;
  const gate = createContentionGate({
    exec: async () => {
      calls += 1;
      return lockResult();
    },
    now: clock.now,
    sleep,
  });
  await gate.run(["list"], {});
  const frozen = calls;
  clock.advance(2499);
  const r = await gate.run(["list"], {});
  assert.equal(r.status, "contended");
  assert.equal(r.retryAfterMs, 1, "remaining time is computed from the deadline");
  assert.equal(calls, frozen, "still suppressed one millisecond before the deadline");
  clock.advance(1);
  await gate.run(["list"], {});
  assert.equal(calls, frozen + 2, "resumes exactly at the deadline");
}

// ---------- adaptive ramp: doubles, then caps ----------
{
  const clock = makeClock();
  const { sleep } = makeSleep();
  const gate = createContentionGate({ exec: async () => lockResult(), now: clock.now, sleep });
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await gate.run(["list"], {});
    seen.push(r.retryAfterMs);
    clock.advance(r.retryAfterMs);
  }
  assert.deepEqual(seen, [2500, 5000, 10000, 10000], "cooldown doubles, then caps at maxCooldownMs");
}

// ---------- a clean result resets the ramp ----------
{
  const clock = makeClock();
  const { sleep } = makeSleep();
  let mode = "lock";
  const gate = createContentionGate({
    exec: async () => (mode === "lock" ? lockResult() : okResult()),
    now: clock.now,
    sleep,
  });
  const first = await gate.run(["list"], {});
  assert.equal(first.retryAfterMs, 2500);
  clock.advance(2500);
  mode = "ok";
  assert.equal((await gate.run(["list"], {})).status, "ok");
  mode = "lock";
  const again = await gate.run(["list"], {});
  assert.equal(again.retryAfterMs, 2500, "a clean run resets the ramp to initialCooldownMs");
}

// ---------- genuine error is passed through, never retried, never cooled down ----------
{
  const clock = makeClock();
  const { sleep } = makeSleep();
  let calls = 0;
  const gate = createContentionGate({
    exec: async () => {
      calls += 1;
      return { code: 1, stdout: "", stderr: "connection refused" };
    },
    now: clock.now,
    sleep,
  });
  const r = await gate.run(["list"], {});
  assert.equal(r.status, "ok", "an unclassified failure is passed through, not retried");
  assert.equal(r.result.code, 1, "the raw failing result reaches the caller");
  assert.equal(calls, 1);
  assert.equal(gate.isCoolingDown(), false, "a genuine error never enters cooldown");
}

// ---------- unclassified throw: error, never retried, no cooldown ----------
{
  const clock = makeClock();
  const { sleep } = makeSleep();
  let calls = 0;
  const gate = createContentionGate({
    exec: async () => {
      calls += 1;
      throw new Error("boom");
    },
    now: clock.now,
    sleep,
  });
  const r = await gate.run(["list"], {});
  assert.equal(r.status, "error");
  assert.equal(r.error.message, "boom");
  assert.equal(calls, 1, "an unclassified throw is never retried");
  assert.equal(gate.isCoolingDown(), false);
}

// ---------- killed / context-canceled is transient ----------
{
  const clock = makeClock();
  const { sleep } = makeSleep();
  let calls = 0;
  const gate = createContentionGate({
    exec: async () => {
      calls += 1;
      return { code: -1, stdout: "", stderr: "context canceled", killed: true };
    },
    now: clock.now,
    sleep,
  });
  const r = await gate.run(["list"], {});
  assert.equal(r.status, "contended", "a killed run is transient");
  assert.equal(calls, 2);
}

// ---------- a successful run is never classified ----------
{
  const clock = makeClock();
  const { sleep } = makeSleep();
  let calls = 0;
  const gate = createContentionGate({
    exec: async () => {
      calls += 1;
      return { code: 0, stdout: "embeddeddolt", stderr: "" };
    },
    now: clock.now,
    sleep,
  });
  assert.equal((await gate.run(["list"], {})).status, "ok");
  assert.equal(calls, 1, "a code-0 result containing lock-ish text is never classified");
}

console.log("molecule-contention-gate: all assertions passed");
