/**
 * rex-pane-run.test.ts — one subagent run, driven from the outside.
 *
 * The runner is the seam between the manager's `RunHandle` world and a real `pi`
 * in a Rex pane. Everything here drives it the way the manager does — `start`
 * with the per-run wiring — against the fake `rex` and stub child in
 * `helpers/rex-pane-harness.ts`, so the assertions are about what the run does
 * rather than about what some internal helper was called:
 *
 *   - the pane is created with the documented label and cwd and minimized;
 *   - the record settles from the child's result file, and the session handle
 *     redisplays the conversation from the child's own session file;
 *   - a child that dies without a result settles as an error carrying the exit
 *     status and whatever the session tail holds — never an await that cannot
 *     return, and never a pane that has to survive the exit;
 *   - a pane that cannot be minimized, or a `rex` that stops answering, is
 *     reported rather than swallowed;
 *   - abort closes the layer.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerRunner } from "../src/agent-manager.js";
import { getAgentConversation, type RunOptions } from "../src/agent-runner.js";
import { createPaneRunner, type PaneRunDeps } from "../src/rex/pane-run.js";
import { execRex } from "../src/rex/rex-cli.js";
import type { RunHandle } from "../src/types.js";
import { type FakeRex, installFakeRex } from "./helpers/rex-pane-harness.js";

const SESSION = "session:pane";
const WINDOW = "window:1";
const MODEL = { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" } as any;

let fake: FakeRex;
let workDir: string;
let sessionDir: string;
let warnings: string[];
/** The handle the last `start()` announced, which is what the manager stores. */
let announced: RunHandle | undefined;

beforeEach(() => {
  fake = installFakeRex();
  workDir = mkdtempSync(join(tmpdir(), "pi-pane-run-work-"));
  sessionDir = mkdtempSync(join(tmpdir(), "pi-pane-run-sessions-"));
  warnings = [];
  announced = undefined;
});

