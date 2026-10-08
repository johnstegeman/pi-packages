/**
 * runtime.ts — the host half of a workflow run.
 *
 * Owns the worker lifecycle, the RPC bridge, the concurrency semaphore, the
 * per-run caps, and the progress log. The script's only route to an agent is a
 * `call` message landing here, which is what makes the caps and the abort story
 * enforceable at all: a script cannot go around them because it has nothing to
 * go around them *with*.
 *
 * Spawning is injected rather than imported. `AgentManager` is a large, stateful
 * dependency and wiring it in directly would make every test here an integration
 * test; a {@link WorkflowHost} stub is a dozen lines. The adapter that binds this
 * to the real manager lives at the call site.
 */

import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { type JournalKeyInput, journalKey, type WorkflowJournalEntry } from "./journal.js";
import { type CompiledSchema, compileJsonSchema } from "./json-schema.js";
import { extractMeta, type WorkflowMeta } from "./meta.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "./progress.js";
import { WORKER_SOURCE } from "./worker-source.js";

/** Matches the `script` field's `maxLength` in the tool schema. */
export const MAX_SCRIPT_LENGTH = 524_288;

/** Agents one run may schedule, in total. */
export const WORKFLOW_AGENT_CAP = 1000;

/** Items one `parallel()` or `pipeline()` call may take. */
export const WORKFLOW_ITEM_CAP = 4096;

/** Nested `workflow()` invocations allowed per run. */
export const WORKFLOW_NESTED_CAP = 256;

/**
 * How long a child may go without reporting activity before the run stops it.
 *
 * Inactivity, not total duration: a review child that reasons for three minutes
 * and then runs tools is working, and a run-level cap would kill it. The shape
 * the watchdog exists for is the one the incident had — a child whose bash
 * command printed its answer and then never exited, so no tool-end, no turn-end
 * and no further model turn ever arrived. Ten minutes is roughly five times the
 * longest legitimate silent stretch; the stuck children sat for 74-78 minutes.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 600_000;

/** How much of a prompt or result is kept for the UI. */
const PREVIEW_LENGTH = 200;

export class WorkflowRuntimeError extends Error {}

/**
 * Concurrent agents allowed, leaving two cores for the host and the TUI.
 *
 * `Math.max(1, …)` is not decoration: the raw `min(16, cpus - 2)` is 0 on a one-
 * or two-core machine, and a semaphore with zero permits never hands out a slot,
 * so the run would hang before its first agent rather than fail.
 */
export function workflowConcurrency(cpuCount: number = cpus().length): number {
  return Math.max(1, Math.min(16, cpuCount - 2));
}

/** One agent the script asked for. `agentId` is the handle for {@link WorkflowHost.abortAgent}. */
export interface WorkflowSpawnRequest {
  agentId: string;
  /** Position in the run, and the progress entry's stable identity. */
  index: number;
  prompt: string;
  label: string;
  agentType: string;
  model?: string;
  /**
   * Reasoning effort for this child, as one of pi's thinking levels.
   *
   * Typed as a plain string because this interface is the host boundary and
   * deliberately knows nothing about pi — `host.ts` is where it becomes a
   * `ThinkingLevel`. The worker has already rejected anything off the list.
   */
  effort?: string;
  isolation?: "worktree";
  /**
   * The per-call inactivity window the script asked for, in seconds, when it
   * passed `agent({ stallTimeout })`.
   *
   * An echo of the option, not a contract: the run enforces the watchdog itself
   * (see {@link RunWorkflowOptions.stallTimeoutMs}), so a host needs only to be
   * able to surface it.
   */
  stallTimeout?: number;
  /**
   * Called by the host once the child's EFFECTIVE configuration is known —
   * which is when its session exists, not when the spawn resolves.
   *
   * Without it a row could only ever show what the script asked for: a fuzzy
   * `model: "haiku"` stays `haiku` instead of the id it resolved to, an
   * `agent()` that named no model shows nothing at all, and a level pi clamped
   * is presented as the level that was requested (#168, #182).
   *
   * Plain strings, like `effort` above: this interface is the host boundary and
   * deliberately knows nothing about pi's `AgentInvocation`. Optional, so a host
   * that cannot report any of this simply does not, and the row keeps the
   * requested values it started with.
   */
  onResolved?(info: {
    /**
     * The host's own id for the child — the manager's `AgentRecord` id here.
     *
     * Reported as soon as the host has one, which is earlier than the rest of
     * this: the model is knowable only once a session exists, but the id is
     * what lets a reader open that child's conversation, and a child that
     * never got a model is exactly the one worth opening.
     */
    recordId?: string;
    modelName?: string;
    modelId?: string;
    thinking?: string;
    requestedThinking?: string;
    requestedModel?: string;
  }): void;
  /**
   * Compiled from the script's `agent({ schema })`.
   *
   * The host must give the child a `StructuredOutput` tool built from it and
   * return the validated payload as JSON text. Compiled rather than raw so the
   * runtime can re-check the answer without re-parsing the schema per call.
   */
  schema?: CompiledSchema;
  phaseIndex?: number;
  phaseTitle?: string;
  /**
   * The `gate` command this agent is being spawned under, when it has one.
   *
   * Passed down rather than run purely from here because an isolated child's
   * worktree is destroyed as part of its own settle: a host that can reach
   * inside that settle runs the gate there, against the tree the child wrote,
   * and reports the outcome back as {@link WorkflowSpawnResult.gate}. A host
   * that ignores this leaves the gate to {@link applyGate}, which then runs it
   * itself — so exactly one execution either way.
   */
  gate?: string;
  /**
   * Called by the host whenever the child does something observable.
   *
   * The watchdog's input, and deliberately coarse: tool start/end, turn end and
   * assistant usage. Not token or text deltas — a wedged provider can dribble
   * keepalives for hours, and a hung bash is exactly "tool started, never
   * ended", so both failure shapes have to read as silence here.
   *
   * Optional, so a host that cannot report any of this simply does not, and the
   * child keeps the whole window rather than being declared dead on arrival.
   */
  onActivity?: () => void;
}

export interface WorkflowSpawnResult {
  ok: boolean;
  /** The agent's answer. Present when `ok`. */
  text?: string;
  /** Why it failed. Present when not `ok`. */
  error?: string;
  /** The user dismissed it rather than it failing; renders as skipped. */
  skipped?: boolean;
  tokens?: number;
  /**
   * Output tokens only, for the script's `budget.spent()`.
   *
   * Separate from {@link tokens}, which is the lifetime total. Claude Code's
   * budget counts output, and a fan-out's re-sent input would swamp it.
   */
  outputTokens?: number;
  /** Whether the child needed an extra prompt to produce its structured answer. */
  structuredRetried?: boolean;
  toolCalls?: number;
  /**
   * Where the child actually ran.
   *
   * Only meaningful for `isolation: "worktree"`, and the whole reason it exists:
   * a gate has to run against the tree the child edited, not the main one, or it
   * verifies the wrong working copy. Left unset, a gate runs wherever the host
   * runs commands by default.
   *
   * Usually unset for a worktree child even so: the copy is removed during the
   * child's own settle, so it no longer exists by the time this is read. That
   * is what {@link gate} is for.
   */
  cwd?: string;
  /**
   * The outcome of this agent's `gate`, when the host already ran it.
   *
   * Set only by a host that ran the command itself — inside the child's
   * worktree, while that directory still existed. Its presence is what tells
   * {@link applyGate} the command has already been executed; the pass/fail
   * decision and the error shaping still happen there, in one place.
   */
  gate?: WorkflowGateResult;
}

