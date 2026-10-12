/**
 * agent-resume-handle.test.ts — the Agent tool's `resume` ref accepts a handle
 * (pi-packages-jnr7.5).
 *
 * The SDD fix loop resumes the implementer by the deterministic handle
 * `task-<sanitized-task-id>-impl`, not by its id: the handle is re-derivable
 * from the task bead id after controller compaction, and the id is not. The
 * tool used to resolve the ref with `manager.getRecord`, which takes an exact
 * id, so the loop's own call could never work.
 */
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
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(async () => {
  // The manager registry is a global symbol claimed by the first activation and
  // released only on shutdown; a throwing test would otherwise leave the NEXT
  // test reading a dead manager.
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

/** Enough of an AgentSession for the manager's and index's hooks. */
function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

/** Boot the real extension. `outputTranscript: false` keeps the run off disk. */
function boot() {
  hermetic = hermeticDir({ settings: { outputTranscript: false } });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

/** Dispatch a finished background agent under `name`; return what its result reported. */
async function dispatch(tools: Map<string, any>, name: string) {
  const session = fakeSession();
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "first answer",
    session,
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
  return { id: /Agent ID: (\S+)/.exec(text)![1], handle: /Handle: (\S+)/.exec(text)![1], session };
}

describe("Agent({ resume }) accepts a handle", () => {
  it("resumes the finished agent the handle names", async () => {
    const { tools } = boot();
    const { handle, session } = await dispatch(tools, "task-jnr7-5-impl");
    expect(handle).toBe("task-jnr7-5-impl");

    vi.mocked(resumeAgent).mockResolvedValue({ text: "second answer", failure: undefined } as any);

    const r = await tools.get("Agent").execute(
      "tc-resume",
      { resume: handle, prompt: "fix the open findings", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(r)).toContain("second answer");
    // The resumed session is the dispatched one, so the manager got the RECORD's
    // id — the handle is only the caller-facing name.
    expect(vi.mocked(resumeAgent).mock.calls[0][0]).toBe(session);
  });

  it("still resolves an exact id", async () => {
    const { tools } = boot();
    const { id, session } = await dispatch(tools, "task-jnr7-5-impl");

    vi.mocked(resumeAgent).mockResolvedValue({ text: "by id", failure: undefined } as any);

    const r = await tools.get("Agent").execute(
      "tc-resume",
      { resume: id, prompt: "more", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(r)).toContain("by id");
    expect(vi.mocked(resumeAgent).mock.calls[0][0]).toBe(session);
  });

  it("names the failure and the way out when nothing answers the ref", async () => {
    const { tools } = boot();
    await dispatch(tools, "task-jnr7-5-impl");

    const r = await tools.get("Agent").execute(
      "tc-missing",
      { resume: "task-nope-impl", prompt: "x", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );

    const text = textOf(r);
    expect(text).toContain("Agent not found");
    expect(text).toContain("re-dispatch with the report file");
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
  });

  it("refuses a handle whose agent is still running", async () => {
    const { tools } = boot();
    vi.mocked(runAgent).mockImplementation((_c: any, _t: any, _p: any, opts: any) => {
      opts.onSessionCreated?.(fakeSession());
      return new Promise(() => {}) as any;
    });
    await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "still going", subagent_type: "Explore", name: "task-live-impl", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    const r = await tools.get("Agent").execute(
      "tc-resume",
      { resume: "task-live-impl", prompt: "more", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(r)).toContain("is still running");
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
  });
});
