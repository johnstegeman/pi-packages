/**
 * rex-pane-integration.test.ts — the manager, running subagents in panes.
 *
 * The manager's job is unchanged: records, statuses, pools, settle,
 * notifications. What changes is which runner serves a spawn — `rexPanesEnabled()`
 * decides, per spawn, and the manager must feed the pane runner the same per-run
 * wiring it feeds the in-process one.
 *
 * These cases drive the real `AgentManager` with `createPaneRunner` against the
 * fake `rex` and stub child, so they are about the manager's half: two spawns
 * settling into their own records without interleaved pane calls, the handle the
 * UI reads (messages, sessionFile, and the absent context percentage), a resume
 * that relaunches the child on its session file, an abort that lands as
 * "stopped", and detection answering "no" leaving the in-process runner in
 * charge with no pane calls at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type ManagerRunner } from "../src/agent-manager.js";
import { resetRexDetectionForTests, rexPanesEnabled } from "../src/rex/detect.js";
import { createPaneRunner, type PaneRunDeps } from "../src/rex/pane-run.js";
import { execRex } from "../src/rex/rex-cli.js";
import { getSessionContextPercent } from "../src/usage.js";
import { type FakeRex, installFakeRex } from "./helpers/rex-pane-harness.js";

const SESSION = "session:pane";
const WINDOW = "window:1";
const MODEL = { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" } as any;

let fake: FakeRex;
let workDir: string;
let sessionDir: string;
let warnings: string[];
let manager: AgentManager | undefined;

beforeEach(() => {
  fake = installFakeRex();
  workDir = mkdtempSync(join(tmpdir(), "pi-pane-int-work-"));
  sessionDir = mkdtempSync(join(tmpdir(), "pi-pane-int-sessions-"));
  warnings = [];
  resetRexDetectionForTests();
});

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  fake.restore();
  rmSync(workDir, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
  resetRexDetectionForTests();
  vi.restoreAllMocks();
});

/** The `pi` and `ctx` a spawn needs, with nothing real behind them. */
function harness() {
  const pi = {
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 1, killed: false })),
    getAllTools: vi.fn(() => []),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
  } as any;
  const ctx = {
    cwd: workDir,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "the parent prompt"),
    isProjectTrusted: vi.fn(() => true),
    sessionManager: { getSessionId: vi.fn(() => "root-1") },
  } as any;
  return { pi, ctx };
}

/** The pane runner the manager would get from index.ts's provider. */
function paneRunner(overrides: Partial<PaneRunDeps> = {}): ManagerRunner {
  const deps: PaneRunDeps = {
    exec: execRex,
    sessionId: SESSION,
    windowId: WINDOW,
    rootSessionId: "root-1",
    agentSessionDir: sessionDir,
    piBinary: fake.stubBinary,
    onWarning: (message) => warnings.push(message),
    ...overrides,
  };
  return createPaneRunner(deps);
}

/**
 * A manager wired the way `index.ts` wires it: one provider, asked once per
 * spawn, answering with the pane runner or nothing at all.
 */
function managerWith(
  provider: () => Promise<ManagerRunner | undefined>,
  inProcess: ManagerRunner,
  onWarning?: (message: string) => void,
): AgentManager {
  manager = new AgentManager(undefined, 10, undefined, undefined, undefined, {
    runner: inProcess,
    runnerFor: provider,
    onWarning: onWarning === undefined ? undefined : (_record, message) => onWarning(message),
  });
  return manager;
}

/** A stand-in for the in-process runner, so a fallback is observable without a session. */
function inProcessStub(text = "in-process"): ManagerRunner {
  return {
    start: vi.fn(async () => ({ responseText: text, session: {} as never, aborted: false, steered: false })),
    resume: vi.fn(async () => ({ text })),
  };
}

/** Spawn one agent and hand back its settled record. */
async function spawn(type: string, description: string) {
  const { pi, ctx } = harness();
  const id = manager!.spawn(pi, ctx, type, `do ${description}`, {
    description,
    isBackground: true,
    model: MODEL,
  });
  const record = manager!.getRecord(id)!;
  // `spawn` returns before startup finishes (the runner is chosen per spawn), so
  // wait for it exactly as every other caller of an asynchronously-started
  // record does, then for the run itself.
  await manager!.awaitStartup(id);
  await record.promise;
  return record;
}

/** Every `session.new_layer` request, parsed, in call order. */
const creates = () =>
  fake
    .paneCalls()
    .filter((call) => call[4] === "session.new_layer")
    .map((call) => JSON.parse(call[5]) as any);

