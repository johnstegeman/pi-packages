// The child half of a Rex pane run: the narrow mode this extension enters when
// it *is* the `pi` in the pane, instead of becoming a second root manager with
// its own widget, scheduler and `/agents`.
//
// Everything the child needs to know rides in the spec the parent wrote beside
// its prompt (`launcher.ts`'s `ChildSpec`, handed over in
// `PI_SUBAGENTS_CHILD_SPEC`). Three things follow from that file, and they are
// the whole of this module:
//
//   - the agent type's tool scope still binds, because the parent resolved it
//     into `toolScope` and `extSelectors` and this process has to re-apply it to
//     its own tool set — otherwise a pane child would hand the agent every
//     extension tool its in-process sibling never had;
//   - the turn cap still binds, because the child's own settings hold the
//     project default the spec deliberately does not carry;
//   - the run reports once. At `agent_settled` the child writes its result file
//     (atomically, before shutting down) and then calls `ctx.shutdown()` — which
//     is what actually ends the session and lets Rex close the pane.
//
// `index.ts` calls `installChildMode()` and returns immediately; nothing in the
// root-manager registration below it runs in a child. That is the rule this file
// exists to keep: a child is a run, not a session a human drives.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AgentManager, type ManagerRunner, type RunnerProvider } from "../agent-manager.js";
import {
  extensionCanonicalNames,
  getGraceTurns,
  normalizeMaxTurns,
  outOfScopeToolReason,
  parseExtSelectors,
  WRAP_UP_STEER,
} from "../agent-runner.js";
import { BUILTIN_TOOL_NAMES } from "../agent-types.js";
import { extractText } from "../context.js";
import { describeModel } from "../model-resolver.js";
import { createNestedSubagentTools } from "../nested-tools.js";
import { loadSettings } from "../settings.js";
import {
  createStructuredCapture,
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
  type StructuredCapture,
  structuredRetryPrompt,
} from "../structured-output.js";
import { type CompiledSchema, compileJsonSchema } from "../workflow/json-schema.js";
import type { ChildSpec } from "./launcher.js";
import { createPaneRunner } from "./pane-run.js";
import { execRex, resolveWindowId } from "./rex-cli.js";

/** The variable the parent sets to the child's `spec.json` path. */
export const CHILD_SPEC_ENV = "PI_SUBAGENTS_CHILD_SPEC";

/**
 * What the child reports back, and the parent's whole view of the run.
 *
 * The key set is normative — `childSpecFromSpawn()`/`writeChildFiles()` name the
 * path, and the parent reads it with no other contract — so this interface, the
 * JSON `writeChildResult()` writes and the parent's reader have to move together.
 * `failure`, `structuredJson` and `sessionFile` are genuinely absent when unset;
 * every other key is always written.
 */
export interface ChildRunResult {
  /** The last non-empty assistant text of the run. */
  text: string;
  /** Why the final turn failed (provider error, silent max-token death), if it did. */
  failure?: string;
  /** True when the child stopped itself at the hard turn limit. */
  aborted: boolean;
  /** True when the soft turn limit steered it to wrap up. */
  steered: boolean;
  /** The validated `StructuredOutput` payload as canonical JSON, when a schema was asked for. */
  structuredJson?: string;
  /** Whether the one extra prompt for a missing `StructuredOutput` payload was spent. */
  structuredRetried?: boolean;
  usage: { input: number; output: number; cacheWrite: number };
  /** The model the child actually ran, as `provider/id`. */
  model: string;
  thinkingLevel: string;
  /** Where the child's own pi session was written, when it was persisted. */
  sessionFile?: string;
  turns: number;
}

/**
 * Read the child's spec, and delete the variable that named it.
 *
 * The variable is the marker that tells a child what it is, and it is inherited
 * by everything the child starts — its own subagents, MCP servers, shells. So it
 * is removed before anything else can read it, whether or not the file parses: a
 * second `pi` must never mistake its parent's spec for its own.
 *
 * Every failure is a `undefined` rather than a throw. A child that cannot read
 * its spec cannot report a result either, and the honest outcome is to run as a
 * plain `pi` in the pane — visible, usable, and clearly not a managed run.
 */
