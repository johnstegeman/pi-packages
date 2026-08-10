import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import registerExtension from "../index.ts";
import { finishAgentRun, startAgentRun, syncActiveTracePhaseTags } from "../src/handlers/agent.ts";
import { __setRuntimeForTest } from "../src/langfuse.ts";
import { clearAllSessionStates, runWithSession, state } from "../src/state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LangfuseRuntime } from "../src/types.ts";

import { buildPhaseMetadata, setPhase } from "../src/phase.ts";

test("registers the Superpowers phase event listener", async () => {
  let registeredChannel: string | undefined;
  let phaseHandler: ((data: unknown) => void) | undefined;

  try {
    await registerExtension({
      registerCommand() {},
      events: {
        emit() {},
        on(channel, handler) {
          registeredChannel = channel;
          phaseHandler = handler;
          return () => {};
        },
      },
      on() {},
    } as any);

    assert.equal(registeredChannel, "superpowers:phase");
    assert.ok(phaseHandler);
    phaseHandler!({ phase: "development" });
    assert.deepEqual(buildPhaseMetadata(), { superpowers_phase: "development" });
    phaseHandler!(null);
    assert.deepEqual(buildPhaseMetadata(), {});
    phaseHandler!({ phase: 42 });
    assert.deepEqual(buildPhaseMetadata(), {});
  } finally {
    setPhase(null);
  }
});

test("root agent observations receive retained phase metadata", async () => {
  const previousConfig = state.config;
  const observation = {
    traceId: "trace-id",
    updates: [] as Array<Record<string, any> | undefined>,
    metadata: undefined as Record<string, unknown> | undefined,
    setTraceIO() {},
    update(body?: Record<string, any>) {
      this.updates.push(body);
      return this;
    },
    end() {},
  };
  let propagatedAttributes: Record<string, any> | undefined;
  const runtime: LangfuseRuntime = {
    startObservation: (_name, body) => {
      observation.metadata = body?.metadata;
      return observation;
    },
    propagateAttributes: (attributes, fn) => {
      propagatedAttributes = attributes as Record<string, any>;
      return fn();
    },
    scoreClient: {},
    getTraceTags: async () => [],
  };
  try {
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.com" };
    __setRuntimeForTest(runtime);
    setPhase("development");
    await startAgentRun({ prompt: "test" }, {});
    assert.equal(observation.metadata?.superpowers_phase, "development");
    assert.deepEqual(propagatedAttributes?.tags, ["phase:development"]);
    await finishAgentRun({ messages: [] });
    assert.equal(observation.updates.at(-1)?.metadata?.superpowers_phase, "development");
  } finally {
    setPhase(null);
    __setRuntimeForTest(null);
    clearAllSessionStates();
    state.config = previousConfig;
  }
});

test("root agent observations omit tags attribute when no phase is retained", async () => {
  const previousConfig = state.config;
  const observation = {
    traceId: "trace-id",
    setTraceIO() {},
    update() {
      return this;
    },
    end() {},
  };
  let propagatedAttributes: Record<string, any> | undefined;
  const runtime: LangfuseRuntime = {
    startObservation: (_name, _body) => observation,
    propagateAttributes: (attributes, fn) => {
      propagatedAttributes = attributes as Record<string, any>;
      return fn();
    },
    scoreClient: {},
    getTraceTags: async () => [],
  };
  try {
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.com" };
    __setRuntimeForTest(runtime);
    await startAgentRun({ prompt: "test" }, {});
    assert.equal(propagatedAttributes?.tags, undefined);
  } finally {
    __setRuntimeForTest(null);
    clearAllSessionStates();
    state.config = previousConfig;
  }
});