/** Outcome of a `gate` command. `output` is what the user is shown when it fails. */
export interface WorkflowGateResult {
  ok: boolean;
  /** Combined stdout/stderr, or whatever the host wants surfaced as the failure. */
  output: string;
}

/** The one seam between a workflow and the rest of the extension. */
/** How a script names another workflow: a saved name, or a path to a file. */
export interface WorkflowScriptRef {
  name?: string;
  scriptPath?: string;
}

export type WorkflowScriptSource =
  | { ok: true; script: string; path?: string }
  | { ok: false; message: string };

export interface WorkflowHost {
  spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult>;
  /** Called for every in-flight agent when the run aborts. */
  abortAgent(agentId: string): void;
  /**
   * Continue a child that already ran in this run, keeping its context.
   *
   * `agentId` is one previously handed out in a {@link WorkflowSpawnRequest};
   * the child keeps the agent type, model and tool contract it started with, so
   * only the follow-up prompt crosses.
   *
   * Optional: a host without it rejects `resume` rather than quietly starting a
   * fresh child that has none of the context the script is counting on.
   */
  resumeAgent?(
    agentId: string,
    prompt: string,
    /**
     * Same reporter {@link WorkflowSpawnRequest.onResolved} carries, for the
     * same reason: a resumed row is rebuilt from scratch, so without it the
     * continuation of a child would show the model the script *asked* for while
     * the row above it shows the one that ran.
     */
    onResolved?: WorkflowSpawnRequest["onResolved"],
    /**
     * Same reporter {@link WorkflowSpawnRequest.onActivity} carries, and for the
     * same reason: a resumed child is watched by the watchdog exactly as a fresh
     * one is, so without this its window would be armed once and never refreshed —
     * a healthy long continuation aborted for silence it never had.
     */
    onActivity?: () => void,
  ): Promise<WorkflowSpawnResult>;
  /**
   * Run a `gate` command and report whether it passed.
   *
   * `cwd` is the child's worktree when it had one. Optional for the same reason
   * as {@link resumeAgent}, and more sharply: a gate that silently does not run
   * would mark unverified work as verified, so the runtime fails the call
   * instead of skipping it.
   */
  runGate?(command: string, options: { agentId: string; cwd?: string }): Promise<WorkflowGateResult>;
  /**
   * Resolve a nested `workflow()` reference to source.
   *
   * The runtime knows nothing about the filesystem or about pi, so it asks. It
   * still decides whether what comes back *is* a workflow — see
   * {@link validateScript} — because those rules belong with the runtime that
   * enforces them everywhere else.
   *
   * Optional for the same reason as {@link resumeAgent}: a host without it
   * rejects `workflow()` outright rather than silently running nothing.
   */
  loadWorkflow?(ref: WorkflowScriptRef): Promise<WorkflowScriptSource> | WorkflowScriptSource;
}

/**
 * What a run can be told to do while it is going, from the workflows dialog.
 *
 * Every method is best-effort and idempotent: the dialog renders off a progress
 * log that lags the runtime slightly, so it will sometimes ask for something
 * that has just stopped being possible. `false` means "there was nothing to do
 * that to" — a caller can say so, but it is never an error.
 */
export interface WorkflowControl {
  /**
   * Stop *starting* agents. Ones already running are left to finish, because
   * killing model work mid-turn throws away everything it has spent and there
   * is no way to hand it back its context.
   */
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  /**
   * Give up on the agent at `index`: its `agent()` call returns `null`, exactly
   * as a terminal failure does, and the row renders skipped.
   *
   * Immediate for a running agent and for one held at a pause. An agent parked
   * behind the concurrency limit takes its skip when it reaches the front —
   * the alternative is a cancellable semaphore for a case that resolves itself
   * as soon as any sibling finishes.
   */
  skip(index: number): boolean;
  /**
   * Start the agent at `index` over: the child is stopped and the same call is
   * re-run, so the script's `agent()` promise is still the one waiting and it
   * gets the new answer.
   *
   * Only while it is running — that is the whole window. Once the call has
   * settled its value is already the script's, and re-running would produce a
   * result with nowhere to go.
   */
  retry(index: number): boolean;
}

export interface RunWorkflowOptions {
  /** Full script source, starting with `export const meta = { … }`. */
  script: string;
  args?: unknown;
  host: WorkflowHost;
  signal?: AbortSignal;
  /** Fired per batch, not per entry — see the worker's progress batching. */
  onProgress?(entries: readonly WorkflowEntry[]): void;
  concurrency?: number;
  agentCap?: number;
  itemCap?: number;
  /**
   * How long one child may go silent before the run aborts it, in ms.
   *
   * `0` disables the watchdog for the whole run — the escape hatch for a script
   * that legitimately expects a long silent stretch. Unset takes
   * {@link DEFAULT_STALL_TIMEOUT_MS}.
   */
  stallTimeoutMs?: number;
  /**
   * How often the watchdog looks, in ms.
   *
   * Unset, it tracks the window: `min(30s, max(100ms, stallTimeoutMs / 10))`,
   * so the production 10-minute window keeps the documented ~30s cadence while
   * a short window is not scanned at a cadence longer than the window itself.
   * A knob rather than a constant because the window is only meaningful to the
   * tests as something injected: they exercise a fifty-millisecond stall, not a
   * ten-minute one. Also the grace a timed-out child gets to settle after its
   * abort before the run answers the call itself.
   */
  stallCheckIntervalMs?: number;
  /**
   * How long the whole run may hear nothing from the worker while nothing is
   * in flight before it is declared wedged, in ms.
   *
   * The per-child watchdog above only sees a child that goes quiet; a script
   * that spins before it ever calls `agent()` — or a worker wedged between
   * calls — posts nothing at all, and only this check can see it. Measured
   * between worker messages and suspended while the run is paused, because a
   * paused run is silent by design. It does not run while a child is in
   * flight: the worker posts one `call` and then hears nothing until the
   * answer, so a running child is indistinguishable from a wedged worker by
   * silence alone — judging it here would cap every `agent()` at this window.
   * `0` disables it. Unset takes {@link DEFAULT_STALL_TIMEOUT_MS} × 2.
   */
  runStallTimeoutMs?: number;
  /**
   * Hands the caller the run's control surface, once per run.
   *
   * A callback rather than a return value because `runWorkflow` resolves when
   * the run is *over*, which is the one moment there is nothing left to
   * control. Fired before the first agent starts.
   */
  onControl?(control: WorkflowControl): void;
  /**
   * How many nested `workflow()` invocations one run may make in total.
   *
   * Each costs a compile and a scope rather than a thread, so the ceiling is
   * generous — but unbounded is worse than capped, on the same reasoning as
   * {@link agentCap}.
   */
  nestedCap?: number;
  /**
   * Replay and record, for `resumeFromRunId`.
   *
   * The runtime does no file IO — `entries` come in already read and `append`
   * goes back out — so its tests stay free of a filesystem, the same reason
   * spawning is behind {@link WorkflowHost}.
   */
  journal?: {
    /** A previous run's settled calls, in position order. Empty replays nothing. */
    entries?: readonly WorkflowJournalEntry[];
    /** Called as each call of *this* run settles, so it can be resumed in turn. */
    append?(entry: WorkflowJournalEntry): void;
  };
}