export function readChildSpec(env: NodeJS.ProcessEnv = process.env): ChildSpec | undefined {
  const raw = env[CHILD_SPEC_ENV];
  if (raw === undefined) return undefined;
  delete env[CHILD_SPEC_ENV];
  const path = raw.trim();
  if (path === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-subagents] ignoring unreadable child spec at ${path}: ${reason}`);
    return undefined;
  }
  if (isChildSpec(parsed)) return parsed;
  console.warn(`[pi-subagents] ignoring malformed child spec at ${path}`);
  return undefined;
}

/**
 * The shape check `readChildSpec()` applies to the parsed file.
 *
 * Deliberately shallow — it guards the fields child mode dereferences before any
 * session exists, not the whole contract. A spec that passes here and is wrong
 * in some deeper way fails loudly at the point of use, which is where the message
 * can say something useful.
 */
function isChildSpec(value: unknown): value is ChildSpec {
  if (typeof value !== "object" || value === null) return false;
  const spec = value as Record<string, unknown>;
  const scope = spec.toolScope as Record<string, unknown> | undefined;
  const pane = spec.pane as Record<string, unknown> | undefined;
  return (
    typeof spec.agentId === "string" &&
    typeof spec.rootSessionId === "string" &&
    typeof spec.depth === "number" &&
    typeof spec.maxSubagentDepth === "number" &&
    typeof spec.resultPath === "string" &&
    typeof spec.cwd === "string" &&
    typeof spec.model === "string" &&
    typeof spec.thinking === "string" &&
    (spec.allowedSubagents === false ||
      spec.allowedSubagents === "all" ||
      Array.isArray(spec.allowedSubagents)) &&
    typeof scope === "object" &&
    scope !== null &&
    Array.isArray(scope.tools) &&
    Array.isArray(scope.excludeTools) &&
    typeof pane === "object" &&
    pane !== null &&
    typeof pane.sessionId === "string"
  );
}

/**
 * Write the result the parent is waiting on: temp file, then rename.
 *
 * Atomic because the parent polls this path while the child is still alive. A
 * reader that catches a half-written result would report a truncated answer as
 * the agent's, so the file appears complete or not at all.
 */
export function writeChildResult(resultPath: string, result: ChildRunResult): void {
  // Key order is the documented order; `JSON.stringify` drops the absent
  // optionals, so the file never carries a `null` a reader has to special-case.
  const payload = {
    text: result.text,
    failure: result.failure,
    aborted: result.aborted,
    steered: result.steered,
    structuredJson: result.structuredJson,
    structuredRetried: result.structuredRetried ?? false,
    usage: result.usage,
    model: result.model,
    thinkingLevel: result.thinkingLevel,
    sessionFile: result.sessionFile,
    turns: result.turns,
  };
  mkdirSync(dirname(resultPath), { recursive: true });
  const tmp = `${resultPath}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(tmp, resultPath);
  } catch (error) {
    // A half-written temp file is still a file: it outlives the failed run and
    // reads like a result to anyone listing the task directory. Best effort,
    // because the original failure is the one worth reporting.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing left to clean up with; the caller's error stands.
    }
    throw error;
  }
}

/**
 * Put this process into child mode: scope its tools, cap its turns, and report
 * one result when it settles.
 *
 * Called from `index.ts` before any root-manager registration, which is why
 * nothing here registers a command, a widget, a scheduler or a completion nudge.
 * The child is still a normal `pi` in every other respect — its own tools, its
 * own extensions, and (through the manager below) its own ability to run
 * children of its own.
 */
export function installChildMode(pi: ExtensionAPI, spec: ChildSpec): void {
  warnAboutConfigCwd(spec);

  const state: RunState = {
    turns: 0,
    steered: false,
    aborted: false,
    wrote: false,
    retried: false,
    assistantTexts: [],
    usage: { input: 0, output: 0, cacheWrite: 0 },
    lastText: "",
  };

  const delegation = installDelegation(pi, spec);
  const structured = installStructuredOutput(pi, spec);
  // `codemode` is re-admitted exactly as the in-process scope re-admits it
  // (`agent-runner.ts`, Divergence 4): it is injected there and can never be
  // named by an `ext:` selector here, so an allowlisted type would otherwise
  // lose the toolbox its in-process sibling kept.
  const injected = [...delegation.names, ...structured.names, "codemode"];
  installToolScope(pi, spec, injected);
  installTurnLimit(pi, spec, state);
  installSettler(pi, spec, state, structured);
  installDelegationShutdown(pi, delegation.manager);
}

