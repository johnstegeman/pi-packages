import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultMaxTurns,
  getGraceTurns,
  normalizeMaxTurns,
  setDefaultMaxTurns,
  setGraceTurns,
} from "../src/agent-runner.js";
import {
  applySettings,
  getWorkflowStallTimeoutSecs,
  type SettingsAppliers,
  setWorkflowStallTimeout,
} from "../src/settings.js";

describe("setDefaultMaxTurns / getDefaultMaxTurns", () => {
  beforeEach(() => {
    setDefaultMaxTurns(undefined);
  });

  it("defaults to undefined (unlimited)", () => {
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("stores a positive integer", () => {
    setDefaultMaxTurns(30);
    expect(getDefaultMaxTurns()).toBe(30);
  });

  it("accepts boundary value 1", () => {
    setDefaultMaxTurns(1);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("treats 0 as unlimited", () => {
    setDefaultMaxTurns(0);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("clamps negative values to 1", () => {
    setDefaultMaxTurns(-10);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("undefined resets to unlimited after being set", () => {
    setDefaultMaxTurns(50);
    expect(getDefaultMaxTurns()).toBe(50);
    setDefaultMaxTurns(undefined);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });
});

describe("normalizeMaxTurns", () => {
  it("treats undefined as unlimited", () => {
    expect(normalizeMaxTurns(undefined)).toBeUndefined();
  });

  it("treats 0 as unlimited", () => {
    expect(normalizeMaxTurns(0)).toBeUndefined();
  });

  it("keeps positive values", () => {
    expect(normalizeMaxTurns(7)).toBe(7);
  });

  it("clamps negative values to 1", () => {
    expect(normalizeMaxTurns(-3)).toBe(1);
  });
});

describe("setGraceTurns / getGraceTurns", () => {
  beforeEach(() => {
    setGraceTurns(5);
  });

  it("round-trips the value this suite set up", () => {
    // NOT a default assertion — the beforeEach above sets 5, so this only
    // proves the setter/getter pair agree. The real module default is asserted
    // against a freshly-imported module in test/documented-defaults.test.ts.
    expect(getGraceTurns()).toBe(5);
  });

  it("stores a positive integer", () => {
    setGraceTurns(10);
    expect(getGraceTurns()).toBe(10);
  });

  it("accepts boundary value 1", () => {
    setGraceTurns(1);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps 0 to 1", () => {
    setGraceTurns(0);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps negative values to 1", () => {
    setGraceTurns(-5);
    expect(getGraceTurns()).toBe(1);
  });

/**
 * `workflowStallTimeoutSecs` is a settings.ts-level value: the module owns both
 * the state and the applier, so this is the round trip the extension performs
 * at boot (settings object → applySettings → applier → module state → getter).
 * The extension's own wiring of that applier is covered by
 * test/workflow-stall-wiring.test.ts.
 */
describe("workflowStallTimeoutSecs", () => {
  /** Every applier stubbed; only the one under test writes real state. */
  function appliers(overrides: Partial<SettingsAppliers> = {}): SettingsAppliers {
    const noop = () => {};
    return {
      setMaxConcurrent: noop,
      setMaxConcurrentForeground: noop,
      setDefaultMaxTurns: noop,
      setGraceTurns: noop,
      setDefaultJoinMode: noop,
      setBackgroundByDefault: noop,
      setSchedulingEnabled: noop,
      setScopeModels: noop,
      setStrictAgentFiles: noop,
      setDisableDefaultAgents: noop,
      setToolDescriptionMode: noop,
      setFleetView: noop,
      setAgentMentions: noop,
      setRememberAgents: noop,
      setWidgetMode: noop,
      setOutputTranscript: noop,
      setWorktreeIsolation: noop,
      setWorkflowsEnabled: noop,
      setMaxSubagentDepth: noop,
      setFallbackSubagent: noop,
      setReportUsage: noop,
      setShowCost: noop,
      setShowModel: noop,
      setViewerMarkdown: noop,
      setWorkflowStallTimeout: noop,
      ...overrides,
    };
  }

  it("applies workflowStallTimeoutSecs including 0", () => {
    applySettings({ workflowStallTimeoutSecs: 900 }, appliers({ setWorkflowStallTimeout }));
    expect(getWorkflowStallTimeoutSecs()).toBe(900);

    // 0 is a real value — "watchdog off" — so the `typeof === "number"` guard
    // in applySettings is load-bearing; truthiness would silently skip it.
    applySettings({ workflowStallTimeoutSecs: 0 }, appliers({ setWorkflowStallTimeout }));
    expect(getWorkflowStallTimeoutSecs()).toBe(0);
  });

  it("leaves the window alone when the setting is absent", () => {
    // Absence means "use the default", not "reset" — the applier must not fire,
    // which is what keeps a global value from being clobbered by a project file
    // that says nothing about it.
    applySettings({ workflowStallTimeoutSecs: 42 }, appliers({ setWorkflowStallTimeout }));
    const applier = vi.fn();
    applySettings({}, appliers({ setWorkflowStallTimeout: applier }));
    expect(applier).not.toHaveBeenCalled();
    expect(getWorkflowStallTimeoutSecs()).toBe(42);
  });
});
});