afterEach(() => {
  fake.restore();
  rmSync(workDir, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The `pi` and `ctx` a run needs, with nothing real behind them. */
function harness() {
  const pi = {
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 1, killed: false })),
    // The parent's own loaded tools, which is where a pane child's extension
    // paths and its codemode/tool-search answer come from.
    getAllTools: vi.fn(() => []),
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

/** A runner over the fake rex, plus the per-run wiring the manager passes. */
function runner(
  overrides: Partial<PaneRunDeps> = {},
  options: Partial<RunOptions> = {},
): { runner: ManagerRunner; ctx: any; options: RunOptions } {
  const { pi, ctx } = harness();
  const runOptions = {
    pi,
    agentId: "agent-1",
    handle: "explore",
    description: "find the pane",
    model: MODEL,
    ...options,
    onSessionCreated: (session: RunHandle) => {
      announced = session;
      options.onSessionCreated?.(session);
    },
  } as RunOptions;
  const paneDeps: PaneRunDeps = {
    exec: execRex,
    sessionId: SESSION,
    windowId: WINDOW,
    rootSessionId: "root-1",
    agentSessionDir: sessionDir,
    piBinary: fake.stubBinary,
    onWarning: (message) => warnings.push(message),
    ...overrides,
  };
  return { runner: createPaneRunner(paneDeps), ctx, options: runOptions };
}

/** Every `api call` method the fake observed, in order. */
const methods = () => fake.paneCalls().map((call) => call[4]);

/** The one `session.new_layer` request, parsed. */
function createRequest(): any {
  const create = fake.paneCalls().find((call) => call[4] === "session.new_layer");
  if (!create) throw new Error("no pane was created");
  return JSON.parse(create[5]);
}

/** The layer ids the run asked to minimize and to close. */
function lifecycle(): { minimized?: string; closed?: string } {
  const minimised = fake.paneCalls().find((call) => call[4] === "session.set_layer_state");
  const closed = fake.paneCalls().find((call) => call[4] === "session.close_layer");
  return {
    minimized: minimised ? JSON.parse(minimised[5]).layer_id : undefined,
    closed: closed ? JSON.parse(closed[5]).layer_id : undefined,
  };
}

/** The task file the child was handed, read back off its argv. */
function readPromptFile(): string {
  const command: string[] = createRequest().layout.block.options.command;
  const promptArg = command[command.length - 1];
  return readFileSync(promptArg.slice(1), "utf-8");
}

/** Wait for the run to announce its handle, without racing the tail's poll. */
async function waitForSession(): Promise<RunHandle> {
  for (let i = 0; i < 500; i++) {
    if (announced !== undefined) return announced;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the run never announced a session");
}

describe("a pane run that succeeds", () => {
  it("creates one pane with the documented label and cwd, minimizes it, and settles from the result file", async () => {
    const { runner: run, ctx, options } = runner();

    const result = await run.start(ctx, "Explore", "find the pane", options);

    // The result file is the success signal.
    expect(result.responseText).toBe("the answer");
    expect(result.aborted).toBe(false);
    expect(result.steered).toBe(false);
    // Keys the child had nothing to say about stay absent, not null.
    expect(result.structuredJson).toBeUndefined();
    expect(result.failure).toBeUndefined();

    const request = createRequest();
    expect(request.session_id).toBe(SESSION);
    expect(request.window_id).toBe(WINDOW);
    expect(request.focus).toBe(false);
    expect(request.layout.block.label).toBe("explore · find the pane");
    expect(request.layout.block.options.cwd).toBe(workDir);
    // No `shell` key: it would run the command under /usr/bin/login and report
    // exit 0 for every outcome, including a crash.
    expect(Object.keys(request.layout.block.options).sort()).toEqual(["command", "cwd", "exit"]);
    expect(request.layout.block.options.exit).toEqual({ on_completion: true });

    const command: string[] = request.layout.block.options.command;
    expect(command[0]).toBe("/usr/bin/env");
    expect(command[1]).toMatch(/^PI_SUBAGENTS_CHILD_SPEC=/);
    expect(command[2]).toBe(fake.stubBinary);
    expect(command).toContain("--session-id");
    expect(command).toContain("--session-dir");
    // The parent session trusts the project, so the child is told so: a pane has
    // nobody to answer a trust prompt.
    expect(command).toContain("-a");
    expect(command).not.toContain("-na");
    // The task travels as a file, so argv stays small.
    expect(command[command.length - 1]).toMatch(/^@.*prompt\.md$/);

    // One create, its own minimize, and the layer closed only at the very end —
    // after the pane this run created was on record.
    expect(methods()).toEqual(["session.new_layer", "session.set_layer_state", "session.close_layer"]);
    const { minimized, closed } = lifecycle();
    expect(minimized).toBeTruthy();
    expect(closed).toBe(minimized);

    // The handle the manager stores, and the transcript it can reopen later.
    expect(announced).toBe(result.session);
    expect(result.session.sessionFile).toContain(sessionDir);
    expect(getAgentConversation(result.session)).toContain("[Assistant]: the answer");
    // The pane was minimized, so there is nothing to report.
    expect(warnings).toEqual([]);
  });

  it("feeds the manager's activity wiring from the child's session file", async () => {
    const turnEnds: number[] = [];
    const usage: unknown[] = [];
    const toolActivity: unknown[] = [];
    const { runner: run, ctx, options } = runner({}, {
      onToolActivity: (activity) => toolActivity.push(activity),
      onTurnEnd: (count) => turnEnds.push(count),
      onAssistantUsage: (entry) => usage.push(entry),
    });

    await run.start(ctx, "Explore", "find the pane", options);

    // The child's assistant message is the run's first (and only) turn, and its
    // spend reaches the manager in pi's own units.
    expect(turnEnds).toEqual([1]);
    expect(usage).toEqual([{ input: 10, output: 20, cacheWrite: 5, cacheRead: 1, cost: 0.25 }]);
    // No tool calls were made, so no activity is invented.
    expect(toolActivity).toEqual([]);
  });

  it("relays structured output and its retry flag from the result file", async () => {
    process.env.STUB_MODE = "structured";
    const { runner: run, ctx, options } = runner();

    const result = await run.start(ctx, "Explore", "find the pane", options);

    expect(result.structuredJson).toBe('{"answer":"42"}');
    expect(result.structuredRetried).toBe(true);
  });

  it("settles a run whose result file arrives while the child is still alive", async () => {
    // The stub writes its result and then stays up for 30 s: a run that waited
    // for the exit would not come back inside this test.
    process.env.STUB_MODE = "result-early";
    const { runner: run, ctx, options } = runner();

    const started = Date.now();
    const result = await run.start(ctx, "Explore", "find the pane", options);

    expect(result.responseText).toBe("the answer");
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("a child that dies without a result file", () => {
  it("settles as an error carrying the exit status and the session tail", async () => {
    process.env.STUB_MODE = "no-result";
    const { runner: run, ctx, options } = runner();

    const outcome = await run.start(ctx, "Explore", "find the pane", options).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(outcome).toBeInstanceOf(Error);
    const message = (outcome as Error).message;
    // The status comes from `rex wait` / the `child_exited` payload, not from a
    // pane that had to survive the exit.
    expect(message).toContain("3");
    expect(message).toMatch(/exit status/i);
    // And the last thing the child said is read from its own session file.
    expect(message).toContain("the answer");
    expect(fake.calls().some((call) => call[0] === "wait")).toBe(true);
    // The layer is closed even on the failure path.
    expect(methods()).toContain("session.close_layer");
  });

  it("reports an unobservable exit status when the pane closed with the child", async () => {
    // A failing `pi` closes its own pane within a second or two, so the status
    // goes with it: `{ lastExit: null, status: null }` means "not observable",
    // never "still running".
    process.env.STUB_MODE = "no-result";
    process.env.REX_FAKE_FAST_CLOSE = "1";
    const { runner: run, ctx, options } = runner();

    const outcome = await run.start(ctx, "Explore", "find the pane", options).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/exit status/i);
    expect((outcome as Error).message).toMatch(/unobserv|unknown|could not/i);
    expect((outcome as Error).message).toContain("the answer");
  });
});

describe("a pane that could not be minimized", () => {
  it("is reported to the caller instead of being claimed as minimized", async () => {
    process.env.REX_FAKE_SET_LAYER_STATE = "bad_request";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runner: run, ctx, options } = runner();

    const result = await run.start(ctx, "Explore", "find the pane", options);

    // The agent is unaffected: the child is running and its result still lands.
    expect(result.responseText).toBe("the answer");
    // But the user is told the pane is still on screen, with Rex's own reason.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not be minimized");
    expect(warnings[0]).toContain("bad_request: a window must keep a visible pane");
  });
});

describe("a rex that stops answering mid-run", () => {
  it("still settles from the result file and records the warning", async () => {
    // The child takes a moment; the server goes away in the meantime.
    process.env.STUB_MODE = "slow-result";
    const { runner: run, ctx, options } = runner();

    const started = run.start(ctx, "Explore", "find the pane", options);
    // Once the pane exists and is minimized, the server goes away.
    for (let i = 0; i < 500 && fake.paneCalls().length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fake.paneCalls().length).toBe(2);
    process.env.REX_FAKE_UNAVAILABLE = "1";
    const result = await started;

    expect(result.responseText).toBe("the answer");
    expect(warnings.some((message) => /could not be reached|could not be watched/i.test(message))).toBe(true);
  });
});

describe("steering", () => {
  it("sends the text and Enter into the child's pane while it is working", async () => {
    process.env.STUB_MODE = "result-early";
    process.env.REX_FAKE_PROGRAM_STATUS = "working";
    const { runner: run, ctx, options } = runner();

    const started = run.start(ctx, "Explore", "find the pane", options);
    const session = await waitForSession();
    await session.steer("keep going");
    await started;

    const sent = fake.calls().filter((call) => call[0] === "send" || call[0] === "send-key");
    expect(sent.map((call) => call[0])).toEqual(["send", "send-key"]);
    expect(sent[0]).toContain("keep going");
    expect(sent[1]).toContain("enter");
  });

  it("refuses while the child is blocked, so text never lands in a dialog", async () => {
    process.env.STUB_MODE = "result-early";
    process.env.REX_FAKE_PROGRAM_STATUS = "blocked";
    const { runner: run, ctx, options } = runner();

    const started = run.start(ctx, "Explore", "find the pane", options);
    const session = await waitForSession();

    await expect(session.steer("keep going")).rejects.toThrow(/blocked|waiting/i);
    expect(fake.calls().some((call) => call[0] === "send")).toBe(false);
    await started;
  });
});

describe("abort", () => {
  it("closes the layer and settles as an aborted run rather than a failure", async () => {
    // The child is still alive when the abort lands, so only the abort can end
    // this run — which is the case the manager records as "stopped".
    process.env.STUB_MODE = "result-early";
    const controller = new AbortController();
    const { runner: run, ctx, options } = runner({}, { signal: controller.signal });

    const started = run.start(ctx, "Explore", "find the pane", options);
    await waitForSession();
    controller.abort();

    const outcome = await started.then(
      (value) => value,
      (error: Error) => error,
    );
    expect(outcome).not.toBeInstanceOf(Error);
    expect((outcome as { aborted: boolean }).aborted).toBe(true);
    const closed = fake.paneCalls().filter((call) => call[4] === "session.close_layer");
    expect(closed).toHaveLength(1);
    expect(JSON.parse(closed[0][5]).layer_id).toBe(lifecycle().minimized);
  });
});

describe("falling back to the in-process runner", () => {
  const fakeFallback = (): ManagerRunner => ({
    start: vi.fn(async () => ({
      responseText: "in-process",
      session: {} as RunHandle,
      aborted: false,
      steered: false,
    })),
    resume: vi.fn(async () => ({ text: "in-process" })),
  });

  it("runs the agent in-process when no pane could be created", async () => {
    process.env.REX_FAKE_NEW_LAYER = "fail";
    const fallback = fakeFallback();
    const { runner: run, ctx, options } = runner({ fallback });

    const result = await run.start(ctx, "Explore", "find the pane", options);

    expect(result.responseText).toBe("in-process");
    expect(fallback.start).toHaveBeenCalledTimes(1);
    // Nothing was watched, and nothing was left to watch.
    expect(methods()).toEqual(["session.new_layer"]);
  });

  it("runs the agent in-process when no model could be resolved for the child", async () => {
    const fallback = fakeFallback();
    const { runner: run, ctx, options } = runner({ fallback }, { model: undefined });

    const result = await run.start(ctx, "Explore", "find the pane", options);

    expect(result.responseText).toBe("in-process");
    expect(fake.calls()).toEqual([]);
  });
});

describe("the parent conversation", () => {
  it("is prepended to the task when the spawn asked to inherit it", async () => {
    const { runner: run, ctx, options } = runner({}, { inheritContext: true });
    // The parent's branch, as `buildParentContext()` reads it.
    ctx.sessionManager.getBranch = vi.fn(() => [
      { type: "message", message: { role: "user", content: "we picked the pane path" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "agreed" }] } },
    ]);

    await run.start(ctx, "Explore", "find the pane", options);

    const prompt = readPromptFile();
    // Byte for byte what the in-process runner would have prompted with: the
    // context, then the task, in that order.
    expect(prompt).toContain("# Parent Conversation Context");
    expect(prompt).toContain("[User]: we picked the pane path");
    expect(prompt).toContain("[Assistant]: agreed");
    expect(prompt.indexOf("we picked the pane path")).toBeLessThan(prompt.indexOf("find the pane"));
  });

  it("stays out of the task when the spawn did not ask for it", async () => {
    const { runner: run, ctx, options } = runner();
    ctx.sessionManager.getBranch = vi.fn(() => [
      { type: "message", message: { role: "user", content: "we picked the pane path" } },
    ]);

    await run.start(ctx, "Explore", "find the pane", options);

    expect(readPromptFile()).toBe("find the pane");
    // Never asked, so never read: the branch walk is not free.
    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
  });
});

describe("a child that writes its session file late", () => {
  it("follows the file that finally appears, so the live view is not left empty", async () => {
    // The session file lands after the 2 s grace window, and the result file
    // after that: discovery on a deadline alone would bind the tail to a path
    // that never exists.
    process.env.STUB_MODE = "slow-start";
    const { runner: run, ctx, options } = runner();

    const result = await run.start(ctx, "Explore", "find the pane", options);

    expect(result.responseText).toBe("the answer");
    // The handle names the child's real file, not the guess.
    expect(result.session.sessionFile.endsWith("_agent-1.jsonl")).toBe(true);
    expect(result.session.sessionFile).toContain(sessionDir);
    expect(existsSync(result.session.sessionFile)).toBe(true);
    // And the tail followed it there: the conversation and the spend are there.
    expect(getAgentConversation(result.session)).toContain("[Assistant]: the answer");
    expect(result.session.getSessionStats()?.tokens.output).toBe(20);
  }, 20_000);
});

describe("a steer that arrives before the child has reported a state", () => {
  it("waits for one instead of refusing a child that is merely still starting", async () => {
    process.env.STUB_MODE = "result-early";
    // Nothing reports a state yet; it starts reporting 300 ms in.
    const { runner: run, ctx, options } = runner();

    const started = run.start(ctx, "Explore", "find the pane", options);
    const session = await waitForSession();
    setTimeout(() => {
      process.env.REX_FAKE_PROGRAM_STATUS = "working";
    }, 300);

    await session.steer("keep going");
    await started;

    const sent = fake.calls().filter((call) => call[0] === "send");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("keep going");
  });

  it("refuses a state it cannot vouch for, naming it", async () => {
    process.env.STUB_MODE = "result-early";
    // `done` is not blocked, but it is also not taking input: the gate is a
    // whitelist, so anything outside it is refused.
    process.env.REX_FAKE_PROGRAM_STATUS = "done";
    const { runner: run, ctx, options } = runner();

    const started = run.start(ctx, "Explore", "find the pane", options);
    const session = await waitForSession();

    await expect(session.steer("keep going")).rejects.toThrow(/done/);
    expect(fake.calls().some((call) => call[0] === "send")).toBe(false);
    await started;
  });
});
