/**
 * rex-cli.test.ts — the exec layer: `execRex`, the pane verbs, and the queue
 * that keeps one spawn's create-and-minimize from interleaving with another's.
 *
 * Every case here drives a fake `rex` on PATH rather than a Rex server, so the
 * argv is the assertion: the pane API is a handful of documented vectors
 * (`session.new_layer`, `session.set_layer_state`, `session.close_layer`,
 * `block call process`, `capture`) and a typo in one of them is a bug the type
 * system cannot see.
 *
 * The fake appends its argv to `$REX_FAKE_LOG` as one JSON array per line —
 * JSON, not space-joined, because a pane label may contain spaces. Canned
 * replies come from `REX_FAKE_*` environment variables, including the failures
 * that must never become throws (a refused minimize, a pane that already
 * closed, a `rex` that is not installed).
 *
 * The serialization case is the one with a race in it: `REX_FAKE_DELAY_MS`
 * widens the window in which a create is on the wire, which is the window
 * (21-29 ms, measured) that a fan-out must not scramble.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePane, launchPane, minimizePane, paneBoundsForIndex } from "../src/rex/launcher.js";
import {
  captureTail,
  DEFAULT_CAPTURE_TAIL_LINES,
  execRex,
  type PaneDeps,
  readProcessState,
  rexReply,
} from "../src/rex/rex-cli.js";

const SESSION = "session:pane";
const WINDOW = "window:1";

/** Every `REX_FAKE_*` knob the fake reads, so each test starts with none set. */
const FAKE_ENV_KEYS = [
  "REX_FAKE_LOG",
  "REX_FAKE_DELAY_MS",
  "REX_FAKE_NEW_LAYER",
  "REX_FAKE_SET_LAYER_STATE",
  "REX_FAKE_CLOSE_LAYER",
  "REX_FAKE_EXIT_CODE",
  "REX_FAKE_PROGRAM_STATUS",
  "REX_FAKE_PROCESS",
  "REX_FAKE_HOLD_EXIT",
  "REX_FAKE_CAPTURE",
  "REX_FAKE_CAPTURE_TEXT",
] as const;

/**
 * The fake CLI. It answers each subcommand the launcher uses with the shape the
 * real CLI prints, and it derives the created ids from the pane label so a test
 * can tell two concurrent creates apart in the log.
 */
