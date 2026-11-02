/**
 * rex-pane-harness.ts — a fake `rex` plus a stub child, so a pane run can be
 * driven end to end without a Rex server and without a real model.
 *
 * The two halves are deliberately separate processes, because that is what the
 * production path is: the parent spawns `rex`, Rex runs the pane's command, and
 * the command is a `pi` the parent never holds a handle on. So the fake `rex`
 * *actually runs* the command from `session.new_layer` (through a one-file
 * supervisor that records its exit status) and answers `process`, `wait`,
 * `capture` and `close_layer` the way the measured CLI does:
 *
 *   - `block call … process` → `{ last_exit: null }` while the program runs,
 *     `{ last_exit: { exit_code } }` once it has exited;
 *   - `wait … --json` → the `child_exited` payload on stdout and the child's own
 *     status as the CLI's exit code, `not found` for a block that has closed, and
 *     `wait timed out` for `--for` expiring (measured on Rex 0.0.1793420730);
 *   - `capture` → whatever the screen holds (nothing, for a pane that closed);
 *   - `close_layer` → the program is killed, as closing a layer ends it.
 *
 * Every invocation appends its argv to a log, one JSON array per line, because a
 * pane label contains spaces. `REX_FAKE_*` knobs pick the failure cases: a
 * refused minimize, a `new_layer` that fails, a server that stops answering
 * mid-run, a block that is already gone.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Every knob the fake reads, so a test can clear the ones it does not set. */
export const FAKE_REX_ENV_KEYS = [
  "REX_FAKE_LOG",
  "REX_FAKE_STATE_DIR",
  "REX_FAKE_NEW_LAYER",
  "REX_FAKE_SET_LAYER_STATE",
  "REX_FAKE_PROGRAM_STATUS",
  "REX_FAKE_PROCESS",
  "REX_FAKE_CAPTURE_TEXT",
  "REX_FAKE_UNAVAILABLE",
  "REX_FAKE_FAST_CLOSE",
  "REX_FAKE_CLOSE_LAYER",
] as const;

/** The stub child's own knobs. */
export const STUB_CHILD_ENV_KEYS = ["STUB_MODE", "STUB_LINE"] as const;

/**
 * The supervisor: runs the pane's command, records its exit status, and stays
 * out of the way. Separate from the fake `rex` because that process answers the
 * API call and exits long before the child does.
 */
