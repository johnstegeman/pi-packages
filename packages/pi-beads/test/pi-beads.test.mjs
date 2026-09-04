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
  ready)
    if [ "$2" = "--mol" ]; then
      MOLP="proj"; [ "$MODE" = "umbrella" ] && MOLP="umb"
      case "$3" in
        *empty*)
          printf '{"molecule_id":"%s-m0","molecule_title":"Empty Mol","ready_steps":0,"total_steps":3,"steps":null}\n' "$MOLP" ;;
        *)
          printf '{"molecule_id":"%s-m0","molecule_title":"Demo Mol","ready_steps":2,"total_steps":4,"steps":[{"parallel_info":{"is_ready":true,"step_id":"%s-t1"},"issue":{"id":"%s-t1","priority":1,"status":"open","title":"Task one"}},{"parallel_info":{"is_ready":true,"step_id":"%s-t2"},"issue":{"id":"%s-t2","priority":2,"status":"open","title":"Task two"}}]}\n' "$MOLP" "$MOLP" "$MOLP" "$MOLP" "$MOLP" ;;
      esac
      exit 0
    fi
    echo "ok"; exit 0
    ;;
  mol)
    if [ "$2" = "pour" ]; then
      DRYRUN=0
      for a in "$@"; do [ "$a" = "--dry-run" ] && DRYRUN=1; done
      if [ "$DRYRUN" = "1" ]; then
        printf -- "- superpowers-workflow (from superpowers-workflow)\n"
        printf -- "- Explore project context: FIXEDTOPIC (from superpowers-workflow.explore)\n"
        printf -- "- Ask clarifying questions (from superpowers-workflow.clarify)\n"
        printf -- "- Propose approaches (from superpowers-workflow.approaches)\n"
        printf -- "- Present design sections (from superpowers-workflow.design)\n"
        printf -- "- User approves design (from superpowers-workflow.design-approved)\n"
        printf -- "- Gate: human (from superpowers-workflow.gate-design-approved)\n"
        printf -- "- Write spec to docs/superpowers/specs/ (from superpowers-workflow.write-spec)\n"
        printf -- "- Spec self-review (from superpowers-workflow.spec-review)\n"
        printf -- "- User reviews written spec (from superpowers-workflow.spec-approved)\n"
        printf -- "- Gate: human (from superpowers-workflow.gate-spec-approved)\n"
        printf -- "- Implement FIXEDTOPIC (from superpowers-workflow.implement)\n"
        printf -- "- Verify (from superpowers-workflow.verify)\n"
        printf -- "- Smoke test / manual QA sign-off (from superpowers-workflow.smoke-test-approved)\n"
        printf -- "- Gate: human (from superpowers-workflow.gate-smoke-test-approved)\n"
        printf -- "- Finish development branch (from superpowers-workflow.finish)\n"
        if [ "$3" = "broken" ]; then
          printf -- "- Ghost step (from superpowers-workflow.ghost)\n"
        fi
      else
        case "$3" in
          f)   printf 'ok\n' ;;
          dup) printf '✓ Poured mol: created 16 issues\n  Root issue: proj-dup\n  Phase: liquid (persistent in .beads/)\n' ;;
          *)   printf '✓ Poured mol: created 16 issues\n  Root issue: proj-m1\n  Phase: liquid (persistent in .beads/)\n' ;;
        esac
      fi
      exit 0
    fi
    if [ "$2" = "show" ]; then
      case "$3" in
        *dup*)
          printf '%s\n' '{"issues":[{"id":"proj-xpl","title":"Explore project context: FIXEDTOPIC","issue_type":"task"},{"id":"proj-c1","title":"Ask clarifying questions","issue_type":"task"},{"id":"proj-c2","title":"Ask clarifying questions","issue_type":"task"},{"id":"proj-app","title":"Propose approaches","issue_type":"task"},{"id":"proj-des","title":"Present design sections","issue_type":"task"},{"id":"proj-apr","title":"User approves design","issue_type":"task"},{"id":"proj-g1","title":"Gate: human","issue_type":"gate"},{"id":"proj-wsp","title":"Write spec to docs/superpowers/specs/","issue_type":"task"},{"id":"proj-srv","title":"Spec self-review","issue_type":"task"},{"id":"proj-sap","title":"User reviews written spec","issue_type":"task"},{"id":"proj-g2","title":"Gate: human","issue_type":"gate"},{"id":"proj-imp","title":"Implement FIXEDTOPIC","issue_type":"task"},{"id":"proj-ver","title":"Verify","issue_type":"task"},{"id":"proj-smt","title":"Smoke test / manual QA sign-off","issue_type":"task"},{"id":"proj-g3","title":"Gate: human","issue_type":"gate"},{"id":"proj-fin","title":"Finish development branch","issue_type":"task"}],"dependencies":[{"depends_on_id":"proj-g1","issue_id":"proj-apr","type":"blocks"},{"depends_on_id":"proj-g2","issue_id":"proj-sap","type":"blocks"},{"depends_on_id":"proj-g3","issue_id":"proj-smt","type":"blocks"}]}'
          exit 0 ;;
      esac
      printf '%s\n' '{"issues":[{"id":"proj-xpl","title":"Explore project context: FIXEDTOPIC","issue_type":"task"},{"id":"proj-clr","title":"Ask clarifying questions","issue_type":"task"},{"id":"proj-app","title":"Propose approaches","issue_type":"task"},{"id":"proj-des","title":"Present design sections","issue_type":"task"},{"id":"proj-apr","title":"User approves design","issue_type":"task"},{"id":"proj-g1","title":"Gate: human","issue_type":"gate"},{"id":"proj-wsp","title":"Write spec to docs/superpowers/specs/","issue_type":"task"},{"id":"proj-srv","title":"Spec self-review","issue_type":"task"},{"id":"proj-sap","title":"User reviews written spec","issue_type":"task"},{"id":"proj-g2","title":"Gate: human","issue_type":"gate"},{"id":"proj-imp","title":"Implement FIXEDTOPIC","issue_type":"task"},{"id":"proj-ver","title":"Verify","issue_type":"task"},{"id":"proj-smt","title":"Smoke test / manual QA sign-off","issue_type":"task"},{"id":"proj-g3","title":"Gate: human","issue_type":"gate"},{"id":"proj-fin","title":"Finish development branch","issue_type":"task"}],"dependencies":[{"depends_on_id":"proj-g1","issue_id":"proj-apr","type":"blocks"},{"depends_on_id":"proj-g2","issue_id":"proj-sap","type":"blocks"},{"depends_on_id":"proj-g3","issue_id":"proj-smt","type":"blocks"}]}'
      exit 0
    fi
    echo "ok"; exit 0
    ;;
  list)
    P=""
    prev=""
    for a in "$@"; do
      [ "$prev" = "--parent" ] && P="$a"
      prev="$a"
    done
    if [ -n "$P" ]; then
      case "$P" in
        *2*) printf '{"issues":[{"id":"proj-m2-imp","title":"Implement T2","status":"open","priority":2,"labels":["step:implement"]}],"meta":{"count":1}}' ;;
        *)   printf '{"issues":[{"id":"proj-m1-imp","title":"Implement T1","status":"open","priority":2,"labels":["step:implement"]},{"id":"proj-m1-done","title":"Explore done","status":"closed","priority":2,"labels":["step:implement"]}],"meta":{"count":2}}' ;;
      esac
    elif [ "$MODE" = "umbrella" ]; then
      echo '[{"id": "crmback-1a2", "title": "sample"}]'
    else
      echo '[{"id": "proj-1a2", "title": "sample"}]'
    fi
    exit 0
    ;;
  dep)
    # canned dependents for beads_gate_resolve / beads_close cascade tests
    if [ "$3" = "proj-g1" ] && [ "$5" = "up" ]; then
      printf '%s\n' '[{"id":"proj-apr","title":"User approves design","issue_type":"task","status":"open","dependency_type":"blocks"}]'
      exit 0
    fi
    # cascade fixtures (Task 2): proj-imp has children proj-t1, proj-t2
    if [ "$3" = "proj-t1" ] && [ "$5" = "down" ]; then
      printf '%s\n' '[{"id":"proj-imp","title":"Implement","issue_type":"task","status":"open","dependency_type":"parent-child"}]'
      exit 0
    fi
    if [ "$3" = "proj-t2" ] && [ "$5" = "down" ]; then
      printf '%s\n' '[{"id":"proj-imp","title":"Implement","issue_type":"task","status":"open","dependency_type":"parent-child"}]'
      exit 0
    fi
    if [ "$3" = "proj-imp" ] && [ "$5" = "up" ]; then
      printf '%s\n' '[{"id":"proj-t1","title":"Task 1","issue_type":"task","status":"open","dependency_type":"parent-child"},{"id":"proj-t2","title":"Task 2","issue_type":"task","status":"open","dependency_type":"parent-child"}]'
      exit 0
    fi
    if [ "$3" = "proj-imp" ] && [ "$5" = "down" ]; then
      printf '%s\n' '[{"id":"proj-m1","title":"m1","issue_type":"molecule","status":"open","dependency_type":"parent-child"}]'
      exit 0
    fi
    if [ "$3" = "proj-t9" ] && [ "$5" = "down" ]; then
      printf '%s\n' '[{"id":"proj-imp2","title":"Implement 2","issue_type":"task","status":"open","dependency_type":"parent-child"}]'
      exit 0
    fi
    if [ "$3" = "proj-imp2" ] && [ "$5" = "up" ]; then
      printf '%s\n' '[{"id":"proj-t9","title":"Task 9","issue_type":"task","status":"open","dependency_type":"parent-child"}]'
      exit 0
    fi
    if [ "$3" = "proj-imp2" ] && [ "$5" = "down" ]; then
      printf '%s\n' '[{"id":"proj-m1","title":"m1","issue_type":"molecule","status":"open","dependency_type":"parent-child"}]'
      exit 0
    fi
    if [ "$3" = "proj-g2" ] && [ "$5" = "up" ]; then
      printf '%s\n' '[{"id":"proj-sap","title":"User reviews written spec","issue_type":"task","status":"open","dependency_type":"blocks"}]'
      exit 0
    fi
    # gate resolve failure path: dep list returns non-JSON (no usable dependents)
    if [ "$3" = "proj-gx" ] && [ "$5" = "up" ]; then
      printf '%s\n' 'not json'
      exit 0
    fi
    # mixed-outcome fixture: one gated step closes, one stays blocked
    if [ "$3" = "proj-gm" ] && [ "$5" = "up" ]; then
      printf '%s\n' '[{"id":"proj-ok-step","title":"Ok step","issue_type":"task","status":"open","dependency_type":"blocks"},{"id":"proj-bad-step","title":"Bad step","issue_type":"task","status":"open","dependency_type":"blocks"}]'
      exit 0
    fi
    printf '%s\n' '[]'
    exit 0
    ;;
  close)
    if [ "$2" = "proj-bad-step" ]; then
      echo "boom" >&2
      exit 1
    fi
    echo "ok"; exit 0
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
test("registers all 17 tools, including the seven new ones", async () => {
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
    "beads_mol_ready",
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
  assert.equal(s.tools.length, 17);
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

test("single-repo: beads_gate_resolve resolves gate then closes its gated step (no double-close)", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r = await s.byName.get("beads_gate_resolve").execute("c", { id: "proj-g2" });
  assert.ok(okResult(r), JSON.stringify(r));
  const invs = invocations();
  findInvocation(["gate", "resolve", "proj-g2"]);
  findInvocation(["dep", "list", "proj-g2", "--direction", "up", "--json"]);
  const closeAt = invs.findIndex((iv) => iv[0] === "close" && iv[1] === "proj-sap");
  const depAt = invs.findIndex((iv) => iv[0] === "dep" && iv[1] === "list");
  assert.ok(closeAt >= 0, `expected close of gated step, got ${JSON.stringify(invs)}`);
  assert.ok(closeAt > depAt, "close AFTER dep list");
  // bd 1.2.2 gate resolve already closes the gate -> no separate close on the gate id
  assert.ok(!invs.some((iv) => iv[0] === "close" && iv[1] === "proj-g2"), "no redundant close of the gate");
  assert.equal(s.emitted.length, 2, "emits after gate resolve AND after closing the gated step");
});

test("single-repo: beads_gate_resolve reports lookup failure when dep list is non-JSON (no false success)", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r = await s.byName.get("beads_gate_resolve").execute("c", { id: "proj-gx" });
  assert.ok(okResult(r), JSON.stringify(r));
  const text = r.content[0].text;
  assert.match(text, /could not look up gated step/, `expected lookup-failure message, got: ${text}`);
  assert.ok(!/resolved$/u.test(text.trim()), `must not report plain success, got: ${text}`);
  assert.ok(
    !invocations().some((iv) => iv[0] === "close"),
    "no close attempted when dep list failed",
  );
});