test("phase events synchronize tags on the active trace", async () => {
  const previousConfig = state.config;
  const observation = {
    traceId: "trace-id",
    setTraceIO() {},
    update() {
      return this;
    },
    end() {},
  };
  const updateTraceTagsCalls: Array<[string, string[]]> = [];
  const getTraceTagsCalls: Array<[string, string[]]> = [];
  let currentTags = ["team:alpha", "phase:development", "phase:legacy"];
  let shouldReject = false;
  const runtime: LangfuseRuntime = {
    startObservation: (_name, _body) => observation,
    propagateAttributes: (_attributes, fn) => fn(),
    scoreClient: {},
    getTraceTags: async (traceId) => {
      getTraceTagsCalls.push([traceId, [...currentTags]]);
      return [...currentTags];
    },
    updateTraceTags: async (traceId, tags) => {
      updateTraceTagsCalls.push([traceId, tags]);
      if (shouldReject) {
        throw new Error("boom");
      }
      currentTags = [...tags];
    },
  };

  let phaseHandler: ((data: unknown) => void) | undefined;

  try {
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.com" };
    __setRuntimeForTest(runtime);

    await registerExtension({
      registerCommand() {},
      events: {
        emit() {},
        on(_channel, handler) {
          phaseHandler = handler;
          return () => {};
        },
      },
      on() {},
    } as any);

    await startAgentRun({ prompt: "test" }, {});

    phaseHandler!({ phase: "brainstorming" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(getTraceTagsCalls.at(-1), ["trace-id", ["team:alpha", "phase:development", "phase:legacy"]]);
    assert.deepEqual(updateTraceTagsCalls.at(-1), ["trace-id", ["team:alpha", "phase:brainstorming"]]);
    assert.deepEqual(currentTags, ["team:alpha", "phase:brainstorming"]);

    phaseHandler!(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(getTraceTagsCalls.at(-1), ["trace-id", ["team:alpha", "phase:brainstorming"]]);
    assert.deepEqual(updateTraceTagsCalls.at(-1), ["trace-id", ["team:alpha"]]);
    assert.deepEqual(currentTags, ["team:alpha"]);

    shouldReject = true;
    await assert.doesNotReject(async () => {
      phaseHandler!({ phase: "development" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  } finally {
    setPhase(null);
    __setRuntimeForTest(null);
    clearAllSessionStates();
    state.config = previousConfig;
  }
});

test("phase tag sync retries the same phase after a failed read", async () => {
  const previousConfig = state.config;
  const observation = {
    traceId: "trace-id",
    setTraceIO() {},
    update() {
      return this;
    },
    end() {},
  };
  let updateTraceTagsCalls = 0;
  let shouldReject = true;
  const runtime: LangfuseRuntime = {
    startObservation: (_name, _body) => observation,
    propagateAttributes: (_attributes, fn) => fn(),
    scoreClient: {},
    getTraceTags: async () => {
      if (shouldReject) {
        throw new Error("read failed");
      }
      return [];
    },
    updateTraceTags: async () => {
      updateTraceTagsCalls += 1;
    },
  };
  let phaseHandler: ((data: unknown) => void) | undefined;
  
  try {
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.com" };
    __setRuntimeForTest(runtime);
    await registerExtension({
      registerCommand() {},
      events: {
        emit() {},
        on(_channel, handler) {
          phaseHandler = handler;
          return () => {};
        },
      },
      on() {},
    } as any);
    await startAgentRun({ prompt: "test" }, {});
    phaseHandler!({ phase: "development" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(updateTraceTagsCalls, 0);
    
    shouldReject = false;
    phaseHandler!({ phase: "development" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(updateTraceTagsCalls, 1);
  } finally {
    setPhase(null);
    __setRuntimeForTest(null);
    clearAllSessionStates();
    state.config = previousConfig;
  }
});


test("concurrent sessions never cross trace ids or tags during phase sync", async () => {
  const previousConfig = state.config;
  const updateCalls: Array<[string, string[]]> = [];
  let releaseTraceA: (() => void) | undefined;
  const observations: Record<string, { traceId: string; setTraceIO(): void; update(): unknown; end(): void }> = {
    "session-a": { traceId: "trace-a", setTraceIO() {}, update() { return this; }, end() {} },
    "session-b": { traceId: "trace-b", setTraceIO() {}, update() { return this; }, end() {} },
  };
  const runtime: LangfuseRuntime = {
    startObservation: (_name, _body) => observations[state.currentSessionId] as any,
    propagateAttributes: (_attributes, fn) => fn(),
    scoreClient: {},
    getTraceTags: async () => [],
    updateTraceTags: async (traceId, tags) => {
      if (traceId === "trace-a") {
        await new Promise<void>((resolve) => {
          releaseTraceA = resolve;
        });
      }
      updateCalls.push([traceId, tags]);
    },
  };

  try {
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.com" };
    __setRuntimeForTest(runtime);

    await runWithSession("session-a", async () => {
      await startAgentRun({ prompt: "a" }, {});
    });
    await runWithSession("session-b", async () => {
      await startAgentRun({ prompt: "b" }, {});
    });

    // Start session A's tag sync. Its `updateTraceTags` call blocks until
    // released, simulating slow/in-flight work for one session while other
    // sessions keep making progress.
    const syncA = runWithSession("session-a", async () => {
      setPhase("alpha");
      return syncActiveTracePhaseTags();
    });

    // Give session A's sync a chance to capture its tags and enter the
    // (blocked) runtime call before session B mutates the shared phase.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(releaseTraceA, "session A should already be inside its updateTraceTags call");

    // Session B changes the globally-retained phase and syncs while A is
    // still in flight. If tags/trace ids were captured lazily (read from
    // `state` only when the queued callback runs) instead of synchronously
    // at enqueue time, A's eventual call could observe B's phase.
    const syncB = runWithSession("session-b", async () => {
      setPhase("beta");
      return syncActiveTracePhaseTags();
    });
    await syncB;

    assert.deepEqual(updateCalls, [["trace-b", ["phase:beta"]]]);

    releaseTraceA!();
    await syncA;

    assert.deepEqual(updateCalls, [
      ["trace-b", ["phase:beta"]],
      ["trace-a", ["phase:alpha"]],
    ]);
  } finally {
    setPhase(null);
    __setRuntimeForTest(null);
    clearAllSessionStates();
    state.config = previousConfig;
  }
});
type ExtensionHandler = Parameters<ExtensionAPI["on"]>[1];

test("agent_end waits for runtime shutdown", async () => {
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<void>>();
  let releaseForceFlush!: () => void;
  let forceFlushStarted = false;
  const previousConfig = state.config;
  const runtime: LangfuseRuntime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {},
    getTraceTags: async () => [],
    tracerProvider: {
      forceFlush: () => new Promise<void>((resolve) => {
        forceFlushStarted = true;
        releaseForceFlush = resolve;
      }),
    },
  };

  try {
    state.config = {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    };
    __setRuntimeForTest(runtime, 1_000);
    await registerExtension({
      registerCommand() {},
      events: {
        emit() {},
        on() { return () => {}; },
      },
      on(name: string, handler: (event: Record<string, unknown>, ctx: unknown) => Promise<void>) {
        handlers.set(name, handler);
      },
    } as any);

    const agentEnd = handlers.get("agent_end");
    assert.ok(agentEnd);
    let settled = false;
    const result = agentEnd!({}, {
      sessionManager: { getSessionFile: () => "/tmp/pi-agent-session.jsonl" },
    }).then(() => {
      settled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(forceFlushStarted, true);

    releaseForceFlush();
    await result;
    assert.equal(settled, true);
  } finally {
    if (forceFlushStarted) {
      releaseForceFlush();
    }
    __setRuntimeForTest(null);
    state.config = previousConfig;
  }
});

void test("uses logical Pi session IDs with the legacy file fallback", async () => {
  const handlers = new Map<string, ExtensionHandler>();
  const propagatedSessionIds: (string | undefined)[] = [];
  const previousConfig = state.config;
  const observation = {
    id: "observation-id",
    traceId: "trace-id",
    update() {
      return this;
    },
    end() {
      return undefined;
    },
  };
  const runtime: LangfuseRuntime = {
    startObservation: () => observation,
    propagateAttributes: (attributes, fn) => {
      propagatedSessionIds.push(attributes.sessionId);
      return fn();
    },
    scoreClient: {},
    getTraceTags: async () => [],
  };

  try {
    state.config = {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    };
    __setRuntimeForTest(runtime);
    await registerExtension({
      registerCommand() {
        return undefined;
      },
      events: {
        emit() {},
        on() { return () => {}; },
      },
      on(name, handler) {
        handlers.set(name, handler);
      },
    });

    const beforeAgentStart = handlers.get("before_agent_start");
    assert.ok(beforeAgentStart);

    await beforeAgentStart({ prompt: "test" }, {
      sessionManager: {
        getSessionId: () => "00000000-0000-7000-8000-000000000003",
        getSessionFile: () => undefined,
      },
    });

    await beforeAgentStart({ prompt: "legacy test" }, {
      sessionManager: {
        getSessionFile: () => "/sessions/legacy-session.jsonl",
      },
    });

    assert.deepEqual(propagatedSessionIds, [
      "00000000-0000-7000-8000-000000000003",
      "legacy-session",
    ]);
  } finally {
    __setRuntimeForTest(null);
    clearAllSessionStates();
    state.config = previousConfig;
  }
});

test("README documents the headless score shutdown timeout", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT/);
  assert.match(readme, /2 seconds/);
});
