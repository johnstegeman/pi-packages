/**
 * rex-child-mode.test.ts — the narrow half of a pane child.
 *
 * The child is a real `pi` that loads this extension too, so "child mode" is what
 * keeps it from becoming a second root manager: it reads its spec, scopes its
 * tools, reports one result file and ends itself. Every assertion here is about
 * that narrowness — which tools surface, which handlers run, and that the result
 * is written exactly once.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import subagentsExtension from "../src/index.js";
import { installChildMode, readChildSpec, writeChildResult } from "../src/rex/child-mode.js";
import type { ChildSpec } from "../src/rex/launcher.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";
import { installFakeRex } from "./helpers/rex-pane-harness.js";

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
  // What pi's registry holds: the two built-ins this suite's children can use,
  // plus whatever an extension registered. Real pi's `getActiveTools()` returns
  // only names that are in here, which is the whole point of the scope
  // comparison — a name the child does not have can never come back.
  pi.getAllTools = vi.fn(() => [toolInfo("read", "builtin:read"), toolInfo("codemode", "builtin:codemode"), ...tools.values()]);
  const handlers = new Map<string, ((event: any, c: any) => any)[]>();
  pi.on = vi.fn((event: string, handler: (e: any, c: any) => any) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return () => {};
  });
  pi.sendUserMessage = vi.fn();
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
    // named them — the in-process scope re-admits them for the same reason. The
    // order is the registry's, which is what pi activates: `codemode` is a
    // built-in here, and the three delegation tools were registered above.
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "codemode",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
    ]);
  });

  it("registers no delegation tools at the depth cap, and never activates them", async () => {
    const dir = hermetic();
    const { pi, tools, send } = makeChildPi();

    installChildMode(pi, specFor(dir, { depth: 2, maxSubagentDepth: 2 }));
    await send("session_start");

    expect(tools.size).toBe(0);
    // The criterion is about the tool surface, not only the registration: a name
    // handed to the active set would surface an `Agent` tool whose every call is
    // an error.
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "codemode"]);
    for (const name of ["Agent", "get_subagent_result", "steer_subagent"]) {
      expect(pi.setActiveTools.mock.calls.flat()).not.toContain(name);
    }
  });

  // A child is a real pi with its own manager, so its fan-out shape is its own
  // business — but it must be the PROJECT's shape, not pi's built-in defaults, or
  // the same agent would run three children in a pane and one in-process.
  it("gives its own manager the project's pool limits", () => {
    const dir = hermetic({ maxConcurrent: 3, maxConcurrentForeground: 2 });
    const { pi } = makeChildPi();
    const pools = vi.spyOn(AgentManager.prototype, "setMaxConcurrent");
    const foreground = vi.spyOn(AgentManager.prototype, "setMaxConcurrentForeground");
    try {
      installChildMode(pi, specFor(dir));

      expect(pools).toHaveBeenCalledWith(3);
      expect(foreground).toHaveBeenCalledWith(2);
    } finally {
      pools.mockRestore();
      foreground.mockRestore();
    }
  });

  it("leaves its manager at the built-in limits when the project sets none", () => {
    const dir = hermetic();
    const { pi } = makeChildPi();
    const pools = vi.spyOn(AgentManager.prototype, "setMaxConcurrent");
    const foreground = vi.spyOn(AgentManager.prototype, "setMaxConcurrentForeground");
    try {
      installChildMode(pi, specFor(dir));

      expect(pools).not.toHaveBeenCalled();
      expect(foreground).not.toHaveBeenCalled();
    } finally {
      pools.mockRestore();
      foreground.mockRestore();
    }
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

    // `codemode` is in scope but this child's registry has no such tool, so it
    // is not activated — pi would drop the name anyway.
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "query"]);
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

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
  });

  it("adds a tool registered between session_start and turn_end to the active set", async () => {
    const dir = hermetic();
    const { pi, send } = makeChildPi();
    // An extension that registers late — pi-mcp connects on `session_start` — is
    // in the registry but not yet in the active set, which is why the scope is
    // re-derived at every `turn_end` as well as at `session_start`.
    let registry = [toolInfo("read", "builtin:read")];
    pi.getAllTools = vi.fn(() => registry);
    const applied: string[][] = [];
    pi.setActiveTools = vi.fn((names: string[]) => {
      applied.push([...names]);
    });
    pi.getActiveTools = vi.fn(() => applied[applied.length - 1] ?? []);
    installChildMode(pi, specFor(dir, { allowedSubagents: false }));

    await send("session_start");
    expect(applied).toEqual([["read"]]);

    registry = [...registry, toolInfo("mcp_query", "/ext/mcp/index.ts")];
    await send("turn_end", {});

    // The late arrival lands inside the scope instead of next to it.
    expect(applied.at(-1)).toEqual(["read", "mcp_query"]);
  });

  it("does not re-set an active list that has not changed", async () => {
    const dir = hermetic();
    const { pi, send } = makeChildPi();
    // The case that made the guard dead: `codemode` is always re-admitted into
    // the scope, and this child's registry has no such tool — which is what
    // `-ne` and `isolated: true` children look like. pi drops unknown names on
    // the way in, so the phantom can never come back from `getActiveTools()`,
    // and comparing the unfiltered scope would find a difference on every turn.
    pi.getAllTools = vi.fn(() => [toolInfo("read", "builtin:read")]);
    const applied: string[][] = [];
    pi.setActiveTools = vi.fn((names: string[]) => {
      applied.push(names.filter((name) => name === "read"));
    });
    pi.getActiveTools = vi.fn(() => applied[applied.length - 1] ?? []);
    installChildMode(pi, specFor(dir, { allowedSubagents: false }));

    await send("session_start");
    // The steady state: every turn re-derives the scope, and none of them pays
    // for a system-prompt rebuild unless something actually changed.
    await send("turn_end", {});
    await send("turn_end", {});

    expect(applied).toEqual([["read"]]);
    expect(pi.setActiveTools).toHaveBeenCalledTimes(1);
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

  it("reports a length stop that produced nothing as a failure, even with text before it", async () => {
    // The #144 shape: an earlier turn answered, and the FINAL message died at
    // the output token limit without emitting anything. Deciding from the run's
    // last non-empty text would call that a completion whose answer is the
    // previous turn's — the silent max-token death `finalTurnError()` guards
    // against in-process.
    const dir = hermetic();
    const spec = specFor(dir, { allowedSubagents: false });
    const { pi, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, spec);

    await send("message_end", assistantEnd("the earlier answer"), c);
    await send("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "length",
        usage: { input: 0, output: 0, cacheWrite: 0 },
      },
    }, c);
    await send("agent_settled", SETTLED, c);

    const written = JSON.parse(readFileSync(spec.resultPath, "utf-8"));
    expect(written.failure).toMatch(/output token limit/i);
    // The text stays the earlier turn's: it is what the run did say.
    expect(written.text).toBe("the earlier answer");
  });

  it("does not fail a length stop that did produce text", async () => {
    const dir = hermetic();
    const spec = specFor(dir, { allowedSubagents: false });
    const { pi, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, spec);

    await send("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "a truncated but real answer" }],
        stopReason: "length",
        usage: { input: 0, output: 0, cacheWrite: 0 },
      },
    }, c);
    await send("agent_settled", SETTLED, c);

    const written = JSON.parse(readFileSync(spec.resultPath, "utf-8"));
    expect("failure" in written).toBe(false);
    expect(written.text).toBe("a truncated but real answer");
  });

  it("reports a schema it cannot apply as the run's failure instead of answering in prose", async () => {
    // The parent validated the schema before launching, so this is the case
    // where the file changed under the child: without a failure the caller's
    // `agent({ schema })` would resolve to prose it cannot read.
    const dir = hermetic();
    const schemaPath = join(dir, "schema.json");
    writeFileSync(schemaPath, "{ not a schema", "utf-8");
    const spec = specFor(dir, { allowedSubagents: false, structuredSchemaPath: schemaPath });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pi, tools, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, spec);

    expect(tools.has("StructuredOutput")).toBe(false);
    expect(warn.mock.calls[0][0]).toContain("could not be applied");

    await send("message_end", assistantEnd("prose instead"), c);
    await send("agent_settled", SETTLED, c);

    const written = JSON.parse(readFileSync(spec.resultPath, "utf-8"));
    expect(written.failure).toContain("could not be applied");
    expect(written.text).toBe("prose instead");
    expect(c.shutdown).toHaveBeenCalledTimes(1);
  });

  it("reports the spec's thinking level when the context carries none", async () => {
    const dir = hermetic();
    const spec = specFor(dir, { allowedSubagents: false, thinking: "low" });
    const { pi, send } = makeChildPi();
    const c = childCtx({ thinkingLevel: undefined });
    installChildMode(pi, spec);

    await send("message_end", assistantEnd("done"), c);
    await send("agent_settled", SETTLED, c);

    const written = JSON.parse(readFileSync(spec.resultPath, "utf-8"));
    expect(written.thinkingLevel).toBe("low");
  });

  it("shuts the child down and says so when the result cannot be written", async () => {
    const dir = hermetic();
    // A directory where the result file should go: the temp write succeeds and the
    // rename fails, which is the only way to exercise the temp-file cleanup.
    const resultPath = join(dir, "agent-1.result.json");
    mkdirSync(resultPath);
    const spec = specFor(dir, { allowedSubagents: false, resultPath });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pi, send } = makeChildPi();
    const c = childCtx();
    installChildMode(pi, spec);

    await send("message_end", assistantEnd("the answer"), c);
    await send("agent_settled", SETTLED, c);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("could not write its result");
    expect(warn.mock.calls[0][0]).toContain("agent-1");
    // The child still ends: a pane holding a live `pi` with no result for the
    // parent is worse than one that exits and says why it could not report.
    expect(c.shutdown).toHaveBeenCalledTimes(1);
    // The temp file the rename came from is gone, not left beside the result path.
    expect(existsSync(`${resultPath}.tmp`)).toBe(false);

    // A failed write was not a delivered result, so the guard is still open: a
    // later settle writes it (and shuts down again, as it must).
    rmSync(resultPath, { recursive: true, force: true });
    await send("agent_settled", SETTLED, c);
    expect(JSON.parse(readFileSync(resultPath, "utf-8")).text).toBe("the answer");
    expect(c.shutdown).toHaveBeenCalledTimes(2);
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

  it("takes the turn cap from config_cwd, the project the agent belongs to", async () => {
    // `cwd` is an empty directory and `config_cwd` holds the project: the cap
    // has to come from the latter, exactly as the pools and the pane provider
    // already do. Reading the cap from `cwd` would leave this run uncapped.
    const project = hermetic({ defaultMaxTurns: 1, graceTurns: 1 });
    const elsewhere = mkdtempSync(join(tmpdir(), "pi-child-elsewhere-"));
    try {
      const { pi, send } = makeChildPi();
      const c = childCtx();
      installChildMode(pi, specFor(elsewhere, { configCwd: project }));

      await send("turn_end", {}, c);

      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(pi.sendUserMessage.mock.calls[0][0]).toContain("turn limit");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
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

describe("a child's own children", () => {
  it("are panes too: its manager is given the pane runner", async () => {
    // A child already knows Rex is there — it *is* a pane — so detection has no
    // question to ask (and would answer "no" for this process). What it must
    // still do is hand its manager the same runner the root manager gets.
    const dir = hermetic({ maxConcurrent: 3 });
    const fake = installFakeRex();
    const savedBlock = process.env.REX_BLOCK;
    process.env.REX_BLOCK = "block-child";
    let own: AgentManager | undefined;
    // The manager is created and configured inside child mode; this is how the
    // test gets hold of the instance without reaching into module state.
    const pools = vi.spyOn(AgentManager.prototype, "setMaxConcurrent").mockImplementation(function (this: AgentManager) {
      own = this;
    });
    try {
      const { pi } = makeChildPi();
      installChildMode(pi, specFor(dir));
      expect(own).toBeDefined();

      // The child's own `ctx`, as pi hands it to an extension: the extra members
      // are the ones the pane runner reads off it (its model, its trust answer,
      // its system prompt).
      const child = childCtx({
        cwd: dir,
        modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
        getSystemPrompt: vi.fn(() => "the child's own prompt"),
        isProjectTrusted: vi.fn(() => true),
        sessionManager: { getSessionFile: () => "/tmp/child.jsonl", getSessionId: () => "root-1" },
      });
      const id = own!.spawn(pi, child as never, "Explore", "do it", {
        description: "a grandchild",
        isBackground: true,
        model: { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      });
      const record = own!.getRecord(id)!;
      await own!.awaitStartup(id);
      for (let i = 0; i < 500 && !fake.paneCalls().some((call) => call[4] === "session.new_layer"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // The grandchild got a real pane, in this child's session and its block's
      // window — no `rex whoami` probe, no in-process session.
      const create = fake.paneCalls().find((call) => call[4] === "session.new_layer");
      expect(create).toBeDefined();
      const request = JSON.parse(create![5]);
      expect(request.session_id).toBe("rex-session");
      expect(request.window_id).toBe("window:1");
      expect(request.layout.block.label).toContain("a grandchild");
      expect(fake.calls().some((call) => call[0] === "whoami")).toBe(false);
      await record.promise;
    } finally {
      if (savedBlock === undefined) delete process.env.REX_BLOCK;
      else process.env.REX_BLOCK = savedBlock;
      pools.mockRestore();
      fake.restore();
    }
  }, 20_000);
});

describe("a child's delegation manager warns", () => {
  it("through a sink, so a refusal is not swallowed one level down", () => {
    // The child's manager has no `ctx` yet (it is built before the child is a
    // session), so the sink is the child's own terminal — the pane the user is
    // watching. Without one, a queued steer the grandchild refuses would vanish
    // exactly as it did at the root before finding 3.
    const dir = hermetic({ maxConcurrent: 3 });
    let own: AgentManager | undefined;
    const pools = vi.spyOn(AgentManager.prototype, "setMaxConcurrent").mockImplementation(function (this: AgentManager) {
      own = this;
    });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      installChildMode(makeChildPi().pi, specFor(dir));

      const sink = (own as unknown as { onWarning?: (record: unknown, message: string) => void }).onWarning;
      expect(sink).toBeDefined();
      sink?.(undefined, "the steering message was not delivered");

      expect(warned).toHaveBeenCalledWith(expect.stringContaining("the steering message was not delivered"));
    } finally {
      warned.mockRestore();
      pools.mockRestore();
    }
  });
});

describe("a child shutting down", () => {
  it("disposes its own manager, so no grandchild outlives the run that made it", async () => {
    const dir = hermetic();
    const { pi, handlers, send } = makeChildPi();
    const dispose = vi.spyOn(AgentManager.prototype, "dispose").mockResolvedValue(undefined);
    try {
      installChildMode(pi, specFor(dir));
      expect(handlers.get("session_shutdown")).toHaveLength(1);

      // Awaited, as pi awaits it: the process exits right after this returns.
      await send("session_shutdown");

      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      dispose.mockRestore();
    }
  });

  it("registers no shutdown handler when it has no manager to dispose", () => {
    const dir = hermetic();
    const { pi, handlers } = makeChildPi();

    // At the depth cap there are no delegation tools and no manager: nothing to
    // tear down, and a handler that exists only to do nothing is noise.
    installChildMode(pi, specFor(dir, { depth: 2, maxSubagentDepth: 2 }));

    expect(handlers.get("session_shutdown")).toBeUndefined();
  });
});
