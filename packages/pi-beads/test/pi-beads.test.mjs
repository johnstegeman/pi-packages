// pi-beads-lean test suite — lightweight node:assert, no framework.
//
// Seam: the extension's internal `bd()` runner invokes the real `bd` binary via
// `execFile` (pexec), resolved from PATH at call time. This suite therefore
// shadows `bd` with a tiny fixture script on a prepended PATH entry: the fixture
// logs the exact argv of every invocation (so we can assert the argv each tool
// builds) and returns canned topology answers (so `resolveTopology` settles into
// either single-repo or umbrella mode). The extension's real `execute` and
// `afterWrite` code runs unmodified — this is a subprocess-boundary test double,
// not a rewrite of the logic under test, so the argv construction and the
// `beads:changed` emit are verified exactly as they happen in production.
//
// The fixture answers are mode-dependent (read from FAKE_BD_MODE) so one suite
// drives both single-repo and umbrella topology.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// fixture topology: a temp tree with a single "repo" and an "umbrella" that
// hydrates a "backend" sub-repo. All paths are real (os.tmpdir) so the child
// process cwd and our expectations agree on macOS (/tmp -> /private/tmp).
// ---------------------------------------------------------------------------
// realpathSync: macOS canonicalises /var -> /private/var after chdir, which
// would otherwise desync the fixture's baked-in patterns from `pwd`.
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-beads-test-")));
const binDir = join(root, "bin");
const repoDir = join(root, "repo"); // the single-repo DB root
const workspace = join(root, "ws"); // session cwd INSIDE the umbrella workspace
const projDir = join(workspace, "proj");
const umbrella = join(root, "umbrella"); // hydrates: aggregates repo + backend
const backendDir = join(umbrella, "sub", "backend");
for (const d of [binDir, repoDir, workspace, projDir, umbrella, backendDir])
  mkdirSync(d, { recursive: true });
const logFile = join(root, "bd.log");

function shellQuote(s) {
  return `'${String(s).replaceAll("'", "'\\''")}'`;
}

const stub = `#!/bin/sh
# fixture bd: shadows the real binary for the test process only. Logs the full
# argv of every invocation to $FAKE_BD_LOG and answers topology probes from
# the FAKE_BD_MODE env var. Everything else is a no-op that "succeeds".
CWD="$(pwd)"
MODE="\${FAKE_BD_MODE:-single}"
{
  printf 'INV cwd=%s mode=%s\\n' "$CWD" "$MODE"
  for a in "$@"; do printf 'ARG %s\\n' "$a"; done
} >> "$FAKE_BD_LOG"
case "$1" in
  where)
    if [ "$MODE" = "umbrella" ]; then
      case "$CWD" in
        ${shellQuote(workspace)}*|${shellQuote(umbrella)}*)
          printf '  %s\\n' ${shellQuote(join(umbrella, ".beads"))}; echo "  prefix: umb"; exit 0 ;;
        *) echo "no beads root: $CWD" >&2; exit 1 ;;
      esac
    fi
    case "$CWD" in
      ${shellQuote(repoDir)}*|${shellQuote(workspace)}*)
        printf '  %s\\n' ${shellQuote(join(repoDir, ".beads"))}; exit 0 ;;
      *) echo "no beads root: $CWD" >&2; exit 1 ;;
    esac
    ;;
  repo)
    if [ "$2" = "list" ] && [ "$MODE" = "umbrella" ]; then
      printf '  - %s\\n' ${shellQuote(backendDir)}
    fi
    exit 0
    ;;
  info) echo "bd 1.2.2 (fixture)"; exit 0 ;;
  list)
    # bd list --all -n 1 --json (prefix sampling): a representative issue id per mode
    if [ "$MODE" = "umbrella" ]; then
      echo '[{"id": "crmback-1a2", "title": "sample"}]'
    else
      echo '[{"id": "proj-1a2", "title": "sample"}]'
    fi
    exit 0
    ;;
  *) echo "ok"; exit 0 ;;
esac
`;
writeFileSync(join(binDir, "bd"), stub, { mode: 0o755 });
process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
process.env.FAKE_BD_LOG = logFile;

const { default: piBeadsLean } = await import("../src/index.ts");
const { DEP_LINK_TYPES, GATE_TYPES } = await import("../src/index.ts");

