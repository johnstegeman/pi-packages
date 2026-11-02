// Which modality is in force: a subagent as a real `pi` in a Rex pane, or the
// in-process SDK session that has always run it.
//
// Detection sits on the spawn path, so every failure here costs one subagent,
// not a session: an absent, slow or hanging `rex` has to answer "no" quickly
// rather than throw or block. That is the acceptance criterion these tests
// exist for (design Review Focus 1).

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REX_PROBE_TIMEOUT_MS,
  detectRexPanes,
  type RexDetectDeps,
  resetRexDetectionForTests,
  rexPanesEnabled,
  rexProbe,
} from "../src/rex/detect.js";

/** A Rex-hosted parent: both markers set, a terminal, the default setting. */
function baseDeps(overrides: Partial<RexDetectDeps> = {}): RexDetectDeps {
  return {
    env: { REX_SESSION: "sess-1", REX_BLOCK: "block-1" },
    isTTY: true,
    setting: "auto",
    probe: () => Promise.resolve(true),
    ...overrides,
  };
}

describe("detectRexPanes", () => {
  it("picks the pane path when every condition holds", async () => {
    const counting = { calls: 0 };
    const deps = baseDeps({
      probe: () => {
        counting.calls += 1;
        return Promise.resolve(true);
      },
    });
    await expect(detectRexPanes(deps)).resolves.toBe(true);
    expect(counting.calls).toBe(1);
  });

  it("picks the pane path when the setting is unset — auto is the default", async () => {
    await expect(detectRexPanes(baseDeps({ setting: undefined }))).resolves.toBe(true);
  });

  // One row per reason to stay in-process. Each is a single missing half of the
  // answer, so a regression in any one of them names itself.
  const staysInProcess: Array<[string, Partial<RexDetectDeps>]> = [
    ["REX_SESSION is missing", { env: { REX_BLOCK: "block-1" } }],
    // An empty value is not a session: `REX_SESSION=` in a wrapper script must
    // not read as "inside Rex".
    ["REX_SESSION is empty", { env: { REX_SESSION: "", REX_BLOCK: "block-1" } }],
    ["REX_BLOCK is missing", { env: { REX_SESSION: "sess-1" } }],
    ["REX_BLOCK is empty", { env: { REX_SESSION: "sess-1", REX_BLOCK: "" } }],
    // Print mode and RPC-driven parents keep the in-process runner: nobody is
    // watching capsules, and the parent may exit mid-run.
    ["stdout is not a terminal", { isTTY: false }],
    // Children inherit REX_SESSION/REX_BLOCK/TTY, so without this a child would
    // spawn panes of its own.
    [
      "a child spec is already in the environment",
      { env: { REX_SESSION: "sess-1", REX_BLOCK: "block-1", PI_SUBAGENTS_CHILD_SPEC: "/tmp/spec.json" } },
    ],
    ["the setting is off", { setting: "off" }],
    ["the probe finds no Rex server", { probe: () => Promise.resolve(false) }],
  ];

  for (const [name, overrides] of staysInProcess) {
    it(`stays in-process when ${name}`, async () => {
      await expect(detectRexPanes(baseDeps(overrides))).resolves.toBe(false);
    });
  }

  it("stays in-process when the probe rejects", async () => {
    const deps = baseDeps({ probe: () => Promise.reject(new Error("boom")) });
    await expect(detectRexPanes(deps)).resolves.toBe(false);
  });

  it("stays in-process when the probe hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const never = baseDeps({
        probe: () =>
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(true), DEFAULT_REX_PROBE_TIMEOUT_MS * 10);
          }),
      });
      const pending = detectRexPanes(never);
      await vi.advanceTimersByTimeAsync(DEFAULT_REX_PROBE_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The probe costs a subprocess, so a condition we already know about must not
  // be paid for.
  it("does not probe when a cheap condition already says no", async () => {
    let calls = 0;
    const probe = () => {
      calls += 1;
      return Promise.resolve(true);
    };
    await detectRexPanes(baseDeps({ probe, isTTY: false }));
    await detectRexPanes(baseDeps({ probe, setting: "off" }));
    await detectRexPanes(baseDeps({ probe, env: { PI_SUBAGENTS_CHILD_SPEC: "/tmp/spec.json" } }));
    expect(calls).toBe(0);
  });
});