describe("two agents spawned at once", () => {
  it("settles each into its own record, with no interleaved create/minimize pairs", async () => {
    process.env.STUB_LINE = "the answer";
    managerWith(async () => paneRunner(), inProcessStub());

    const { pi, ctx } = harness();
    const first = manager!.spawn(pi, ctx, "Explore", "do the first", {
      description: "the first",
      isBackground: true,
      model: MODEL,
    });
    const second = manager!.spawn(pi, ctx, "Explore", "do the second", {
      description: "the second",
      isBackground: true,
      model: MODEL,
    });
    await Promise.all([manager!.awaitStartup(first), manager!.awaitStartup(second)]);
    await Promise.all([manager!.getRecord(first)!.promise, manager!.getRecord(second)!.promise]);

    const records = [manager!.getRecord(first)!, manager!.getRecord(second)!];
    for (const record of records) {
      expect(record.status).toBe("completed");
      expect(record.result).toBe("the answer");
    }
    // Each record owns a handle onto its own child's session file: two runs, two
    // transcripts, and never the other agent's.
    const files = records.map((record) => record.session?.sessionFile);
    expect(files[0]).toContain(sessionDir);
    expect(files[1]).toContain(sessionDir);
    expect(files[0]).not.toBe(files[1]);

    // Two creates, two minimizes, each pair adjacent, each against the layer its
    // own create answered with. A fan-out that scrambled this would leave a
    // capsule on screen that no run believes it owns.
    const lifecycle = fake.paneCalls().map((call) => ({
      method: call[4],
      layer: call[4] === "session.new_layer" ? undefined : JSON.parse(call[5]).layer_id,
    }));
    const pairs = lifecycle.filter((entry) => entry.method !== "session.close_layer");
    expect(pairs.map((entry) => entry.method)).toEqual([
      "session.new_layer",
      "session.set_layer_state",
      "session.new_layer",
      "session.set_layer_state",
    ]);
    expect(pairs[1].layer).toBeTruthy();
    expect(pairs[3].layer).toBeTruthy();
    expect(pairs[1].layer).not.toBe(pairs[3].layer);
    // And each agent closed the layer it minimized, not its sibling's — the one
    // interleaving the launcher's queue does not cover, because `close_layer`
    // must not queue behind another agent's create.
    const closed = fake
      .paneCalls()
      .filter((call) => call[4] === "session.close_layer")
      .map((call) => JSON.parse(call[5]).layer_id)
      .sort();
    expect(closed).toEqual([pairs[1].layer, pairs[3].layer].sort());
    // Labels keep the two agents apart for the user.
    expect(creates().map((request) => request.layout.block.label).sort()).toEqual([
      "explore · the first",
      "explore-2 · the second",
    ]);
  });
});

describe("what the UI reads off a pane-backed record", () => {
  it("serves the conversation, the session file, and no context percentage", async () => {
    managerWith(async () => paneRunner(), inProcessStub());

    const record = await spawn("Explore", "the only one");

    expect(record.status).toBe("completed");
    expect(record.session).toBeDefined();
    const messages = record.session!.messages;
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
    expect(record.sessionFile).toContain(sessionDir);
    // Spending reaches the record through the run's own usage events, so the
    // widget's token count is not a false zero.
    expect(record.lifetimeUsage.output).toBe(20);
    // The tail carries no `contextUsage`: a context percentage needs the model's
    // window, which the file does not name. Absent, never wrong.
    expect(getSessionContextPercent(record.session!)).toBeNull();
  });

  it("resumes by relaunching the child on its session file, never by prompting the proxy", async () => {
    managerWith(async () => paneRunner(), inProcessStub());

    const record = await spawn("Explore", "the only one");
    const sessionFile = record.sessionFile!;
    process.env.STUB_LINE = "the second answer";

    const resumed = await manager!.resume(record.id, "go on");

    expect(resumed?.status).toBe("completed");
    expect(resumed?.result).toBe("the second answer");

    // A second pane, launched with `--session <file>` — not `--session-id`, and
    // not `PaneSession.prompt()`, which rejects by design.
    const launches = creates();
    expect(launches).toHaveLength(2);
    const resumeCommand: string[] = launches[1].layout.block.options.command;
    expect(resumeCommand).toContain("--session");
    expect(resumeCommand[resumeCommand.indexOf("--session") + 1]).toBe(sessionFile);
    expect(resumeCommand).not.toContain("--session-id");
    // The record still points at the same conversation.
    expect(resumed?.sessionFile).toBe(sessionFile);
  });
});