// ---------------------------------------------------------------------------
// minimal runner: node:assert + a tiny async harness (mirrors the widget test's
// "all assertions passed" style; this one also runs async tool executes).
// `run()` is invoked at the very end of the file, after registrations.
// ---------------------------------------------------------------------------
let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}
async function run() {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failures++;
      console.error(`FAIL - ${name}\n${e.stack ?? e}`);
    }
  }
  if (failures > 0) {
    console.error(`\npi-beads: ${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\npi-beads: all assertions passed");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function makePi() {
  const emitted = [];
  const handlers = {};
  const tools = [];
  const pi = {
    events: { emit: (name) => emitted.push(name) },
    on: (ev, fn) => (handlers[ev] ??= []).push(fn),
    registerTool: (t) => tools.push(t),
    registerCommand: () => {},
  };
  piBeadsLean(pi);
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { pi, emitted, handlers, byName, tools };
}

async function openSession(env, cwd) {
  process.env.FAKE_BD_MODE = env;
  const s = makePi();
  await s.handlers.session_start[0]({}, { cwd });
  return s;
}

function resetLog() {
  writeFileSync(logFile, "");
}

function invocations() {
  const invs = [];
  let cur = null;
  for (const ln of readFileSync(logFile, "utf8").split("\n")) {
    if (ln.startsWith("INV ")) {
      cur = [];
      invs.push(cur);
    } else if (ln.startsWith("ARG ") && cur) {
      cur.push(ln.slice(4));
    }
  }
  return invs;
}

function findInvocation(args) {
  const argsStr = JSON.stringify(args);
  const found = invocations().find(
    (inv) => inv.length === args.length && args.every((a, i) => inv[i] === a),
  );
  assert.ok(found, `expected bd argv ${argsStr}; got:\n${JSON.stringify(invocations(), null, 1)}`);
  return found;
}

function assertNoInvocation(args) {
  const found = invocations().some(
    (inv) => inv.length === args.length && args.every((a, i) => inv[i] === a),
  );
  assert.ok(!found, `bd argv unexpectedly invoked: ${JSON.stringify(args)}`);
}

const okResult = (r) => r && Array.isArray(r.content) && r.content[0]?.type === "text";

// ---------------------------------------------------------------------------
// 0. module surface: the new tools are registered and the type allowlists export
// ---------------------------------------------------------------------------
test("registers all 16 tools, including the six new ones", async () => {
  const { tools } = makePi();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "beads_close",
    "beads_comment",
    "beads_create",
    "beads_dep",
    "beads_deps",
    "beads_gate_create",
    "beads_gate_resolve",
    "beads_list",
    "beads_mol_current",
    "beads_mol_pour",
    "beads_mol_show",
    "beads_ready",
    "beads_reopen",
    "beads_show",
    "beads_undep",
    "beads_update",
  ]);
  for (const t of tools) assert.equal(typeof t.execute, "function");
});

test("type allowlists are exactly the bd-verified sets", async () => {
  assert.deepEqual(DEP_LINK_TYPES, [
    "blocks",
    "tracks",
    "related",
    "parent-child",
    "discovered-from",
  ]);
  assert.deepEqual(GATE_TYPES, ["human", "timer", "gh:run", "gh:pr"]);
});

// ---------------------------------------------------------------------------
// 1. single-repo mode: argv construction + beads:changed emit after mutations
// ---------------------------------------------------------------------------
test("single-repo: session_start resolves, registers tools, emits nothing", async () => {
  const s = await openSession("single", repoDir);
  assert.equal(s.emitted.length, 0, "session_start must not emit beads:changed");
  assert.equal(s.tools.length, 16);
});

test("single-repo: beads_create builds argv and emits beads:changed", async () => {
  const s = await openSession("single", repoDir);
  const before = s.emitted.length;
  resetLog();
  const r = await s.byName.get("beads_create").execute("c", { title: "Do the thing" });
  assert.ok(okResult(r), `create failed: ${JSON.stringify(r)}`);
  findInvocation(["create", "Do the thing"]);
  assert.equal(s.emitted.length, before + 1);
  assert.equal(s.emitted.at(-1), "beads:changed");
});

test("single-repo: beads_update claim/setMetadata/description/title plumbing", async () => {
  const s = await openSession("single", repoDir);
  const before = s.emitted.length;
  resetLog();
  const r = await s.byName.get("beads_update").execute("c", {
    id: "proj-1a2",
    status: "in_progress",
    title: "New title",
    claim: true,
    setMetadata: "review.verdict=done,foo=bar",
    description: "new body",
  });
  assert.ok(okResult(r), JSON.stringify(r));
  findInvocation([
    "update",
    "proj-1a2",
    "--status",
    "in_progress",
    "--title",
    "New title",
    "--claim",
    "--set-metadata",
    "review.verdict=done",
    "--set-metadata",
    "foo=bar",
    "--description",
    "new body",
  ]);
  assert.equal(s.emitted.length, before + 1);
});

test("single-repo: beads_dep --type plumbing and default (no --type)", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  await s.byName.get("beads_dep").execute("c", {
    issue: "proj-1a2",
    blocker: "proj-2b3",
    type: "discovered-from",
  });
  findInvocation(["link", "proj-1a2", "proj-2b3", "--type", "discovered-from"]);
  resetLog();
  await s.byName.get("beads_dep").execute("c", {
    issue: "proj-1a2",
    blocker: "proj-2b3",
  });
  findInvocation(["link", "proj-1a2", "proj-2b3"]);
});

test("single-repo: beads_show --full changes only the digest, not argv; no emit", async () => {
  const s = await openSession("single", repoDir);
  const before = s.emitted.length;
  resetLog();
  const r = await s.byName.get("beads_show").execute("c", { id: "proj-1a2", full: true });
  assert.ok(okResult(r), JSON.stringify(r));
  findInvocation(["show", "proj-1a2", "--json"]);
  assert.equal(s.emitted.length, before, "beads_show must not emit");
});

test("single-repo: beads_gate_resolve runs gate resolve THEN close and emits twice", async () => {
  const s = await openSession("single", repoDir);
  const before = s.emitted.length;
  resetLog();
  const r = await s.byName.get("beads_gate_resolve").execute("c", { id: "proj-g1" });
  assert.ok(okResult(r), JSON.stringify(r));
  const invs = invocations();
  const resolved = invs.findIndex(
    (iv) => iv[0] === "gate" && iv[1] === "resolve" && iv[2] === "proj-g1",
  );
  const closed = invs.findIndex((iv) => iv[0] === "close" && iv[1] === "proj-g1");
  assert.ok(resolved >= 0 && closed >= 0, `expected gate resolve + close in ${JSON.stringify(invs)}`);
  assert.ok(resolved < closed, "close must come after gate resolve");
  assert.equal(s.emitted.length, before + 2, "gate_resolve emits after resolve AND after close");
});

test("single-repo: beads_mol_pour builds argv (--var split) and emits", async () => {
  const s = await openSession("single", repoDir);
  const before = s.emitted.length;
  resetLog();
  const r = await s.byName.get("beads_mol_pour").execute("c", {
    proto: "superpowers-workflow",
    vars: "topic=foo, owner=bar",
  });
  assert.ok(okResult(r), JSON.stringify(r));
  findInvocation([
    "mol",
    "pour",
    "superpowers-workflow",
    "--var",
    "topic=foo",
    "--var",
    "owner=bar",
  ]);
  assert.equal(s.emitted.length, before + 1);
});

test("single-repo: read tools never emit beads:changed", async () => {
  const s = await openSession("single", repoDir);
  const reads = [
    ["beads_ready", { limit: 5 }, ["ready", "--json", "--include-ephemeral", "-n", "5"]],
    ["beads_list", { status: "open,in_progress", limit: 7 }, ["list", "--json", "-n", "7", "--status", "open,in_progress"]],
    ["beads_show", { id: "proj-1a2" }, ["show", "proj-1a2", "--json"]],
    ["beads_deps", { ids: "proj-1a2" }, ["dep", "tree", "proj-1a2", "--direction", "down", "--json"]],
    ["beads_mol_show", { id: "proj-m1" }, ["mol", "show", "proj-m1", "--json"]],
    ["beads_mol_current", { id: "proj-m1" }, ["mol", "current", "proj-m1", "--json"]],
  ];
  for (const [name, params, argv] of reads) {
    resetLog();
    const r = await s.byName.get(name).execute("c", params);
    assert.ok(okResult(r), `${name} failed: ${JSON.stringify(r)}`);
    findInvocation(argv); // the read really went to bd with the right argv
    assert.equal(s.emitted.length, 0, `${name} must not emit beads:changed`);
  }
});

// ---------------------------------------------------------------------------
// 2. type allowlists rejected (Imp #3): error text, no bd call, no emit
// ---------------------------------------------------------------------------
test("beads_dep rejects an invalid dependency type with the allowed set", async () => {
  const s = await openSession("single", repoDir);
  const before = s.emitted.length;
  resetLog();
  const r = await s.byName.get("beads_dep").execute("c", {
    issue: "proj-1a2",
    blocker: "proj-2b3",
    type: "bogus",
  });
  const text = r?.content?.[0]?.text ?? "";
  assert.ok(/invalid dependency type 'bogus'/.test(text), `expected error, got: ${text}`);
  assert.ok(
    DEP_LINK_TYPES.every((t) => text.includes(t)),
    `error must name the allowed set: ${text}`,
  );
  assertNoInvocation(["link", "proj-1a2", "proj-2b3", "--type", "bogus"]);
  assert.equal(s.emitted.length, before, "rejected dep must not emit");
});

test("beads_gate_create rejects an invalid gate type with the allowed set", async () => {
  const s = await openSession("single", repoDir);
  const before = s.emitted.length;
  resetLog();
  const r = await s.byName.get("beads_gate_create").execute("c", {
    blocks: "proj-1a2",
    type: "bogus",
  });
  const text = r?.content?.[0]?.text ?? "";
  assert.ok(/invalid gate type 'bogus'/.test(text), `expected error, got: ${text}`);
  assert.ok(
    GATE_TYPES.every((t) => text.includes(t)),
    `error must name the allowed set: ${text}`,
  );
  assertNoInvocation(["gate", "create", "--blocks", "proj-1a2", "--type", "bogus"]);
  assert.equal(s.emitted.length, before, "rejected gate must not emit");
});

// ---------------------------------------------------------------------------
// 3. umbrella mode: prefix-routed writes emit; reads against the aggregate don't
// ---------------------------------------------------------------------------
test("umbrella: session_start hydrates the umbrella + backend repo", async () => {
  const s = await openSession("umbrella", projDir);
  assert.equal(s.emitted.length, 0);
  // prefix routing table exists: reads must run against the umbrella
  resetLog();
  const r = await s.byName.get("beads_list").execute("c", { limit: 3 });
  assert.ok(okResult(r), JSON.stringify(r));
  findInvocation(["repo", "sync"]); // ensureFresh before a read
  findInvocation(["list", "--json", "-n", "3"]);
});

test("umbrella: beads_create routes to the owning repo, re-exports JSONL, emits", async () => {
  const s = await openSession("umbrella", projDir);
  const before = s.emitted.length;
  resetLog();
  const r = await s.byName.get("beads_create").execute("c", {
    title: "Feature X",
    repo: "backend",
    type: "feature",
    priority: 1,
    description: "d",
    labels: "a,b",
    notes: "n",
    design: "x",
    ephemeral: "true",
  });
  assert.ok(okResult(r), JSON.stringify(r));
  findInvocation([
    "create",
    "Feature X",
    "-t",
    "feature",
    "-p",
    "1",
    "-d",
    "d",
    "-l",
    "a,b",
    "--notes",
    "n",
    "--design",
    "x",
    "--ephemeral",
  ]);
  // afterWrite in umbrella mode also exports the repo's JSONL, then emits
  findInvocation(["export", "-o", ".beads/issues.jsonl"]);
  assert.equal(s.emitted.length, before + 1);
});

test("umbrella: update/close/reopen/gate create/mol pour route to owning repo and emit", async () => {
  const s = await openSession("umbrella", projDir);
  resetLog();
  await s.byName.get("beads_update").execute("c", { id: "crmback-1a2", claim: true });
  findInvocation(["update", "crmback-1a2", "--claim"]);
  resetLog();
  await s.byName.get("beads_reopen").execute("c", { ids: "crmback-1a2 crmback-2b3", reason: "retry" });
  findInvocation(["reopen", "crmback-1a2", "crmback-2b3", "-r", "retry"]);
  resetLog();
  await s.byName.get("beads_gate_create").execute("c", {
    blocks: "crmback-1a2",
    type: "gh:pr",
    reason: "waiting",
    awaitId: "42",
  });
  findInvocation([
    "gate",
    "create",
    "--blocks",
    "crmback-1a2",
    "--type",
    "gh:pr",
    "--reason",
    "waiting",
    "--await-id",
    "42",
  ]);
  resetLog();
  await s.byName.get("beads_mol_pour").execute("c", { proto: "f", repo: "backend" });
  findInvocation(["mol", "pour", "f"]);
  assert.equal(s.emitted.length, 4);
  assert.ok(s.emitted.every((e) => e === "beads:changed"), `all emits are beads:changed: ${s.emitted}`);
});

test("umbrella: gate_resolve two-step emits twice (one per afterWrite)", async () => {
  const s = await openSession("umbrella", projDir);
  const before = s.emitted.length;
  resetLog();
  await s.byName.get("beads_gate_resolve").execute("c", { id: "crmback-g1" });
  findInvocation(["gate", "resolve", "crmback-g1"]);
  findInvocation(["close", "crmback-g1"]);
  assert.equal(s.emitted.length, before + 2);
});

test("umbrella: read tools never emit beads:changed", async () => {
  const s = await openSession("umbrella", projDir);
  const names = [
    ["beads_ready", { limit: 5 }],
    ["beads_list", { status: "open" }],
    ["beads_show", { id: "crmback-1a2" }],
    ["beads_deps", { ids: "crmback-1a2" }],
    ["beads_mol_show", { id: "crmback-m1" }],
    ["beads_mol_current", { id: "crmback-m1" }],
  ];
  for (const [name, params] of names) {
    resetLog();
    const r = await s.byName.get(name).execute("c", params);
    assert.ok(okResult(r), `${name} failed: ${JSON.stringify(r)}`);
    assert.equal(s.emitted.length, 0, `${name} must not emit beads:changed`);
  }
});

// ---------------------------------------------------------------------------
// run everything (all test() registrations above must complete first)
// ---------------------------------------------------------------------------
await run();