test("single-repo: beads_gate_resolve reports still-blocked steps alongside closed ones", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r = await s.byName.get("beads_gate_resolve").execute("c", { id: "proj-gm" });
  assert.ok(okResult(r), JSON.stringify(r));
  const text = r.content[0].text;
  assert.match(text, /proj-ok-step/, `expected closed step in message, got: ${text}`);
  assert.match(text, /steps still blocked: proj-bad-step/, `expected still-blocked step in message, got: ${text}`);
  findInvocation(["close", "proj-ok-step"]);
  findInvocation(["close", "proj-bad-step"]);
});

test("single-repo: beads_close does NOT cascade while a sibling task is open", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r = await s.byName.get("beads_close").execute("c", { ids: "proj-t1", reason: "done" });
  assert.ok(okResult(r), JSON.stringify(r));
  const invs = invocations();
  findInvocation(["close", "proj-t1", "-r", "done"]);
  assert.ok(!invs.some((iv) => iv[0] === "close" && iv[1] === "proj-imp"), "no cascade while sibling open");
});

test("single-repo: beads_close cascades to close the parent step when its last child closes", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  // proj-t9 is the only child of proj-imp2 -> closing it closes proj-imp2, but NOT the root
  const r = await s.byName.get("beads_close").execute("c", { ids: "proj-t9", reason: "done" });
  assert.ok(okResult(r), JSON.stringify(r));
  const invs = invocations();
  findInvocation(["close", "proj-t9", "-r", "done"]);
  findInvocation(["close", "proj-imp2"]);
  assert.ok(!invs.some((iv) => iv[0] === "close" && iv[1] === "proj-m1"), "never closes the molecule root");
  assert.ok(
    invs.findIndex((iv) => iv[0] === "close" && iv[1] === "proj-imp2") >
      invs.findIndex((iv) => iv[0] === "close" && iv[1] === "proj-t9"),
    "parent closed after child",
  );
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
  assert.equal(s.emitted.length, before + 2);
});

