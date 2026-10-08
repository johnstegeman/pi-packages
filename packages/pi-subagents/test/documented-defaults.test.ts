// README publishes concrete default values (Persistent settings, README:441).
// Every existing test that looked like it checked one actually SET the value
// first — `test/agent-runner-settings.test.ts` had a `beforeEach(setGraceTurns(5))`
// followed by `it("defaults to 5")`, which asserts the setter, not the default.
//
// The defaults live in module-level `let`s that the settings appliers overwrite
// at boot, so reading them after any other suite has run tells you nothing.
// `vi.resetModules()` + a dynamic import gives a genuinely fresh module, which
// is why this lives in its own file: resetModules is file-wide and hostile to
// suites that hold module references across tests.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("documented defaults (README:441)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // src/agent-runner.js pulls in the whole pi-coding-agent graph, and
  // `server.deps.inline` means resetModules re-transforms all of it — several
  // seconds under a loaded full run, versus instant in isolation. The default
  // 5s timeout makes these two flaky, so they get an explicit generous one
  // rather than a retry.
  const HEAVY_REIMPORT_MS = 60_000;

  it("grace turns after the soft limit default to 5", async () => {
    const { getGraceTurns } = await import("../src/agent-runner.js");
    expect(getGraceTurns()).toBe(5);
  }, HEAVY_REIMPORT_MS);

  it("max turns is unlimited by default", async () => {
    const { getDefaultMaxTurns } = await import("../src/agent-runner.js");
    expect(getDefaultMaxTurns()).toBeUndefined();
  }, HEAVY_REIMPORT_MS);

  it("nested subagent depth defaults to 2", async () => {
    const { getMaxSubagentDepth } = await import("../src/nested-tools.js");
    expect(getMaxSubagentDepth()).toBe(2);
  });

  // Raised from 4 when top-level spawns started defaulting to background:
  // foreground bypasses the pool entirely, so a limit tuned for opt-in
  // background would now queue the tail of ordinary parallel fan-outs.
  it("background concurrency defaults to 10", async () => {
    const { AgentManager } = await import("../src/agent-manager.js");
    const manager = new AgentManager();
    try {
      expect(manager.getMaxConcurrent()).toBe(10);
    } finally {
      manager.dispose();
    }
  });

  // Off, not a number: nothing here ever bounded foreground work, and pi runs a
  // message's tool calls through Promise.all, so any default above 0 would be a
  // behaviour change for everyone rather than an opt-in for #253's reporter.
  it("foreground concurrency is unlimited by default", async () => {
    const { AgentManager } = await import("../src/agent-manager.js");
    const manager = new AgentManager();
    try {
      expect(manager.getMaxConcurrentForeground()).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it("top-level spawns default to background, nested spawns to foreground", async () => {
    const { resolveAgentInvocationConfig } = await import("../src/invocation-config.js");
    // The setting's default (true) is what index.ts passes for top-level calls.
    expect(resolveAgentInvocationConfig(undefined, {}, { defaultRunInBackground: true }).runInBackground).toBe(true);
    // nested-tools.ts passes false unconditionally.
    expect(resolveAgentInvocationConfig(undefined, {}, { defaultRunInBackground: false }).runInBackground).toBe(false);
    // An explicit param still wins over either default.
    expect(resolveAgentInvocationConfig(undefined, { run_in_background: false }, { defaultRunInBackground: true }).runInBackground).toBe(false);
    expect(resolveAgentInvocationConfig(undefined, { run_in_background: true }, { defaultRunInBackground: false }).runInBackground).toBe(true);
  });

  it("model scope is off by default", async () => {
    // Off is the safe default: on, an unconfigured enabledModels would start
    // refusing spawns. README:428 documents it as opt-in.
    const { isScopeModelsEnabled } = await import("../src/model-scope.js");
    expect(isScopeModelsEnabled()).toBe(false);
  });

  it("workflow stall timeout defaults to 10 minutes", async () => {
    const { getWorkflowStallTimeoutSecs } = await import("../src/settings.js");
    expect(getWorkflowStallTimeoutSecs()).toBe(600);
  }, HEAVY_REIMPORT_MS);

  // The user-facing half of the same default: the module value is worthless to
  // someone who cannot learn the knob exists, and the README's Persistent
  // Settings section is the only place it is published. Pin both places a user
  // reads it (the setting's own paragraph, and the hardcoded-defaults list).
  it("README documents the workflow stall timeout default", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
    expect(readme).toContain("**Workflow stall timeout** (`workflowStallTimeoutSecs`, default `600`)");
    expect(readme).toMatch(/hardcoded defaults \([^)]*workflow stall timeout `600`/);
  });

  // The user-facing setting is seconds and lives in settings.ts; the runtime's
  // own fallback is milliseconds in workflow/runtime.ts. Nothing else ties the
  // two constants together, and a drift between them would give every workflow
  // a window the settings menu does not show.
  it("agrees with the runtime's millisecond fallback", async () => {
    const { getWorkflowStallTimeoutSecs } = await import("../src/settings.js");
    const { DEFAULT_STALL_TIMEOUT_MS } = await import("../src/workflow/runtime.js");
    expect(getWorkflowStallTimeoutSecs() * 1000).toBe(DEFAULT_STALL_TIMEOUT_MS);
  }, HEAVY_REIMPORT_MS);
});