function fakeRexSource(): string {
  return [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const env = process.env;",
    "const args = process.argv.slice(2);",
    'fs.appendFileSync(env.REX_FAKE_LOG, JSON.stringify(args) + "\\n");',
    // A synchronous sleep: it holds the fake open, which is what makes an
    // unserialized second create visible in the log.
    "if (env.REX_FAKE_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.REX_FAKE_DELAY_MS));",
    "const out = (value) => process.stdout.write(JSON.stringify(value));",
    'const fail = (message, code) => { process.stderr.write("Error: " + message + "\\n"); process.exit(code); };',
    "function apiCall(method, body) {",
    '  if (method === "session.new_layer") {',
    '    if (env.REX_FAKE_NEW_LAYER === "fail") fail("bad_request: layout", 1);',
    '    if (env.REX_FAKE_NEW_LAYER === "no_layer_id") { out({ layer_id: null, block_ids: ["block:orphan"], revision: 1 }); return; }',
    '    if (env.REX_FAKE_NEW_LAYER === "no_block_ids") { out({ layer_id: "layer:orphan", block_ids: [], revision: 1 }); return; }',
    '    if (env.REX_FAKE_NEW_LAYER === "no_ids") { out({ layer_id: null, block_ids: null, revision: 1 }); return; }',
    "    const label = JSON.parse(body).layout.block.label;",
    '    out({ layer_id: "layer:" + label, block_ids: ["block:" + label], revision: 1 });',
    '  } else if (method === "session.set_layer_state") {',
    '    if (env.REX_FAKE_SET_LAYER_STATE === "bad_request") fail("bad_request: last visible pane", 1);',
    // A failure with nothing on stderr: the reason has to fall back to the
    // caller's generic text rather than an empty string.
    '    if (env.REX_FAKE_SET_LAYER_STATE === "quiet") process.exit(1);',
    "    out({ revision: 2 });",
    '  } else if (method === "session.close_layer") {',
    '    if (env.REX_FAKE_CLOSE_LAYER === "not_found") fail("not_found: no layer", 1);',
    "    out({ revision: 3 });",
    '  } else fail("unknown method " + method, 2);',
    "}",
    "function blockCall(method) {",
    '  const blockId = args[args.indexOf("-b") + 1];',
    '  if (method === "process") {',
    '    if (env.REX_FAKE_PROCESS === "missing") fail("block target " + blockId + " not found", 3);',
    "    const code = env.REX_FAKE_EXIT_CODE;",
    '    out({ last_exit: code === undefined ? null : { exit_code: Number(code), error: "exit status " + code }, child: null });',
    '  } else if (method === "program_status") {',
    '    out({ records: env.REX_FAKE_PROGRAM_STATUS ? [{ state: env.REX_FAKE_PROGRAM_STATUS }] : [] });',
    '  } else fail("unknown method " + method, 2);',
    "}",
    'if (args[0] === "api" && args[1] === "call") apiCall(args[4], args[5] ?? "{}");',
    'else if (args[0] === "block" && args[1] === "call") blockCall(args[args.length - 1]);',
    'else if (args[0] === "capture") {',
    '  if (env.REX_FAKE_CAPTURE === "missing") fail("block target " + args[4] + " not found", 3);',
    '  process.stdout.write(env.REX_FAKE_CAPTURE_TEXT || "");',
    '} else if (args[0] === "whoami") out({ rex_version: "fake" });',
    // A `rex` that never answers: the timeout has to kill it.
    'else if (args[0] === "sleep") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);',
    // A `rex` that exits 0 at once while a grandchild keeps the inherited pipes
    // open: `'close'` on the parent side then cannot fire until the grandchild is
    // gone, which is the case the timeout has to settle without.
    'else if (args[0] === "hold") {',
    '  require("node:child_process").spawn("sleep", [args[1] ?? "3"], { stdio: "inherit" }).unref();',
    '  if (env.REX_FAKE_HOLD_EXIT === "0") process.exit(0);',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);',
    "}",
    // A `rex` that answers with a failure.
    'else if (args[0] === "fail") fail("boom", 7);',
    'else fail("unknown command", 2);',
  ].join("\n");
}

let binDir = "";
let logFile = "";
let emptyDir = "";
let savedPath: string | undefined;
let savedEnv: Map<string, string | undefined> = new Map();

/** The deps every verb takes: the real `execRex`, and the pane's session ids. */
function deps(): PaneDeps {
  return { exec: execRex, sessionId: SESSION, windowId: WINDOW };
}