export interface WorkflowRunResult {
  status: "completed" | "failed" | "killed";
  meta: WorkflowMeta;
  /** The script's return value, JSON-checked at the boundary. */
  value?: unknown;
  error?: string;
  /** The append-only log, in emission order. */
  progress: WorkflowEntry[];
  /** Agents scheduled, including those that failed. */
  agentCount: number;
  /** How many of those came back from the journal instead of being spawned. */
  replayedCount: number;
}

/* ------------------------------------------------------------------------- *
 * JSON boundary — host side
 * ------------------------------------------------------------------------- */

function boundaryError(what: string, path: string): WorkflowRuntimeError {
  return new WorkflowRuntimeError(
    `Cannot pass ${what} across the workflow VM boundary (at ${path}).`,
  );
}

function walk(value: unknown, path: string, seen: Set<object>): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw boundaryError("a non-finite number", path);
    return;
  }
  if (kind === "undefined") {
    if (path === "args") return;
    throw boundaryError("undefined", path);
  }
  if (kind === "bigint") throw boundaryError("a BigInt", path);
  if (kind === "symbol") throw boundaryError("a symbol", path);
  if (kind === "function") throw boundaryError("a function", path);
  if (kind !== "object") throw boundaryError(`a ${kind}`, path);

  const object = value as object;
  if (seen.has(object)) throw boundaryError("a circular structure", path);
  seen.add(object);

  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw boundaryError("an object with symbol keys", path);
  }

  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      if (!Object.hasOwn(object, i)) throw boundaryError("a sparse array", `${path}[${i}]`);
      walk(object[i], `${path}[${i}]`, seen);
    }
    seen.delete(object);
    return;
  }

  const prototype = Object.getPrototypeOf(object);
  if (prototype !== null && prototype !== Object.prototype) {
    throw boundaryError("a non-plain object", path);
  }
  for (const [key, entry] of Object.entries(object)) {
    walk(entry, `${path}.${key}`, seen);
  }
  seen.delete(object);
}

/**
 * Reject anything that cannot survive the round trip to the worker and into a
 * resume journal. Structured clone would happily carry a `Map` or a cycle that
 * the journal then cannot represent, so the check is stricter than the transport.
 */
export function assertBoundarySafe(value: unknown, path: string): void {
  walk(value, path, new Set());
}

/**
 * LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md
 *
 * `args` is the one value a script reads before it can defend itself, and a
 * scalar there fails late and confusingly: a JSON *string* arrives as a string,
 * every `args.x` is `undefined`, and the run dies at the return marshal with
 * "Cannot pass undefined across the workflow VM boundary (at the workflow
 * result.x)" — an error that blames the result for an input problem. The tool
 * description already tells callers to pass the value itself; this makes the
 * runtime enforce what the description asks for.
 *
 * `undefined` means "not provided". Arrays are data and pass; every other
 * non-`object` typeof — including `null` — is rejected.
 */
export function assertWorkflowArgs(args: unknown): void {
  if (args === undefined) return;
  if (args === null || typeof args !== "object") {
    const kind = args === null ? "null" : typeof args;
    throw new WorkflowRuntimeError(
      "Workflow `args` must be an object or an array, not " +
        kind +
        "." +
        (kind === "string" ? " Pass the value itself, not a JSON-encoded string." : ""),
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Semaphore
 * ------------------------------------------------------------------------- */

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    // Hand the permit straight over rather than decrementing and re-acquiring;
    // otherwise a burst of releases can let more than `limit` through.
    if (next) next();
    else this.active--;
  }

  /** Wake everyone so aborted callers can observe the abort and bail. */
  drain(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.();
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Messages
 * ------------------------------------------------------------------------- */

interface AgentCallPayload {
  prompt: string;
  label?: string;
  model?: string;
  agentType?: string;
  isolation?: "worktree";
  phaseIndex?: number;
  phaseTitle?: string;
  /** Shell command that has to pass before the agent counts as done. */
  gate?: string;
  /** Label of an earlier child in this run to continue instead of starting one. */
  resume?: string;
  /** Reasoning effort, already validated against pi's thinking levels worker-side. */
  effort?: string;
  /** Raw JSON Schema from `agent({ schema })`, compiled before anything spawns. */
  schema?: unknown;
  /**
   * Per-call inactivity window in seconds, from `agent({ stallTimeout })`.
   *
   * Overrides {@link RunWorkflowOptions.stallTimeoutMs} for this child alone;
   * `0` disables the watchdog for it. Validated worker-side, so it is only ever
   * a finite number in `[0, 86400]` by the time it lands here.
   */
  stallTimeout?: number;
}

type WorkerMessage =
  | { type: "call"; callId: number; method: string; payload: AgentCallPayload }
  | { type: "progress"; entries: WorkflowEntry[] }
  | { type: "complete"; resultJson?: string }
  | { type: "error"; message: string; stack?: string };

/** Everything below 0x20 except tab, newline and carriage return, plus DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const preview = (text: string) =>
  text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`;

/** First line of the prompt, trimmed — the fallback display name for an agent. */
function derivedLabel(prompt: string): string {
  const line = prompt.split("\n", 1)[0].trim();
  return line.length <= 60 ? line || "agent" : `${line.slice(0, 59)}…`;
}

/**
 * A child `resume` can revive, remembered under its label.
 *
 * The spawn options travel with it because `resume` deliberately takes none: the
 * revived child keeps the agent type, model and isolation it was started with,
 * and the progress entry has to show the same thing the first entry showed.
 */
interface CompletedChild {
  agentId: string;
  label: string;
  agentType: string;
  model?: string;
  isolation?: "worktree";
}

/**
 * Turn a failing gate into a failing agent.
 *
 * Deliberately no new state, no new entry type: a gated agent whose command
 * fails is *a failed agent*, so the card, the dialog and `agent()`'s `null`
 * return all handle it with the code they already have. The command output
 * becomes the error, because that is the thing worth reading.
 *
 * The single place that decides whether a gate passed. The command may have
 * been run by the host instead (inside a worktree that no longer exists by
 * now), but only ever by one of the two: a host that ran it says so with
 * `result.gate`, and this then shapes that outcome rather than running it
 * again.
 */
/**
 * Hold a schema'd result to its schema, host-side.
 *
 * The child's own tool already validated whatever it passed, so this normally
 * agrees. It exists for the cases where nothing did: a host that ignores
 * `schema` entirely, a replayed journal entry from before the schema changed,
 * or a payload that reached us some other way. The script asked for a shape;
 * exactly one place should be able to promise it.
 */
function applySchema(result: WorkflowSpawnResult, compiled: CompiledSchema): WorkflowSpawnResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text ?? "");
  } catch {
    return {
      ...result,
      ok: false,
      error: "The agent did not return structured output: its answer was not JSON.",
    };
  }
  const verdict = compiled.check(parsed);
  if (verdict === true) return result;
  return {
    ...result,
    ok: false,
    error: `The agent's answer did not match the requested schema: ${verdict}`,
  };
}

async function applyGate(
  result: WorkflowSpawnResult,
  command: string,
  agentId: string,
  runGate: NonNullable<WorkflowHost["runGate"]>,
): Promise<WorkflowSpawnResult> {
  const outcome =
    result.gate ??
    (await runGate(command, {
      agentId,
      // Where the child worked, when it had a worktree of its own. Gating the
      // main tree instead would verify code the child never touched.
      ...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
    }));
  const { gate: _ran, ...kept } = result;
  if (outcome.ok) return kept;
  const { text: _discarded, ...rest } = kept;
  const output = outcome.output.trim();
  return { ...rest, ok: false, error: output === "" ? `Gate command failed: ${command}` : output };
}

