/**
 * rex-run-handle.test.ts — the seam a run is read through.
 *
 * A subagent runs in one of two ways: today's in-process `AgentSession`, or —
 * inside Rex — a real `pi` in a pane, where the parent holds no session at
 * all. Everything downstream (widget, fleet list, viewer, `/agents`,
 * `get_subagent_result`, the `.output` transcript) therefore reads a
 * `RunHandle` off the record instead of an `AgentSession`, and the manager
 * takes its run entry points from an injectable `ManagerRunner`.
 *
 * These tests pin that contract from the outside: a fake runner whose handle
 * is a plain object — no `AgentSession`, no extension runner, nothing a spy
 * could mistake for a live session — must be enough to settle a record.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type ManagerRunner } from "../src/agent-manager.js";
import { getAgentConversation, type RunResult } from "../src/agent-runner.js";
import { getAgentConfig, getAllTypes, registerAgents } from "../src/agent-types.js";
import { streamToOutputFile } from "../src/output-file.js";
import type { AgentConfig, RunHandle } from "../src/types.js";
import { getSessionContextPercent } from "../src/usage.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

/**
 * A handle with exactly the members `RunHandle` declares and nothing pi-shaped
 * behind them — what a pane-backed run can actually supply.
 */
function fakeHandle(overrides: Partial<RunHandle> = {}): RunHandle {
  return {
    messages: [],
    subscribe: () => () => {},
    getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheWrite: 30 }, contextUsage: { percent: 42 } }),
    sessionFile: "/tmp/subagent-session.jsonl",
    prompt: async () => {},
    steer: async () => {},
    abort: async () => {},
    dispose: () => {},
    ...overrides,
  };
}

const runnerWithHandle = (handle: RunHandle, announceSession = true): ManagerRunner => ({
  start: vi.fn(async (_ctx, _type, _prompt, options) => {
    if (announceSession) options.onSessionCreated?.(handle);
    return { responseText: "fake", session: handle, aborted: false, steered: false };
  }),
  resume: vi.fn(async () => ({ text: "resumed by the fake runner" })),
});

/** An injected runner and nothing else: no callbacks, no limits to tune. */
const makeManager = (runner: ManagerRunner) =>
  new AgentManager(undefined, 10, undefined, undefined, undefined, { runner });

