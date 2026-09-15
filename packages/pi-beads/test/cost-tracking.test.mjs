// pi-beads cost-tracking test suite — node:assert, no framework.
// Shadows `bd` with a shell fixture (argv logged to FAKE_BD_LOG) that answers
// topology (`where`), reads (`show`), and `info` deterministically. The real
// extension code runs unmodified; the fixture makes `show` return whatever
// metadata the test seeds in FAKE_BD_SHOW_JSON.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { CONC_GUARD_SH, concEnv } from "./helpers/fake-bd.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-beads-cost-")));
const binDir = join(root, "bin");
const repoDir = join(root, "repo");
const workspace = join(root, "ws");
const logFile = join(root, "bd.log");
for (const d of [binDir, repoDir, workspace]) mkdirSync(d, { recursive: true });

const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

const stub = `#!/bin/sh
CWD="$(pwd)"
{
  printf 'INV cwd=%s\\n' "$CWD"
  for a in "$@"; do printf 'ARG %s\\n' "$a"; done
} >> "$FAKE_BD_LOG"
${CONC_GUARD_SH}
case "$1" in
  where)
    printf '  %s\\n  prefix: rep\\n' ${shellQuote(join(repoDir, ".beads"))}; exit 0 ;;
  show)
    conc_guard
    printf '%s\\n' "$FAKE_BD_SHOW_JSON"; exit 0 ;;
  update)
    conc_guard
    exit 0 ;;
  list)
    # single-repo prefix resolution (samplePrefixOf) needs one id to derive the
    # 'rep' prefix; mirrors pi-beads.test.mjs's single-repo list answer.
    printf '[{"id":"rep-1","title":"sample"}]\\n'; exit 0 ;;
  info) echo "bd 1.2.2 (fixture)"; exit 0 ;;
  *) exit 0 ;;
esac
`;
writeFileSync(join(binDir, "bd"), stub);
chmodSync(join(binDir, "bd"), 0o755);
process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
process.env.FAKE_BD_LOG = logFile;

const { default: piBeadsLean, getBeadsRuntime } = await import("../src/index.ts");
const { default: costTracking } = await import("../src/cost-tracking.ts");

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
async function run() {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { failures++; console.error(`FAIL - ${name}\n${e.stack ?? e}`); }
  }
  if (failures) { console.error(`\npi-beads-cost: ${failures} test(s) failed`); process.exit(1); }
  console.log("\npi-beads-cost: all assertions passed");
}

function makePi() {
  const emitted = [];
  const eventHandlers = {}; // pi.events.on registrations
  const handlers = {};      // pi.on registrations
  const pi = {
    events: {
      on: (n, fn) => (eventHandlers[n] ??= []).push(fn),
      emit: (n) => emitted.push(n),
    },
    on: (ev, fn) => (handlers[ev] ??= []).push(fn),
    registerTool: () => {},
    registerCommand: () => {},
  };
  piBeadsLean(pi);  // first — populates getBeadsRuntime()
  costTracking(pi); // second — subscribes subagents events
  return { pi, emitted, eventHandlers, handlers };
}

const openSession = async () => {
  const s = makePi();
  await s.handlers.session_start[0]({}, { cwd: workspace }); // resolves topology: prefix rep -> repoDir
  return s;
};

const fire = async (s, name, payload) => { for (const fn of s.eventHandlers[name] ?? []) await fn(payload); };

const resetLog = () => writeFileSync(logFile, "");
function invocations() {
  const invs = [];
  let cur = null;
  for (const ln of readFileSync(logFile, "utf8").split("\n")) {
    if (ln.startsWith("INV ")) { cur = []; invs.push(cur); }
    else if (ln.startsWith("ARG ") && cur) cur.push(ln.slice(4));
  }
  return invs;
}
function findInvocation(args) {
  const found = invocations().find(
    (inv) => inv.length === args.length && args.every((a, i) => inv[i] === a),
  );
  assert.ok(found, `expected bd argv ${JSON.stringify(args)}; got:\n${JSON.stringify(invocations(), null, 1)}`);
  return found;
}
function findUpdateContaining(beadId, sub) {
  const invs = invocations().filter((inv) => inv[0] === "update" && inv[1] === beadId);
  assert.ok(invs.length > 0, `no update for ${beadId}: ${JSON.stringify(invocations(), null, 1)}`);
  for (const a of sub) {
    assert.ok(invs.some((inv) => inv.includes(a)), `update for ${beadId} missing arg ${a}:\n${JSON.stringify(invs, null, 1)}`);
  }
  return invs;
}
function assertNoInvocation(args) {
  const found = invocations().some(
    (inv) => inv.length === args.length && args.every((a, i) => inv[i] === a),
  );
  assert.ok(!found, `bd argv unexpectedly invoked: ${JSON.stringify(args)}`);
}

