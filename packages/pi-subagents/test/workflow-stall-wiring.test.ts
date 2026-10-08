/**
 * workflow-stall-wiring.test.ts — `workflowStallTimeoutSecs` through the REAL
 * extension: settings file → applier → module state → the `stallTimeoutMs`
 * option `runWorkflowTask` hands the runtime.
 *
 * The runtime's own watchdog is covered by workflow-runtime.test.ts. What no
 * other test covers is the seam: nothing else reads this setting, so a dropped
 * applier or a call site that forgets the option leaves every workflow on the
 * built-in window while `/agents → Settings` happily shows the user's number.
 *
 * `runWorkflow` is mocked only so the option object can be inspected; the rest
 * of the runtime (and `assertWorkflowArgs`, which runs before the mock) stays
 * real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/workflow/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/workflow/runtime.js")>();
  return {
    ...actual,
    runWorkflow: vi.fn(async (options: RunWorkflowOptions) => {
      // The runtime's watchdog row reaches the extension only through
      // `onProgress`, so the mock has to be the one that emits it for the
      // toast to be under test at all.
      options.onProgress?.([
        { type: "workflow_agent", index: 0, label: "verifier", state: "error", timedOut: true },
      ]);
      return {
        status: "completed" as const,
        meta: { name: "wired", description: "wired" },
        value: "done",
        progress: [],
        agentCount: 0,
        replayedCount: 0,
      };
    }),
  };
});

import subagentsExtension from "../src/index.js";
import { getWorkflowStallTimeoutSecs, setWorkflowStallTimeout } from "../src/settings.js";
import { type RunWorkflowOptions, runWorkflow } from "../src/workflow/runtime.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const script = 'export const meta = { name: "wired", description: "wired" };\nreturn "done";\n';

let hermetic: Hermetic | undefined;
let booted: ReturnType<typeof makePi> | undefined;

/** Boot the real extension against a hermetic project directory. */
function boot(settings: Record<string, unknown> = {}) {
  // Hermetic dir first — settings are read at extension load.
  hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true, ...settings } });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b;
  return b;
}

/** Run one workflow through the registered tool and return the options it used. */
async function runOneWorkflow() {
  const b = booted!;
  await b.tools
    .get("SubagentWorkflow")
    .execute("tc-stall", { script }, undefined, undefined, ctx({ cwd: hermetic!.dir }));
  await vi.waitFor(() => expect(vi.mocked(runWorkflow)).toHaveBeenCalled());
  return vi.mocked(runWorkflow).mock.calls[0][0];
}

beforeEach(() => {
  // The module-level window survives between tests in this file, so each test
  // states the value it expects rather than inheriting the previous one.
  setWorkflowStallTimeout(600);
  vi.mocked(runWorkflow).mockClear();
});

afterEach(async () => {
  // Let the detached run settle before its temp dir disappears underneath it.
  await flush();
  await booted?.lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

describe("workflowStallTimeoutSecs — settings to runWorkflow", () => {
  it("applies the persisted setting to the in-memory window at boot", () => {
    boot({ workflowStallTimeoutSecs: 900 });
    expect(getWorkflowStallTimeoutSecs()).toBe(900);
  });

  it("leaves the default in place when the setting is absent", () => {
    boot();
    expect(getWorkflowStallTimeoutSecs()).toBe(600);
  });

  it("passes the window to runWorkflow as milliseconds", async () => {
    boot({ workflowStallTimeoutSecs: 900 });
    const options = await runOneWorkflow();
    // Seconds in the file, milliseconds in RunWorkflowOptions — the conversion
    // is the whole reason this test exists.
    expect(options.stallTimeoutMs).toBe(900_000);
  });

  it("passes an explicit 0 through, which the runtime reads as disabled", async () => {
    boot({ workflowStallTimeoutSecs: 0 });
    const options = await runOneWorkflow();
    // Not `undefined`/`null`: the runtime distinguishes "0 = off" from "unset =
    // use the built-in default", so a `||` fallback here would turn the user's
    // off switch back on.
    expect(options.stallTimeoutMs).toBe(0);
  });

  it("passes a run-level window at twice the child window", async () => {
    boot({ workflowStallTimeoutSecs: 900 });
    const options = await runOneWorkflow();
    // The runtime's own default draws the run window as 2× the child window;
    // the setting has to drive that same relationship, or the Settings label
    // would only govern the per-child watchdog and leave the run-level one
    // armed at a fixed 20 minutes.
    expect(options.runStallTimeoutMs).toBe(1_800_000);
  });

  it("passes an explicit 0 through to the run-level window too, which disables it", async () => {
    boot({ workflowStallTimeoutSecs: 0 });
    const options = await runOneWorkflow();
    // `0 × 2` is still 0. Leaving `runStallTimeoutMs` unset here would arm the
    // runtime's built-in window and make the user's off switch a lie — which is
    // exactly the bug this assertion locks down.
    expect(options.runStallTimeoutMs).toBe(0);
  });

  it("toasts a stalled child once, through the real extension", async () => {
    // The toast is the only non-blocking channel the user gets while the run is
    // still going; without this test its wording and its level are unpinned.
    boot();
    const c = ctx({ cwd: hermetic!.dir, hasUI: true });
    await booted!.tools
      .get("SubagentWorkflow")
      .execute("tc-toast", { script }, undefined, undefined, c);

    expect(c.ui.notify).toHaveBeenCalledWith("Workflow child timed out (stalled): verifier", "warning");
  });
});