describe("RunHandle seam — an injected runner settles the record", () => {
  let manager: AgentManager;
  afterEach(async () => {
    // Awaited: `dispose()` sweeps the runs' handles, and a test that left a
    // dispose in flight would let its warnings land in the next one.
    await manager?.dispose();
    vi.restoreAllMocks();
  });

  it("settles a record from a runner that hands back no AgentSession", async () => {
    const handle = fakeHandle();
    manager = makeManager(runnerWithHandle(handle));

    const id = manager.spawn(mockPi, mockCtx, "Explore", "do the thing", {
      description: "do the thing",
      isBackground: true,
    });

    const record = manager.getRecord(id)!;
    expect(await record.promise).toBe("fake");
    expect(record.status).toBe("completed");
    expect(record.result).toBe("fake");
    // The record carries the runner's own handle, not a session.
    expect(record.session).toBe(handle);
    // Captured through the handle, so an evicted record can still be reopened.
    expect(record.sessionFile).toBe("/tmp/subagent-session.jsonl");
  });

  it("names the model and thinking level from the spawn options without a session", async () => {
    // The pane modality: the parent never touches the child's session, so the
    // model/thinking labels have to be there before the run starts.
    manager = makeManager(runnerWithHandle(fakeHandle(), false));

    const id = manager.spawn(mockPi, mockCtx, "Explore", "do the thing", {
      description: "do the thing",
      isBackground: true,
      model: { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" } as any,
      thinkingLevel: "high",
    });

    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.invocation).toMatchObject({
      modelName: "haiku 4.5",
      modelId: "anthropic/claude-haiku-4-5",
      thinking: "high",
    });
  });

  it("labelled from what it can resolve when the context has no model registry", async () => {
    // The labels are now resolved at SPAWN, so an unguarded `ctx.modelRegistry`
    // would fail the tool call itself over display data. A context without one
    // (a stub, or a partial SDK context) must still start the run: the agent
    // file's model cannot be resolved, so the answer is what it can name.
    const existing = new Map(getAllTypes().map((name) => [name, getAgentConfig(name)!]));
    registerAgents(
      new Map([
        ...existing,
        [
          "model-in-file",
          {
            name: "model-in-file",
            description: "an agent file that names a model",
            extensions: true,
            skills: true,
            systemPrompt: "",
            promptMode: "replace",
            model: "anthropic/claude-haiku-4-5",
          } as AgentConfig,
        ],
      ]),
    );
    try {
      manager = makeManager(runnerWithHandle(fakeHandle(), false));
      const ctx = { cwd: "/tmp" } as any;

      const id = manager.spawn(mockPi, ctx, "model-in-file", "do the thing", {
        description: "do the thing",
        isBackground: true,
      });
      const record = manager.getRecord(id)!;

      expect(await record.promise).toBe("fake");
      expect(record.status).toBe("completed");
      // Nothing was invented: no parent model, no registry to resolve the
      // agent file's, so no label rather than a wrong one.
      expect(record.invocation).toBeUndefined();
    } finally {
      registerAgents(existing);
    }
  });

  it("disposes a handle with no extension runner, and does not throw", async () => {
    // A run backed by a file has no extension runner at all (`PaneSession` never
    // has one), so the shutdown's `session_shutdown` emit has nothing to run
    // against: the dispose has to fall through to the handle's own `dispose()`.
    const dispose = vi.fn();
    manager = makeManager(runnerWithHandle(fakeHandle({ dispose }), false));

    const id = manager.spawn(mockPi, mockCtx, "Explore", "do the thing", {
      description: "do the thing",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("resumes through the injected runner's resume, not the in-process one", async () => {
    const handle = fakeHandle();
    const runner = runnerWithHandle(handle);
    manager = makeManager(runner);

    const id = manager.spawn(mockPi, mockCtx, "Explore", "start", {
      description: "start",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    const record = await manager.resume(id, "again");

    expect(runner.resume).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runner.resume).mock.calls[0][0]).toBe(handle);
    expect(vi.mocked(runner.resume).mock.calls[0][1]).toBe("again");
    expect(record?.status).toBe("completed");
    expect(record?.result).toBe("resumed by the fake runner");
  });

  it("leaves a stopped record stopped when the resume unwinds afterwards", async () => {
    // A stop is recorded the moment it lands; the resume then rejects with
    // whatever the abort caused — a pane run ends by having its layer closed,
    // so it reports "exited without writing its result file". That is not a
    // crash, and relabelling it `error` contradicts what the user was told.
    const handle = fakeHandle();
    let reject!: (error: Error) => void;
    manager = makeManager({
      start: vi.fn(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated?.(handle);
        return { responseText: "fake", session: handle, aborted: false, steered: false };
      }),
      resume: vi.fn(
        () =>
          new Promise<{ text: string }>((_resolve, fail) => {
            reject = fail;
          }),
      ),
    });

    const id = manager.spawn(mockPi, mockCtx, "Explore", "start", {
      description: "start",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    const resuming = manager.resume(id, "again");
    // The record is "running" for as long as the resume is in flight, which is
    // the state `/agents` stop acts on.
    await Promise.resolve();
    expect(manager.getRecord(id)!.status).toBe("running");
    expect(manager.abort(id)).toBe(true);
    reject(new Error("the agent's pi exited with status 143 without writing its result file"));
    const record = await resuming;

    expect(record?.status).toBe("stopped");
    expect(record?.error).toBeUndefined();
  });

  it("steers the live run through the record's handle", async () => {
    // `steer_subagent`, `@handle`, the viewer's composer and nested delegation
    // all go through the manager, which must reach the run — whatever carries
    // it — and nothing else.
    const steer = vi.fn(async () => {});
    const handle = fakeHandle({ steer });
    let finish!: (result: RunResult) => void;
    manager = makeManager({
      start: vi.fn(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated?.(handle);
        return new Promise<RunResult>((resolve) => {
          finish = resolve;
        });
      }),
      resume: vi.fn(async () => ({ text: "" })),
    });

    const id = manager.spawn(mockPi, mockCtx, "Explore", "start", {
      description: "start",
      isBackground: true,
    });
    expect(manager.steer(id, "keep going")).toBe(true);
    expect(steer).toHaveBeenCalledWith("keep going");

    finish({ responseText: "done", session: handle, aborted: false, steered: false });
    await manager.getRecord(id)!.promise;
  });
});

describe("RunHandle seam — the surfaces that read a run", () => {
  it("feeds the viewer transcript, the context % and the .output stream", () => {
    // The three reads a run still has to satisfy after (or while) it runs:
    // `get_subagent_result({verbose})` and `/agents` → View log, the
    // widget/fleet context figure, and the `.output` transcript. None of them
    // may need a live session behind the handle.
    const messages = [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ] as unknown as RunHandle["messages"];
    const listeners = new Set<(event: unknown) => void>();
    const handle = fakeHandle({
      messages,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    expect(getAgentConversation(handle)).toContain("[Assistant]: done");
    expect(getSessionContextPercent(handle)).toBe(42);

    const dir = mkdtempSync(join(tmpdir(), "run-handle-"));
    const path = join(dir, "agent.output");
    const stop = streamToOutputFile(handle, path, "agent-id", "/tmp", 0);
    for (const listener of listeners) listener({ type: "turn_end" });
    stop();

    const written = readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(written.map((entry: { type: string }) => entry.type)).toEqual(["user", "assistant"]);
    expect(written[1].message.content[0].text).toBe("done");

    rmSync(dir, { recursive: true, force: true });
  });
});
