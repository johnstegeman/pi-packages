/**
 * get-result-evicted.test.ts — `get_subagent_result` answers identity from a
 * tombstone (pi-packages-jnr7.5).
 *
 * Past the ten-minute record sweep the handle resolved to nothing, while the
 * tombstone beside it held the durable id all along — so the ledger's `agent:`
 * field was unfillable by query exactly when it was needed. Identity only: a
 * read must never cost a run.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  vi.useRealTimers();
  hermetic?.restore();
  hermetic = undefined;
});

function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

function boot() {
  hermetic = hermeticDir({ settings: { outputTranscript: false } });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

const sessionPath = () => join(process.cwd(), "explore-session.jsonl");

async function evict(id: string) {
  const manager = (globalThis as any)[MANAGER_KEY];
  const record = manager.getRecord(id);
  record.sessionFile = sessionPath();
  writeFileSync(record.sessionFile, "");
  record.completedAt = Date.now() - 11 * 60_000;
  await vi.advanceTimersByTimeAsync(60_000);
  return manager;
}

async function dispatch(tools: Map<string, any>, name: string) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "first answer",
    session: fakeSession(),
    aborted: false,
    steered: false,
    failure: undefined,
  } as any);
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "implement the task", subagent_type: "Explore", name, run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  await flush();
  const text = textOf(r);
  return { id: /Agent ID: (\S+)/.exec(text)![1], handle: /Handle: (\S+)/.exec(text)![1] };
}

describe("get_subagent_result answers identity from a tombstone", () => {
  it("reports the durable id of an evicted agent without spawning", async () => {
    const { tools } = boot();
    const { id, handle } = await dispatch(tools, "task-jnr7-5-impl");
    await evict(id);
    vi.mocked(runAgent).mockClear();

    const r = await tools.get("get_subagent_result").execute("tc", { agent_id: handle }, undefined, undefined, ctx());

    expect((r as any).structuredContent).toEqual({ agentId: id, status: "evicted" });
    const text = textOf(r);
    expect(text).toContain(`Agent: ${id}`);
    expect(text).toContain("can be reopened with");
    expect(text).toContain("report file");

    // A read that costs a run is exactly what this design refused.
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
  });

  it("reports the resolved id and the handle for a live agent", async () => {
    const { tools } = boot();
    const { id, handle } = await dispatch(tools, "task-jnr7-5-impl");

    const r = await tools.get("get_subagent_result").execute("tc", { agent_id: handle }, undefined, undefined, ctx());

    expect((r as any).structuredContent).toMatchObject({ agentId: id, handle });
  });

  it("still answers Agent not found for a name that was never issued", async () => {
    const { tools } = boot();
    const r = await tools.get("get_subagent_result").execute("tc", { agent_id: "task-nope-impl" }, undefined, undefined, ctx());
    expect(textOf(r)).toContain("Agent not found");
  });
});
