/**
 * rex-child-mode.test.ts — the narrow half of a pane child.
 *
 * The child is a real `pi` that loads this extension too, so "child mode" is what
 * keeps it from becoming a second root manager: it reads its spec, scopes its
 * tools, reports one result file and ends itself. Every assertion here is about
 * that narrowness — which tools surface, which handlers run, and that the result
 * is written exactly once.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { installChildMode, isChildMode, readChildSpec, writeChildResult } from "../src/rex/child-mode.js";
import type { ChildSpec } from "../src/rex/launcher.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

/** The keys the parent's reader is promised, in the order the file writes them. */
const RESULT_KEYS = [
  "text",
  "failure",
  "aborted",
  "steered",
  "structuredJson",
  "structuredRetried",
  "usage",
  "model",
  "thinkingLevel",
  "sessionFile",
  "turns",
];

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});

function hermetic(settings?: Record<string, unknown>): string {
  const h = hermeticDir(settings ? { settings } : {});
  cleanup = h.restore;
  return h.dir;
}

function specFor(dir: string, overrides: Partial<ChildSpec> = {}): ChildSpec {
  return {
    agentId: "agent-1",
    rootSessionId: "root-1",
    depth: 1,
    maxSubagentDepth: 2,
    allowedSubagents: "all",
    resultPath: join(dir, "agent-1.result.json"),
    cwd: dir,
    toolScope: { tools: ["read"], excludeTools: [] },
    model: "anthropic/claude-sonnet-4-6",
    thinking: "medium",
    pane: { sessionId: "rex-session", windowId: "window-1" },
    ...overrides,
  };
}

/**
 * A stub `ExtensionAPI` that records handlers per event (pi allows several per
 * event, and child mode registers two `turn_end` handlers), plus `send`, which
 * delivers one event to all of them.
 */
function makeChildPi() {
  const { pi, tools, commands } = makePi();
  const handlers = new Map<string, ((event: any, c: any) => any)[]>();
  pi.on = vi.fn((event: string, handler: (e: any, c: any) => any) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return () => {};
  });
  pi.sendUserMessage = vi.fn();
  pi.getThinkingLevel = vi.fn(() => "medium");
  const send = async (event: string, payload: Record<string, unknown> = {}, c: any = ctx()) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, c);
  };
  return { pi, tools, commands, handlers, send };
}

function toolInfo(name: string, path: string) {
  return { name, description: name, parameters: {}, sourceInfo: { path, source: "", scope: "", origin: "" } };
}

function childCtx(overrides: Record<string, unknown> = {}) {
  return ctx({
    model: { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    thinkingLevel: "high",
    sessionManager: { getSessionFile: () => "/tmp/child-session.jsonl" },
    shutdown: vi.fn(),
    abort: vi.fn(),
    ...overrides,
  });
}

// A real assistant message always carries `usage`; the fixture does too, so a test
// that does not care about tokens still exercises the accumulation path.
function assistantEnd(text: string, usage = { input: 0, output: 0, cacheWrite: 0 }) {
  return {
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage },
  };
}

/** `agent_settled` carries no payload; one constant so the call sites read the same. */
const SETTLED = {};

describe("readChildSpec", () => {
  it("reads the spec the parent wrote and deletes the variable it read it from", () => {
    const dir = hermetic();
    const spec = specFor(dir);
    const path = join(dir, "spec.json");
    writeFileSync(path, JSON.stringify(spec), "utf-8");
    const env: NodeJS.ProcessEnv = { PI_SUBAGENTS_CHILD_SPEC: path, PATH: "/usr/bin" };

    expect(readChildSpec(env)).toEqual(spec);
    expect(env.PI_SUBAGENTS_CHILD_SPEC).toBeUndefined();
    // Only the env it was handed is touched — process.env is not a fallback here.
    expect(env.PATH).toBe("/usr/bin");
  });

  it("returns undefined when the variable is absent", () => {
    expect(readChildSpec({})).toBeUndefined();
  });

  it("returns undefined for an empty value, and still clears it", () => {
    const env: NodeJS.ProcessEnv = { PI_SUBAGENTS_CHILD_SPEC: "  " };
    expect(readChildSpec(env)).toBeUndefined();
    expect(env.PI_SUBAGENTS_CHILD_SPEC).toBeUndefined();
  });

  it("returns undefined for a path that is not there, and still clears it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = { PI_SUBAGENTS_CHILD_SPEC: "/nonexistent/spec.json" };

    expect(readChildSpec(env)).toBeUndefined();
    expect(env.PI_SUBAGENTS_CHILD_SPEC).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    const dir = hermetic();
    const path = join(dir, "spec.json");
    writeFileSync(path, "{ not json", "utf-8");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(readChildSpec({ PI_SUBAGENTS_CHILD_SPEC: path })).toBeUndefined();
  });

  it("returns undefined for JSON that is not a spec", () => {
    const dir = hermetic();
    const path = join(dir, "spec.json");
    writeFileSync(path, JSON.stringify({ agentId: "a" }), "utf-8");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(readChildSpec({ PI_SUBAGENTS_CHILD_SPEC: path })).toBeUndefined();
  });
});