/**
 * Nico's wording, kept verbatim — this is the one borrowed check whose message a
 * user is likely to search for.
 */
function unawaitedLaunchMessage(labels: readonly string[]): string {
  const list = labels.map(label => `'${label}'`).join(", ");
  return `workflow script completed with unawaited agent launch(es): ${list}. Await or return each launch.`;
}

/**
 * Run one workflow script to completion.
 *
 * Rejects before starting for a script that cannot run at all (bad `meta`, over
 * the size limit, control characters, non-JSON `args`). Everything after the
 * worker is live resolves instead, carrying the failure in `status` — by then
 * there is a progress log worth handing back.
 */
/**
 * Everything a script must satisfy before it is compiled.
 *
 * Extracted so a nested `workflow()` is held to exactly the same standard as a
 * top-level run: same size limit, same character rules, same `meta` contract.
 * The host resolves a reference to source; deciding whether that source is a
 * workflow stays here, where the rules live.
 */
export function validateScript(script: string): { meta: WorkflowMeta; body: string } {
  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new WorkflowRuntimeError(
      `Workflow script is ${script.length} characters, over the limit of ${MAX_SCRIPT_LENGTH}.`,
    );
  }
  if (CONTROL_CHARACTERS.test(script)) {
    throw new WorkflowRuntimeError(
      "Workflow script contains control characters. Only tab, carriage return and newline are allowed.",
    );
  }
  return extractMeta(script);
}

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const { script, host } = options;

  // LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md
  assertWorkflowArgs(options.args);
  assertBoundarySafe(options.args, "args");

  const { meta, body } = validateScript(script);
  const agentCap = options.agentCap ?? WORKFLOW_AGENT_CAP;
  const itemCap = options.itemCap ?? WORKFLOW_ITEM_CAP;
  const semaphore = new Semaphore(options.concurrency ?? workflowConcurrency());

  const progress: WorkflowEntry[] = [];
  const inflight = new Set<string>();
  /** Label → the child that ran under it, last one wins. The `resume` handle. */
  const completedByLabel = new Map<string, CompletedChild>();
  /**
   * Launches the host has accepted and not yet answered, in call order.
   *
   * This is the whole unawaited-launch mechanism: a script that drops an
   * `agent()` promise still gets its call answered eventually, but it returns
   * first — so anything left here when `complete` arrives is a result nobody is
   * waiting for. Tracking it host-side avoids proxying `Promise` inside the
   * realm, which §2.4 rules out, and reading stack traces, which is brittle.
   */
  const openLaunches = new Map<number, string>();
  let agentCount = 0;
  let aborted = false;
  let settled = false;

  /* --- resume state ---------------------------------------------------- */

  const journalEntries = options.journal?.entries ?? [];
  const recordJournal = options.journal?.append;
  /**
   * Whether the replayable prefix is still intact.
   *
   * Once a position misses — different key, a journaled failure, or nothing
   * recorded there — every later call runs live, however well it matches.
   * See the header of journal.ts for why this is a prefix and not a lookup.
   */
  // A journal from a run that used `agent({ resume })` is declined whole: see
  // journal.ts on why a replayed agent leaves nothing for a later resume to
  // continue. Declining up front beats stranding the first `resume` call
  // partway through a run that has already spent its cheap half.
  const journalResumes = journalEntries.some(entry => entry.resumed);
  let prefixIntact = journalEntries.length > 0 && !journalResumes;
  let replayedCount = 0;

  /* --- live control ---------------------------------------------------- */

  /**
   * Agents that still have an unanswered `agent()` call, by index.
   *
   * The window in which skip and retry mean anything: before the entry appears
   * there is nothing to act on, and after it is gone the script already has its
   * value. `started` is what separates the two — a retry needs a child to stop.
   */
  interface LiveAgent {
    agentId: string;
    started: boolean;
    intent?: "skip" | "retry";
    /** Wakes it out of a pause hold, so a skip does not wait for a resume. */
    wake?: () => void;
    /**
     * The watchdog stopped this child for silence, so its call is a timeout
     * rather than whatever the abort happens to report.
     */
    timedOut?: boolean;
    /**
     * Answers the outstanding `agent()` call when the child ignored its abort.
     *
     * Set only while a spawn is in flight, so a stale resolver can never settle
     * a later attempt. See {@link checkStalls} — this is the last resort that
     * keeps a run from wedging on a child that will not stop.
     */
    forceSettle?: (result: WorkflowSpawnResult) => void;
  }
  const liveAgents = new Map<number, LiveAgent>();

  /* --- stall watchdog --------------------------------------------------- */

  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const stallCheckIntervalMs =
    options.stallCheckIntervalMs ??
    // Tracks the window rather than a flat 30s: the default 10-minute window
    // still scans at 30s, but a short window is not scanned at a cadence
    // longer than the window itself (which would make the effective window up
    // to 2× the configured one). `Math.max(100, …)` keeps a tiny window from
    // spinning the timer.
    Math.min(30_000, Math.max(100, Math.round(stallTimeoutMs / 10)));
  /**
   * In-flight children by runtime agent id, with the last time each said
   * anything and the window that child is judged against.
   *
   * Keyed by id rather than index because {@link host.abortAgent} takes an id,
   * and the index is what finds the {@link LiveAgent} to mark. Armed after the
   * semaphore, so time parked behind the concurrency limit never counts against
   * a child that has not started yet.
   *
   * The window is per entry, not per run: `agent({ stallTimeout })` gives one
   * child a different patience from its siblings.
   */
  const lastActivity = new Map<string, { index: number; at: number; timeoutMs: number }>();
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * The one line the watchdog writes itself, wired up with the run's progress
   * sink below. `checkStalls` is defined here but that sink is created further
   * down, so the force-settle path reaches the log through this rather than
   * across the closure.
   */
  let warnForceSettle: ((agentId: string) => void) | undefined;

  /** The one wording for a watchdog stop, shared by the row and the abort. */
  const stallMessage = (timeoutMs: number) =>
    `Timed out after ${Math.round(timeoutMs / 1000)}s of inactivity.`;

  const checkStalls = () => {
    const now = Date.now();
    for (const [agentId, entry] of lastActivity) {
      const live = liveAgents.get(entry.index);
      if (live === undefined) continue;
      if (live.timedOut !== true) {
        if (now - entry.at <= entry.timeoutMs) continue;
        // Abort, rather than answer the call here: a stop reaches a hung tool
        // call, and it lets the child settle normally — worktree cleanup and
        // all — so its slot is handed back the way any other child's is.
        live.timedOut = true;
        host.abortAgent(agentId);
        continue;
      }
      // A whole tick past the abort and still outstanding: this child is not
      // going to settle, and waiting for it would wedge the run exactly as the
      // watchdog exists to prevent. Answer the call ourselves. The child may be
      // left running — the lesser evil, and why this is the second tick rather
      // than the first — but the run is free either way.
      //
      // That grace IS one scan tick, so it is not an independent bound: it
      // tracks `min(30s, max(100ms, window/10))` and a short window is answered
      // a tick sooner.
      const forceSettle = live.forceSettle;
      // Nothing to answer means nothing was force-completed, so the warning
      // below must not fire for it: the warning names a leak, and a leak needs
      // the act. Unreachable in practice — the entry is deleted the moment the
      // child settles, and `forceSettle` is cleared in the same `finally` — but
      // the warning belongs to the block that acts, not to the iteration.
      if (forceSettle === undefined) continue;
      forceSettle(
        // Report the stop the user asked for, not the one the watchdog did: a
        // skip that raced the watchdog is still a skip, and only the row's own
        // flag can say so once the child never reported one itself.
        live.intent === "skip" ?
          { ok: false, skipped: true, error: "Stopped." }
        : { ok: false, error: stallMessage(entry.timeoutMs) },
      );
      // Force-completion is the one path that can leak: the child never
      // stopped, so it may still hold a process or a worktree. A leak nobody
      // can name is a leak nobody can clean up, so say which child (design §2).
      warnForceSettle?.(agentId);
    }
  };

  /** One timer per run, and only while a child is actually in flight. */
  const armStallTimer = () => {
    // Armed only by a caller that has just registered a watched child, so the
    // run's own window being `0` must not veto a positive per-call one.
    if (stallTimer !== undefined) return;
    stallTimer = setInterval(checkStalls, stallCheckIntervalMs);
    // A live workflow must not be the reason the process stays up.
    stallTimer.unref?.();
  };

  const disarmStallTimer = () => {
    if (stallTimer === undefined || lastActivity.size > 0) return;
    clearInterval(stallTimer);
    stallTimer = undefined;
  };

  /** A heartbeat from one child. Unknown ids are ignored, not registered. */
  const noteActivity = (agentId: string) => {
    const entry = lastActivity.get(agentId);
    if (entry !== undefined) entry.at = Date.now();
  };

  /* --- run-level liveness ------------------------------------------------ */

  /**
   * When the run last heard anything at all from the worker.
   *
   * The per-child watchdog above only notices a child that goes quiet; this is
   * the run's own pulse, and the only thing that sees a worker wedged before
   * it ever calls an agent — a `while (true) {}` script posts nothing, so no
   * child is ever registered to watch. Set on every worker message, whatever
   * it is: a progress batch and a `call` are equally proof the worker is alive.
   */
  let lastWorkerMessageAt = Date.now();
  const runStallTimeoutMs = options.runStallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS * 2;
  /**
   * Set once `finish` exists, for the same reason as {@link warnForceSettle}:
   * the timer is armed inside the run's promise, and the check has to reach
   * the settle path that only exists there.
   */
  let finishRunStall: (() => void) | undefined;
  let runStallTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * The run-level half of the watchdog: silence is measured between *worker*
   * messages, not child heartbeats, so it catches a worker that never speaks
   * rather than a child that does not. A pause is not silence — the clock is
   * restarted on resume — and a run that is already settling has nothing left
   * to fail.
   *
   * It is gated on there being nothing in flight, because a worker awaiting a
   * child is silent by design: the worker posts one `call` and then hears
   * nothing until the answer, so silence alone cannot tell a healthy long
   * call from a wedged worker. Judging it while a child runs would cap every
   * `agent()` at this window and throw away the per-child — or per-call
   * `agent({ stallTimeout })` — patience. Only a run that is silent with
   * nothing in flight is wedged in the sense this check exists for.
   */
  const checkRunStall = () => {
    if (isPaused() || settled) return;
    if (inflight.size > 0) return;
    if (Date.now() - lastWorkerMessageAt <= runStallTimeoutMs) return;
    finishRunStall?.();
  };

  /** One timer per run, and only while the run is alive. */
  const armRunStallTimer = () => {
    // `0` is the escape hatch, the same as the per-child window: a script whose
    // worker is legitimately silent for longer than the window (a very long
    // gate, say) opts out here.
    if (runStallTimer !== undefined || runStallTimeoutMs <= 0) return;
    runStallTimer = setInterval(checkRunStall, stallCheckIntervalMs);
    // A live workflow must not be the reason the process stays up.
    runStallTimer.unref?.();
  };

  const disarmRunStallTimer = () => {
    if (runStallTimer === undefined) return;
    clearInterval(runStallTimer);
    runStallTimer = undefined;
  };

  /**
   * Output tokens this run has spent, mirrored to the script as
   * `budget.spent()`.
   *
   * The host owns the number and every response carries it, rather than the
   * worker accumulating its own: two counters would drift, and there is nothing
   * to gain from the second one. Nor is there observable staleness — tokens
   * only accrue through agents, and the script only learns anything through
   * agent responses.
   */
  let spentOutputTokens = 0;

  let paused = false;
  /** Read through a call for the same reason `intent()` is — see below. */
  const isPaused = () => paused;
  const pauseWaiters = new Set<() => void>();
  /** Release everyone held at a pause — on resume, and on the way out. */
  function releasePause(): void {
    for (const wake of [...pauseWaiters]) wake();
    pauseWaiters.clear();
  }
  /** Park here while the run is paused, so no new agent is started. */
  function pauseGate(live: LiveAgent): Promise<void> {
    if (!paused || aborted || settled) return Promise.resolve();
    return new Promise<void>(resolve => {
      const wake = () => {
        pauseWaiters.delete(wake);
        live.wake = undefined;
        resolve();
      };
      live.wake = wake;
      pauseWaiters.add(wake);
    });
  }

  options.onControl?.({
    pause: () => { paused = true; },
    // A pause is silence by design, so the run-level clock restarts here: a
    // long pause must not count against the window that follows it.
    resume: () => {
      paused = false;
      lastWorkerMessageAt = Date.now();
      releasePause();
    },
    isPaused: () => paused,
    skip: index => {
      const live = liveAgents.get(index);
      if (live === undefined || live.intent !== undefined) return false;
      live.intent = "skip";
      // A running child is stopped, which comes back as a skipped result; a
      // held one is woken so it can bail at the gate it is parked on.
      if (live.started) host.abortAgent(live.agentId);
      else live.wake?.();
      return true;
    },
    retry: index => {
      const live = liveAgents.get(index);
      if (live === undefined || !live.started || live.intent !== undefined) return false;
      live.intent = "retry";
      host.abortAgent(live.agentId);
      return true;
    },
  });

  /** The journal entry to reuse at `index`, or undefined to run it live. */
  function replayAt(index: number, key: string): WorkflowJournalEntry | undefined {
    if (!prefixIntact) return undefined;
    const entry = journalEntries[index];
    if (entry === undefined || entry.index !== index || entry.key !== key || !entry.ok) {
      prefixIntact = false;
      return undefined;
    }
    return entry;
  }

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      body,
      metaJson: JSON.stringify(meta),
      argsJson: options.args === undefined ? undefined : JSON.stringify(options.args),
      itemCap,
      nestedCap: options.nestedCap ?? WORKFLOW_NESTED_CAP,
    },
  });

  return await new Promise<WorkflowRunResult>(resolve => {
    const emit = (entries: WorkflowEntry[]) => {
      if (entries.length === 0) return;
      progress.push(...entries);
      options.onProgress?.(entries);
    };
    warnForceSettle = agentId => {
      emit([
        {
          type: "workflow_log",
          message:
            `Workflow agent ${agentId} did not stop after its stall abort and was force-completed; ` +
            "it may still be running (leaked process or worktree).",
        },
      ]);
    };

    const respond = (callId: number, ok: boolean, value?: unknown, error?: string, fatal?: boolean) => {
      // Cleared before the settled check: a launch answered by a run that is
      // already finishing is not an unawaited launch either.
      openLaunches.delete(callId);
      if (settled) return;
      // `spent` rides on every response, so the worker's `budget.spent()` is a
      // mirror of this number rather than a second tally of its own.
      worker.postMessage({ type: "response", callId, ok, value, error, fatal, spent: spentOutputTokens });
    };

    const finish = (result: Omit<WorkflowRunResult, "meta" | "progress" | "agentCount" | "replayedCount">) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      // Symmetric with `semaphore.drain()` below: everything parked is woken so
      // it observes the settle and unwinds. Nothing depends on it — the run's
      // promise resolves either way — it just does not leave live-agent
      // bookkeeping behind for a run that is over.
      releasePause();
      for (const agentId of inflight) host.abortAgent(agentId);
      inflight.clear();
      // Nothing is in flight any more, so there is nothing left to watch — and
      // a timer outliving its run would keep the process up for nothing.
      lastActivity.clear();
      disarmStallTimer();
      disarmRunStallTimer();
      semaphore.drain();
      // Resolve only once the thread is actually down, so a caller that awaits
      // runWorkflow() is guaranteed not to be leaking one.
      const settle = () => resolve({ ...result, meta, progress, agentCount, replayedCount });
      void worker.terminate().then(settle, settle);
    };

    // The settle path exists now, so the run's own liveness check can reach
    // it. Armed here rather than with the worker: no message can arrive before
    // this tick ends, and a worker that wedges before it ever posts is exactly
    // what this catches.
    finishRunStall = () => {
      finish({
        status: "failed",
        error: `Workflow stalled: no progress for ${Math.round(runStallTimeoutMs / 1000)}s.`,
      });
    };
    armRunStallTimer();

    function onAbort() {
      aborted = true;
      // terminate() is why this runs in a worker at all: it stops a script that
      // is spinning or wedged mid-await, which an in-process vm cannot do.
      finish({ status: "killed", error: "Workflow aborted." });
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    async function handleAgent(callId: number, payload: AgentCallPayload): Promise<void> {
      // Bound now: the optional methods are checked once, up front, so a
      // capability the host lacks fails before an agent is spawned rather than
      // after — a gate that never ran must not be mistaken for a gate that
      // passed.
      const runGate = host.runGate?.bind(host);
      const resumeAgent = host.resumeAgent?.bind(host);
      if (payload.gate !== undefined && runGate === undefined) {
        respond(callId, false, undefined, "This workflow host cannot run gate commands.", true);
        return;
      }
      if (payload.resume !== undefined && resumeAgent === undefined) {
        respond(callId, false, undefined, "This workflow host cannot resume agents.", true);
        return;
      }

      let resumed: CompletedChild | undefined;
      if (payload.resume !== undefined) {
        resumed = completedByLabel.get(payload.resume);
        if (resumed === undefined) {
          const known = [...completedByLabel.keys()];
          // Fatal: a typo'd label is a script bug, and folding it into a null
          // would show up as an agent that mysteriously returned nothing.
          //
          // Unless agents were replayed, in which case it is not a script bug
          // at all — the label's child came back from the journal and has no
          // conversation here to continue. Saying "no agent has completed"
          // would send the reader hunting for a typo that is not there.
          respond(
            callId,
            false,
            undefined,
            replayedCount > 0 ?
              `agent() opts.resume: "${payload.resume}" was replayed from the resume journal, not run, so there is ` +
                "no conversation in this run to continue. Re-run without resumeFromRunId."
            : `agent() opts.resume: no agent has completed under the label "${payload.resume}" in this run. ${
                known.length === 0
                  ? "No agent has completed yet."
                  : `Known labels: ${known.map(label => `"${label}"`).join(", ")}.`
              }`,
            true,
          );
          return;
        }
      }

      // Compiled before anything is scheduled. A schema the runtime cannot use
      // is a script bug, so it is fatal like a typo'd resume label — folding it
      // into a null would surface as an agent that mysteriously returned
      // nothing, and it costs no model call to say so here.
      let compiledSchema: CompiledSchema | undefined;
      if (payload.schema !== undefined) {
        const compilation = compileJsonSchema(payload.schema);
        if (!compilation.ok) {
          respond(callId, false, undefined, compilation.message, true);
          return;
        }
        compiledSchema = compilation.compiled;
      }

      if (agentCount >= agentCap) {
        // Fatal, so parallel()/pipeline() rethrow instead of folding it into a
        // null. A cap that silently drops work is worse than no cap.
        respond(callId, false, undefined, `Workflow exceeded its cap of ${agentCap} agents.`, true);
        return;
      }
      const index = agentCount++;
      // A resumed call is the same child again: it keeps the agent id, so an
      // abort still reaches it, and it keeps its spawn contract, so the row
      // reads the same as the row it continues.
      const agentId = resumed?.agentId ?? `wf-agent-${index}`;
      const label = payload.label ?? resumed?.label ?? derivedLabel(payload.prompt);
      const agentType = resumed?.agentType ?? payload.agentType ?? "general-purpose";
      const model = resumed !== undefined ? resumed.model : payload.model;
      const isolation = resumed !== undefined ? resumed.isolation : payload.isolation;
      // Per-call patience, resolved once outside the retry loop: a per-call
      // `stallTimeout` wins over the run's, and `0` either way means no watchdog
      // for this child. A retry is owed the same window as the attempt before.
      const agentStallMs =
        payload.stallTimeout === undefined ? stallTimeoutMs : payload.stallTimeout * 1000;
      openLaunches.set(callId, label);

      const base: WorkflowAgentEntry = {
        type: "workflow_agent",
        index,
        label,
        state: "start",
        agentId,
        agentType,
        promptPreview: preview(payload.prompt),
        ...(model !== undefined ? { model } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
        ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
      };

      const queuedAt = Date.now();
      emit([{ ...base, queuedAt }]);

      // Replay before the semaphore, not after: a cached answer is not model
      // running, so it must not hold a concurrency slot that a live agent
      // could use. The row still appears in the tree — the run reads as the
      // same shape it had the first time, just faster.
      // The payload's `schema` is the raw object; the key wants it serialized,
      // so the spread is narrowed rather than passed through.
      const keyInput: JournalKeyInput = {
        ...payload,
        schema: payload.schema !== undefined ? JSON.stringify(payload.schema) : undefined,
      };
      let replayed = replayAt(index, journalKey(keyInput));
      // A replayed answer still has to satisfy the schema. The key covers a
      // schema that *changed*, but not a journal that was hand-edited, and not
      // the empty text a torn entry leaves behind — either would hand the
      // script a null from an entry the journal claims succeeded.
      if (replayed !== undefined && compiledSchema !== undefined) {
        const recheck = applySchema({ ok: true, text: replayed.text ?? "" }, compiledSchema);
        if (!recheck.ok) {
          prefixIntact = false;
          replayed = undefined;
        }
      }
      if (replayed !== undefined) {
        replayedCount++;
        const replayedText = replayed.text ?? "";
        const at = Date.now();
        emit([
          {
            ...base,
            queuedAt,
            startedAt: at,
            lastProgressAt: at,
            durationMs: 0,
            state: "done",
            // The row reads as done, because it is — `cached` is what tells the
            // dialog to annotate it "from resume journal" rather than letting a
            // 0ms agent look like one that did the work impossibly fast.
            cached: true,
            resultPreview: preview(replayedText),
          },
        ]);
        openLaunches.delete(callId);
        // Re-recorded so this run's journal is complete on its own terms: a
        // resume of a resume must not have to walk back through a chain of
        // earlier files to find the prefix.
        recordJournal?.({ index, key: replayed.key, ok: true, text: replayedText });
        respond(callId, true, replayedText);
        return;
      }

      const key = journalKey(keyInput);
      const resumeMark = payload.resume !== undefined ? ({ resumed: true } as const) : {};

      /** A skip the user asked for, before the child ever started. */
      const settleSkipped = (extra: Partial<WorkflowAgentEntry>) => {
        recordJournal?.({ index, key, ok: false, ...resumeMark });
        emit([{ ...base, queuedAt, ...extra, state: "error", skipped: true, error: "Skipped by user." }]);
        // `null`, exactly as a terminal failure gives — a skipped agent is one
        // the script's `.filter(Boolean)` was already written to survive.
        respond(callId, true, null);
      };

      // Registered for exactly as long as the call is unanswered, which is the
      // window in which skip and retry mean anything.
      const live: LiveAgent = { agentId, started: false };
      liveAgents.set(index, live);
      // Read through a call, not off the field: `intent` is set from outside
      // this function while it is suspended at an await, so control-flow
      // narrowing across the awaits would be reasoning about a value that has
      // since changed.
      const intent = (): LiveAgent["intent"] => live.intent;
      let attempt = 1;
      try {
        for (;;) {
          // Held before the slot, not after: a paused run must not sit on
          // concurrency it is not using while its running agents drain.
          await pauseGate(live);
          if (intent() === "skip") return settleSkipped({});

          // A resumed agent waits its turn like any other: it is the same amount of
          // model running at once.
          await semaphore.acquire();
          if (aborted || settled) {
            semaphore.release();
            respond(callId, false, undefined, "Workflow aborted.", true);
            return;
          }
          // Paused while parked behind the limit: this agent was waiting for a
          // permit when the pause landed, so it never passed the gate above.
          // Hand the permit back and go wait at the gate like everything else,
          // or a pause would leak exactly as many agents as were queued.
          if (isPaused() && !aborted && !settled) {
            semaphore.release();
            continue;
          }
          // Skipped while parked behind the limit: the permit arrived, and the
          // only thing left to do with it is give it back.
          if (intent() === "skip") {
            semaphore.release();
            return settleSkipped({});
          }

          // Carried on every emit from here on, so a retried row keeps saying
          // why it is on its second attempt instead of losing it to the next
          // progress update.
          const attemptMark =
            attempt > 1 ? { attempt, lastAttemptReason: "user-retry" as const } : {};

          const startedAt = Date.now();
          emit([{ ...base, queuedAt, startedAt, ...attemptMark }]);

          // Mutates `base` rather than emitting a standalone patch: every later
          // emit spreads it, so the settle path carries the effective values
          // without knowing they were ever corrected. Re-emitting under the
          // same `index` is what the append-only, last-write-wins progress log
          // is for — the row updates in place while the agent is still running.
          const onResolved = (info: {
            recordId?: string;
            modelName?: string;
            modelId?: string;
            thinking?: string;
            requestedThinking?: string;
            requestedModel?: string;
          }) => {
            if (info.recordId !== undefined) base.recordId = info.recordId;
            if (info.modelName !== undefined) base.model = info.modelName;
            if (info.modelId !== undefined) base.modelId = info.modelId;
            if (info.thinking !== undefined) base.thinking = info.thinking;
            if (info.requestedThinking !== undefined) base.requestedThinking = info.requestedThinking;
            if (info.requestedModel !== undefined) base.requestedModel = info.requestedModel;
            // `base.state` is still "start", so emitting after the row reached a
            // terminal state would revert it to running under last-write-wins.
            // Not reachable from this repo's host, which reports during startup
            // — but this is the host boundary, and every other promise it makes
            // is checked rather than trusted.
            if (!inflight.has(agentId)) return;
            emit([{ ...base, queuedAt, startedAt, ...attemptMark, lastProgressAt: Date.now() }]);
          };
          live.started = true;
          inflight.add(agentId);
          // Armed here rather than when the call arrived: a child parked behind
          // the concurrency limit has had no chance to say anything, and timing
          // it out for the run's own queueing would be a false positive.
          if (agentStallMs > 0) {
            lastActivity.set(agentId, { index, at: Date.now(), timeoutMs: agentStallMs });
            armStallTimer();
          }

          let result: WorkflowSpawnResult;
          try {
            const spawn: Promise<WorkflowSpawnResult> =
              resumed !== undefined && resumeAgent !== undefined
                ? resumeAgent(resumed.agentId, payload.prompt, onResolved, () => noteActivity(agentId))
                : host.spawnAgent({
                    agentId,
                    index,
                    prompt: payload.prompt,
                    label,
                    agentType,
                    ...(model !== undefined ? { model } : {}),
                    ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
                    ...(payload.stallTimeout !== undefined ? { stallTimeout: payload.stallTimeout } : {}),
                    ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
                    ...(isolation !== undefined ? { isolation } : {}),
                    ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
                    ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
                    // Offered, not delegated: a host that can run it inside the
                    // child's worktree does, and hands back `result.gate`.
                    ...(payload.gate !== undefined ? { gate: payload.gate } : {}),
                    onResolved,
                    // What the watchdog listens to. The resume path forwards the
                    // same signal below, so a long continuation proves it is alive
                    // rather than being watched but unable to report.
                    onActivity: () => noteActivity(agentId),
                  });
            // Raced, so that a child which ignores its abort cannot leave this
            // await — and with it the whole run — outstanding forever. A real
            // child settles here; only a stopped-in-name-only one is answered
            // by `checkStalls`, and only after a tick's grace.
            result = await new Promise<WorkflowSpawnResult>(resolve => {
              live.forceSettle = resolve;
              spawn.then(resolve, error => {
                resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
              });
            });
            // The child itself has settled — success, failure or a stop — so it
            // is no longer a candidate for the watchdog. Deleted here, before the
            // gate below, because the gate is not the child: a gate longer than
            // the stall window would otherwise mark a finished child timedOut and
            // throw the gate's verdict away with it.
            lastActivity.delete(agentId);
            disarmStallTimer();
            // A child can resolve `ok` in the same instant the watchdog aborts
            // it. The timeout verdict wins: registering it as completed or
            // running its gate would let a stopped child read as a clean pass.
            // The timed-out branch below shapes the row instead.
            if (result.ok && live.timedOut !== true) {
              // Recorded before the gate runs: the child itself finished, so it is
              // resumable even when its gate rejects the work — "here is what the
              // gate said, fix it" is the loop this exists for.
              completedByLabel.set(label, {
                agentId,
                label,
                agentType,
                ...(model !== undefined ? { model } : {}),
                ...(isolation !== undefined ? { isolation } : {}),
              });
              // Re-checked here, not just in the child's tool: this is the one
              // place that decides the script's value matches the schema it
              // asked for, so a host that ignored `schema` fails loudly instead
              // of handing the script prose. Before the gate, because a gate
              // verifies work and there is no work to verify if the shape is
              // wrong — and the reader should see the schema error, not a gate
              // error standing in front of it.
              if (compiledSchema !== undefined && result.ok) {
                result = applySchema(result, compiledSchema);
              }
              if (result.ok && payload.gate !== undefined && runGate !== undefined) {
                result = await applyGate(result, payload.gate, agentId, runGate);
              }
            }
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) };
          } finally {
            live.forceSettle = undefined;
            inflight.delete(agentId);
            // The run-level clock measures silence between worker messages, but
            // a worker awaiting a child is silent by design — and this child has
            // just settled without the worker posting anything. Restart the clock
            // once nothing is left in flight, so the worker gets the whole window
            // to post its next message (the next `call`, or `complete`) before the
            // run-level check may call it wedged. Without this, a run whose last
            // child ran longer than the window would be failed the instant that
            // child settled, on a clock that started before the child did.
            if (inflight.size === 0) lastWorkerMessageAt = Date.now();
            live.started = false;
            semaphore.release();
          }

          if (settled) return;

          // The stop that produced this result was ours, so run the same call
          // again rather than reporting it. The script is still awaiting this
          // `agent()`, which is the only reason a retry can mean anything.
          if (intent() === "retry" && !aborted) {
            live.intent = undefined;
            // The retry starts the clock over: the silent child is gone, and
            // the new one is owed the whole window before it is called silent
            // too. Without this, a retry of a timed-out call would be killed on
            // the next tick by the verdict on the attempt before it.
            live.timedOut = false;
            // No `noteActivity` here: the settle path already deleted this
            // child's entry, so there is nothing to refresh — the loop's own
            // `lastActivity.set` on the next iteration is what starts the new
            // attempt's clock.
            attempt++;
            emit([{ ...base, queuedAt, attempt, lastAttemptReason: "user-retry" }]);
            continue;
          }

          // The watchdog stopped this child, so the call is a timeout rather
          // than a failure or a skip — whatever the abort made the host report.
          //
          // `intent()` and not `result.skipped`: a host reports a stopped child
          // as skipped whether a user asked for it or the watchdog did, so the
          // result alone cannot tell the two apart. The user's intent can, and
          // theirs wins the race — and it wins it whatever the child's own
          // result turned out to be: the gate below was skipped with the abort,
          // so a child that resolved `ok` in the same instant must not hand the
          // script text nothing verified.
          if (live.timedOut === true) {
            // Counted here too: the child ran and burned output tokens before
            // the watchdog stopped it, and this branch returns before the
            // shared accumulation below.
            spentOutputTokens += result.outputTokens ?? 0;
            const timedOutAt = Date.now();
            const stopCommon = {
              ...base,
              queuedAt,
              startedAt,
              ...attemptMark,
              lastProgressAt: timedOutAt,
              durationMs: timedOutAt - startedAt,
              ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
              ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
            };
            // `ok: false`, like any other failure: resuming this run re-runs
            // this child live, which is the honest thing to do with a call that
            // never produced an answer.
            recordJournal?.({ index, key, ok: false, ...resumeMark });
            if (intent() === "skip") {
              // The stop the user asked for, not the one the watchdog did.
              emit([{ ...stopCommon, state: "error", skipped: true, error: "Stopped." }]);
            } else {
              emit([{ ...stopCommon, state: "error", timedOut: true, error: stallMessage(agentStallMs) }]);
            }
            // `null` to the script, the shape a skip already gives — the SDD
            // scripts degrade on a missing verdict rather than throw.
            respond(callId, true, null);
            return;
          }

          // Counted before the response is sent, so the very call that spent
          // them already sees them in `budget.spent()`. Failed and skipped
          // agents count too — they burned the tokens either way.
          spentOutputTokens += result.outputTokens ?? 0;

          const finishedAt = Date.now();
          const common = {
            ...base,
            queuedAt,
            startedAt,
            ...attemptMark,
            lastProgressAt: finishedAt,
            durationMs: finishedAt - startedAt,
            ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
            ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
          };

          if (result.ok) {
            const text = result.text ?? "";
            emit([{ ...common, state: "done", resultPreview: preview(text) }]);
            recordJournal?.({ index, key, ok: true, text, ...resumeMark });
            respond(callId, true, text);
            return;
          }
          // Recorded as a failure rather than left out: a gap would be read as an
          // unchanged prefix on the next resume, silently skipping the retry this
          // whole mechanism exists to make cheap.
          recordJournal?.({ index, key, ok: false, ...resumeMark });
          // A dead agent is a null in the script, not a thrown error: Claude Code
          // scripts .filter(Boolean) rather than try/catch around every call.
          emit([
            {
              ...common,
              state: "error",
              // A user skip reaches here as a stopped child, which the host
              // already reports as skipped — the flag is taken from the result
              // rather than from the intent so an abort mid-skip still reads
              // as whatever actually happened to the child.
              error: result.error ?? "Agent failed.",
              ...(result.skipped ? { skipped: true } : {}),
            },
          ]);
          respond(callId, true, null);
          return;
        }
      } finally {
        liveAgents.delete(index);
        // The child is gone (or was declared gone), so the watchdog stops
        // watching it — and stops altogether once no child is left.
        lastActivity.delete(agentId);
        disarmStallTimer();
      }
    }

    /**
     * Resolve one `workflow(ref)` and hand the child's source back compiled.
     *
     * Resolution failures are non-fatal — Claude Code documents `workflow()` as
     * throwing on an unknown name so a script can catch it and carry on. A host
     * with no `loadWorkflow` at all is fatal, matching how a missing `runGate`
     * or `resumeAgent` is treated: a capability the script asked for and this
     * host cannot provide is a wiring error, not a runtime condition.
     */
    async function handleLoadWorkflow(callId: number, ref: WorkflowScriptRef): Promise<void> {
      const loadWorkflow = host.loadWorkflow?.bind(host);
      if (loadWorkflow === undefined) {
        respond(callId, false, undefined, "This workflow host cannot run nested workflows.", true);
        return;
      }
      let source: WorkflowScriptSource;
      try {
        source = await loadWorkflow(ref);
      } catch (error) {
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error));
        return;
      }
      if (!source.ok) {
        respond(callId, false, undefined, source.message);
        return;
      }
      try {
        const child = validateScript(source.script);
        respond(callId, true, {
          name: child.meta.name,
          metaJson: JSON.stringify(child.meta),
          body: child.body,
        });
      } catch (error) {
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error));
      }
    }

    worker.on("message", (message: WorkerMessage) => {
      // Any message is proof the worker is alive, whatever it says: this is the
      // run-level pulse, and it is set before the settled check so a late
      // message cannot leave the clock stale for a check already scheduled.
      lastWorkerMessageAt = Date.now();
      if (settled) return;
      switch (message.type) {
        case "progress":
          emit(message.entries);
          break;
        case "call":
          if (message.method === "workflow") {
            void handleLoadWorkflow(message.callId, message.payload as WorkflowScriptRef);
            break;
          }
          if (message.method !== "agent") {
            respond(message.callId, false, undefined, `Unknown workflow host method "${message.method}".`, true);
            break;
          }
          void handleAgent(message.callId, message.payload as AgentCallPayload);
          break;
        case "complete": {
          // The script is done, so every launch it made should have been
          // answered by now — a response is sent before the worker can post
          // this, so anything still open was never awaited. finish() aborts
          // those children on the way out.
          const unawaited = [...openLaunches.values()];
          if (unawaited.length > 0) {
            finish({ status: "failed", error: unawaitedLaunchMessage(unawaited) });
            break;
          }
          finish({
            status: "completed",
            ...(message.resultJson === undefined ? {} : { value: JSON.parse(message.resultJson) }),
          });
          break;
        }
        case "error":
          finish({ status: "failed", error: message.message });
          break;
      }
    });

    worker.on("error", error => {
      finish({ status: "failed", error: error instanceof Error ? error.message : String(error) });
    });

    worker.on("exit", () => {
      // Only reachable when the worker dies without reporting — a terminate()
      // we did not initiate, or a hard crash.
      finish({ status: "failed", error: "Workflow worker exited before completing." });
    });
  });
}
