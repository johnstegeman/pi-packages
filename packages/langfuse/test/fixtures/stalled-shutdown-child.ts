import {
  __setRuntimeForTest,
  forceShutdownRuntime,
  sendScore,
} from "../../src/langfuse.ts";
import { state } from "../../src/state.ts";
import type { LangfuseRuntime } from "../../src/types.js";

state.config = {
  publicKey: "pk-old",
  secretKey: "sk-old",
  host: "http://127.0.0.1:1",
};

globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const activeHandle = setInterval(() => {}, 1_000);
    init?.signal?.addEventListener("abort", () => {
      clearInterval(activeHandle);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  })) as typeof fetch;

const runtime = {
  startObservation: (() => {
    throw new Error("not used");
  }) as LangfuseRuntime["startObservation"],
  propagateAttributes: (() => {
    throw new Error("not used");
  }) as LangfuseRuntime["propagateAttributes"],
  getTraceTags: async () => [],
  scoreClient: {},
  runtimeConfig: { ...state.config },
  pendingScores: [],
  scoreFlushAt: 1,
  scoreFlushIntervalMs: 60_000,
  scoreRequestTimeoutMs: 60_000,
} satisfies LangfuseRuntime;

console.warn = () => {};
__setRuntimeForTest(runtime, 50);
await sendScore("turn_count", 1, { traceId: "stalled-trace" });
await forceShutdownRuntime();