test("single-repo: beads_mol_pour stamps step:<key> on every step and gate", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r = await s.byName.get("beads_mol_pour").execute("c", { proto: "superpowers-workflow", vars: "topic=whatever" });
  assert.ok(okResult(r), JSON.stringify(r));
  assert.match(r.content[0].text, /Root issue: proj-m1/);
  const expect = [
    ["proj-xpl", "step:explore"],
    ["proj-clr", "step:clarify"],
    ["proj-app", "step:approaches"],
    ["proj-des", "step:design"],
    ["proj-apr", "step:design-approved"],
    ["proj-g1", "step:gate-design-approved"],
    ["proj-wsp", "step:write-spec"],
    ["proj-srv", "step:spec-review"],
    ["proj-sap", "step:spec-approved"],
    ["proj-g2", "step:gate-spec-approved"],
    ["proj-imp", "step:implement"],
    ["proj-ver", "step:verify"],
    ["proj-smt", "step:smoke-test-approved"],
    ["proj-g3", "step:gate-smoke-test-approved"],
    ["proj-fin", "step:finish"],
  ];
  for (const [id, lbl] of expect) findInvocation(["update", id, "--add-label", lbl]);
  assertNoInvocation(["update", "proj-m1", "--add-label", "step:superpowers-workflow"]);
  findInvocation(["mol", "pour", "superpowers-workflow", "--var", "topic=whatever", "--dry-run"]);
  assert.equal(invocations().filter((inv) => inv[0] === "update").length, 15);
});