const SUPERVISOR_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const spec = JSON.parse(process.argv[2]);
const child = spawn(spec.command[0], spec.command.slice(1), {
  cwd: spec.cwd,
  // Nothing reads the pane's screen in these tests, and a stub that prints must
  // not block on a pipe nobody drains.
  stdio: "ignore",
  env: process.env,
});
fs.writeFileSync(spec.pidFile, String(child.pid ?? ""));
const finish = (code) => {
  // Atomic, because the fake rex polls this file while the child is finishing:
  // a half-written status would read as a parse error exactly once.
  const tmp = spec.exitFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ exit_code: code }));
  fs.renameSync(tmp, spec.exitFile);
  // A child that fails closes its own pane within a second or two (measured), so
  // one knob reproduces the case where nothing is capturable afterwards.
  if (spec.closeOnExit) fs.writeFileSync(spec.exitFile + ".closed", "");
};
child.on("exit", (code) => finish(code === null ? -1 : code));
child.on("error", () => finish(-1));
`;

/**
 * The fake CLI. Answers each subcommand the launcher and the run use with the
 * shape the real CLI prints, and runs the pane's command for real.
 */
function fakeRexSource(): string {
  return [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawn } = require("node:child_process");',
    "const env = process.env;",
    "const args = process.argv.slice(2);",
    'fs.appendFileSync(env.REX_FAKE_LOG, JSON.stringify(args) + "\\n");',
    "const out = (value) => process.stdout.write(JSON.stringify(value));",
    'const fail = (message, code) => { process.stderr.write("Error: " + message + "\\n"); process.exit(code); };',
    // A server that stopped answering, which is not the same thing as a block
    // that is gone: the run must keep going and settle from the result file.
    'if (env.REX_FAKE_UNAVAILABLE === "1") fail("dial unix: connection refused", 1);',
    "const stateDir = env.REX_FAKE_STATE_DIR;",
    "const flagValue = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };",
    "const positionals = () => {",
    "  const out = [];",
    "  for (let i = 0; i < args.length; i++) {",
    "    const arg = args[i];",
    '    if (arg === "-s" || arg === "-w" || arg === "--for") { i++; continue; }',
    '    if (arg.startsWith("-")) continue;',
    "    out.push(arg);",
    "  }",
    "  return out;",
    "};",
    "function recordFor(blockId) {",
    '  const file = path.join(stateDir, blockId + ".json");',
    "  try {",
    '    const record = JSON.parse(fs.readFileSync(file, "utf-8"));',
    // A closed layer is gone: `process`, `wait` and `capture` all say so, which is
    // what the run relies on after an abort.
    '    if (fs.existsSync(record.exitFile + ".closed")) return undefined;',
    "    return record;",
    '  } catch { return undefined; }',
    "}",
    "function exitStatus(blockId) {",
    "  const record = recordFor(blockId);",
    "  if (!record) return undefined;",
    '  try { return JSON.parse(fs.readFileSync(record.exitFile, "utf-8")).exit_code; } catch { return undefined; }',
    "}",
    "function newLayer(body) {",
    '  if (env.REX_FAKE_NEW_LAYER === "fail") fail("bad_request: layout", 1);',
    "  const request = JSON.parse(body);",
    '  const id = Math.random().toString(36).slice(2, 10);',
    '  const blockId = "block-" + id;',
    "  const options = request.layout.block.options;",
    "  const pidFile = path.join(stateDir, blockId + '.pid');",
    "  const exitFile = path.join(stateDir, blockId + '.exit');",
    '  const spec = { command: options.command, cwd: options.cwd, pidFile, exitFile, closeOnExit: env.REX_FAKE_FAST_CLOSE === "1" };',
    '  fs.writeFileSync(path.join(stateDir, blockId + ".json"), JSON.stringify(spec));',
    '  spawn(process.execPath, [path.join(stateDir, "supervisor.js"), JSON.stringify(spec)], { detached: true, stdio: "ignore" }).unref();',
    '  out({ layer_id: "layer-" + id, block_ids: [blockId], revision: 1 });',
    "}",
    "function apiCall(method, body) {",
    '  if (method === "session.new_layer") return newLayer(body);',
    '  if (method === "session.set_layer_state") {',
    '    if (env.REX_FAKE_SET_LAYER_STATE === "bad_request") fail("bad_request: a window must keep a visible pane", 1);',
    "    return out({ revision: 2 });",
    "  }",
    '  if (method === "session.close_layer") {',
    // A close the server refuses: the pane is still there, and a shutdown has to
    // be able to say so instead of reporting a cleanup it did not perform.
    '    if (env.REX_FAKE_CLOSE_LAYER === "error") fail("internal: the server is wedged", 1);',
    '    const blockId = "block-" + String(JSON.parse(body).layer_id).replace(/^layer-/, "");',
    "    const record = recordFor(blockId);",
    "    if (record) {",
    "      fs.writeFileSync(record.exitFile + '.closed', '');",
    '      try { process.kill(Number(fs.readFileSync(record.pidFile, "utf-8")), "SIGTERM"); } catch { /* already gone */ }',
    "    }",
    "    return out({ revision: 3 });",
    "  }",
    '  fail("unknown method " + method, 2);',
    "}",
    "function blockCall(blockId, method) {",
    "  const record = recordFor(blockId);",
    '  if (!record) fail("block target " + blockId + " not found", 3);',
    '  if (method === "process") {',
    '    if (env.REX_FAKE_PROCESS === "missing") fail("block target " + blockId + " not found", 3);',
    "    const code = exitStatus(blockId);",
    '    out({ last_exit: code === undefined ? null : { exit_code: code, error: "exit status " + code }, child: null });',
    "    return;",
    "  }",
    '  if (method === "program_status") {',
    "    // The root record carries no `id` — measured against a live pane. An",
    "    // `id: \"\"` root is a different record, and leaving it empty would make",
    "    // every status read as null.",
    '    out({ records: env.REX_FAKE_PROGRAM_STATUS ? [{ state: env.REX_FAKE_PROGRAM_STATUS }] : [] });',
    "    return;",
    "  }",
    '  fail("unknown method " + method, 2);',
    "}",
    "function parseDuration(text) {",
    '  if (typeof text !== "string") return 30000;',
    '  if (text.endsWith("ms")) return Number(text.slice(0, -2)) || 0;',
    '  if (text.endsWith("s")) return (Number(text.slice(0, -1)) || 0) * 1000;',
    '  if (text.endsWith("m")) return (Number(text.slice(0, -1)) || 0) * 60000;',
    "  return Number(text) || 0;",
    "}",
    "function waitFor(target) {",
    "  const deadline = Date.now() + parseDuration(flagValue('--for'));",
    "  for (;;) {",
    "    const code = exitStatus(target);",
    "    if (code !== undefined) {",
    '      out(code === 0 ? { exit_code: code } : { exit_code: code, error: "exit status " + code });',
    "      process.exit(Math.min(code, 255));",
    "    }",
    '    if (!recordFor(target)) fail("block or window target " + target + " not found", 3);',
    '    if (Date.now() >= deadline) fail("wait timed out after " + flagValue("--for"), 1);',
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
    "  }",
    "}",
    'if (args[0] === "api" && args[1] === "call") apiCall(args[4], args[5] ?? "{}");',
    'else if (args[0] === "block" && args[1] === "call") blockCall(flagValue("-b"), args[args.length - 1]);',
    'else if (args[0] === "block" && args[1] === "inspect") out({ block: { block_id: positionals()[1], window_id: "window:1" } });',
    'else if (args[0] === "capture") {',
    '  if (!recordFor(flagValue("-b"))) fail("block target " + flagValue("-b") + " not found", 3);',
    '  process.stdout.write(env.REX_FAKE_CAPTURE_TEXT || "");',
    '} else if (args[0] === "wait") waitFor(positionals()[1]);',
    'else if (args[0] === "send") out({ revision: 4 });',
    'else if (args[0] === "send-key") out({ revision: 5 });',
    'else if (args[0] === "whoami") out({ rex_version: "fake" });',
    'else fail("unknown command", 2);',
  ].join("\n");
}

