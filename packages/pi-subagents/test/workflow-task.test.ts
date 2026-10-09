/**
 * workflow-task.test.ts — the record one run lives in.
 *
 * Most of `task.ts` is covered through the tool and command suites, which drive
 * it the way the extension does. The pause bookkeeping is not: it is a small
 * state machine that spans the record and the run's control surface, and the
 * two ways it can go wrong — flipping the record without telling the runtime,
 * or letting a held run keep counting elapsed time — are both invisible from
 * the outside. So it gets driven directly, against a control stub.
 */

import { describe, expect, it, vi } from "vitest";
import { workflowEntryData } from "../src/workflow/entry.js";
import type { WorkflowControl } from "../src/workflow/runtime.js";
import {
  completeWorkflowTask,
  createWorkflowTask,
  failWorkflowTask,
  formatWorkflowNotification,
  pauseWorkflowTask,
  resumeWorkflowTask,
  updateWorkflowProgressBatch,
  type WorkflowTask,
} from "../src/workflow/task.js";

function stubControl(): WorkflowControl & { pause: ReturnType<typeof vi.fn> } {
  return {
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: vi.fn(() => false),
    skip: vi.fn(() => true),
    retry: vi.fn(() => true),
  } as unknown as WorkflowControl & { pause: ReturnType<typeof vi.fn> };
}

function runningTask(): { task: WorkflowTask; control: ReturnType<typeof stubControl> } {
  const task = createWorkflowTask({ id: "wf_abc123", script: "", startTime: 1_000 });
  const control = stubControl();
  task.control = control;
  return { task, control };
}

describe("pausing a run", () => {
  it("tells the run to hold, not just the record", () => {
    // Flipping the status alone would show a paused run in every surface while
    // it kept starting agents.
    const { task, control } = runningTask();

    expect(pauseWorkflowTask(task, 5_000)).toBe(true);
    expect(control.pause).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("paused");
    expect(task.pausedAt).toBe(5_000);
  });

  it("banks the held time on resume, so elapsed does not count it", () => {
    const { task, control } = runningTask();
    pauseWorkflowTask(task, 5_000);

    expect(resumeWorkflowTask(task, 9_000)).toBe(true);
    expect(control.resume).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("running");
    expect(task.totalPausedMs).toBe(4_000);
    expect(task.pausedAt).toBeUndefined();
  });

  it("accumulates across several pauses", () => {
    const { task } = runningTask();
    pauseWorkflowTask(task, 2_000);
    resumeWorkflowTask(task, 3_000);
    pauseWorkflowTask(task, 4_000);
    resumeWorkflowTask(task, 10_000);

    expect(task.totalPausedMs).toBe(7_000);
  });

  it("refuses when there is no run behind the record", () => {
    // A task whose run has settled keeps its progress but loses its control;
    // pausing it would be a status the runtime never agreed to.
    const task = createWorkflowTask({ id: "wf_abc123", script: "" });
    expect(pauseWorkflowTask(task)).toBe(false);
    expect(task.status).toBe("running");
  });

  it("refuses to pause twice or resume something running", () => {
    const { task, control } = runningTask();
    expect(pauseWorkflowTask(task, 1_000)).toBe(true);
    expect(pauseWorkflowTask(task, 2_000)).toBe(false);
    expect(control.pause).toHaveBeenCalledTimes(1);
    // And the first pause's clock is untouched by the refused second one.
    expect(task.pausedAt).toBe(1_000);

    expect(resumeWorkflowTask(task, 3_000)).toBe(true);
    expect(resumeWorkflowTask(task, 4_000)).toBe(false);
    expect(control.resume).toHaveBeenCalledTimes(1);
  });
});

describe("settling a run", () => {
  const result = {
    status: "completed" as const,
    value: 1,
    meta: { name: "wf", description: "d" },
    progress: [],
    agentCount: 0,
    replayedCount: 0,
  };

  it("drops the control so a finished run cannot be paused", () => {
    const { task } = runningTask();
    completeWorkflowTask(task, result);

    expect(task.control).toBeUndefined();
    expect(pauseWorkflowTask(task)).toBe(false);
  });

  it("banks a pause that was still open when the run finished", () => {
    // A run held at a pause can still settle — its last agents finish and the
    // script returns. That time was spent held, and elapsed has to say so.
    const { task } = runningTask();
    pauseWorkflowTask(task, Date.now() - 3_000);
    completeWorkflowTask(task, result);

    expect(task.pausedAt).toBeUndefined();
    expect(task.totalPausedMs).toBeGreaterThanOrEqual(3_000);
    expect(task.status).toBe("completed");
  });

  it("drops the control when the run never started", () => {
    const { task } = runningTask();
    failWorkflowTask(task, "bad meta");

    expect(task.control).toBeUndefined();
    expect(task.status).toBe("failed");
  });
});