test("single-repo: beads_mol_pour fails loudly when the step map is incomplete", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r = await s.byName.get("beads_mol_pour").execute("c", { proto: "broken" });
  assert.ok(okResult(r), JSON.stringify(r));
  assert.match(r.content[0].text, /could not stamp step labels/);
  assert.equal(invocations().filter((inv) => inv[0] === "update").length, 0);
});

test("single-repo: beads_mol_pour hard-fails on an ambiguous step title (no partial labels)", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r = await s.byName.get("beads_mol_pour").execute("c", { proto: "dup" });
  assert.ok(okResult(r), JSON.stringify(r));
  assert.match(r.content[0].text, /could not stamp step labels/);
  assert.equal(invocations().filter((inv) => inv[0] === "update").length, 0);
});

test("single-repo: read tools never emit beads:changed", async () => {
  const s = await openSession("single", repoDir);
  const reads = [
    ["beads_ready", { limit: 5 }, ["ready", "--json", "--include-ephemeral", "-n", "5"]],
    ["beads_list", { status: "open,in_progress", limit: 7 }, ["list", "--json", "-n", "7", "--status", "open,in_progress"]],
    ["beads_list", { label: "step:implement", mol: "proj-m1" }, ["list", "--json", "-n", "30", "--label", "step:implement", "--all", "--parent", "proj-m1", "--include-gates"]],
    ["beads_list", { mol: "proj-m1" }, ["list", "--json", "-n", "30", "--all", "--parent", "proj-m1", "--include-gates"]],
    ["beads_show", { id: "proj-1a2" }, ["show", "proj-1a2", "--json"]],
    ["beads_deps", { ids: "proj-1a2" }, ["dep", "tree", "proj-1a2", "--direction", "down", "--json"]],
    ["beads_mol_show", { id: "proj-m1" }, ["mol", "show", "proj-m1", "--json"]],
    ["beads_mol_current", { id: "proj-m1" }, ["mol", "current", "proj-m1", "--json"]],
    ["beads_mol_ready", { id: "proj-m1" }, ["ready", "--mol", "proj-m1", "--json"]],
    ["beads_mol_ready", { id: "proj-m1", limit: 2 }, ["ready", "--mol", "proj-m1", "--json", "-n", "2"]],
  ];
  for (const [name, params, argv] of reads) {
    resetLog();
    const r = await s.byName.get(name).execute("c", params);
    assert.ok(okResult(r), `${name} failed: ${JSON.stringify(r)}`);
    findInvocation(argv); // the read really went to bd with the right argv
    assert.equal(s.emitted.length, 0, `${name} must not emit beads:changed`);
  }
});

