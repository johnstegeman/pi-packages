// pi-beads dolt-lock retry helper test suite — node:assert, no framework.
//
// Pure-module tests: `withDoltLockRetry` and `isDoltLockError` take an
// injectable `attempt`, `delaysMs`, and `sleep`, so no real timers run here.
// A fake `sleep` records the requested delays; assertions then pin the
// bounded backoff and the "never throw on persistent lock" contract.
import assert from "node:assert/strict";

const { isDoltLockError, withDoltLockRetry } = await import("../src/lock-retry.ts");

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(err?.stack ?? err);
  }
}

await test("isDoltLockError matches embedded-dolt lock text, rejects unrelated", () => {
  const yes = [
    "database is locked",
    "database is locked (5) (SQLITE_BUSY)",
    "locked by another dolt process",
    "embeddeddolt: init lock held",
    "EMBEDDEDDOLT",
  ];
  const no = [
    "not a git repository",
    "",
    "no beads root: /tmp/x",
    "permission denied",
  ];
  for (const s of yes) assert.equal(isDoltLockError(s), true, `expected true: ${s}`);
  for (const s of no) assert.equal(isDoltLockError(s), false, `expected false: ${s}`);
  assert.equal(isDoltLockError(undefined), false);
});

await test("locked once then succeeds → returns success, sleeps once with delaysMs[0]", async () => {
  const sleeps = [];
  const calls = [];
  const delaysMs = [7, 11, 13];
  const value = await withDoltLockRetry(
    async (n) => {
      calls.push(n);
      return n === 0 ? { value: "locked", lock: true } : { value: "done", lock: false };
    },
    { attempts: 5, delaysMs, sleep: async (ms) => sleeps.push(ms) },
  );
  assert.equal(value, "done");
  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(sleeps, [7]);
});

await test("always locked → attempt attempts times, sleeps attempts-1, returns final value", async () => {
  const sleeps = [];
  const calls = [];
  const delaysMs = [1, 2, 3, 4];
  const value = await withDoltLockRetry(
    async (n) => {
      calls.push(n);
      return { value: `locked-${n}`, lock: true };
    },
    { attempts: 4, delaysMs, sleep: async (ms) => sleeps.push(ms) },
  );
  assert.equal(value, "locked-3");
  assert.deepEqual(calls, [0, 1, 2, 3]);
  assert.deepEqual(sleeps, [1, 2, 3]);
});

await test("non-lock throw propagates immediately, attempt called once", async () => {
  const sleeps = [];
  const calls = [];
  const boom = new Error("not a git repository");
  await assert.rejects(
    () =>
      withDoltLockRetry(
        async (n) => {
          calls.push(n);
          throw boom;
        },
        { attempts: 5, delaysMs: [1, 2], sleep: async (ms) => sleeps.push(ms) },
      ),
    (err) => err === boom,
  );
  assert.deepEqual(calls, [0]);
  assert.deepEqual(sleeps, []);
});

await test("default attempts/delaysMs: persistent lock retries 5 times, sleeps [50,150,400,900]", async () => {
  const sleeps = [];
  const calls = [];
  const value = await withDoltLockRetry(
    async (n) => {
      calls.push(n);
      return { value: "locked", lock: true };
    },
    { sleep: async (ms) => sleeps.push(ms) },
  );
  assert.equal(value, "locked");
  assert.equal(calls.length, 5);
  assert.deepEqual(sleeps, [50, 150, 400, 900]);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nlock-retry: all tests passed");
