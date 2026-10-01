/**
 * mention-clone-seeding.e2e.test.ts — what the MODEL actually receives from a
 * mention clone.
 *
 * `runMentionClone` exists to hand a throwaway session the parent's conversation
 * and the parent's live system prompt. Both are decided by Pi, not by the module:
 * since 0.87.0 the `SessionManager` is canonical for an `AgentSession`'s provider
 * context, and the prompt is projected from `before_agent_start`/`forceSystemPrompt`
 * rather than read off a writable field. A unit test whose fake session asserts on
 * the array the module happens to write to therefore passes against a clone that
 * seeds NOTHING — which is exactly the state this port shipped in.
 *
 * So this drives a REAL `AgentSession` through a faux provider and asserts on the
 * transcript the provider was handed: the parent's messages are in it, and the
 * leading system prompt is the parent's, not one rebuilt from cwd/agentDir.
 *
 * No network: a faux provider satisfies session construction and the turn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

// Real pi-mono session construction; a cold first run under full-suite CPU
// contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

const PARENT_PROMPT = "PARENT-LIVE-SYSTEM-PROMPT";

/** Text of every non-system message the provider was handed, in order. */
function providerText(messages: TranscriptContext["messages"]): string[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) =>
      ((m.content ?? []) as Array<{ type?: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(""),
    );
}

describe("mention clone transcript seeding against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-mention-seed-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Run the clone over a real parent conversation and capture what the provider got. */
  async function runClone(conversation: Array<Record<string, unknown>>) {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);

    const received: TranscriptContext[] = [];
    faux.setResponses([
      (context) => {
        received.push(context);
        return fauxAssistantMessage([fauxText("ok")]);
      },
    ]);

    // A real SessionManager holding the parent's conversation — the same shape
    // `runMentionClone` reads through `ctx.sessionManager.getEntries()`.
    const parent = SessionManager.inMemory(cwd);
    for (const message of conversation) parent.appendMessage(message as never);

    const ctx: any = {
      cwd,
      model,
      thinkingLevel: "medium",
      getSystemPrompt: () => PARENT_PROMPT,
      // The runtime off the registry facade, the same shim agent-runner carries
      // for Pi >= 0.80.8.
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: { getEntries: () => parent.getEntries(), getLeafId: () => parent.getLeafId() },
    };

    const agentTool = {
      name: "Agent",
      // A real `ToolDefinition`. `toToolDeclaration` JSON round-trips `parameters`,
      // so a bare `{ name, execute }` mock dies in the request with
      // `"undefined" is not valid JSON` before the provider is ever reached.
      description: "Start a subagent",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "Agent ID: a1" }], details: {} })),
    } as any;

    await runMentionClone({ ctx, type: "Explore", message: "find the flaky test", agentTool });
    return received;
  }

  it("hands the provider the parent's conversation, not just the reminder", async () => {
    const received = await runClone([
      { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 },
    ]);

    expect(received).toHaveLength(1);
    const text = providerText(received[0].messages);
    // The whole point of the clone: the copy reasons over what the main model can see.
    expect(text).toContain("hi");
    expect(text).toContain("hello");
    // …and the mention itself still arrives.
    expect(text.some((t) => t.includes("find the flaky test"))).toBe(true);
  });

  it("hands the provider the parent's live prompt, not one rebuilt from cwd/agentDir", async () => {
    const received = await runClone([{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }]);

    expect(received).toHaveLength(1);
    expect(getCurrentSystemPrompt(received[0].messages)).toBe(PARENT_PROMPT);
  });
});
