/**
 * agent-resume-from-disk.test.ts — `Agent({ resume })` reopens an evicted
 * agent's conversation (pi-packages-jnr7.5).
 *
 * The record is swept ten minutes after it finishes and a task review routinely
 * outlasts that (251s, 566s, 199s observed), so the fix loop's rounds 1-3
 * resume failed with `Agent not found` on every task. The tombstone and the
 * reopen machinery already existed for the `@handle` mention path; this is the
 * tool reaching it.
 */
import { unlinkSync, writeFileSync } from "node:fs";
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

// Only the interval and Date are faked: `flush()` runs on setImmediate, and the
// manager's cleanup timer starts in its constructor, so the fake clock has to be
// installed before boot().
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  vi.mocked(runAgent).mockReset();
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

/** `settings` rides into `.pi/subagents.json`, which is read at boot. */
function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

/** Inside the hermetic cwd, so teardown takes it with the rest. */
const sessionPath = () => join(process.cwd(), "explore-session.jsonl");

/**
 * Age the record past the cutoff and let the real GC evict it. The session file
 * has to exist on disk: the reopen refuses one it cannot find, so a fictional
 * path would take the "session is gone" branch and every resume assertion below
 * would pass for the wrong reason.
 */
async function evict(id: string) {
  const manager = (globalThis as any)[MANAGER_KEY];
  const record = manager.getRecord(id);
  record.sessionFile = sessionPath();
  writeFileSync(record.sessionFile, "");
  record.completedAt = Date.now() - 11 * 60_000;
  await vi.advanceTimersByTimeAsync(60_000);
  return manager;
}

/**
 * Dispatch a finished background agent; return the identity its result reported.
 * `subagent_type` is a parameter because the type-unavailable case needs a custom
 * agent it can then disable — the type recorded on the tombstone is what counts.
 */
async function dispatch(tools: Map<string, any>, name: string, subagent_type = "Explore") {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "first answer",
    session: fakeSession(),
    aborted: false,
    steered: false,
    failure: undefined,
  } as any);
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "implement the task", subagent_type, name, run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  await flush();
  const text = textOf(r);
  return { id: /Agent ID: (\S+)/.exec(text)![1], handle: /Handle: (\S+)/.exec(text)![1] };
}

/** A runAgent that finishes immediately, for the reopen that follows. */
function reopenedRun() {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "FIXED-THE-FINDINGS",
    session: fakeSession(),
    aborted: false,
    steered: false,
    failure: undefined,
  } as any);
}