describe("writeChildResult", () => {
  it("writes exactly the documented keys, atomically", () => {
    const dir = hermetic();
    const path = join(dir, "agent-1.result.json");

    writeChildResult(path, {
      text: "the answer",
      failure: "provider error with no output",
      aborted: false,
      steered: true,
      structuredJson: '{"answer":"42"}',
      structuredRetried: true,
      usage: { input: 10, output: 5, cacheWrite: 2 },
      model: "anthropic/claude-sonnet-4-6",
      thinkingLevel: "high",
      sessionFile: "/tmp/child-session.jsonl",
      turns: 3,
    });

    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(Object.keys(written)).toEqual(RESULT_KEYS);
    expect(written.usage).toEqual({ input: 10, output: 5, cacheWrite: 2 });
    expect(written.turns).toBe(3);
    // The temp file the rename came from is gone: a parent polling the path
    // never reads a half-written result.
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("omits the optional keys that have no value, and keeps structuredRetried explicit", () => {
    const dir = hermetic();
    const path = join(dir, "agent-1.result.json");

    writeChildResult(path, {
      text: "",
      aborted: true,
      steered: false,
      usage: { input: 0, output: 0, cacheWrite: 0 },
      model: "anthropic/claude-sonnet-4-6",
      thinkingLevel: "medium",
      turns: 0,
    });

    const written = JSON.parse(readFileSync(path, "utf-8"));
    for (const key of Object.keys(written)) expect(RESULT_KEYS).toContain(key);
    expect(written.structuredRetried).toBe(false);
    expect("failure" in written).toBe(false);
    expect("structuredJson" in written).toBe(false);
    expect("sessionFile" in written).toBe(false);
  });

  it("replaces an existing result file", () => {
    const dir = hermetic();
    const path = join(dir, "agent-1.result.json");
    writeFileSync(path, JSON.stringify({ text: "stale" }), "utf-8");

    writeChildResult(path, {
      text: "fresh",
      aborted: false,
      steered: false,
      usage: { input: 1, output: 1, cacheWrite: 0 },
      model: "m",
      thinkingLevel: "low",
      turns: 1,
    });

    expect(JSON.parse(readFileSync(path, "utf-8")).text).toBe("fresh");
  });
});

describe("installChildMode", () => {
  it("marks the process as a child", () => {
    const dir = hermetic();
    const { pi } = makeChildPi();
    expect(isChildMode()).toBe(false);

    installChildMode(pi, specFor(dir));

    expect(isChildMode()).toBe(true);
  });

  it("registers the delegation tools inside the depth cap, and no command", async () => {
    const dir = hermetic();
    const { pi, tools, commands, send } = makeChildPi();

    installChildMode(pi, specFor(dir));
    await send("session_start");

    expect([...tools.keys()].sort()).toEqual(["Agent", "get_subagent_result", "steer_subagent"]);
    // No `/agents`, no scheduler menu, no settings command: a run, not a session.
    expect(commands.size).toBe(0);
    expect(pi.registerCommand).not.toHaveBeenCalled();
    // The injected tools survive the tool scope even though `tools: read` never
    // named them — the in-process scope re-admits them for the same reason.
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
      // `codemode` is re-admitted unconditionally, as the in-process scope does.
      "codemode",
    ]);
  });

  it("registers no delegation tools at the depth cap", () => {
    const dir = hermetic();
    const { pi, tools } = makeChildPi();

    installChildMode(pi, specFor(dir, { depth: 2, maxSubagentDepth: 2 }));

    expect(tools.size).toBe(0);
  });

  it("registers no delegation tools when the type does not allow them", () => {
    const dir = hermetic();
    const { pi, tools } = makeChildPi();

    installChildMode(pi, specFor(dir, { allowedSubagents: false }));

    expect(tools.size).toBe(0);
  });

  it("applies the spec's extSelectors narrowing to the active set", async () => {
    const dir = hermetic();
    const { pi, send } = makeChildPi();
    pi.getAllTools = vi.fn(() => [
      toolInfo("read", "builtin:read"),
      toolInfo("bash", "builtin:bash"),
      toolInfo("report", "/ext/alpha/index.ts"),
      toolInfo("scan", "/ext/alpha/index.ts"),
      toolInfo("query", "/ext/beta/index.ts"),
      // Named by no selector, but re-admitted anyway: the in-process path always
      // loads codemode and an `ext:` allowlist can never name it (Divergence 4).
      toolInfo("codemode", "builtin:codemode"),
    ]);

    installChildMode(pi, specFor(dir, {
      allowedSubagents: false,
      extSelectors: ["ext:alpha/report"],
      toolScope: { tools: ["read"], excludeTools: [] },
    }));
    await send("session_start");

    // `tools: read` is the built-in scope; `alpha` is loaded but narrowed to
    // `report`; `beta` was never named by a selector; `codemode` survives because
    // it is always re-admitted.
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "report", "codemode"]);
  });

  it("keeps every extension tool when the type names no ext: selector", async () => {
    const dir = hermetic();
    const { pi, send } = makeChildPi();
    pi.getAllTools = vi.fn(() => [
      toolInfo("read", "builtin:read"),
      toolInfo("query", "/ext/beta/index.ts"),
    ]);

    installChildMode(pi, specFor(dir, { allowedSubagents: false }));
    await send("session_start");

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "query", "codemode"]);
  });

  it("drops a denied tool even when an extension registered it", async () => {
    const dir = hermetic();
    const { pi, send } = makeChildPi();
    pi.getAllTools = vi.fn(() => [
      toolInfo("read", "builtin:read"),
      toolInfo("query", "/ext/beta/index.ts"),
    ]);

    installChildMode(pi, specFor(dir, {
      allowedSubagents: false,
      toolScope: { tools: ["read"], excludeTools: ["query"] },
    }));
    await send("session_start");

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "codemode"]);
  });

  it("vetoes a tool call outside the scope", async () => {
    const dir = hermetic();
    const { pi, handlers, send } = makeChildPi();
    pi.getAllTools = vi.fn(() => [toolInfo("read", "builtin:read"), toolInfo("bash", "builtin:bash")]);
    installChildMode(pi, specFor(dir, { allowedSubagents: false }));
    const veto = handlers.get("tool_call")?.at(-1);
    if (!veto) throw new Error("no tool_call handler registered");

    // Nothing is scoped before session_start, so nothing is blocked yet.
    expect(await veto({ type: "tool_call", toolName: "bash" }, childCtx())).toBeUndefined();

    await send("session_start");
    const blocked = await veto({ type: "tool_call", toolName: "bash" }, childCtx());
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("bash");
    expect(await veto({ type: "tool_call", toolName: "read" }, childCtx())).toBeUndefined();
  });

  it("writes the result once at settle, then shuts itself down once", async () => {
    const dir = hermetic();
    const spec = specFor(dir, { allowedSubagents: false });
    const { pi, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, spec);

    await send("message_end", assistantEnd("the answer", { input: 10, output: 5, cacheWrite: 2 }), c);
    await send("turn_end", {}, c);
    await send("agent_settled", SETTLED, c);

    const written = JSON.parse(readFileSync(spec.resultPath, "utf-8"));
    expect(written.text).toBe("the answer");
    expect(written.turns).toBe(1);
    expect(written.usage).toEqual({ input: 10, output: 5, cacheWrite: 2 });
    expect(written.model).toBe("anthropic/claude-sonnet-4-6");
    expect(written.thinkingLevel).toBe("high");
    expect(written.sessionFile).toBe("/tmp/child-session.jsonl");
    expect(written.aborted).toBe(false);
    expect(written.steered).toBe(false);
    expect(c.shutdown).toHaveBeenCalledTimes(1);

    // A second settle — a late event, or a shutdown that races one — must not
    // rewrite the file the parent may already have read.
    await send("message_end", assistantEnd("a different answer"), c);
    await send("agent_settled", SETTLED, c);
    expect(JSON.parse(readFileSync(spec.resultPath, "utf-8")).text).toBe("the answer");
    expect(c.shutdown).toHaveBeenCalledTimes(1);
  });

  it("reports a failing final turn as the result's failure", async () => {
    const dir = hermetic();
    const spec = specFor(dir, { allowedSubagents: false });
    const { pi, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, spec);

    await send("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "overloaded",
        usage: { input: 0, output: 0, cacheWrite: 0 },
      },
    }, c);
    await send("agent_settled", SETTLED, c);

    expect(JSON.parse(readFileSync(spec.resultPath, "utf-8")).failure).toBe("overloaded");
  });

  it("applies the project's defaultMaxTurns when the spec carries none", async () => {
    const dir = hermetic({ defaultMaxTurns: 2, graceTurns: 1 });
    const spec = specFor(dir);
    const { pi, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, spec);

    await send("turn_end", {}, c);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    await send("turn_end", {}, c);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toContain("turn limit");
    expect(c.abort).not.toHaveBeenCalled();

    // graceTurns: 1 → the next turn past the limit is the hard stop.
    await send("turn_end", {}, c);
    expect(c.abort).toHaveBeenCalledTimes(1);

    await send("agent_settled", SETTLED, c);
    const written = JSON.parse(readFileSync(spec.resultPath, "utf-8"));
    expect(written.steered).toBe(true);
    expect(written.aborted).toBe(true);
  });

  it("does not invent a turn cap when neither the spec nor the project sets one", async () => {
    const dir = hermetic();
    const { pi, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, specFor(dir));

    for (let i = 0; i < 60; i++) await send("turn_end", {}, c);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(c.abort).not.toHaveBeenCalled();
  });

  it("prefers the spec's maxTurns over the project default", async () => {
    const dir = hermetic({ defaultMaxTurns: 9 });
    const { pi, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, specFor(dir, { maxTurns: 1 }));

    await send("turn_end", {}, c);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("warns once about a config_cwd it cannot reproduce", () => {
    const dir = hermetic();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pi } = makeChildPi();

    installChildMode(pi, specFor(dir, { configCwd: "/elsewhere/config" }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("agent-1");
    expect(warn.mock.calls[0][0]).toContain("/elsewhere/config");
  });

  it("does not warn when the type has no config_cwd", () => {
    const dir = hermetic();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pi } = makeChildPi();

    installChildMode(pi, specFor(dir));

    expect(warn).not.toHaveBeenCalled();
  });

  it("asks once more through StructuredOutput, then reports the payload", async () => {
    const dir = hermetic();
    const schemaPath = join(dir, "schema.json");
    writeFileSync(schemaPath, JSON.stringify(SCHEMA), "utf-8");
    const spec = specFor(dir, { allowedSubagents: false, structuredSchemaPath: schemaPath });
    const { pi, tools, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, spec);

    expect(tools.has("StructuredOutput")).toBe(true);

    // A settle with nothing captured is not the end: one retry prompt goes out
    // and no result is written yet.
    await send("agent_settled", SETTLED, c);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toContain("StructuredOutput");
    expect(existsSync(spec.resultPath)).toBe(false);
    expect(c.shutdown).not.toHaveBeenCalled();

    await send("message_end", assistantEnd("42"), c);
    await tools.get("StructuredOutput").execute("call-1", { answer: "42" }, undefined, undefined, c);
    await send("agent_settled", SETTLED, c);

    const written = JSON.parse(readFileSync(spec.resultPath, "utf-8"));
    expect(written.structuredJson).toBe(JSON.stringify({ answer: "42" }));
    expect(written.structuredRetried).toBe(true);
    expect(c.shutdown).toHaveBeenCalledTimes(1);
  });

  it("reports a run that never satisfied the schema as a failure", async () => {
    const dir = hermetic();
    const schemaPath = join(dir, "schema.json");
    writeFileSync(schemaPath, JSON.stringify(SCHEMA), "utf-8");
    const spec = specFor(dir, { allowedSubagents: false, structuredSchemaPath: schemaPath });
    const { pi, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, spec);

    await send("message_end", assistantEnd("prose only"), c);
    await send("agent_settled", SETTLED, c);
    await send("agent_settled", SETTLED, c);

    const written = JSON.parse(readFileSync(spec.resultPath, "utf-8"));
    expect(written.failure).toContain("StructuredOutput");
    expect(written.structuredRetried).toBe(true);
    expect(c.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("index.ts hook", () => {
  it("takes the child branch before any root-manager registration", () => {
    const dir = hermetic();
    const spec = specFor(dir);
    const path = join(dir, "spec.json");
    writeFileSync(path, JSON.stringify(spec), "utf-8");
    const { pi, tools, commands, handlers } = makeChildPi();
    const previous = process.env.PI_SUBAGENTS_CHILD_SPEC;
    process.env.PI_SUBAGENTS_CHILD_SPEC = path;
    let after: string | undefined;
    try {
      subagentsExtension(pi);
      after = process.env.PI_SUBAGENTS_CHILD_SPEC;
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENTS_CHILD_SPEC;
      else process.env.PI_SUBAGENTS_CHILD_SPEC = previous;
    }

    // The marker is gone: nothing this child starts inherits its spec.
    expect(after).toBeUndefined();
    // No `/agents`, no completion-nudge renderer, no mention or fleet hooks — the
    // root-manager registration below the hook never ran.
    expect(commands.size).toBe(0);
    expect(pi.registerCommand).not.toHaveBeenCalled();
    expect(pi.registerMessageRenderer).not.toHaveBeenCalled();
    expect(handlers.has("input")).toBe(false);
    expect(handlers.has("tool_execution_start")).toBe(false);
    // What a child does keep: its own delegation tools and its own result file.
    expect([...tools.keys()].sort()).toEqual(["Agent", "get_subagent_result", "steer_subagent"]);
    expect(handlers.has("agent_settled")).toBe(true);
  });
});