describe("rexProbe", () => {
  let binDir: string;
  let savedPath: string | undefined;

  /** Install a fake `rex` executable as the first entry on PATH. */
  function fakeRex(script: string): void {
    const file = join(binDir, "rex");
    writeFileSync(file, script);
    chmodSync(file, 0o755);
    process.env.PATH = `${binDir}:/usr/bin:/bin`;
  }

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "pi-rex-probe-"));
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  it("is true when the CLI exits 0 with whoami JSON", async () => {
    fakeRex('#!/bin/sh\necho \'{"rex_version":"0.0.1793420730","session_id":"sess-1"}\'\n');
    await expect(rexProbe()).resolves.toBe(true);
  });

  it("is false when the CLI exits non-zero, even if it printed a body", async () => {
    // Exit status is the answer, so a body must not rescue it: a CLI that
    // prints whoami JSON and then fails is still saying there is no server to
    // talk to.
    fakeRex('#!/bin/sh\necho \'{"rex_version":"0.0.1793420730"}\'\nexit 1\n');
    await expect(rexProbe()).resolves.toBe(false);
  });

  // A CLI that exits 0 while printing valid JSON of the wrong shape is a
  // different CLI, not a Rex server: whoami answers with an object.
  for (const body of ["no server", "true", "null", '"0.0.1793420730"', "[]"]) {
    it(`is false when exit 0 carries ${body}`, async () => {
      fakeRex(`#!/bin/sh\necho '${body}'\n`);
      await expect(rexProbe()).resolves.toBe(false);
    });
  }

  it("is false when exit 0 carries something that is not JSON", async () => {
    fakeRex("#!/bin/sh\necho 'no server'\n");
    await expect(rexProbe()).resolves.toBe(false);
  });

  it("is false when rex is not installed", async () => {
    process.env.PATH = binDir;
    await expect(rexProbe()).resolves.toBe(false);
  });

  it("is false and gives up when the CLI hangs", async () => {
    // `exec` so the kill reaches the thing that is actually sleeping, which is
    // what makes this test finish instead of leaking a process for five seconds.
    fakeRex("#!/bin/sh\nexec sleep 5\n");
    await expect(rexProbe(50)).resolves.toBe(false);
  });
});

describe("rexPanesEnabled", () => {
  // A fake `rex` on PATH that counts its invocations: the memoization contract
  // is about how often the spawn path pays for the subprocess, so counting
  // probes is the only honest way to assert it.
  let root: string;
  let callLog: string;
  let saved: { path?: string; agentDir?: string; session?: string; block?: string; childSpec?: string };
  let savedIsTTY: PropertyDescriptor | undefined;

  const probeCount = () =>
    existsSync(callLog)
      ? readFileSync(callLog, "utf-8")
          .split("\n")
          .filter((line) => line.trim() !== "").length
      : 0;

  beforeEach(() => {
    resetRexDetectionForTests();
    root = mkdtempSync(join(tmpdir(), "pi-rex-enabled-"));
    callLog = join(root, "calls.log");
    const rex = join(root, "rex");
    writeFileSync(rex, `#!/bin/sh\nprintf 'call\\n' >> ${callLog}\necho '{"rex_version":"0.0.1793420730"}'\n`);
    chmodSync(rex, 0o755);
    mkdirSync(join(root, "agent"), { recursive: true });

    saved = {
      path: process.env.PATH,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      session: process.env.REX_SESSION,
      block: process.env.REX_BLOCK,
      childSpec: process.env.PI_SUBAGENTS_CHILD_SPEC,
    };
    process.env.PATH = `${root}:/usr/bin:/bin`;
    // Keep the developer's own ~/.pi/agent/subagents.json out of the answer.
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.REX_SESSION = "sess-1";
    process.env.REX_BLOCK = "block-1";
    delete process.env.PI_SUBAGENTS_CHILD_SPEC;

    savedIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    resetRexDetectionForTests();
    if (savedIsTTY) Object.defineProperty(process.stdout, "isTTY", savedIsTTY);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    for (const [key, value] of [
      ["PATH", saved.path],
      ["PI_CODING_AGENT_DIR", saved.agentDir],
      ["REX_SESSION", saved.session],
      ["REX_BLOCK", saved.block],
      ["PI_SUBAGENTS_CHILD_SPEC", saved.childSpec],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("probes once for the process, and probes again only after a reset", async () => {
    await expect(rexPanesEnabled(root)).resolves.toBe(true);
    await expect(rexPanesEnabled(root)).resolves.toBe(true);
    expect(probeCount()).toBe(1);

    resetRexDetectionForTests();
    await expect(rexPanesEnabled(root)).resolves.toBe(true);
    expect(probeCount()).toBe(2);
  });
});