/**
 * Close this child's own panes before this process exits.
 *
 * A grandchild is a real `pi` in a layer of its own, and nothing outside this
 * process will end it — the parent of this child only knows about *this* pane.
 * So the child's manager stops its runs and waits for each layer to close on the
 * way out, using the same awaited `dispose()` the root session uses. pi awaits
 * this handler and then exits, so an unawaited teardown would not run at all.
 */
function installDelegationShutdown(pi: ExtensionAPI, manager: AgentManager | undefined): void {
  if (manager === undefined) return;
  pi.on("session_shutdown", async () => {
    await manager.dispose(pi);
  });
}

/** What the child knows about its own run, fed by the events it subscribes to. */
interface RunState {
  turns: number;
  steered: boolean;
  aborted: boolean;
  wrote: boolean;
  retried: boolean;
  /** Every assistant message's text, in order — the last non-empty one is the answer. */
  assistantTexts: string[];
  usage: { input: number; output: number; cacheWrite: number };
  /** The final assistant message's stop reason, for the failure field. */
  lastStop?: { stopReason: string; errorMessage?: string };
  /**
   * The final assistant message's *own* text, empty included.
   *
   * Not `assistantTexts`: a "length" stop is a silent max-token death only
   * when the message that hit the limit produced nothing, and the run-wide last
   * non-empty text may well be an earlier turn's answer (#144).
   */
  lastText: string;
}

/**
 * `config_cwd` has no CLI equivalent, so the child cannot honour it: it
 * discovers project config from its own working directory. One warning per
 * spawn, naming both, because the alternative is a run that silently uses a
 * different project's agents and settings than its type was written for.
 */
function warnAboutConfigCwd(spec: ChildSpec): void {
  if (spec.configCwd === undefined) return;
  console.warn(
    `[pi-subagents] agent "${spec.agentId}" sets config_cwd ${spec.configCwd}, which a pane child cannot reproduce: it reads project config from its own working directory (${spec.cwd})`,
  );
}

/**
 * Register the nested delegation tools, under the same two gates the in-process
 * runner applies: the agent type must opt in through `allowed_subagents`, and a
 * child already at the depth cap registers nothing at all.
 *
 * A child that may delegate gets a manager of its own rather than a share of its
 * parent's: the two are separate processes, so its children are panes and
 * records in this process only. Nothing here binds UI — no widget, no scheduler,
 * no `/agents` — because that is what keeps a fan-out from painting twenty
 * capsules twice.
 *
 * Returns the tool names it registered, so the tool scope can re-admit them, and
 * the manager itself when there is one — its owner has to dispose it at
 * shutdown, or its panes outlive this process.
 */
function installDelegation(pi: ExtensionAPI, spec: ChildSpec): { names: string[]; manager?: AgentManager } {
  if (spec.allowedSubagents === false) return { names: [] };
  // At (or past) the cap this child can never spawn, so it can never own a child
  // to fetch from or steer either — three tools whose every call would be an
  // error are worse than none.
  if (spec.depth >= spec.maxSubagentDepth) return { names: [] };
  const manager = childDelegationManager(spec);
  const tools = createNestedSubagentTools({
    manager,
    pi,
    parentAgentId: spec.agentId,
    depth: spec.depth,
    maxSubagentDepth: spec.maxSubagentDepth,
    allowedSubagents: spec.allowedSubagents,
    configCwd: spec.configCwd ?? spec.cwd,
  });
  for (const tool of tools) pi.registerTool(tool);
  return { names: tools.map((tool) => tool.name), manager };
}

/**
 * The manager a pane child delegates through, with the project's own pool limits
 * applied.
 *
 * Child mode deliberately does not run the root manager's `applySettings`:
 * almost everything in that list binds UI the child must not have (the widget,
 * the fleet view, mentions, schedules). The two limits that do bind are the
 * concurrency pools, and they have to match the project's, or the shape of a
 * fan-out would change with the modality. Turn defaults are read where they are
 * used (`installTurnLimit()`), not stored, so they need no applier here.
 *
 * `configCwd` is where the project's settings were resolved from — the whole
 * reason it exists is that the child's working directory can be somewhere else.
 * Reading the pools from `cwd` would give this child the wrong project's limits.
 */
