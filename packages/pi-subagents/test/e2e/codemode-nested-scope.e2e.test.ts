/**
 * codemode-nested-scope.e2e.test.ts — the nested (script) path honors the
 * subagent tool scope.
 *
 * `installExtensionToolScope` enforces the scope in two places: `turn_end`
 * re-narrows the ACTIVE set, and a wrap of `session.agent.beforeToolCall`
 * vetoes out-of-scope calls that turn 1 cannot pre-narrow. Neither covers the
 * path a codemode script takes. `ctx.executeTool()` goes through
 * `AgentSession._executeNestedToolCall`, whose `runToolCall` gets
 * `beforeToolCall: (ctx) => this._beforeToolCall(ctx, parentId)` — the
 * session's own dispatcher for extension `tool_call` handlers, NOT the
 * `agent.beforeToolCall` property we wrap. So the wrap is invisible to scripts.
 *
 * The active set cannot close that gap either: `_getCallableTools()` returns the
 * active `direct` tools PLUS every registered `codemode`/`deferred` tool, so a
 * `deferred` tool the `ext:` narrowing excluded is still callable from a script.
 *
 * This guard drives a REAL codemode script (real QuickJS executor, real
 * session, real extensions) and asserts:
 *   1. an in-scope deferred tool is still callable from a script, and
 *   2. an out-of-scope deferred tool is REFUSED.
 *
 * No network/LLM: a faux Model satisfies `createAgentSession`; the script is
 * executed directly against the session's codemode tool rather than through a
 * model turn. A synthetic assistant message is pushed first because pi
 * attributes nested calls to the last assistant message and refuses without one
 * (that refusal would make this test pass for the wrong reason).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

// Real pi-mono (loader + dynamic extension import + session construction) plus
// a real QuickJS codemode execution; give a cold run headroom.
vi.setConfig({ testTimeout: 30_000 });

const VETO_NESTED = resolve(fileURLToPath(new URL("../fixtures/ext-veto-nested.mjs", import.meta.url)));

function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

/** Concatenated text of a tool result. */
function textOf(result: any): string {
  return (result?.content ?? [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");
}

describe("codemode nested calls honor the subagent tool scope", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-nested-scope-"));
    faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses a script's call to a deferred tool the ext: narrowing excluded", async () => {
    registerAgents(
      new Map([
        [
          "nested-scope",
          {
            name: "nested-scope",
            description: "nested scope guard",
            builtinToolNames: ["read"],
            extensions: [VETO_NESTED],
            // Narrow the extension to probe_allowed: probe_denied is registered
            // (and deferred-callable) but deliberately out of scope.
            extSelectors: ["ext:ext-veto-nested.mjs/probe_allowed"],
            skills: false,
            systemPrompt: "You are nested-scope.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
          } as AgentConfig,
        ],
      ]),
    );

    const model = faux.getModel();
    const modelRegistry: any = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };

    let session: any;
    try {
      await runAgent(ctx, "nested-scope", "go", {
        pi: makePi(),
        model,
        onSessionCreated: (s: any) => {
          session = s;
        },
      });
    } catch {
      // A faux-model turn may not complete; the scope is fixed at construction.
    }

    // Nested calls are attributed to the last assistant message; without one pi
    // refuses the call before any hook runs, which would mask the real result.
    session.agent.state.messages.push({
      role: "assistant",
      content: [],
      api: "faux",
      provider: "faux",
      model: "faux-1",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const codemode = session.agent.state.tools.find((t: any) => t.name === "codemode");
    expect(codemode, "codemode must be active for a codemode script to run").toBeTruthy();

    const runScript = async (code: string): Promise<string> =>
      textOf(await codemode.execute("nested-scope-test", { code }, undefined, undefined));

    // Control: the narrowing selected probe_allowed, so it must still run. This
    // also proves the guard is not a blanket block on nested calls.
    expect(await runScript("return await tools.probe_allowed({})")).toContain("probe_allowed ran");

    // The gap: probe_denied is deferred, so it stays in getCallableTools() even
    // though the ext: narrowing kept it out of the active set. It must be vetoed.
    const denied = await runScript("return await tools.probe_denied({})");
    expect(denied).not.toContain("probe_denied ran");
    expect(denied).toMatch(/not available to this subagent/i);
  });
});