describe("Agent({ resume }) reopens an evicted conversation", () => {
  it("reopens from disk instead of starting a fresh agent", async () => {
    const { tools } = boot();
    const { id, handle } = await dispatch(tools, "task-jnr7-5-impl");
    const manager = await evict(id);
    expect(manager.getRecord(id)).toBeUndefined();
    vi.mocked(runAgent).mockClear();
    reopenedRun();

    const r = await tools.get("Agent").execute(
      "tc-resume",
      // `subagent_type` is deliberately a lie here: a reopen takes the type from
      // the tombstone, exactly as a live resume ignores the parameter.
      { resume: handle, subagent_type: "implementer", prompt: "fix the open findings", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    await flush();

    // The reopened run is a NEW record fed the evicted conversation's file, under
    // the type the tombstone recorded — not the one the caller named.
    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      expect.anything(),
      "Explore",
      "fix the open findings",
      expect.objectContaining({ resumeSessionFile: sessionPath() }),
    );

    const text = textOf(r);
    expect(text).toContain("resumed from disk");
    expect(text).toContain("Agent ID: ");
    expect(text).not.toContain(`Agent ID: ${id}`);
    expect(text).toContain(`Handle: ${handle}`);

    // The caller-facing name came back with the reopened record, so the next
    // round names the same conversation rather than the corpse: the reclaimed
    // alias is the `name` the caller dispatched under, and the type-derived
    // handle the dispatch originally assigned is reclaimed too — asserting the
    // alias alone would not fail if `reclaim.handle` were dropped.
    const resumedId = (vi.mocked(runAgent).mock.calls[0][3] as any).agentId;
    const reopenedRecord = manager.getRecord(resumedId);
    expect(reopenedRecord.alias).toBe(handle);
    expect(reopenedRecord.handle).toBe("explore");
  });

  it("resolves the live record when a stale id matches a tombstone a reopen kept", async () => {
    const { tools } = boot();
    const { id, handle } = await dispatch(tools, "task-jnr7-5-impl");
    const manager = await evict(id);
    vi.mocked(runAgent).mockClear();
    reopenedRun();
    vi.mocked(resumeAgent).mockResolvedValue({ text: "SECOND-TURN", failure: undefined } as any);

    // The FIRST resume names the pre-reopen id, which only the tombstone holds.
    const first = textOf(
      await tools.get("Agent").execute(
        "tc-resume-1",
        { resume: id, prompt: "fix the open findings", run_in_background: true },
        undefined,
        undefined,
        ctx(),
      ),
    );
    await flush();
    expect(first).toContain("resumed from disk");
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    const reopenedId = (vi.mocked(runAgent).mock.calls[0][3] as any).agentId;
    expect(reopenedId).not.toBe(id);

    // A successful reopen KEEPS its tombstone, and the reopened record carries a
    // new id while the tombstone keeps the old one — so this second call matches
    // that stale entry by id again. It must find the live holder of the handle
    // rather than reopening the same conversation a second time: a second reopen
    // takes the handle back from the run that already owns it, so two live
    // records share one name and one session file.
    const second = textOf(
      await tools.get("Agent").execute(
        "tc-resume-2",
        { resume: id, prompt: "fix the rest", run_in_background: true },
        undefined,
        undefined,
        ctx(),
      ),
    );
    await flush();
    expect(second).not.toContain("resumed from disk");
    expect(second).toContain(`Agent ID: ${reopenedId}`);
    // The live-record arm ran, and no second reopen did: the registry exposes no
    // way to list live records, so `runAgent` staying at one call is what shows
    // no second record took the handle.
    expect(vi.mocked(resumeAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    // The handle still resolves to the record the first reopen made, not a fork.
    expect((manager.getRecord(reopenedId).alias ?? manager.getRecord(reopenedId).handle)).toBe(handle);
  });

  it("reports the queue position when the reopen has to wait for a background slot", async () => {
    const { tools } = boot({ maxConcurrent: 1 });
    const { id, handle } = await dispatch(tools, "task-jnr7-5-impl");
    await evict(id);

    // One background slot, held by an agent that stays running: the reopen must
    // queue, and it reaches the pool through `spawnResolved` rather than the
    // foreground `spawnAndWait`, so nothing else in this file covers it.
    let finishHolder!: (value: any) => void;
    vi.mocked(runAgent).mockImplementationOnce(
      () => new Promise((resolve) => { finishHolder = resolve; }),
    );
    await tools.get("Agent").execute(
      "tc-holder",
      { prompt: "hold the slot", description: "hold the slot", subagent_type: "Explore", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    await flush();

    vi.mocked(runAgent).mockClear();
    reopenedRun();
    const text = textOf(
      await tools.get("Agent").execute(
        "tc-resume",
        { resume: handle, prompt: "fix the open findings", run_in_background: true },
        undefined,
        undefined,
        ctx(),
      ),
    );
    await flush();
    expect(text).toContain("resumed from disk");
    expect(text).toContain("Position: queued (max 1 concurrent)");

    // Let the holder finish so the queued reopen drains and teardown is not left
    // waiting on a run that can never settle.
    finishHolder({ responseText: "held", session: fakeSession(), aborted: false, steered: false, failure: undefined });
    await flush();
  });

  it("blocks and returns the output inline when the caller asked to", async () => {
    const { tools } = boot();
    const { id, handle } = await dispatch(tools, "task-jnr7-5-impl");
    await evict(id);
    vi.mocked(runAgent).mockClear();
    reopenedRun();

    const r = await tools.get("Agent").execute(
      "tc-resume",
      { resume: handle, prompt: "fix the open findings", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );

    const text = textOf(r);
    expect(text).toContain("resumed from disk");
    // The same identity lines every other dispatch result carries, so a
    // controller that pattern-matches `Agent ID:` / `Handle:` records the
    // reopened record rather than leaving a dead `agent:` in its ledger.
    expect(text).toContain("Agent ID: ");
    expect(text).toContain(`Handle: ${handle}`);
    expect(text).toContain("FIXED-THE-FINDINGS");
  });

  it("frees the handle and names the alternative when the session file is gone", async () => {
    const { tools } = boot();
    const { id, handle } = await dispatch(tools, "task-jnr7-5-impl");
    await evict(id);
    unlinkSync(sessionPath());
    vi.mocked(runAgent).mockClear();

    const r = await tools.get("Agent").execute(
      "tc-resume",
      { resume: handle, prompt: "fix the open findings", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    const text = textOf(r);
    expect(text).toContain("session file is gone");
    expect(text).toContain("re-dispatch a fresh implementer with the report file");
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    // A row that can only ever fail is worse than none: the tombstone is gone,
    // so a second resume finds nothing to reopen rather than refusing again.
    // The manager registry exposes no tombstone accessor, so this observes the
    // drop the way a caller does rather than poking internal state.
    const again = textOf(
      await tools.get("Agent").execute(
        "tc-resume-2",
        { resume: handle, prompt: "fix the open findings", run_in_background: true },
        undefined,
        undefined,
        ctx(),
      ),
    );
    expect(again).toContain("Agent not found");
    expect(again).not.toContain("session file is gone");
  });

  it("keeps the tombstone, and names the way back, when the agent type is unavailable", async () => {
    // `planReopen` refuses to reopen under a substitute agent: `resolveSpawnType`
    // falls back to general-purpose for a type it cannot resolve (#183), and
    // reopening this conversation under another agent's prompt and tools is not
    // continuing it. The tombstone stays, though — re-enabling the type makes the
    // same resume work — so the refusal must not read as terminal: a controller
    // that trusts a dead-end wording discards a recoverable implementer.
    hermetic = hermeticDir({
      settings: { outputTranscript: false },
      agentFiles: { scout: "---\ndescription: scouts\n---\nbody" },
    });
    const b = makePi();
    subagentsExtension(b.pi);
    booted = b.lifecycle;
    const { id } = await dispatch(b.tools, "task-jnr7-5-impl", "scout");
    await evict(id);
    // Disabled after the run, the way `/agents → Disable` does it at any time.
    writeFileSync(
      join(process.cwd(), ".pi", "agents", "scout.md"),
      "---\ndescription: scouts\nenabled: false\n---\nbody",
    );
    vi.mocked(runAgent).mockClear();

    const r = await b.tools.get("Agent").execute(
      "tc-resume",
      { resume: id, prompt: "fix the open findings", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    const text = textOf(r);
    expect(text).toContain("the scout agent is no longer available");
    expect(text).toContain("re-enabling the agent makes resume");
    expect(text).toContain("re-dispatch a fresh implementer with the report file");
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();

    // The tombstone is retained: a second attempt refuses with the same reason
    // rather than the rung-4 `Agent not found`, which is what a caller sees once
    // the record is really gone.
    const again = textOf(
      await b.tools.get("Agent").execute(
        "tc-resume-2",
        { resume: id, prompt: "fix the open findings", run_in_background: true },
        undefined,
        undefined,
        ctx(),
      ),
    );
    expect(again).toContain("no longer available");
    expect(again).not.toContain("Agent not found");

    // And the way back the message names: re-enabling the type reopens the same
    // conversation, which is the whole reason the tombstone is kept.
    writeFileSync(join(process.cwd(), ".pi", "agents", "scout.md"), "---\ndescription: scouts\n---\nbody");
    reopenedRun();
    const reopened = textOf(
      await b.tools.get("Agent").execute(
        "tc-resume-3",
        { resume: id, prompt: "fix the open findings", run_in_background: true },
        undefined,
        undefined,
        ctx(),
      ),
    );
    await flush();
    expect(reopened).toContain("resumed from disk");
  });
});

// Deliberately no case for a NESTED (non-top-level) ref. A nested child gets no
// handle (`src/agent-manager.ts` — `handle: !isTopLevelAgent(options) ? undefined`),
// and `tombstone()` returns early without one, so an evicted child leaves nothing
// behind: `resolveResumeTarget` can only ever answer `Agent not found`, and there is
// no second outcome to assert. The refusal is not silent, though — the missing-ref
// message names the alternative — and `test/agent-resume-handle.test.ts` covers the
// live-only resolution that shares this ladder.