test("completed event writes per-agent line + rollups and emits beads:changed after update", async () => {
  const s = await openSession();
  process.env.FAKE_BD_SHOW_JSON = JSON.stringify([{ id: "rep-1", metadata: { "review.verdict": "done" } }]);
  resetLog();
  s.emitted.length = 0;
  await fire(s, "subagents:completed", {
    id: "auth-audit-2", type: "implementer", status: "completed",
    description: "Implement task bead:rep-1",
    usage: { input: 100, output: 50, cacheRead: 10, cost: { total: 0.42 } },
  });
  const updateLine = findInvocation([
    "update", "rep-1",
    "--set-metadata", "cost.agents.auth-audit-2.total=0.42",
    "--set-metadata", "cost.agents.auth-audit-2.tokens.input=100",
    "--set-metadata", "cost.agents.auth-audit-2.tokens.output=50",
    "--set-metadata", "cost.agents.auth-audit-2.tokens.cacheRead=10",
    "--set-metadata", "cost.agents.auth-audit-2.role=implementer",
    "--set-metadata", "cost.agents.auth-audit-2.status=completed",
    "--set-metadata", "cost.total=0.42",
    "--set-metadata", "cost.tokens.input=100",
    "--set-metadata", "cost.tokens.output=50",
    "--set-metadata", "cost.tokens.cacheRead=10",
    "--set-metadata", "cost.agents.count=1",
  ]);
  const invs = invocations();
  const showIdx = invs.findIndex((inv) => inv.length === 3 && inv[0] === "show" && inv[1] === "rep-1" && inv[2] === "--json");
  const updateIdx = invs.findIndex((inv) => inv.length === updateLine.length && updateLine.every((a, i) => inv[i] === a));
  assert.ok(showIdx >= 0 && updateIdx > showIdx, "show must precede update");
  assert.ok(s.emitted.includes("beads:changed"), "afterWrite emits beads:changed");
  for (const inv of invs)
    for (const a of inv)
      if (a.startsWith("--set-metadata ")) // flag itself ("--set-metadata") is not a key=value pair
        assert.ok(a.startsWith("--set-metadata cost."), `non-cost metadata key written: ${a}`);
});

test("accumulation: prior agent line stays, new agent summed into rollups", async () => {
  const s = await openSession();
  process.env.FAKE_BD_SHOW_JSON = JSON.stringify([{ id: "rep-1", metadata: {
    "cost.agents.a1.total": 1.0, "cost.total": 1.0, "cost.agents.count": 1,
    "review.verdict": "done",
  } }]);
  resetLog();
  await fire(s, "subagents:completed", { id: "b2", type: "task-reviewer", status: "completed", description: "Review task bead:rep-1", usage: { input: 20, output: 10, cacheRead: 0, cost: { total: 0.5 } } });
  const invs = findUpdateContaining("rep-1", [
    "--set-metadata", "cost.agents.a1.total=1",     // untouched prior line (JSON.parse turns 1.0 into the number 1)
    "--set-metadata", "cost.agents.b2.total=0.5",
    "--set-metadata", "cost.total=1.5",             // 1.0 + 0.5, not double-counted
    "--set-metadata", "cost.tokens.input=20",       // a1 has no token keys -> contributes 0
    "--set-metadata", "cost.tokens.output=10",
    "--set-metadata", "cost.agents.count=2",
  ]);
  for (const inv of invs)
    for (const a of inv)
      if (a.startsWith("--set-metadata ")) // flag itself ("--set-metadata") is not a key=value pair
        assert.ok(a.startsWith("--set-metadata cost."), `non-cost metadata key written: ${a}`);
});

test("resume round: same agent id overwrites its own line (rollup not double-counted)", async () => {
  const s = await openSession();
  process.env.FAKE_BD_SHOW_JSON = JSON.stringify([{ id: "rep-1", metadata: { "cost.agents.auth-audit-2.total": 0.1, "cost.total": 0.1, "cost.agents.count": 1 } }]);
  resetLog();
  await fire(s, "subagents:completed", { id: "auth-audit-2", type: "implementer", status: "completed", description: "Fix round task bead:rep-1", usage: { input: 5, output: 5, cacheRead: 0, cost: { total: 0.42 } } });
  const invs = findUpdateContaining("rep-1", [
    "--set-metadata", "cost.agents.auth-audit-2.total=0.42",
    "--set-metadata", "cost.total=0.42",   // 0.42, NOT 0.52
    "--set-metadata", "cost.agents.count=1",
  ]);
  for (const inv of invs) {
    assert.ok(!inv.includes("cost.agents.auth-audit-2.total=0.1"), "old line value must be overwritten");
    assert.ok(!inv.includes("cost.total=0.1"), "old rollup must not survive");
  }
});