function childDelegationManager(spec: ChildSpec): AgentManager {
  const manager = new AgentManager(undefined, undefined, undefined, undefined, undefined, {
    // The child's own manager needs the pane runner for the same reason the root
    // one does: a grandchild should be a real `pi` in a pane, not a second
    // in-process session hiding inside this one.
    runnerFor: childPaneProvider(spec),
    // A refusal the root would notify about — a queued steering message the
    // grandchild would not take — has to reach somebody here too, or the defect
    // it was reported for reappears one level down. There is no `ctx` yet (the
    // child is not a session when its tools are registered), so the sink is the
    // child's own terminal: that is the pane the user is watching, and the same
    // channel this module's other warnings use.
    onWarning: (_record, message) => console.warn(`[pi-subagents] ${message}`),
  });
  const settings = loadSettings(spec.configCwd ?? spec.cwd);
  if (typeof settings.maxConcurrent === "number") manager.setMaxConcurrent(settings.maxConcurrent);
  if (typeof settings.maxConcurrentForeground === "number") {
    manager.setMaxConcurrentForeground(settings.maxConcurrentForeground);
  }
  return manager;
}

/**
 * The pane runner a delegating child hands its own manager, so its children are
 * panes too.
 *
 * Detection cannot answer this one: it returns false for exactly this process,
 * because a child spec in the environment is how a pane child is told what it is
 * (see `rexTerminalMarkers()`). A child does not need to be told — it *is* a
 * pane, so Rex is there, its session is the one it lives in, and its own block
 * names the window its children should float in.
 *
 * What it still honours is the user's `runInRexPanes: "off"`: that is a decision
 * about the user's screen, not about what this process can prove.
 *
 * Lazy and memoized, like the root provider: `block inspect` is a `rex` call, and
 * a child that never delegates must not pay for it.
 */
function childPaneProvider(spec: ChildSpec): RunnerProvider {
  let runner: ManagerRunner | undefined;
  return async () => {
    const blockId = process.env.REX_BLOCK;
    // REX_BLOCK is how this child knows where it is; without it there is no
    // window to place a pane in.
    if (blockId === undefined || blockId === "") return undefined;
    if (loadSettings(spec.configCwd ?? spec.cwd).runInRexPanes === "off") return undefined;
    if (runner !== undefined) return runner;
    const windowId = await resolveWindowId({ exec: execRex, sessionId: spec.pane.sessionId }, blockId);
    if (windowId === undefined) return undefined;
    runner = createPaneRunner({
      exec: execRex,
      // A pane is never created in anyone else's session.
      sessionId: spec.pane.sessionId,
      windowId,
      // The cascade and the transcript store belong to the session that started
      // it, so a grandchild's transcript is filed beside its parent's.
      rootSessionId: spec.rootSessionId,
      agentSessionDir: join(getAgentDir(), "subagent-sessions", spec.rootSessionId),
      piBinary: process.execPath,
    });
    return runner;
  };
}

/**
 * What installing the structured-output tool produced: the capture to read the
 * payload off at settle, the tool name to re-admit into the tool scope, and the
 * failure to report when the schema could not be applied at all.
 */
interface StructuredWiring {
  capture?: StructuredCapture;
  names: string[];
  failure?: string;
}

/**
 * The `agent({ schema })` contract in a pane: the child reports through
 * `StructuredOutput` and the parent reads the payload off the result file.
 *
 * The schema was compiled by the caller and written beside the spec, and the
 * parent read that file back before launching (see `writeStructuredSchema()`),
 * so this should always compile. If it does not — a task directory rewritten
 * under us, a disk that half-wrote it — the run says so in its result instead
 * of quietly answering in prose: a caller waiting for a payload cannot use one,
 * and "no failure" would file that prose as the answer.
 */
function installStructuredOutput(
  pi: ExtensionAPI,
  spec: ChildSpec,
): StructuredWiring {
  if (spec.structuredSchemaPath === undefined) return { names: [] };
  const schema = readCompiledSchema(spec.structuredSchemaPath);
  if ("failure" in schema) return { names: [], failure: schema.failure };
  const capture = createStructuredCapture();
  pi.registerTool(createStructuredOutputTool(schema.compiled, capture));
  return { capture, names: [STRUCTURED_OUTPUT_TOOL_NAME] };
}