describe("surfacing a stalled child", () => {
  /** A run with one clean child and one the watchdog stopped. */
  function stalledTask(): WorkflowTask {
    const task = createWorkflowTask({ id: "wf_x", script: "x", scriptPath: "x", toolCallId: "c" });
    task.workflowName = "sdd-final-review";
    task.workflowProgress = [
      { type: "workflow_agent", index: 0, label: "find:correctness", state: "done" },
      { type: "workflow_agent", index: 1, label: "verify:a.ts:1", state: "error", timedOut: true },
    ];
    task.agentCount = 2;
    task.status = "completed";
    return task;
  }

  it("names timed-out children in the notification summary", () => {
    expect(formatWorkflowNotification(stalledTask())).toContain("1 timed out (stalled)");
  });

  it("leaves the summary alone when nothing stalled", () => {
    const task = createWorkflowTask({ id: "wf_x", script: "x" });
    task.workflowProgress = [{ type: "workflow_agent", index: 0, label: "find", state: "done" }];
    task.status = "completed";
    expect(formatWorkflowNotification(task)).not.toContain("timed out");
  });

  it("reports each timed-out child once, however many batches it spans", () => {
    // The batch handler toasts what this returns, so a row the runtime
    // re-emits (a later batch carries its duration) must not toast twice.
    const task = createWorkflowTask({ id: "wf_x", script: "x" });
    const row = {
      type: "workflow_agent",
      index: 1,
      label: "verify:a.ts:1",
      state: "error",
      timedOut: true,
    } as const;

    expect(updateWorkflowProgressBatch(task, [row])).toEqual(["verify:a.ts:1"]);
    expect(updateWorkflowProgressBatch(task, [{ ...row, durationMs: 12 }])).toEqual([]);
  });

  it("reports a stall once per attempt, so a retry that stalls again is heard", () => {
    // Keyed by index alone, a retry that stalls a second time was silent: the
    // run's one warning had already been spent on the attempt the user threw
    // away.
    const task = createWorkflowTask({ id: "wf_toast", script: "return 1" });
    const row = (attempt: number) => ({
      type: "workflow_agent" as const,
      index: 0,
      label: "verifier",
      state: "error" as const,
      timedOut: true,
      attempt,
    });

    expect(updateWorkflowProgressBatch(task, [row(0)])).toEqual(["verifier"]);
    expect(updateWorkflowProgressBatch(task, [row(0)])).toEqual([]);
    expect(updateWorkflowProgressBatch(task, [row(1)])).toEqual(["verifier"]);
    expect(updateWorkflowProgressBatch(task, [row(1)])).toEqual([]);
  });

  it("says nothing about a skip or an ordinary failure", () => {
    const task = createWorkflowTask({ id: "wf_x", script: "x" });
    expect(
      updateWorkflowProgressBatch(task, [
        { type: "workflow_agent", index: 0, label: "dismissed", state: "error", skipped: true },
        { type: "workflow_agent", index: 1, label: "broke", state: "error" },
      ]),
    ).toEqual([]);
  });
});

describe("snapshotting a settled run", () => {
  it("carries the run id and the outcome, so a reload can still answer for it", () => {
    // The transcript is the only thing that outlives the process. Without the
    // id the snapshot is unqueryable after a reload; without the outcome
    // `get_subagent_result` has nothing left to report (§5d).
    const task = createWorkflowTask({ id: "wf_abc123", script: "x" });
    task.status = "completed";
    task.value = "all clear";

    expect(workflowEntryData(task)).toMatchObject({ id: "wf_abc123", result: "all clear" });
  });

  it("persists paused time, and omits the field entirely when there is none", () => {
    // Both directions are load-bearing. With the pause in the snapshot a
    // recovered run reports the duration the live one did; without the field —
    // the default, and every snapshot written before it existed — the key must
    // be absent rather than `0`, or every legacy snapshot's bytes change.
    const paused = createWorkflowTask({ id: "wf_paused", script: "x" });
    paused.status = "completed";
    paused.totalPausedMs = 600_000;
    expect(workflowEntryData(paused)).toMatchObject({ totalPausedMs: 600_000 });

    const fresh = createWorkflowTask({ id: "wf_fresh", script: "x" });
    fresh.status = "completed";
    expect(workflowEntryData(fresh)).not.toHaveProperty("totalPausedMs");
  });

  it("caps the persisted outcome so a large run result cannot bloat the transcript", () => {
    // The snapshot lands in the session file, so an unbounded `JSON.stringify`
    // of a large run value would grow it without limit. Same 4000-char budget
    // as the completion notification.
    const task = createWorkflowTask({ id: "wf_big", script: "x" });
    task.status = "completed";
    task.value = { blob: "x".repeat(50_000) };

    const data = workflowEntryData(task);
    expect(data.result).toBeDefined();
    expect((data.result ?? "").length).toBeLessThanOrEqual(4000 + "\n...(truncated)".length);
    expect(data.result?.endsWith("\n...(truncated)")).toBe(true);
  });
});