/**
 * The stub child: a `pi` stand-in that writes the session file the parent tails
 * and the result file the parent settles on, and does nothing else.
 *
 * It reads its spec exactly as the real child does (the environment variable the
 * launcher sets), writes the session file pi would have written under
 * `--session-dir`, and reports through the same result keys — so the parent's
 * reader is exercised against the real contract rather than a convenient one.
 */
function stubChildSource(): string {
  return [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const argv = process.argv.slice(2);",
    "const argOf = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };",
    "const specPath = process.env.PI_SUBAGENTS_CHILD_SPEC;",
    'const spec = specPath ? JSON.parse(fs.readFileSync(specPath, "utf-8")) : undefined;',
    'const mode = process.env.STUB_MODE || "ok";',
    'const line = process.env.STUB_LINE || "the answer";',
    "function sessionFile() {",
    '  const explicit = argOf("--session");',
    "  if (explicit) return explicit;",
    '  const dir = argOf("--session-dir");',
    '  const id = argOf("--session-id");',
    "  fs.mkdirSync(dir, { recursive: true });",
    '  return path.join(dir, "2026-11-02T00-00-00-000Z_" + id + ".jsonl");',
    "}",
    "function writeSession(file) {",
    "  // Ids are unique per run: a resume appends to the same file, and the tail",
    "  // walks the branch by id, so a repeated id would read as a rewind.",
    '  const tag = Math.random().toString(36).slice(2, 8);',
    '  fs.appendFileSync(file, [',
    '    JSON.stringify({',
    '      type: "message", id: "u-" + tag, parentId: null,',
    '      message: { role: "user", content: "the task", timestamp: 1 },',
    "    }),",
    '    JSON.stringify({',
    '      type: "message", id: "a-" + tag, parentId: "u-" + tag,',
    '      message: {',
    '        role: "assistant",',
    '        content: [{ type: "text", text: line }],',
    '        api: "anthropic", provider: "anthropic", model: "claude-sonnet-4",',
    '        usage: { input: 10, output: 20, cacheWrite: 5, cacheRead: 1, cost: { total: 0.25 } },',
    '        stopReason: "stop", timestamp: 2,',
    "      },",
    "    }),",
    "  ].join(\"\\n\") + \"\\n\");",
    "  return file;",
    "}",
    "function writeResult(extra) {",
    "  if (!spec) return;",
    '  const tmp = spec.resultPath + ".tmp";',
    "  // The optional keys are absent when the child had nothing to say, which is",
    "  // what the parent's reader has to tolerate.",
    "  const payload = Object.assign(",
    '    { text: line, aborted: false, steered: false, usage: { input: 10, output: 20, cacheWrite: 5 }, turns: 1 },',
    "    extra || {},",
    "  );",
    '  fs.mkdirSync(path.dirname(spec.resultPath), { recursive: true });',
    '  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));',
    '  fs.renameSync(tmp, spec.resultPath);',
    "}",
    "const file = sessionFile();",
    // A child that writes its session file later than the parent's 2 s grace
    // window, and its result later still: discovery has to keep looking.
    'const lateSession = mode === "slow-start";',
    "if (lateSession) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);",
    "writeSession(file);",
    "if (lateSession) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);",
    'if (mode === "silent-exit") process.exit(3);',
    'if (mode === "structured") writeResult({ structuredJson: \'{"answer":"42"}\', structuredRetried: true });',
    'else if (mode === "slow-result") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); writeResult(); }',
    // Writes its result while staying alive: a run that waited for the exit
    // would never come back inside a test.
    'else if (mode === "result-early") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); writeResult(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); }',
    // Never reports, and stays alive: only something closing its pane ends it, so a
    // test that relies on that cannot race a result landing first.
    'else if (mode === "hold") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); process.exit(0); }',
    'else if (mode !== "no-result") writeResult();',
    'if (mode === "no-result") process.stderr.write("the child died before reporting\\n");',
    'process.exit(mode === "no-result" ? 3 : 0);',
  ].join("\n");
}

