/**
 * foreground-result-retrieval.test.ts — issue #174, via the REAL Agent tool +
 * the REAL get_subagent_result tool.
 *
 * Report: a FOREGROUND agent that wraps up at max_turns returns its partial
 * result inline, but a get_subagent_result for "that agent ID" immediately
 * afterwards answers `Agent not found ... It may have been cleaned up.` — with
 * no /new, /resume or session switch in between.
 *
 * Tracing says the premise can't hold, and these tests pin both halves of why:
 *
 *   1. The record is NOT cleaned up. Foreground completion mutates the record
 *      in place (agent-manager.ts startAgent's .then) — nothing deletes it. So
 *      a lookup with the REAL id succeeds.
 *   2. The reporter's id was invented, not ours. At the time, a foreground
 *      result carried the output text only; the id travelled in `details`,
 *      which is renderer metadata and never reached the API (only `content` is
 *      serialized). The background path was the one that put `Agent ID: ...`
 *      in the text. The foreground result now carries the id and the handle it
 *      was assigned too, so the model can name the agent again.
 *
 * Together: whatever id the reporter's model passed, it wasn't one we issued,
 * and "not found" was the correct answer. The eviction test pins the rule that
 * DOES apply, so the two are not confused again.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

/**
 * Run a FOREGROUND agent that wraps up at the turn limit — the exact #174
 * shape. `steered: true` is what agent-manager turns into status "steered",
 * which is what produces the reporter's "(wrapped up at the turn limit —
 * output may be partial)" note.
 *
 * Returns the tool result plus the id read out of `details`. The result text
 * carries it too now (see the identity tests), but the structured field is the
 * stable way for a test to learn the id.
 */
async function runForegroundSteeredAgent(tools: Map<string, any>) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-RESULT-PAYLOAD",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: true,
  });
  const res = await tools.get("Agent").execute(
    "tc-fg",
    {
      prompt: "Perform a very thorough read-only codebase exploration.",
      description: "Locate organization-scope changes",
      subagent_type: "Explore",
      max_turns: 20,
      run_in_background: false,
    },
    undefined,
    undefined,
    ctx(),
  );
  const id = (res as any).details?.agentId as string | undefined;
  expect(id, "foreground spawn should have produced a record id in details").toBeTruthy();
  return { res, id: id as string };
}