/** Every argv the fake was invoked with, in order. */
function calls(): string[][] {
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
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "pi-rex-cli-"));
  emptyDir = mkdtempSync(join(tmpdir(), "pi-rex-cli-empty-"));
  logFile = join(binDir, "calls.log");
  const rex = join(binDir, "rex");
  writeFileSync(rex, fakeRexSource());
  chmodSync(rex, 0o755);

  savedPath = process.env.PATH;
  savedEnv = new Map(FAKE_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of FAKE_ENV_KEYS) delete process.env[key];
  // `dirname(process.execPath)` is on PATH so the fake's `#!/usr/bin/env node`
  // shebang resolves: the test must not depend on where node happens to live.
  process.env.PATH = `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.REX_FAKE_LOG = logFile;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(binDir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("execRex — the only place this package spawns rex", () => {
  it("returns the exit status and both streams", async () => {
    const result = await execRex(["whoami", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rex_version: "fake" });
    expect(result.stderr).toBe("");
  });

  it("reports a failed call as a status and stderr, never a rejection", async () => {
    const result = await execRex(["fail"]);

    expect(result.code).toBe(7);
    expect(result.stderr).toContain("boom");
  });

  it("reports a missing rex as -1 instead of throwing ENOENT into the caller", async () => {
    process.env.PATH = emptyDir;

    const result = await execRex(["whoami", "--json"]);

    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("rex");
  });

  it("kills a rex that hangs past the timeout", async () => {
    const result = await execRex(["sleep"], { timeoutMs: 100 });

    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("timed out");
  });

  // The pane queue only moves when the call in it settles, so a `rex` whose
  // stdio stays open after it is killed must not be able to hold the queue: the
  // promise settles on its own, not on the stream closing.
  it("settles on the timeout even when a grandchild keeps the pipes open", async () => {
    const started = Date.now();
    // The fake exits 0 at once and leaves `sleep 3` holding the inherited pipes,
    // so `'close'` cannot fire until the grandchild is gone.
    process.env.REX_FAKE_HOLD_EXIT = "0";
    const result = await execRex(["hold", "3"], { timeoutMs: 100 });
    const elapsed = Date.now() - started;

    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("timed out");
    // Well before the 3 s the pipes stay open: the backstop settled it.
    expect(elapsed).toBeLessThan(2000);
  });

  it("reports a timeout, not success, when the child exits 0 as the timer fires", async () => {
    // Same shape with a grandchild that lets go after the timeout but before the
    // backstop: `'close'` then arrives carrying a clean exit status, which must
    // not be reported as a successful call.
    process.env.REX_FAKE_HOLD_EXIT = "0";

    const result = await execRex(["hold", "0.4"], { timeoutMs: 300 });

    expect(result).toMatchObject({ code: -1 });
    expect(result.stderr).toContain("timed out");
  });

  // The three ways `rexReply()` has no body to read, asserted where the
  // decision is made rather than through a caller that would mask it.
  it("reads no reply body from a failed call, non-JSON, or a JSON array", () => {
    expect(rexReply({ code: 1, stdout: "{}", stderr: "" })).toBeUndefined();
    expect(rexReply({ code: 0, stdout: "not json", stderr: "" })).toBeUndefined();
    expect(rexReply({ code: 0, stdout: "[1,2]", stderr: "" })).toBeUndefined();
    expect(rexReply({ code: 0, stdout: '{"layer_id":"layer:a"}', stderr: "" })).toEqual({ layer_id: "layer:a" });
  });
});

describe("launchPane — create the pane, then minimize it", () => {
  it("creates the layer unfocused, minimizes its own layer, and returns its ids", async () => {
    const launched = await launchPane({
      deps: deps(),
      label: "explore · find the pane",
      command: ["/usr/bin/env", "PI_SUBAGENTS_CHILD_SPEC=/tmp/a/spec.json", "/bin/pi"],
      cwd: "/work/dir",
      index: 1,
    });

    // The fake derives both ids from the label, so an id that comes back is
    // proof this launch's own reply was read.
    expect(launched).toEqual({
      layerId: "layer:explore · find the pane",
      blockId: "block:explore · find the pane",
      minimize: { minimized: true },
    });

    const [create, minimize] = calls();
    expect(create.slice(0, 5)).toEqual(["api", "call", "-s", SESSION, "session.new_layer"]);
    expect(JSON.parse(create[5])).toEqual({
      session_id: SESSION,
      window_id: WINDOW,
      bounds: paneBoundsForIndex(1),
      focus: false,
      layout: {
        block: {
          flavor: "com.superlogical.terminal.shell",
          label: "explore · find the pane",
          options: {
            command: ["/usr/bin/env", "PI_SUBAGENTS_CHILD_SPEC=/tmp/a/spec.json", "/bin/pi"],
            cwd: "/work/dir",
            exit: { on_completion: true },
          },
        },
      },
    });
    // No `shell` key: it would run the command under /usr/bin/login and report
    // exit 0 for every outcome.
    expect(Object.keys(JSON.parse(create[5]).layout.block.options).sort()).toEqual(["command", "cwd", "exit"]);

    expect(minimize).toEqual([
      "api",
      "call",
      "-s",
      SESSION,
      "session.set_layer_state",
      JSON.stringify({ layer_id: "layer:explore · find the pane", state: "minimized" }),
    ]);
    expect(calls()).toHaveLength(2);
  });

  it("returns undefined when the create call fails, and leaves no pane to minimize", async () => {
    process.env.REX_FAKE_NEW_LAYER = "fail";

    await expect(launchPane({ deps: deps(), label: "a", command: ["/bin/pi"], cwd: "/w", index: 0 })).resolves.toBe(
      undefined,
    );
    expect(calls()).toHaveLength(1);
  });

  it("resolves undefined when the exec seam throws, rather than into the manager", async () => {
    // `RexExec` is documented as never rejecting. A deps object that does anyway
    // must still not carry a rejection into a spawn, where it would take down a
    // fan-out that could otherwise have fallen back to the in-process runner.
    const started = launchPane({
      deps: { exec: () => Promise.reject(new Error("boom")), sessionId: SESSION, windowId: WINDOW },
      label: "a",
      command: ["/bin/pi"],
      cwd: "/w",
      index: 0,
    });

    await expect(started).resolves.toBeUndefined();
  });

  // Half an id is no id: without a layer id the pane could never be minimized or
  // closed, without a block id nothing could read its process or its screen.
  for (const [mode, why] of [
    ["no_ids", "neither id"],
    ["no_layer_id", "no layer id"],
    ["no_block_ids", "no block id"],
  ] as const) {
    it(`returns undefined for a reply with ${why}, which leaves a pane nothing could reach`, async () => {
      process.env.REX_FAKE_NEW_LAYER = mode;

      await expect(
        launchPane({ deps: deps(), label: "a", command: ["/bin/pi"], cwd: "/w", index: 0 }),
      ).resolves.toBe(undefined);
      // Nothing to minimize: an untrackable pane is treated as no pane.
      expect(calls()).toHaveLength(1);
    });
  }

  it("still returns the ids when the minimize is refused, and carries why in the result", async () => {
    process.env.REX_FAKE_SET_LAYER_STATE = "bad_request";
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const launched = await launchPane({ deps: deps(), label: "a", command: ["/bin/pi"], cwd: "/w", index: 0 });

      // The child is already running, so the launch stands — but the pane is on
      // screen, and nothing may claim it was minimized. The reason travels in
      // the value, so a caller can put it in the tool result.
      expect(launched).toEqual({
        layerId: "layer:a",
        blockId: "block:a",
        minimize: { minimized: false, reason: "bad_request: last visible pane" },
      });
      expect(calls().map((call) => call[4])).toEqual(["session.new_layer", "session.set_layer_state"]);
      // The log line is extra, and repeats the same reason.
      expect(warned).toHaveBeenCalledTimes(1);
      expect(warned.mock.calls[0]?.[0]).toContain("could not be minimized");
      expect(warned.mock.calls[0]?.[0]).toContain("bad_request: last visible pane");
    } finally {
      warned.mockRestore();
    }
  });
});

describe("minimizePane — a refusal is an answer, not an exception", () => {
  it("is true when the server accepts the state change", async () => {
    await expect(minimizePane(deps(), "layer:a")).resolves.toEqual({ minimized: true });
    expect(calls()).toEqual([
      [
        "api",
        "call",
        "-s",
        SESSION,
        "session.set_layer_state",
        JSON.stringify({ layer_id: "layer:a", state: "minimized" }),
      ],
    ]);
  });

  it("is false with Rex's own reason on bad_request — a window that would lose its last visible pane", async () => {
    process.env.REX_FAKE_SET_LAYER_STATE = "bad_request";

    // The reason is the message, not the CLI's `Error: ` decoration: it is
    // going into a tool result a user reads.
    await expect(minimizePane(deps(), "layer:a")).resolves.toEqual({
      minimized: false,
      reason: "bad_request: last visible pane",
    });
  });

  it("falls back to a generic reason when the CLI fails without saying why", async () => {
    process.env.REX_FAKE_SET_LAYER_STATE = "quiet";

    // No diagnostic means no evidence about the cause: calling this a
    // `bad_request` would be a guess, and a timeout looks exactly like this.
    await expect(minimizePane(deps(), "layer:a")).resolves.toEqual({
      minimized: false,
      reason: "rex call failed",
    });
  });

  it("carries the spawn failure as the reason when rex cannot be started at all", async () => {
    process.env.PATH = emptyDir;

    const result = await minimizePane(deps(), "layer:a");

    expect(result).toMatchObject({ minimized: false });
    // Not a `bad_request`: the call never reached a server, and the caller is
    // told what actually went wrong.
    expect(result.minimized === false && result.reason).toContain("rex");
  });
});

describe("the queue — one spawn's create and minimize never interleave with another's", () => {
  it("runs the two launches' calls in order, each minimize against its own layer", async () => {
    // The window in which a create is on the wire: widened so an unserialized
    // second create has every chance to log before the first minimizes.
    process.env.REX_FAKE_DELAY_MS = "40";

    const [first, second] = await Promise.all([
      launchPane({ deps: deps(), label: "agent-a", command: ["/bin/pi"], cwd: "/w", index: 0 }),
      launchPane({ deps: deps(), label: "agent-b", command: ["/bin/pi"], cwd: "/w", index: 1 }),
    ]);

    expect(first).toEqual({
      layerId: "layer:agent-a",
      blockId: "block:agent-a",
      minimize: { minimized: true },
    });
    expect(second).toEqual({
      layerId: "layer:agent-b",
      blockId: "block:agent-b",
      minimize: { minimized: true },
    });

    expect(calls().map((call) => [call[4], JSON.parse(call[5] ?? "{}").layer_id ?? null])).toEqual([
      ["session.new_layer", null],
      ["session.set_layer_state", "layer:agent-a"],
      ["session.new_layer", null],
      ["session.set_layer_state", "layer:agent-b"],
    ]);
  });
});

describe("closePane — cleanup that tolerates a pane already gone", () => {
  it("closes the layer it created", async () => {
    await expect(closePane(deps(), "layer:a")).resolves.toBeUndefined();

    expect(calls()).toEqual([
      ["api", "call", "-s", SESSION, "session.close_layer", JSON.stringify({ layer_id: "layer:a" })],
    ]);
  });

  it("resolves when the layer is already closed", async () => {
    process.env.REX_FAKE_CLOSE_LAYER = "not_found";

    await expect(closePane(deps(), "layer:a")).resolves.toBeUndefined();
  });
});

describe("readProcessState — the pane's exit status and what it says it is doing", () => {
  it("reads the exit code and the program's own state", async () => {
    process.env.REX_FAKE_EXIT_CODE = "3";
    process.env.REX_FAKE_PROGRAM_STATUS = "working";

    await expect(readProcessState(deps(), "block:a")).resolves.toEqual({ lastExit: 3, status: "working" });
    expect(calls()).toEqual([
      ["block", "call", "-s", SESSION, "-b", "block:a", "process"],
      ["block", "call", "-s", SESSION, "-b", "block:a", "program_status"],
    ]);
  });

  it("reports a blocked child, which is waiting for a human rather than working", async () => {
    process.env.REX_FAKE_PROGRAM_STATUS = "blocked";

    await expect(readProcessState(deps(), "block:a")).resolves.toEqual({ lastExit: null, status: "blocked" });
  });

  it("reports nothing when the pane is gone, without asking a second question", async () => {
    // Only `process` fails: `program_status` would still answer, so the log is
    // what proves the second question is never asked.
    process.env.REX_FAKE_PROCESS = "missing";

    await expect(readProcessState(deps(), "block:a")).resolves.toEqual({ lastExit: null, status: null });
    expect(calls()).toEqual([["block", "call", "-s", SESSION, "-b", "block:a", "process"]]);
  });
});

describe("captureTail — the pane's last lines, for a run that ended without a result", () => {
  const screen = ["line 1", "line 2", "line 3", "line 4", "line 5", ""].join("\n");

  it("prints the trimmed screen, keeping the last N lines", async () => {
    process.env.REX_FAKE_CAPTURE_TEXT = screen;

    await expect(captureTail(deps(), "block:a", 2)).resolves.toBe("line 4\nline 5");
    // A nonsensical request still shows a line rather than nothing.
    await expect(captureTail(deps(), "block:a", 0)).resolves.toBe("line 5");
    expect(calls()).toEqual([
      ["capture", "-s", SESSION, "-b", "block:a", "--trim"],
      ["capture", "-s", SESSION, "-b", "block:a", "--trim"],
    ]);
  });

  it("keeps a bounded tail by default, so a long scrollback cannot flood a report", async () => {
    const long = Array.from({ length: DEFAULT_CAPTURE_TAIL_LINES + 5 }, (_, i) => `line ${i + 1}`);
    process.env.REX_FAKE_CAPTURE_TEXT = `${long.join("\n")}\n`;

    const tail = await captureTail(deps(), "block:a");

    expect(tail.split("\n")).toEqual(long.slice(-DEFAULT_CAPTURE_TAIL_LINES));
    expect(tail.split("\n")[0]).toBe("line 6");
  });

  it("is empty when the pane already closed, which is normal after a program exits", async () => {
    process.env.REX_FAKE_CAPTURE = "missing";

    await expect(captureTail(deps(), "block:a")).resolves.toBe("");
  });

  it("is empty for a blank screen", async () => {
    process.env.REX_FAKE_CAPTURE_TEXT = "\n\n";

    await expect(captureTail(deps(), "block:a")).resolves.toBe("");
  });
});