describe("abort", () => {
  it("closes the layer and settles the record as stopped", async () => {
    process.env.STUB_MODE = "result-early";
    managerWith(async () => paneRunner(), inProcessStub());

    const { pi, ctx } = harness();
    const id = manager!.spawn(pi, ctx, "Explore", "do it", {
      description: "the only one",
      isBackground: true,
      model: MODEL,
    });
    const record = manager!.getRecord(id)!;
    // Wait for the pane to exist, then stop the agent the way `/agents` does.
    await manager!.awaitStartup(id);
    for (let i = 0; i < 500 && record.session === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(record.session).toBeDefined();
    expect(manager!.abort(id)).toBe(true);
    await record.promise;

    expect(record.status).toBe("stopped");
    expect(fake.paneCalls().some((call) => call[4] === "session.close_layer")).toBe(true);
  });
});

describe("a resume the user stops", () => {
  it("is recorded as stopped, not as a child that died without a result", async () => {
    // The docs promise `stopped`. A resumed child ends by having its layer
    // closed, so it exits without writing a result file — which the runner used
    // to report as "exited without writing its result file", turning a user stop
    // into a crash.
    managerWith(async () => paneRunner(), inProcessStub());
    const record = await spawn("Explore", "the only one");

    // The resumed child reports nothing and stays up: only closing its layer
    // can end it, so nothing races this test with a result file.
    process.env.STUB_MODE = "hold";
    expect(manager!.resume(record.id, "go on", undefined, { isBackground: true })).toBeDefined();
    for (let i = 0; i < 1000 && creates().length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(creates()).toHaveLength(2);
    expect(manager!.abort(record.id)).toBe(true);
    await record.promise.catch(() => {});

    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
    // The resumed pane was closed, not left running behind a stopped record.
    expect(fake.paneCalls().filter((call) => call[4] === "session.close_layer").length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});

describe("detection", () => {
  it("leaves the in-process runner in charge outside Rex, with no pane calls", async () => {
    // The one thing index.ts's provider decides: panes only when detection says
    // so. Outside Rex the probe never even runs.
    const saved = new Map([["REX_SESSION", process.env.REX_SESSION], ["REX_BLOCK", process.env.REX_BLOCK]]);
    delete process.env.REX_SESSION;
    delete process.env.REX_BLOCK;
    try {
      const inProcess = inProcessStub("in-process");
      managerWith(async () => ((await rexPanesEnabled(workDir)) ? paneRunner() : undefined), inProcess);

      const record = await spawn("Explore", "the only one");

      expect(record.status).toBe("completed");
      expect(record.result).toBe("in-process");
      expect(inProcess.start).toHaveBeenCalledTimes(1);
      expect(fake.calls()).toEqual([]);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("an agent that could not get its pane", () => {
  it("says so on the record, not only in a warning", async () => {
    process.env.REX_FAKE_NEW_LAYER = "fail";
    const inProcess = inProcessStub("in-process");
    managerWith(async () => paneRunner({ fallback: inProcess }), inProcessStub("never"));

    const record = await spawn("Explore", "the only one");

    // It ran, and it ran in-process — but the record carries the difference, so
    // a reader arriving after the warning scrolled away can still tell.
    expect(record.result).toBe("in-process");
    expect(record.paneFallback).toMatch(/could not get a pane/);
    expect(warnings.some((message) => /in-process instead/.test(message))).toBe(true);
  });
});

describe("a refused queued steer", () => {
  it("is reported instead of being counted as delivered", async () => {
    // The child is alive but sitting on a dialog: the pane runner refuses the
    // message, and nobody is left holding a tool result to report it in.
    process.env.STUB_MODE = "result-early";
    process.env.REX_FAKE_PROGRAM_STATUS = "blocked";
    const reported: string[] = [];
    managerWith(async () => paneRunner(), inProcessStub(), (message) => reported.push(message));

    const { pi, ctx } = harness();
    const id = manager!.spawn(pi, ctx, "Explore", "do it", {
      description: "the only one",
      isBackground: true,
      model: MODEL,
    });
    const record = manager!.getRecord(id)!;
    // Queued in the window the pane path really has: the handle is announced
    // only once the child's session file is found.
    record.pendingSteers = ["keep going"];
    await manager!.awaitStartup(id);
    await record.promise;

    expect(fake.calls().some((call) => call[0] === "send")).toBe(false);
    expect(reported.some((message) => /not delivered/.test(message))).toBe(true);
    expect(reported.join("\n")).toMatch(/waiting on a prompt/);
  });
});

/** The layer ids the run asked to minimize and to close, in call order. */
function lifecycles(method: string): string[] {
  return fake
    .paneCalls()
    .filter((call) => call[4] === method)
    .map((call) => JSON.parse(call[5]).layer_id);
}

/** Wait for the fake to have recorded a call, without assuming when it happens. */
async function waitForCall(method: string): Promise<void> {
  for (let i = 0; i < 1000 && lifecycles(method).length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Dispose with a ceiling, so a hanging teardown fails here rather than at the suite timeout. */
async function disposeWithin(ms: number): Promise<"disposed" | "hung"> {
  const disposing = manager!.dispose().then(() => "disposed" as const);
  manager = undefined;
  return Promise.race([
    disposing,
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);
}

describe("shutting down with a run still in its pane", () => {
  it("closes the layer and waits for it before dispose returns", async () => {
    // The child never reports and stays up for 30 s, so only a shutdown that
    // closes the layer ends it — and nothing can race this test by landing a
    // result file first.
    process.env.STUB_MODE = "hold";
    managerWith(async () => paneRunner(), inProcessStub());

    const { pi, ctx } = harness();
    const id = manager!.spawn(pi, ctx, "Explore", "do it", {
      description: "the only one",
      isBackground: true,
      model: MODEL,
    });
    const record = manager!.getRecord(id)!;
    await manager!.awaitStartup(id);
    for (let i = 0; i < 500 && record.session === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(record.session).toBeDefined();

    expect(await disposeWithin(5_000)).toBe("disposed");

    // One pane was created, minimized and closed — no more, no less: the layer
    // the shutdown closed is the one this run was given.
    expect(lifecycles("session.new_layer")).toHaveLength(1);
    const minimized = lifecycles("session.set_layer_state");
    expect(minimized).toHaveLength(1);
    expect(lifecycles("session.close_layer")).toEqual(minimized);
    // And the record is terminal, so nothing reports it as still running.
    expect(record.status).toBe("stopped");
  }, 20_000);

  it("says so when the pane would not close, instead of claiming it did", async () => {
    // Rex refusing the close is the one failure that means a live child outlives
    // its parent, so a shutdown reports it rather than counting the close as done.
    process.env.STUB_MODE = "result-early";
    process.env.REX_FAKE_CLOSE_LAYER = "error";
    managerWith(async () => paneRunner(), inProcessStub());

    const { pi, ctx } = harness();
    const id = manager!.spawn(pi, ctx, "Explore", "do it", {
      description: "the only one",
      isBackground: true,
      model: MODEL,
    });
    const record = manager!.getRecord(id)!;
    await manager!.awaitStartup(id);
    await waitForCall("session.new_layer");

    expect(await disposeWithin(5_000)).toBe("disposed");

    expect(warnings.some((message) => /could not be closed/.test(message))).toBe(true);
    expect(warnings.join("\n")).toContain("internal: the server is wedged");
    // The run is still terminal: the record is not left looking like it is live.
    expect(record.status).toBe("stopped");
    // Let the result file settle the run before the next test reuses the harness.
    await record.promise.catch(() => {});
  }, 20_000);

  it("closes a pane whose child has not produced a session file yet", async () => {
    // The window the manager cannot reach: the pane exists, but the handle is
    // announced only once the child's session file is found — 2 s of grace, then
    // a path the child is still not writing (`slow-start` writes at 3 s). A quit
    // in here used to leave the layer open with a live child in it.
    process.env.STUB_MODE = "slow-start";
    managerWith(async () => paneRunner(), inProcessStub());

    const { pi, ctx } = harness();
    const id = manager!.spawn(pi, ctx, "Explore", "do it", {
      description: "the only one",
      isBackground: true,
      model: MODEL,
    });
    const record = manager!.getRecord(id)!;
    await manager!.awaitStartup(id);
    await waitForCall("session.new_layer");
    expect(lifecycles("session.new_layer")).toHaveLength(1);
    // The precondition of this test, not an incidental fact: no handle yet.
    expect(record.session).toBeUndefined();

    expect(await disposeWithin(15_000)).toBe("disposed");

    // The layer the run created was closed by a runner that was never handed a
    // handle for it, and the child it was running is gone.
    const minimized = lifecycles("session.set_layer_state");
    expect(minimized).toHaveLength(1);
    expect(lifecycles("session.close_layer")).toEqual(minimized);
    expect(record.status).toBe("stopped");
    // Let the run finish settling before the next test reuses the harness.
    await record.promise.catch(() => {});
  }, 30_000);
});