describe("issue #174: foreground agent that hits max_turns", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir, scheduling off — same isolation as
    // clear-completed-wiring.test.ts, so session_start doesn't spin a
    // scheduler or touch the dev's filesystem.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-174-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-174-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is NOT cleaned up — get_subagent_result with the real id still resolves it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { res, id } = await runForegroundSteeredAgent(tools);

    // The inline result is the turn-limit wrap-up the reporter described.
    expect(textOf(res)).toContain("wrapped up at the turn limit");

    // No /new, no /resume, no session switch — exactly the reporter's sequence.
    const read = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(read);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    // The structured payload mirrors the text — this is the `outputSchema`
    // shape the codemode path reads, and it has to be set on the resolved
    // path too, not only on the not-found one. It also proves the usage
    // wrapper preserves it (it spreads the result).
    expect((read as any).structuredContent).toEqual({
      agentId: id,
      handle: "explore",
      status: "steered",
      result: "THE-RESULT-PAYLOAD",
    });

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("hands the model the durable id and the handle the spawn assigned", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { res, id } = await runForegroundSteeredAgent(tools);

    // `content` is the only thing serialized to the API, so these two lines are
    // the whole reason the model can name this agent again after eviction.
    const text = textOf(res);
    expect(text).toContain(`Agent ID: ${id}`);
    expect(text).toContain("Handle: explore");

    // The wrap-up note the reporter described is still there, and the identity
    // block does not displace the payload.
    expect(text).toContain("wrapped up at the turn limit");
    expect(text).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("carries the identity block on the failed foreground return too", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    // A final turn whose provider error pi resolved instead of rejecting lands
    // the record on "error" (agent-manager settleRun, #144), which is the branch
    // that returns `Agent failed:` — the other half of the identity contract.
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "PARTIAL-BEFORE-FAILURE",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
      failure: "provider exploded",
    });
    const res = await tools.get("Agent").execute(
      "tc-fail",
      { prompt: "go", description: "work", subagent_type: "Explore", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );

    const text = textOf(res);
    expect(text).toContain("Agent failed: provider exploded");
    expect(text).toContain(`Agent ID: ${(res as any).details?.agentId}`);
    expect(text).toContain("Handle: explore");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("carries the identity block on a synchronous resume, success and failure", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { id } = await runForegroundSteeredAgent(tools);
    const resume = () =>
      tools.get("Agent").execute(
        "tc-resume",
        { prompt: "keep going", description: "work", subagent_type: "Explore", resume: id, run_in_background: false },
        undefined,
        undefined,
        ctx(),
      );

    vi.mocked(resumeAgent).mockResolvedValue({ text: "RESUMED-PAYLOAD" } as any);
    const ok = textOf(await resume());
    expect(ok).toContain(`Agent ID: ${id}`);
    expect(ok).toContain("Handle: explore");
    expect(ok).toContain("RESUMED-PAYLOAD");

    vi.mocked(resumeAgent).mockResolvedValue({ text: "", failure: "provider exploded" } as any);
    const failed = textOf(await resume());
    expect(failed).toContain("Agent failed: provider exploded");
    expect(failed).toContain(`Agent ID: ${id}`);
    expect(failed).toContain("Handle: explore");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("still rejects an id it was never issued", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await runForegroundSteeredAgent(tools);

    const bogus = await tools.get("get_subagent_result").execute(
      "tc-bogus",
      { agent_id: "3f1320a7-74ec-422" },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(bogus)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("reports the handle the spawn actually assigned, not the name that was asked for", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "x",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const spawn = (name: string) =>
      tools.get("Agent").execute(
        "tc",
        { prompt: "go", description: "work", subagent_type: "Explore", name, run_in_background: true },
        undefined,
        undefined,
        ctx(),
      );

    expect(textOf(await spawn("task-jnr7-5-impl"))).toContain("Handle: task-jnr7-5-impl");
    // The canonical name is held by the first claimant, so the second dispatch is
    // silently renamed. The result has to say so, or a later resume by the
    // canonical name reopens the OLDER agent — the trap this contract exists to
    // close.
    expect(textOf(await spawn("task-jnr7-5-impl"))).toContain("Handle: task-jnr7-5-impl-2");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("names the handle on the background path too", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "bg",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const r = await tools.get("Agent").execute(
      "tc-bg",
      { prompt: "go", description: "background work", subagent_type: "Explore", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(r)).toMatch(/Agent ID: \S+/);
    expect(textOf(r)).toContain("Handle: explore");
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("survives a subagent session's OWN activation lifecycle (adversarial: cross-activation eviction)", async () => {
    // The one mechanism that could produce the reported symptom with no
    // user-visible session change: a second activation of this extension in the
    // same process. Child sessions no longer reach it — activation returns early
    // under `inChildSessionContext()` — but any other in-process activation still
    // can, and if its session_start / session_shutdown reached the PARENT's
    // manager, that activation ending would wipe the parent's records.
    const parent = makePi();
    subagentsExtension(parent.pi);
    await parent.lifecycle.get("session_start")?.({}, ctx());
    const { id } = await runForegroundSteeredAgent(parent.tools);

    // A child activation runs its full lifecycle, as a subagent session does.
    const child = makePi();
    subagentsExtension(child.pi);
    await child.lifecycle.get("session_start")?.({}, ctx());
    await child.lifecycle.get("session_shutdown")?.({}, ctx());

    // The parent's record must be untouched — separate manager per activation.
    const read = await parent.tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(read);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await parent.lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("IS evicted by a session switch — its result was already delivered inline", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { id } = await runForegroundSteeredAgent(tools);

    // Foreground results count as consumed the moment they're returned inline,
    // so clearCompleted(true)'s #108 preservation deliberately does not cover
    // them. This is the ONLY path that makes a foreground id stop resolving.
    await lifecycle.get("session_before_switch")?.();

    const read = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(read)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