test("skip matrix: no bead token / no usage / unknown repo prefix", async () => {
  const s = await openSession();
  process.env.FAKE_BD_SHOW_JSON = JSON.stringify([{ id: "rep-1", metadata: {} }]);
  resetLog();
  await fire(s, "subagents:completed", { id: "x1", description: "Implement the feature", usage: { cost: { total: 1 } } });
  await fire(s, "subagents:completed", { id: "x2", description: "Task bead:rep-1" });            // no usage
  await fire(s, "subagents:failed", { id: "x3", type: "implementer", status: "error", description: "Task bead:unknown-1", usage: { cost: { total: 0.2 } } }); // unknown prefix
  assertNoInvocation(["update", "rep-1"]);
  assertNoInvocation(["update", "unknown-1"]);
});

test("failed event with usage records the run (cost spent before failing)", async () => {
  const s = await openSession();
  process.env.FAKE_BD_SHOW_JSON = JSON.stringify([{ id: "rep-1", metadata: {} }]);
  resetLog();
  await fire(s, "subagents:failed", { id: "y1", type: "implementer", status: "aborted", description: "Task bead:rep-1", usage: { input: 30, output: 0, cacheRead: 0, cost: { total: 0.07 } } });
  findUpdateContaining("rep-1", [
    "--set-metadata", "cost.agents.y1.total=0.07",
    "--set-metadata", "cost.agents.y1.status=aborted",
    "--set-metadata", "cost.total=0.07",
    "--set-metadata", "cost.tokens.input=30",
    "--set-metadata", "cost.agents.count=1",
  ]);
});

test("dotted agent id is sanitized to underscore and still counted in rollups", async () => {
  const s = await openSession();
  process.env.FAKE_BD_SHOW_JSON = JSON.stringify([{ id: "rep-1", metadata: {} }]);
  resetLog();
  await fire(s, "subagents:completed", {
    id: "sub.agent-9", type: "implementer", status: "completed",
    description: "Implement task bead:rep-1",
    usage: { input: 10, output: 5, cacheRead: 0, cost: { total: 0.11 } },
  });
  findUpdateContaining("rep-1", [
    "--set-metadata", "cost.agents.sub_agent-9.total=0.11",
    "--set-metadata", "cost.agents.sub_agent-9.role=implementer",
    "--set-metadata", "cost.total=0.11",
    "--set-metadata", "cost.agents.count=1",
  ]);
});

test("overlapping events for the same bead are serialized (no lost/overlapping RMW)", async () => {
  const s = await openSession();
  process.env.FAKE_BD_SHOW_JSON = JSON.stringify([{ id: "rep-1", metadata: {} }]);
  const restoreConc = concEnv(join(root, "conc"), join(root, "conc.marker"));
  try {
    resetLog();
    await Promise.all([
      fire(s, "subagents:completed", { id: "a1", type: "implementer", status: "completed", description: "x task bead:rep-1", usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0.1 } } }),
      fire(s, "subagents:completed", { id: "a2", type: "implementer", status: "completed", description: "x task bead:rep-1", usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0.2 } } }),
    ]);
    // prove the instrumentation was active, else the marker check is vacuous
    assert.ok(existsSync(join(root, "conc")), "concurrency instrumentation never ran");
    let marker = "";
    try { marker = readFileSync(process.env.FAKE_BD_CONC_MARKER, "utf8"); } catch {}
    assert.equal(marker.trim(), "", `overlapping RMW observed: ${marker}`);
  } finally {
    restoreConc();
  }
});

test("handlers are registered once across repeated factory runs", async () => {
  const s = makePi();
  costTracking(s.pi); // second registration on the same pi instance
  assert.equal(s.eventHandlers["subagents:completed"].length, 1);
  assert.equal(s.eventHandlers["subagents:failed"].length, 1);
});

test("smoke: realistic subagent completion drives the shipped entrypoints end-to-end", async () => {
  const s = await openSession();
  // Contract: the extension subscribes to exactly the events pi-subagents emits.
  assert.ok(s.eventHandlers["subagents:completed"]?.length === 1, "subscribes subagents:completed");
  assert.ok(s.eventHandlers["subagents:failed"]?.length === 1, "subscribes subagents:failed");

  process.env.FAKE_BD_SHOW_JSON = JSON.stringify([{ id: "rep-1", metadata: {} }]);
  resetLog();
  s.emitted.length = 0;
  // Payload shaped exactly as pi-subagents emits it (see cost-tracking.ts Interfaces).
  await fire(s, "subagents:completed", {
    id: "smoke-agent-1",
    type: "implementer",
    status: "completed",
    description: "Implement task bead:rep-1",
    usage: { input: 42, output: 21, cacheRead: 7, cost: { total: 0.123456 } },
  });
  findUpdateContaining("rep-1", [
    "--set-metadata", "cost.agents.smoke-agent-1.total=0.123456",
    "--set-metadata", "cost.agents.smoke-agent-1.role=implementer",
    "--set-metadata", "cost.agents.smoke-agent-1.status=completed",
    "--set-metadata", "cost.total=0.123456",
    "--set-metadata", "cost.agents.count=1",
  ]);
  assert.ok(s.emitted.includes("beads:changed"), "afterWrite emits beads:changed");
});

run();
