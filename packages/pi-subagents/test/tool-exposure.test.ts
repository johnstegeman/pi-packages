// Code-mode exposure (#code-mode plan, stage A): instantiates the real extension
// with a mock pi (same pattern as tool-description-mode.test.ts) and inspects the
// tool objects pi actually receives — never the source text of index.ts.

import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn(),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
  };
}

function registered() {
  const { pi, tools } = makePi();
  subagentsExtension(pi);
  return tools;
}

const NAMESPACE = {
  name: "subagents",
  description: "Subagent dispatch and workflow orchestration",
};

describe("code-mode exposure", () => {
  it("defers SubagentWorkflow", () => {
    expect(registered().get("SubagentWorkflow")?.exposure).toBe("deferred");
  });

  it("exposes the two helper tools as codemode", () => {
    const tools = registered();
    expect(tools.get("get_subagent_result")?.exposure).toBe("codemode");
    expect(tools.get("steer_subagent")?.exposure).toBe("codemode");
  });

  it("groups the moved tools under the subagents namespace", () => {
    const tools = registered();
    for (const name of ["SubagentWorkflow", "get_subagent_result", "steer_subagent"]) {
      expect(tools.get(name)?.namespace).toEqual(NAMESPACE);
    }
  });

  it("leaves Agent direct", () => {
    const agent = registered().get("Agent");
    expect(agent).toBeDefined();
    expect(agent?.exposure).toBeUndefined();
    expect(agent?.namespace).toBeUndefined();
  });

  it("declares outputSchema on get_subagent_result", () => {
    expect(registered().get("get_subagent_result")?.outputSchema).toBeDefined();
  });

  it("returns structuredContent from get_subagent_result", async () => {
    const tool = registered().get("get_subagent_result");
    const result = await tool.execute("tc", { agent_id: "no-such-agent" }, undefined, undefined, undefined);
    expect(result.structuredContent).toEqual({ error: 'Agent not found: "no-such-agent"' });
  });
});