test("single-repo: beads_list mol scope isolates the same step:implement label across two molecules", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r1 = await s.byName.get("beads_list").execute("c", { label: "step:implement", mol: "proj-m1" });
  assert.match(r1.content[0].text, /proj-m1-imp/);
  assert.doesNotMatch(r1.content[0].text, /proj-m2-imp/);
  resetLog();
  const r2 = await s.byName.get("beads_list").execute("c", { label: "step:implement", mol: "proj-m2" });
  assert.match(r2.content[0].text, /proj-m2-imp/);
  assert.doesNotMatch(r2.content[0].text, /proj-m1-imp/);
  findInvocation(["list", "--json", "-n", "30", "--label", "step:implement", "--all", "--parent", "proj-m2", "--include-gates"]);
});

test("single-repo: beads_list formats object-shape --parent output (normalizes {issues,meta})", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r = await s.byName.get("beads_list").execute("c", { mol: "proj-m1" });
  assert.ok(okResult(r), JSON.stringify(r));
  assert.match(r.content[0].text, /proj-m1-imp/);
});

test("single-repo: beads_list mol resolves closed labeled steps too (--all)", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r = await s.byName.get("beads_list").execute("c", { label: "step:implement", mol: "proj-m1" });
  assert.ok(okResult(r), JSON.stringify(r));
  assert.match(r.content[0].text, /proj-m1-done/); // closed step still resolves
  findInvocation(["list", "--json", "-n", "30", "--label", "step:implement", "--all", "--parent", "proj-m1", "--include-gates"]);
});

test("single-repo: beads_mol_ready digest (ready + empty) without emitting", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r1 = await s.byName.get("beads_mol_ready").execute("c", { id: "proj-m1" });
  const t1 = r1?.content?.[0]?.text ?? "";
  assert.match(t1, /molecule: proj-m0 — Demo Mol · 2\/4 ready/);
  assert.match(t1, /proj-t1 P1 \[open\] Task one/);
  assert.match(t1, /proj-t2 P2 \[open\] Task two/);
  resetLog();
  const r2 = await s.byName.get("beads_mol_ready").execute("c", { id: "proj-empty-m0" });
  const t2 = r2?.content?.[0]?.text ?? "";
  assert.match(t2, /molecule: proj-m0 — Empty Mol · 0\/3 ready/);
  assert.match(t2, /no ready steps \(all blocked or completed\)/);
  assert.equal(s.emitted.length, 0);
});

test("single-repo: beads_mol_ready limit truncates the step rows client-side", async () => {
  const s = await openSession("single", repoDir);
  resetLog();
  const r = await s.byName.get("beads_mol_ready").execute("c", { id: "proj-m1", limit: 1 });
  const t = r?.content?.[0]?.text ?? "";
  assert.match(t, /molecule: proj-m0 — Demo Mol · 2\/4 ready/); // header still reports full counts
  assert.match(t, /proj-t1 P1 \[open\] Task one/);
  assert.ok(!/proj-t2 P2 \[open\] Task two/.test(t), "limit=1 must hide the second ready step row");
  assert.equal(s.emitted.length, 0);
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

test("umbrella: gate_resolve resolves, lists dependents, closes none when dep list empty, one emit", async () => {
  const s = await openSession("umbrella", projDir);
  const before = s.emitted.length;
  resetLog();
  await s.byName.get("beads_gate_resolve").execute("c", { id: "crmback-g1" });
  findInvocation(["gate", "resolve", "crmback-g1"]);
  findInvocation(["dep", "list", "crmback-g1", "--direction", "up", "--json"]);
  // no canned dependents for crmback-g1 -> no gated step to close, no redundant gate close
  assertNoInvocation(["close", "crmback-g1"]);
  assert.equal(s.emitted.length, before + 1);
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
    ["beads_mol_ready", { id: "crmback-m1" }],
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