export interface FakeRex {
  /** The `pi` the parent should launch in the pane. */
  stubBinary: string;
  /** Every argv the fake was invoked with, in order. */
  calls(): string[][];
  /** Calls whose first two words are `api call`, i.e. the pane lifecycle. */
  paneCalls(): string[][];
  restore(): void;
}

/**
 * Install the fake `rex`, the supervisor and the stub child in one temp dir and
 * put it first on PATH.
 */
export function installFakeRex(): FakeRex {
  const root = mkdtempSync(join(tmpdir(), "pi-rex-pane-"));
  const binDir = join(root, "bin");
  const stateDir = join(root, "state");
  const logFile = join(root, "calls.log");
  const stubBinary = join(root, "stub-pi");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const rex = join(binDir, "rex");
  writeFileSync(rex, fakeRexSource());
  chmodSync(rex, 0o755);
  writeFileSync(join(stateDir, "supervisor.js"), SUPERVISOR_SOURCE);
  writeFileSync(stubBinary, stubChildSource());
  chmodSync(stubBinary, 0o755);

  const previousPath = process.env.PATH;
  const previous = new Map<string, string | undefined>();
  for (const key of [...FAKE_REX_ENV_KEYS, ...STUB_CHILD_ENV_KEYS]) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  // `dirname(process.execPath)` resolves the fake's and the stub's shebangs: the
  // test must not depend on where node happens to live.
  process.env.PATH = `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.REX_FAKE_LOG = logFile;
  process.env.REX_FAKE_STATE_DIR = stateDir;

  const calls = (): string[][] => {
    let text = "";
    try {
      text = readFileSync(logFile, "utf-8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as string[]);
  };

  return {
    stubBinary,
    calls,
    paneCalls: () => calls().filter((call) => call[0] === "api" && call[1] === "call"),
    restore() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