/** The compiled schema, or why this process cannot apply it. */
function readCompiledSchema(path: string): { compiled: CompiledSchema } | { failure: string } {
  try {
    const verdict = compileJsonSchema(JSON.parse(readFileSync(path, "utf-8")));
    if (verdict.ok) return { compiled: verdict.compiled };
    return { failure: schemaFailure(path, verdict.message) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { failure: schemaFailure(path, reason) };
  }
}

/** The failure message for a schema that could not be applied, also logged once. */
function schemaFailure(path: string, reason: string): string {
  const message = `the structured-output schema at ${path} could not be applied: ${reason}`;
  console.warn(`[pi-subagents] ${message}`);
  return message;
}

/**
 * Re-apply the agent type's tool scope to this process's own tool set.
 *
 * The in-process runner has `installExtensionToolScope()` for this; a child has
 * no session to install it on, so the same predicate is expressed against the
 * extension API instead (`pi.getAllTools()` / `pi.setActiveTools()`), with the
 * same two enforcement points:
 *
 *   - the ACTIVE set, re-derived at `session_start` and at every `turn_end`.
 *     Extensions may register late (pi-mcp connects on `session_start`), and pi
 *     snapshots the next turn's tools at `turn_end`, so re-narrowing there is
 *     what makes a late arrival land inside the scope rather than next to it.
 *   - a `tool_call` veto, which is the only guard a codemode script sees:
 *     `codemode`/`deferred` tools stay callable whether active or not.
 *
 * Built-in tools are exactly the names the type's `tools:` allowed. Extension
 * tools ride on `ext:` selectors: when the type names any, they become an
 * allowlist (`ext:foo` keeps all of foo's tools, `ext:foo/bar` only `bar`), and
 * a loaded extension nobody named contributes nothing. Injected tools are
 * re-admitted afterwards — the in-process scope does the same, for the same
 * reason: the type never wrote `Agent` in its `tools:` list.
 */
function installToolScope(pi: ExtensionAPI, spec: ChildSpec, injected: string[]): void {
  const { extNames, narrowing } = parseExtSelectors(spec.extSelectors ?? []);
  const excluded = new Set(spec.toolScope.excludeTools);
  const builtinNames = new Set(BUILTIN_TOOL_NAMES);
  const injectedNames = new Set(injected);
  // Canonical names cost a filesystem walk, and the same extension answers per
  // tool, so ask once per path rather than once per turn.
  const canonCache = new Map<string, string[]>();
  const canonsOf = (path: string): string[] => {
    let canons = canonCache.get(path);
    if (!canons) {
      canons = extensionCanonicalNames(path);
      canonCache.set(path, canons);
    }
    return canons;
  };

  const compute = (): Set<string> => {
    const keep = new Set(spec.toolScope.tools.filter((name) => !excluded.has(name)));
    const optIn = extNames.size > 0;
    for (const tool of pi.getAllTools()) {
      // Built-ins are already decided by `toolScope.tools`; injected tools are
      // re-admitted below and must not be lost to an `ext:` allowlist that could
      // never have named them.
      if (builtinNames.has(tool.name) || injectedNames.has(tool.name)) continue;
      if (excluded.has(tool.name)) continue;
      const canons = canonsOf(tool.sourceInfo.path);
      if (optIn && !canons.some((name) => extNames.has(name))) continue;
      // First alias that carries a narrowing set — a type will not narrow one
      // extension under two different names.
      const narrowed = canons.map((name) => narrowing.get(name)).find(Boolean);
      if (narrowed && !narrowed.has(tool.name)) continue;
      keep.add(tool.name);
    }
    for (const name of injectedNames) keep.add(name);
    return keep;
  };

  let inScope = new Set<string>();
  let scoped = false;
  const refresh = (): void => {
    inScope = compute();
    scoped = true;
    // What pi can actually activate, in its own registry order — the same
    // shape `installExtensionToolScope()`'s `renarrow` applies in-process.
    // `inScope` is the logical scope and can name a tool this build does not
    // have (the re-admitted `codemode` under `-ne`, a builtin a type lists but
    // this pi lacks); `getActiveTools()` only ever lists real ones, so
    // comparing the unfiltered set would find a difference every single turn
    // and rebuild the system prompt for nothing.
    const next = pi.getAllTools().map((tool) => tool.name).filter((name) => inScope.has(name));
    const current = pi.getActiveTools();
    // `setActiveTools` rebuilds the system prompt, so re-setting an unchanged
    // list would charge every turn for nothing. The in-process scope skips the
    // same no-op (`installExtensionToolScope()`'s `renarrow`).
    if (next.length !== current.length || next.some((name, i) => name !== current[i])) {
      pi.setActiveTools(next);
    }
  };

  pi.on("session_start", refresh);
  pi.on("turn_end", refresh);
  pi.on("tool_call", (event): ToolCallEventResult | undefined => {
    // Fail-OPEN until the first refresh, unlike the in-process
    // `createToolScopeVeto` which fails CLOSED for nested calls. That difference
    // is safe rather than lax: there the unset holder can be permanent
    // (`noExtensions`/`isolated` sessions skip the install entirely), while here
    // the refresh is bound to `session_start`, which pi emits before it accepts
    // any prompt — so "unscoped" only ever means "no prompt has run yet", and
    // failing closed would protect nothing while risking a session that cannot
    // start.
    if (!scoped || inScope.has(event.toolName)) return undefined;
    return { block: true, reason: outOfScopeToolReason(event.toolName) };
  });
}

/**
 * The turn cap, applied to this process's own run.
 *
 * The spec carries the caller's or the type's `max_turns`; the project default
 * is deliberately not in it, so the child loads the same settings its parent did
 * and applies them here. Both legs then behave like the in-process loop: steering
 * wraps the run up at the limit, and a run that keeps going past the grace turns
 * is aborted.
 *
 * No setting and no spec value means no cap at all — not a hard-coded one. An
 * inherited cap the parent never asked for would end a pane run mid-answer with
 * an explanation nobody can find.
 */
function installTurnLimit(pi: ExtensionAPI, spec: ChildSpec, state: RunState): void {
  // The project the agent belongs to, not the directory it happens to work in:
  // with `config_cwd` set those differ, and the sibling reads above
  // (`childDelegationManager()`, the pane provider) already resolve theirs
  // against `configCwd`. Reading the cap from `cwd` would wrap a run up at
  // another project's turn count while honouring this one's pools.
  const settings = loadSettings(spec.configCwd ?? spec.cwd);
  const maxTurns = normalizeMaxTurns(spec.maxTurns ?? settings.defaultMaxTurns);
  // Floored at 1 for the same reason `setGraceTurns()` floors it: a grace of 0
  // would abort on the very turn the wrap-up steer went out.
  const graceTurns = Math.max(1, settings.graceTurns ?? getGraceTurns());

  pi.on("turn_end", (_event, ctx) => {
    state.turns++;
    // `undefined` is a real answer, not a missing one: no spec value and no
    // project default means the run is unlimited, and this handler only counts.
    if (maxTurns === undefined) return;
    if (!state.steered && state.turns >= maxTurns) {
      state.steered = true;
      pi.sendUserMessage(WRAP_UP_STEER, { deliverAs: "steer" });
      return;
    }
    if (state.steered && state.turns >= maxTurns + graceTurns) {
      state.aborted = true;
      ctx.abort();
    }
  });
}

/**
 * Subscribe to the run's own events, then report and end the child at settle.
 *
 * `agent_settled` fires after a run has fully settled — no retry, compaction or
 * queued continuation pending — which is the only moment at which "the agent is
 * done" is true. The result is written before `ctx.shutdown()`, because shutdown
 * ends the process and the parent would otherwise have nothing to read; and the
 * write is guarded, because a late settle arriving after shutdown must not
 * replace the answer the parent already holds.
 */
function installSettler(
  pi: ExtensionAPI,
  spec: ChildSpec,
  state: RunState,
  structured: StructuredWiring,
): void {
  const { capture } = structured;
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const text = extractText(message.content).trim();
    if (text) state.assistantTexts.push(text);
    // Every assistant message, empty included: this is what decides whether a
    // "length" stop was a truncated answer or a silent max-token death.
    state.lastText = text;
    state.lastStop = { stopReason: message.stopReason, errorMessage: message.errorMessage };
    state.usage.input += message.usage.input;
    state.usage.output += message.usage.output;
    state.usage.cacheWrite += message.usage.cacheWrite;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (state.wrote) return;
    // One more prompt when a schema was asked for and nothing came back — the
    // same single retry `runAgent()` spends, so a pane child and an in-process
    // one give the model the same number of chances.
    if (capture !== undefined && capture.json === undefined && !state.retried && !state.aborted) {
      state.retried = true;
      pi.sendUserMessage(structuredRetryPrompt(capture));
      return;
    }
    // `wrote` is set only when the write actually landed. A failed write — a
    // full disk, a task directory removed under us — must not look like a
    // delivered result to a later settle, and the process still has to end:
    // otherwise the child outlives its run with nothing for the parent to read
    // and no exit for the pane to notice. Written first, shut down regardless;
    // a child that keeps running after a settle is worse than one that reports
    // why it could not.
    try {
      writeChildResult(spec.resultPath, buildResult(spec, ctx, state, structured));
      state.wrote = true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[pi-subagents] child "${spec.agentId}" could not write its result to ${spec.resultPath}: ${reason}`,
      );
    } finally {
      ctx.shutdown();
    }
  });
}

/**
 * The result file's contents, assembled from what this process's session knows.
 *
 * Both the model and the thinking level prefer what the session reports at
 * settle — pi clamps a level to what the model supports, so the effective pair is
 * the honest one — and fall back to the spec, which is the parent's resolved
 * answer and, for `thinking`, the value the child was launched with
 * (`buildChildCommand()`'s `--thinking` flag, which `launcher.ts` documents as
 * mirroring `spec.thinking`). Deliberately not `pi.getThinkingLevel()`: that
 * reports the same effective level as the context, so preferring it over the spec
 * would leave the spec's field unreachable and the launcher's promise untested.
 */
function buildResult(
  spec: ChildSpec,
  ctx: ExtensionContext,
  state: RunState,
  structured: Pick<StructuredWiring, "capture" | "failure">,
): ChildRunResult {
  const { capture } = structured;
  const text = [...state.assistantTexts].reverse().find((entry) => entry !== "") ?? "";
  const structuredFailure = capture !== undefined && capture.json === undefined
    ? capture.lastError !== undefined
      ? `The agent's StructuredOutput call did not match the required schema: ${capture.lastError}`
      : "The agent did not report its answer through StructuredOutput."
    : undefined;
  const result: ChildRunResult = {
    text,
    aborted: state.aborted,
    steered: state.steered,
    usage: { ...state.usage },
    model: ctx.model ? describeModel(ctx.model).modelId : spec.model,
    thinkingLevel: ctx.thinkingLevel ?? spec.thinking,
    turns: state.turns,
  };
  // A schema this process could not apply is a failure of the run, not a silent
  // return to prose: the caller asked for a payload, and would otherwise file
  // text it cannot use as the answer.
  const failure = turnFailure(state) ?? structuredFailure ?? structured.failure;
  if (failure !== undefined) result.failure = failure;
  if (capture?.json !== undefined) result.structuredJson = capture.json;
  if (state.retried) result.structuredRetried = true;
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile !== undefined) result.sessionFile = sessionFile;
  return result;
}

/**
 * Why the run's final assistant turn failed, mirroring `finalTurnError()` in the
 * in-process runner: a provider error pi resolved instead of rejecting, and a
 * "length" stop that produced no text at all (a silent max-token death). A
 * "length" stop that did produce text is a legitimately truncated answer, not a
 * failure.
 *
 * The empty-text question is asked of the FINAL message (`state.lastText`), not
 * of the text the result carries: a run whose last turn died at the token limit
 * without emitting anything still has an earlier turn's answer to report, and
 * deciding from that would file a silent death as a completion (#144).
 */
function turnFailure(state: RunState): string | undefined {
  const stop = state.lastStop;
  if (!stop) return undefined;
  if (stop.stopReason === "error") return stop.errorMessage?.trim() || "provider error with no output";
  if (stop.stopReason === "length" && state.lastText === "") {
    return "run hit the output token limit before producing any text";
  }
  return undefined;
}
