// One subagent run, as a real `pi` in a Rex pane.
//
// The manager owns the record; this owns the run. `start()` composes the child's
// inputs, creates and minimizes its pane, tails the child's own session file for
// the live view, and settles on whichever comes first: the child's result file,
// or its process exit. `resume()` does the same for a run that already has a
// transcript, relaunching the child on that session file.
//
// Three things here are measured facts rather than choices:
//
//   - **The result file is the success signal.** A failing `pi` closes its own
//     pane within a second or two, so a run must never depend on a surviving
//     pane: the exit status comes from `rex wait`, and by the time a crash is
//     visible the screen is usually gone already.
//   - **`{ lastExit: null, status: null }` means "not yet observable".** It is
//     what a closed block and a program that has not exited both read as, so the
//     exit is taken from `rex wait` and the process read is only the fallback.
//   - **A refused minimize is part of the outcome.** Rex rejects
//     `set_layer_state` when the window would lose its last visible pane; the
//     agent is unaffected and the pane stays on screen, so the refusal travels
//     back to whoever can tell the user rather than being logged and dropped.
//
// Nothing here fails a spawn for a reason it can fall back from: an agent that
// cannot get a pane runs in-process instead, and one whose pane cannot be
// minimized runs in a pane that happens to be visible.

import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagerRunner, RunResume, RunStart } from "../agent-manager.js";
import {
  extensionCanonicalNames,
  type ResumeAgentOptions,
  type ResumeAgentResult,
  type RunOptions,
  type RunResult,
  resumeAgent,
  runAgent,
} from "../agent-runner.js";
import { getAgentConfig, getConfig } from "../agent-types.js";
import { buildParentContext, extractText } from "../context.js";
import { detectEnv } from "../env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "../memory.js";
import { describeModel, resolveDefaultModel } from "../model-resolver.js";
import { getMaxSubagentDepth } from "../nested-tools.js";
import { sessionTaskDir } from "../output-file.js";
import { buildAgentPrompt, type PromptExtras } from "../prompts.js";
import { findSkillPath } from "../skill-loader.js";
import type { AgentConfig, RunHandle, SubagentType } from "../types.js";
import type { LifetimeUsage } from "../usage.js";
import type { ChildRunResult } from "./child-mode.js";
import {
  buildChildCommand,
  type ChildFiles,
  type ChildSpec,
  type CloseResult,
  childMayTrustProject,
  childSpecFromSpawn,
  closePane,
  launchPane,
  type PaneHandle,
  type ResolvedResources,
  writeChildFiles,
  writeStructuredSchema,
} from "./launcher.js";
import { PaneSession } from "./pane-session.js";
import {
  captureTail,
  failureReason,
  type PaneDeps,
  type ProcessState,
  type RexExec,
  type RexExecResult,
  readProcessState,
} from "./rex-cli.js";
import { SessionTail } from "./session-tail.js";

/** How often the child's result file is looked for, and its session file too. */
const POLL_INTERVAL_MS = 100;

/**
 * How long one `rex wait` watches before giving up and being asked again.
 *
 * One unbounded wait would be a child process per running agent for as long as
 * the agent runs, with no way to notice a server that restarted. Thirty seconds
 * costs two round trips a minute per agent and still gives every failure a
 * moment to be noticed.
 */
const WAIT_WINDOW_MS = 30_000;

/** How long a `rex wait` call may take before `execRex` kills it: its own window plus slack. */
const WAIT_TIMEOUT_MS = WAIT_WINDOW_MS + 5_000;

/** The pause between an unproductive exit read and the next attempt. */
const EXIT_POLL_INTERVAL_MS = 500;

/**
 * How long the child gets to create its session file before the tail starts on a
 * path the runner guessed.
 *
 * A guess is not the end of the discovery: `pi` writes its JSONL lazily, on the
 * first turn, so a slow child can cross this window and the tail keeps looking
 * in the background (see `followSessionFile()`).
 */
const SESSION_FILE_GRACE_MS = 2_000;

/**
 * How long `steerPane()` waits for a child that has not reported a program
 * status yet.
 *
 * A just-started `pi` reports nothing at all for a few hundred milliseconds —
 * the pane exists, the child is still starting — and refusing in that window
 * would drop a steer that arrived at exactly the moment a run became steerable.
 */
const STEER_STATUS_GRACE_MS = 2_000;

/**
 * How long a close gets on the shutdown path.
 *
 * Shorter than the default allowance because this one is best-effort by nature: a
 * quit that spent ten seconds on a wedged Rex would delay the exit it is trying
 * to make clean, and a pane left behind by a process that is going away is the
 * lesser evil. Long enough for a healthy server, which answers in milliseconds.
 */
const SHUTDOWN_CLOSE_TIMEOUT_MS = 2_000;

/** The pane label's task slice: enough to tell two agents apart, short enough for a capsule. */
const LABEL_DESCRIPTION_CHARS = 60;

/** The tools whose mere presence says the parent has that built-in extension loaded. */
const CODEMODE_TOOL = "codemode";
const TOOL_SEARCH_TOOL = "tool_search";

/**
 * What a pane run needs from the parent: how to reach Rex, where this session's
 * children live, and which binary is `pi`.
 *
 * Injected rather than read from the environment so a whole run can be driven
 * without a Rex server, and so the same runner serves panes wherever the
 * parent's ids came from.
 */
export interface PaneRunDeps {
  exec: RexExec;
  /** The parent's own session. A pane is never created in anyone else's. */
  sessionId: string;
  /** The window the parent block sits in, which is where its panes float. */
  windowId: string;
  /** The session that started the cascade — the child session store is keyed by it. */
  rootSessionId: string;
  /** `<getAgentDir()>/subagent-sessions/<rootSessionId>/`, created on first use. */
  agentSessionDir: string;
  /** The parent's own executable path, so the pane's `pi` is the same build. */
  piBinary: string;
  /**
   * Where a spawn-level warning a user must see goes: a refused minimize, or a
   * Rex that stopped answering. The run is unaffected in both cases, which is
   * exactly why it has to be said out loud — the alternative is a pane on screen
   * that nobody was told about.
   */
  onWarning?: (message: string) => void;
  /**
   * The runner to use when no pane can be made. Defaults to the in-process
   * runner, which is the honest fallback; injectable so a test can watch the
   * fallback happen without booting a real session.
   */
  fallback?: ManagerRunner;
}

/**
 * The pane runner: one child `pi` per agent, watched from the outside.
 *
 * The factory is the only export the manager sees. Everything below is about one
 * run: compose, launch, watch, settle, close.
 */
export function createPaneRunner(deps: PaneRunDeps): ManagerRunner {
  const fallback: ManagerRunner = deps.fallback ?? { start: runAgent, resume: resumeAgent };
  const warn = deps.onWarning ?? ((message: string) => console.warn(`[pi-subagents] ${message}`));
  /**
   * Live panes in this process, so each new one lands a step lower than the last
   * (`paneBoundsForIndex`). A settled run gives its place back, because its
   * capsule is gone by then.
   */
  const live = new Set<symbol>();
  /**
   * What `resume()` needs and a `RunHandle` does not carry: the handle it was
   * given, and the inputs its child was launched with. Keyed by the handle, so a
   * handle from another runner is simply not here and falls through to it.
   */
  const states = new WeakMap<RunHandle, RunState>();
  /**
   * Runs this runner can close but the manager cannot reach yet — see
   * {@link InFlightRun}. Keyed by the agent id the run was launched for.
   */
  const inFlight = new Map<string, InFlightRun>();

  /**
   * Run this agent in-process instead, saying so on the result as well as out
   * loud.
   *
   * The warning reaches a user who is watching; the record field reaches
   * everyone else — a later reader of the record, and the tool result that
   * reports the run — because "this agent has no pane" is a fact about where
   * it ran, not a transient hiccup.
   */
  const inProcess = async (
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: RunOptions,
    reason: string,
  ): Promise<RunResult> => {
    warn(`agent "${options.description ?? type}" ${reason}; running it in-process instead`);
    return { ...(await fallback.start(ctx, type, prompt, options)), paneFallback: reason };
  };

  const start: RunStart = async (ctx, type, prompt, options) => {
    const composed = await compose(deps, ctx, type, prompt, options);
    if ("fallback" in composed) {
      // The child's own inputs could not be built — no model to name, or a
      // schema it could not be trusted to apply — so there is nothing to
      // launch. In-process is the honest answer: it is a run that works, and
      // the reason travels on the result as well as to the user.
      return inProcess(ctx, type, prompt, options, composed.fallback);
    }
    const { inputs } = composed;
    // Registered BEFORE the launch: that is the window in which a pane exists and
    // the manager has no handle for it yet, so a quit there would leave a live
    // child in an orphan pane.
    const run = trackRun(inFlight, inputs.agentId, inputs.label);
    try {
      // The place in the cascade is taken BEFORE the launch, not after: two
      // spawns that both read the size while their panes are being created would
      // be handed the same bounds and stack on top of each other.
      const ticket = Symbol(inputs.agentId);
      live.add(ticket);
      const pane = await launchPane({
        deps: paneDeps(deps),
        label: inputs.label,
        command: childCommand(inputs, deps),
        cwd: inputs.cwd,
        index: live.size - 1,
      });
      if (pane === undefined) {
        live.delete(ticket);
        return inProcess(ctx, type, prompt, options, "could not get a pane (creating it failed)");
      }
      return await watch({ deps, warn, live, states, inputs, pane, options, ticket, run });
    } finally {
      // Both a no-op when `watch()` already registered the way out, and the
      // reason a run that threw before it got that far cannot strand a dispose.
      run.settle();
      inFlight.delete(inputs.agentId);
    }
  };

  const resume: RunResume = async (session, prompt, options) => {
    const state = states.get(session);
    if (state === undefined) {
      // A handle this runner did not create: an in-process session whose record
      // is being resumed, which its own runner knows how to continue.
      return fallback.resume(session, prompt, options);
    }
    return relaunch({ deps, warn, live, inFlight, state, prompt, options: options ?? {} });
  };

  /**
   * End a run this runner started, and resolve once its layer is closed.
   *
   * This is the half of a run that no other part of the parent can do: a pane
   * child is a real process in a layer of its own, and a parent that exits
   * without closing the layer leaves it running in an orphan pane. The manager
   * calls this from `dispose()`, after aborting the record — an abort is what
   * makes the run stop, and this is what proves the pane is gone.
   *
   * Idempotent, because the settle path closes the same layer: the promise is
   * memoized per run, so a dispose that races a settle joins it rather than
   * asking Rex twice. A run still in `inFlight` (a resume whose new pane is
   * being created) is closed through its register instead, so the close lands on
   * the pane that actually exists rather than the one that was replaced.
   */
  const close = async (session: RunHandle): Promise<void> => {
    const state = states.get(session);
    // Not ours: an in-process handle, or a run another runner owns.
    if (state === undefined) return;
    const unclosed = await closeRun(state, inFlight.get(state.inputs.agentId), paneDeps(deps));
    if (unclosed !== undefined) reportUnclosed(warn, state.inputs.label, unclosed);
  };

  /**
   * Close every pane this runner still has open and resolve when they are gone.
   *
   * The manager's own lever on a run is its record's handle, which the pane path
   * announces only after the child's session file is found. `close(session)`
   * therefore cannot see a run in that window — and neither can it see a run whose
   * launch never got that far — so the shutdown path drains this register too.
   * Best-effort per pane: one that will not close is reported and does not stop
   * the rest.
   */
  const closeAll = async (): Promise<void> => {
    const runs = [...inFlight.values()];
    await Promise.all(
      runs.map(async (run) => {
        const unclosed = await closeRun(undefined, run, paneDeps(deps));
        if (unclosed !== undefined) reportUnclosed(warn, run.label, unclosed);
      }),
    );
  };

  return { start, resume, close, closeAll };
}

/**
 * The way out of one run, once it has a pane to close.
 *
 * A thunk rather than the ids, because a resume replaces the pane: the close has
 * to read whichever pane the run has when somebody asks, not the one it had when
 * the thunk was made. `options.timeoutMs` is for the shutdown path.
 */
type CloseThunk = (options?: { timeoutMs?: number }) => Promise<CloseResult>;

/**
 * One run between "its pane exists" and "its layer is closed".
 *
 * The manager's only handle is `record.session`, assigned when `watch()`
 * announces the run — which waits for the child's session file, up to
 * `SESSION_FILE_GRACE_MS` after the pane was created. A quit inside that window
 * would neither stop the child nor close the layer, so the runner keeps its own
 * register: created before the launch, resolved with the close thunk as soon as
 * there is one, and walked by `closeAll()`.
 */
interface InFlightRun {
  /** The pane label, for a report that cannot name a record. */
  label: string;
  /** Resolves with this run's way out, or with undefined when it has no pane. */
  closable: Promise<CloseThunk | undefined>;
  /** Resolve {@link closable}, once. */
  settle(close?: CloseThunk): void;
}

/**
 * Register a run that is about to create a pane.
 *
 * `settle()` is idempotent, so a caller can call it unconditionally in its
 * `finally`: the first resolution wins, and no dispose is left waiting for a run
 * that fell through to in-process, threw, or already said how to close itself.
 */
function trackRun(inFlight: Map<string, InFlightRun>, agentId: string, label: string): InFlightRun {
  let resolve!: (close: CloseThunk | undefined) => void;
  const closable = new Promise<CloseThunk | undefined>((settle) => {
    resolve = settle;
  });
  let settled = false;
  const run: InFlightRun = {
    label,
    closable,
    settle(close) {
      if (settled) return;
      settled = true;
      resolve(close);
    },
  };
  inFlight.set(agentId, run);
  return run;
}

/**
 * Close one run: through its register when it has one, else through its state.
 *
 * Returns the failure to report, or undefined when the pane is gone (or never
 * existed). Deliberately not called by the settle and abort paths, which close
 * directly and treat the same failure as the ordinary end of a run — by then the
 * child is gone and the pane usually with it, so the only path where a failed
 * close means a live orphan is this one.
 */
async function closeRun(
  state: RunState | undefined,
  run: InFlightRun | undefined,
  deps: PaneDeps,
): Promise<CloseResult | undefined> {
  const close = run === undefined ? undefined : await run.closable;
  if (close !== undefined) return await close({ timeoutMs: SHUTDOWN_CLOSE_TIMEOUT_MS });
  if (state === undefined) return undefined;
  return await closeRunPane(deps, state, { timeoutMs: SHUTDOWN_CLOSE_TIMEOUT_MS });
}

/**
 * Say so when a pane would not close at shutdown.
 *
 * Only the shutdown path reports this: there, a layer that is still open means a
 * child that outlives its parent, and nobody will look again.
 */
function reportUnclosed(warn: (message: string) => void, label: string, result: CloseResult): void {
  if (result.closed) return;
  warn(`the pane for "${label}" could not be closed (${result.reason}); its child may still be running`);
}

/** Everything the child is launched with, resolved once per spawn. */
interface RunInputs {
  label: string;
  type: SubagentType;
  /** The parent's durable id for this agent; also the child's pi session id. */
  agentId: string;
  /** The child's working directory — the pane block's `cwd`. */
  cwd: string;
  /** Where `.pi` config was discovered, which is also where the child's files live. */
  configCwd: string;
  files: ChildFiles;
  spec: ChildSpec;
  /** The composed system prompt, rewritten byte for byte on a resume. */
  systemPrompt: string;
  agentConfig: AgentConfig | undefined;
  isolated: boolean | undefined;
  resolved: ResolvedResources;
  model: NonNullable<RunOptions["model"]>;
  thinkingFlag: string[];
  projectTrusted: boolean;
  /**
   * The child's `--name`: the record's handle, or the type when a run has
   * none (a nested child), exactly as the pane label names it.
   */
  name: string;
  /**
   * An existing session file the child must open instead of starting a new
   * conversation (`RunOptions.resumeSessionFile`) — the reopen paths for a
   * record that was swept out of memory. A relaunch passes its own file
   * instead (see `childCommand()`).
   */
  resumeSessionFile?: string;
}

/** The live state of one pane-backed run. */
interface RunState {
  inputs: RunInputs;
  /** The pane currently running this agent; a resume replaces it. */
  pane: PaneHandle;
  tail: SessionTail;
  /** The child's own pi session file, as far as it is known; a resume reuses it. */
  sessionFile: string;
  /**
   * The promise of this run's layer closing, created once.
   *
   * An abort and the settle path both want the layer gone, and a dispose that
   * races them wants to wait for it — so the close is started once and every
   * caller waits on the same promise rather than asking Rex twice. The result
   * carries whether the layer is in fact gone, which only the shutdown path
   * reports (see `reportUnclosed()`).
   */
  closing?: Promise<CloseResult>;
}

// ---------------------------------------------------------------------------
// Composing the child
// ---------------------------------------------------------------------------

/**
 * What `compose()` produced: the child's inputs, or the reason this run cannot
 * be a pane child at all.
 *
 * A fallback is a run the caller turns into an in-process one, with a warning
 * that says what happened. Both reasons are about the child's *inputs* — no
 * model to name it with, a schema it could not be handed — not about Rex:
 * everything that can go wrong later is reported where it happens.
 */
type Composed = { inputs: RunInputs } | { fallback: string };

/** Resolve everything a child needs from the parent's spawn options. */
async function compose(
  deps: PaneRunDeps,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<Composed> {
  const agentConfig = getAgentConfig(type);
  const cwd = options.cwd ?? ctx.cwd;
  const configCwd = options.configCwd ?? cwd;
  const model = options.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig?.model);
  if (model === undefined) return { fallback: "could not be given a model for its pane" };

  const isolated = options.isolated;
  const thinking = options.thinkingLevel ?? agentConfig?.thinking;
  const agentId = options.agentId ?? type;
  // The runner's own root session is the fallback, not this `ctx`'s: the
  // transcript store this runner writes to is keyed by the former, and a
  // grandchild's `ctx` is its own session rather than the cascade's root.
  const rootSessionId = options.rootSessionId ?? deps.rootSessionId;
  const taskDir = sessionTaskDir(configCwd, rootSessionId);
  // The schema travels as a file: the child recompiles it with the same
  // validator the parent used, so `agent({ schema })` behaves in a pane exactly
  // as it does in-process.
  const schemaPath = options.structuredOutput ? join(taskDir, agentId, "schema.json") : undefined;
  if (schemaPath !== undefined && options.structuredOutput !== undefined) {
    // Written here, before anything is launched, so a schema that will not
    // survive the round trip falls back in-process instead of leaving the
    // child without the tool its caller asked for.
    const problem = writeStructuredSchema(schemaPath, options.structuredOutput);
    if (problem !== undefined) {
      return { fallback: `could not be handed its structured-output schema (${problem})` };
    }
  }

  const spec = childSpecFromSpawn({
    agentId,
    rootSessionId,
    // `nestedRuntime` is what the manager already passes for the in-process
    // loop; the depth cap has to cross the process boundary or a fresh child
    // would reset recursion.
    depth: options.nestedRuntime?.depth ?? 1,
    maxSubagentDepth: options.nestedRuntime?.maxSubagentDepth ?? getMaxSubagentDepth(),
    agentConfig,
    type,
    cwd,
    configCwd: options.configCwd,
    isolated,
    maxTurns: options.maxTurns,
    structuredSchemaPath: schemaPath,
    model: describeModel(model).modelId,
    thinking: thinking ?? "",
    pane: { sessionId: deps.sessionId, windowId: deps.windowId },
  });

  const systemPrompt = await systemPromptFor({ type, cwd, configCwd, agentConfig, spec }, ctx, options);
  // An inherited parent conversation travels with the task, exactly as
  // `runAgent()` prepends it: the child sees the same text on both paths, and
  // the file it receives is the whole of what the parent said.
  const task = taskFor(ctx, prompt, options.inheritContext);
  const files = writeChildFiles({ taskDir, systemPrompt, prompt: task, spec });
  mkdirSync(deps.agentSessionDir, { recursive: true });

  const inputs: RunInputs = {
    label: labelFor(options.handle ?? type, options.description ?? prompt),
    type,
    agentId,
    cwd,
    configCwd,
    files,
    spec,
    systemPrompt,
    agentConfig,
    isolated,
    resolved: resolvedResources(options.pi, configCwd, agentConfig),
    model,
    thinkingFlag: thinking === undefined ? [] : ["--thinking", thinking],
    // The parent's answer, narrowed to the directories it actually covers: a
    // child pointed at another repo is `-na`, not given a free pass for that
    // repo's project-local `.pi` files.
    projectTrusted: childMayTrustProject({
      parentTrusted: ctx.isProjectTrusted(),
      // The parent's own directory — the project the user was actually asked
      // about — not the config root, which a bare `cwd:` spawn moves with it.
      projectRoot: ctx.cwd,
      childCwd: cwd,
      // A worktree spawn is the parent's own copy of its project.
      projectCopy: options.worktreeBase !== undefined,
    }),
    name: options.handle ?? type,
  };
  if (options.resumeSessionFile !== undefined) inputs.resumeSessionFile = options.resumeSessionFile;
  return { inputs };
}

/**
 * The task text the child receives.
 *
 * `inherit_context` prepends the parent's conversation on both paths, and the
 * same builder produces it, so a pane child reads exactly what an in-process one
 * would have been prompted with. Empty context (a fresh session) adds nothing,
 * rather than an empty heading.
 */
function taskFor(ctx: ExtensionContext, prompt: string, inheritContext: boolean | undefined): string {
  if (!inheritContext) return prompt;
  const parentContext = buildParentContext(ctx);
  return parentContext === "" ? prompt : parentContext + prompt;
}

/**
 * The argv that runs the child under the launcher's documented form.
 *
 * `sessionFile` is a relaunch's own transcript and wins over the inputs': a
 * resume continues the conversation the run actually had, which is not always
 * the one the spawn was pointed at.
 */
function childCommand(inputs: RunInputs, deps: PaneRunDeps, sessionFile?: string): string[] {
  return buildChildCommand({
    files: inputs.files,
    spec: inputs.spec,
    agentConfig: inputs.agentConfig,
    isolated: inputs.isolated,
    resolved: inputs.resolved,
    piBinary: deps.piBinary,
    // Always explicit: `-ne`, or an allowlist that omits the provider's own
    // extension, makes `--provider` unresolvable, so it can never be inferred.
    modelFlag: ["--provider", inputs.model.provider, "--model", inputs.model.id],
    thinkingFlag: inputs.thinkingFlag,
    // The child's own tool scope is applied by child mode from the spec, so no
    // `--tools` allowlist is passed: two sources of truth for one scope is how
    // they come to disagree.
    toolFlags: [],
    agentSessionDir: deps.agentSessionDir,
    projectTrusted: inputs.projectTrusted,
    name: inputs.name,
    sessionFile: sessionFile ?? inputs.resumeSessionFile,
  });
}

/**
 * The system prompt the child starts with, composed the way `runAgent()` composes
 * it.
 *
 * Two deliberate differences, both consequences the design records rather than
 * drifts: a skill named by `skills: [a, b]` is loaded as a skill (`--skill`)
 * instead of having its text pasted into the prompt, and `config_cwd` cannot be
 * reproduced at all (child mode warns about it once per spawn).
 */
async function systemPromptFor(
  inputs: Pick<RunInputs, "type" | "cwd" | "configCwd" | "agentConfig" | "spec">,
  ctx: ExtensionContext,
  options: RunOptions,
): Promise<string> {
  // An unknown type resolves to general-purpose, exactly as the in-process
  // fallback does — the parent prompt then flows in through `prompt_mode: append`.
  const promptConfig: AgentConfig = {
    ...getConfig(inputs.type),
    name: inputs.type,
    systemPrompt: inputs.agentConfig?.systemPrompt ?? "",
  };
  const env = await detectEnv(options.pi, inputs.cwd);
  const extras: PromptExtras = {};
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;
  if (options.workflow && options.structuredOutput === undefined) extras.workflowChild = true;
  // Persistent memory rides in the prompt on both paths: it is a file the agent
  // is told about, not something pi can be handed by flag.
  const memory = inputs.agentConfig?.memory;
  if (memory) {
    // The *effective* scope, not the type's raw `tools:` list: the spec already
    // carries the memory widening `runAgent()` applies before it chooses this
    // block, and the denylist still binds. An agent whose `write` is disallowed
    // must be told to read memory, not handed a block that tells it to write
    // files it cannot write.
    const denied = new Set(inputs.spec.toolScope.excludeTools);
    const tools = new Set(inputs.spec.toolScope.tools.filter((name) => !denied.has(name)));
    // The agent's own name, as the in-process path passes it: a memory block
    // headed with the type would file a named agent's notes under the wrong
    // heading.
    const name = inputs.agentConfig?.name ?? inputs.type;
    extras.memoryBlock =
      tools.has("write") || tools.has("edit")
        ? buildMemoryBlock(name, memory, inputs.configCwd)
        : buildReadOnlyMemoryBlock(name, memory, inputs.configCwd);
  }
  return buildAgentPrompt(promptConfig, inputs.cwd, env, ctx.getSystemPrompt(), extras);
}

/**
 * What the child's confinement flags need to know about the parent's discovery.
 *
 * The parent's loaded tools are the only enumeration of its extensions a pane
 * runner can reach, so an extension that registers no tool is invisible here; it
 * is also invisible to `ext:` selectors and `exclude_extensions`, which match by
 * name, so the mapping still agrees with the in-process loader for everything an
 * agent file can name. Skills are looked up by the same discovery that preloads
 * them in-process, one step before reading them.
 */
function resolvedResources(pi: ExtensionAPI, cwd: string, agentConfig: AgentConfig | undefined): ResolvedResources {
  const extensionPaths = new Map<string, string>();
  let codemodeAutoLoads = false;
  let toolSearchAutoLoads = false;
  for (const tool of pi.getAllTools()) {
    if (tool.name === CODEMODE_TOOL) codemodeAutoLoads = true;
    if (tool.name === TOOL_SEARCH_TOOL) toolSearchAutoLoads = true;
    const path = tool.sourceInfo?.path;
    // `builtin:read` and `<inline:…>` name no file, and `-e` takes a file.
    if (typeof path !== "string" || path === "" || path.startsWith("builtin:") || path.startsWith("<")) continue;
    for (const name of extensionCanonicalNames(path)) extensionPaths.set(name, path);
  }
  const skillPaths = new Map<string, string>();
  if (Array.isArray(agentConfig?.skills)) {
    for (const name of agentConfig.skills) {
      const path = findSkillPath(name, cwd);
      if (path !== undefined) skillPaths.set(name, path);
    }
  }
  return { cwd, extensionPaths, skillPaths, codemodeAutoLoads, toolSearchAutoLoads };
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/**
 * Watch one launched pane until the run settles.
 *
 * The order matters: the handle is announced before the race starts, so anything
 * that steers or reads the run has a session to do it through; the result file
 * and the exit race each other; and the layer is closed in a `finally`, which is
 * the only place that runs on every outcome.
 */
async function watch(args: {
  deps: PaneRunDeps;
  warn: (message: string) => void;
  live: Set<symbol>;
  states: WeakMap<RunHandle, RunState>;
  inputs: RunInputs;
  pane: PaneHandle;
  options: RunOptions;
  /** This run's place in the cascade, taken before the launch; given back when it settles. */
  ticket: symbol;
  /** The register a shutdown reaches this run through before it has a handle. */
  run: InFlightRun;
}): Promise<RunResult> {
  const { deps, warn, live, states, inputs, pane, options, ticket, run } = args;
  const paneDepsHere = paneDeps(deps);
  reportMinimize(warn, inputs, pane);

  // A reopened conversation is a file the parent already knows, and the child is
  // told to append to it (`--session <file>`), so nothing is discovered: a
  // guess at a fresh path would leave the live view watching a file the child
  // never writes, and the handle naming it.
  const known = inputs.resumeSessionFile;
  const location =
    known !== undefined
      ? { file: known, found: true }
      : await findSessionFile(deps.agentSessionDir, inputs.agentId);
  const tail = new SessionTail(location.file);
  const state: RunState = { inputs, pane, tail, sessionFile: location.file };
  const session = new PaneSession({
    tail,
    steer: (message) => steerPane(paneDepsHere, state, message),
    abort: async () => {
      await closeRunPane(paneDepsHere, state);
    },
  });
  states.set(session, state);
  // The pane exists and the manager has no handle for it yet: this is the way a
  // shutdown closes it. Registered before the handle is announced, deliberately.
  run.settle((options) => closeRunPane(paneDepsHere, state, options));
  // A child slower than the grace window writes its file later, and the path
  // this run announced is a guess until it does: keep looking, so the live view
  // fills in and the handle names the file the child actually wrote.
  const stopFollow =
    location.found
      ? () => {}
      : followSessionFile(deps.agentSessionDir, inputs.agentId, (file) => {
          // Only once the tail is actually reading it: a record that named a file
          // the live view was not following would be worse than one that named
          // the path it was still waiting for.
          if (tail.retarget(file)) state.sessionFile = file;
        });
  tail.start();
  const stopActivity = feedActivity(tail, options, false);

  const stop = runStop();
  let aborted = options.signal?.aborted === true;
  const unlisten = forwardAbort(options.signal, () => {
    aborted = true;
    // Closing the layer ends the child, which is what an abort means here: the
    // run is stopped rather than interrupted mid-tool-call.
    void closeRunPane(paneDepsHere, state);
  });

  options.onSessionCreated?.(session);
  try {
    const outcome = await firstOutcome({
      deps: paneDepsHere,
      warn,
      inputs,
      blockId: state.pane.blockId,
      stop,
    });
    if ("exitCode" in outcome) {
      // The child is gone. A result file the poll had not noticed yet is still
      // the answer: the child writes it before it shuts down.
      const late = readResultFile(inputs.spec.resultPath);
      if (late !== undefined) return runResult(late, session, aborted);
      if (aborted) return { responseText: lastAssistantText(session), session, aborted: true, steered: false };
      throw new Error(await exitFailureMessage(paneDepsHere, state.pane.blockId, outcome.exitCode, session));
    }
    return runResult(outcome, session, aborted);
  } finally {
    stop.requested = true;
    stop.cancel.abort();
    stopActivity();
    unlisten();
    stopFollow();
    tail.stop();
    live.delete(ticket);
    await closeRunPane(paneDepsHere, state);
  }
}

/**
 * Relaunch a settled pane run on its own session file.
 *
 * The record's handle is reused, not replaced: it is the same conversation, and
 * the viewer's Markdown cache and the fleet list are keyed off it. What changes is
 * which pane is running the child, so the handle's injected verbs read the
 * current pane rather than the first one. `PaneSession.prompt()` rejects by
 * design — a pane child is a one-shot process, and resuming means starting
 * another on the same transcript.
 *
 * Unlike `start()`, a resume that cannot get a pane **throws**: the record was
 * already settled, its transcript is on disk, and re-running the agent from
 * scratch in-process would answer a different question than "continue that
 * conversation". `start()` can fall back because nothing has happened yet; here
 * something has, and the caller has to be told it was not continued.
 */
async function relaunch(args: {
  deps: PaneRunDeps;
  warn: (message: string) => void;
  live: Set<symbol>;
  inFlight: Map<string, InFlightRun>;
  state: RunState;
  prompt: string;
  options: ResumeAgentOptions;
}): Promise<ResumeAgentResult> {
  const { deps, warn, live, inFlight, state, prompt, options } = args;
  const paneDepsHere = paneDeps(deps);
  const { inputs } = state;

  // This child answers into its own result file, and the previous run's is still
  // there: leaving it would settle the resume before the child had started.
  rmSync(inputs.spec.resultPath, { force: true });
  // Only the task changes. The spec, the system prompt and the confinement stay
  // as the agent type was resolved for this record.
  const files = writeChildFiles({
    taskDir: sessionTaskDir(inputs.configCwd, inputs.spec.rootSessionId),
    systemPrompt: inputs.systemPrompt,
    prompt,
    spec: inputs.spec,
  });
  // Registered before the launch, as a spawn is: between the new layer existing and
  // `state.pane` naming it, a close would otherwise close the pane this resume has
  // just replaced.
  const run = trackRun(inFlight, inputs.agentId, inputs.label);
  try {
    // The cascade slot is taken before the launch, for the same reason as on a
    // spawn: a resume that read the size while its pane was being made would be
    // handed the bounds its neighbour already took.
    const ticket = Symbol(inputs.agentId);
    live.add(ticket);
    const pane = await launchPane({
      deps: paneDepsHere,
      label: inputs.label,
      command: childCommand({ ...inputs, files }, deps, state.sessionFile),
      cwd: inputs.cwd,
      index: live.size - 1,
    });
    if (pane === undefined) {
      live.delete(ticket);
      throw new Error(`the pane for "${inputs.label}" could not be created; the agent was not resumed`);
    }
    reportMinimize(warn, inputs, pane);
    state.pane = pane;
    // A new layer, so a new close: the previous run's promise has settled.
    state.closing = undefined;
    run.settle((options) => closeRunPane(paneDepsHere, state, options));
    return await relaunchWatch({ deps, warn, live, inputs, state, options, ticket });
  } finally {
    run.settle();
    inFlight.delete(inputs.agentId);
  }
}

/**
 * Watch a relaunched pane until it settles.
 *
 * Split from `relaunch()` so the launch, the register and the watch share one
 * `finally`: a resume that threw between the two would otherwise leave a pane
 * open that nothing in this process names.
 */
async function relaunchWatch(args: {
  deps: PaneRunDeps;
  warn: (message: string) => void;
  live: Set<symbol>;
  inputs: RunInputs;
  state: RunState;
  options: ResumeAgentOptions;
  ticket: symbol;
}): Promise<ResumeAgentResult> {
  const { deps, warn, live, inputs, state, options, ticket } = args;
  const paneDepsHere = paneDeps(deps);
  // The child appends to the same file, so the same tail keeps following it, and
  // what is already there belongs to the previous run.
  state.tail.start();
  const stopActivity = feedActivity(state.tail, options, true);

  const stop = runStop();
  // Recorded here for the same reason `watch()` records it: an aborted resume
  // ends when the layer closes, so its child exits without ever writing a
  // result file — and that is a stop, not a crash.
  let aborted = options.signal?.aborted === true;
  const unlisten = forwardAbort(options.signal, () => {
    aborted = true;
    void closeRunPane(paneDepsHere, state);
  });
  try {
    const outcome = await firstOutcome({
      deps: paneDepsHere,
      warn,
      inputs,
      blockId: state.pane.blockId,
      stop,
    });
    if ("exitCode" in outcome) {
      const late = readResultFile(inputs.spec.resultPath);
      if (late !== undefined) return { text: late.text, failure: late.failure };
      // A stopped run has nothing to report and nothing to throw: the caller
      // asked for it to end, and the manager keeps its own "stopped" status.
      if (aborted) return { text: lastAssistantText(state.tail) };
      const message = await exitFailureMessage(paneDepsHere, state.pane.blockId, outcome.exitCode, state.tail);
      throw new Error(message);
    }
    return { text: outcome.text, failure: outcome.failure };
  } finally {
    stop.requested = true;
    stop.cancel.abort();
    stopActivity();
    unlisten();
    state.tail.stop();
    live.delete(ticket);
    await closeRunPane(paneDepsHere, state);
  }
}

// ---------------------------------------------------------------------------
// Watching: the result file, the exit, and the child's own session
// ---------------------------------------------------------------------------

/**
 * What a watching loop is asked to stop: a flag to check, and a controller for
 * the `rex` call already in flight.
 *
 * The flag alone would end the loop but leave a `rex wait` running — up to its
 * whole 30 s window for a run the result file settled in 200 ms. Aborting the
 * call is what makes "this run is over" true outside this process too.
 */
interface RunStop {
  requested: boolean;
  cancel: AbortController;
}

function runStop(): RunStop {
  return { requested: false, cancel: new AbortController() };
}

/**
 * Whichever comes first: the child's result file, or its exit.
 *
 * The two are genuinely independent — a child can write its result and keep
 * running, or die without writing one — so both are watched and the winner
 * decides how the run settles. `stop` is the caller's flag, set in its `finally`;
 * everything watching checks it, so a run that settled one way leaves nothing
 * running the other way.
 */
function firstOutcome(args: {
  deps: PaneDeps;
  warn: (message: string) => void;
  inputs: RunInputs;
  blockId: string;
  stop: RunStop;
}): Promise<PaneRunResult | { exitCode: number | null }> {
  return Promise.race([
    waitForResult(args.inputs.spec.resultPath, args.stop),
    watchExit(args.deps, args.blockId, args.warn, args.inputs, args.stop).then((exitCode) => ({ exitCode })),
  ]);
}

/**
 * The result file, as soon as the child writes it.
 *
 * A poll rather than `fs.watch`: the file appears by rename, so there is nothing
 * to watch before it exists, and one `readFileSync` attempt per tick is cheaper
 * than a watcher per running agent. The timer clears itself the moment the run
 * stops caring, which is how an exit-settled run leaves no interval behind.
 */
function waitForResult(resultPath: string, stop: RunStop): Promise<PaneRunResult> {
  return new Promise<PaneRunResult>((resolve) => {
    const tick = () => {
      if (stop.requested) {
        clearInterval(timer);
        return;
      }
      const parsed = readResultFile(resultPath);
      if (parsed === undefined) return;
      clearInterval(timer);
      resolve(parsed);
    };
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    // Never the reason the parent process stays alive.
    timer.unref();
    tick();
  });
}

/**
 * The child's exit status, from `rex wait` with the process read as the fallback.
 *
 * `wait --json` answers with the `child_exited` payload and exits with the child's
 * own status (measured), so a payload is a definite answer. Anything else is not:
 * an expired `--for` window, and a server that stopped answering, both mean
 * "nothing observable yet" — never "still running" — so the loop keeps asking and
 * lets the result-file race end the run.
 *
 * A block that is not found is the one final non-answer: `exit.on_completion`
 * closes a pane with its child, so a pane that is gone has taken its exit status
 * with it. `null` says exactly that, and the caller reports an unobservable
 * status rather than inventing one.
 *
 * The wait is cancelled through the run's own stop, so a run that settled from
 * its result file is left with no `rex` process of its own.
 */
async function watchExit(
  deps: PaneDeps,
  blockId: string,
  warn: (message: string) => void,
  inputs: RunInputs,
  stop: RunStop,
): Promise<number | null> {
  let warned = false;
  for (;;) {
    if (stop.requested) return null;
    const waited = await deps.exec(
      ["wait", "-s", deps.sessionId, blockId, "--json", "--for", `${WAIT_WINDOW_MS}ms`],
      { timeoutMs: WAIT_TIMEOUT_MS, signal: stop.cancel.signal },
    );
    if (stop.requested) return null;
    const code = replyBody(waited)?.exit_code;
    if (typeof code === "number") return code;

    // The fallback read: `rex wait` not answering is not the same as the child
    // still running, and `last_exit` is the other way to learn the status.
    const state = await readProcessState(deps, blockId);
    if (state.lastExit !== null) return state.lastExit;
    if (paneIsGone(waited)) return null;

    if (!warned) {
      warned = true;
      warn(
        `the pane for "${inputs.label}" could not be reached while watching it` +
        ` (${failureReason(waited.stderr, `rex exited with status ${waited.code}`)});` +
          " the run will be settled from the child's result file",
      );
    }
    if (stop.requested) return null;
    await delay(EXIT_POLL_INTERVAL_MS);
  }
}

/**
 * The part of the child's result this runner acts on.
 *
 * Deliberately narrower than `ChildRunResult`, the file's full contract. The
 * child also reports `usage`, `model`, `thinkingLevel`, `turns` and
 * `sessionFile`, and this runner already has a live source for every one of them:
 * the session tail feeds the manager's usage and turn counts message by message,
 * and the file it reads is the handle's `sessionFile`. Reading them here as well
 * would make two sources for the same figures, which is how two sources come to
 * disagree. `text`, `failure`, `aborted` and `steered` exist nowhere else — the
 * run's own outcome is only in this file.
 */
type PaneRunResult = Pick<ChildRunResult, "text" | "aborted" | "steered"> &
  Partial<Pick<ChildRunResult, "failure" | "structuredJson" | "structuredRetried">>;

/**
 * The result the child wrote, or undefined when there is nothing to read yet.
 *
 * Tolerant by contract: `failure`, `structuredJson` and `structuredRetried` are
 * absent whenever the child had nothing to say, so every one of them is optional
 * and nothing here may require the file to be complete. A half-written file (a
 * rename that has not landed, a hand edit) reads as "not yet", which is also what
 * a poll wants.
 */
function readResultFile(path: string): PaneRunResult | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  // `text` is the one key the child always writes, so its absence means this is
  // not a result file at all rather than an empty answer.
  if (typeof record.text !== "string") return undefined;
  const result: PaneRunResult = {
    text: record.text,
    aborted: record.aborted === true,
    steered: record.steered === true,
  };
  if (typeof record.failure === "string") result.failure = record.failure;
  if (typeof record.structuredJson === "string") result.structuredJson = record.structuredJson;
  if (record.structuredRetried === true) result.structuredRetried = true;
  return result;
}

/** The child's report as the manager's `RunResult`. */
function runResult(child: PaneRunResult, session: PaneSession, aborted: boolean): RunResult {
  return {
    responseText: child.text,
    session,
    // Either the child stopped itself at its hard turn limit, or the parent
    // aborted the run; the manager keeps its own "stopped" status for the second.
    aborted: child.aborted || aborted,
    steered: child.steered,
    failure: child.failure,
    structuredJson: child.structuredJson,
    structuredRetried: child.structuredRetried,
  };
}

/**
 * What a run that ended with no result file reports instead.
 *
 * Built from the exit status and whatever the child had said by then: the pane's
 * screen when it is still there (rare — a failing `pi` closes its own pane) and
 * the last assistant message from its session file when it is not. A status that
 * could not be observed is said to be unobservable rather than guessed at.
 */
async function exitFailureMessage(
  deps: PaneDeps,
  blockId: string,
  exitCode: number | null,
  session: RunHandle | SessionTail,
): Promise<string> {
  const status =
    exitCode === null
      ? "an exit status that could not be observed (the pane closed first)"
      : `exit status ${exitCode}`;
  const parts = [`the agent's pi exited with ${status} without writing its result file`];
  const said = lastAssistantText(session);
  if (said !== "") parts.push(`Last message from the child:\n${said}`);
  const screen = await captureTail(deps, blockId);
  if (screen !== "") parts.push(`Last lines in the pane:\n${screen}`);
  return parts.join("\n\n");
}

/** The last assistant text a run holds, for an error report. */
function lastAssistantText(run: RunHandle | SessionTail): string {
  const messages = run instanceof SessionTail ? run.read().messages : run.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = extractText(message.content).trim();
    if (text !== "") return text;
  }
  return "";
}

/**
 * Forward the child's session file into the manager's activity wiring.
 *
 * A file cannot stream: a message reaches it only once it is complete. So the
 * diff is taken on each tail event — a new assistant message is a turn's spend,
 * its turn count and its tool calls; a new tool result closes one — and the
 * tail's `compaction_end` becomes the manager's. `onTextDelta` is deliberately
 * never called: there are no deltas in a file, and inventing them would put the
 * same text on screen twice.
 *
 * `skipExisting` is for a resume: what the file already holds belongs to the
 * previous run, whose usage the record already counted.
 */
function feedActivity(
  tail: SessionTail,
  options: Pick<RunOptions, "onAssistantUsage" | "onToolActivity" | "onTurnEnd" | "onCompaction">,
  skipExisting: boolean,
): () => void {
  let seen = skipExisting ? tail.read().messages.length : 0;
  let turns = seen === 0 ? 0 : countTurns(tail.read().messages);
  const sync = () => {
    const snapshot = tail.read();
    for (; seen < snapshot.messages.length; seen++) {
      const message = snapshot.messages[seen];
      if (message.role === "assistant") {
        options.onAssistantUsage?.(lifetimeUsageOf(message.usage));
        for (const block of message.content) {
          if (block.type === "toolCall") options.onToolActivity?.({ type: "start", toolName: block.name });
        }
        turns++;
        options.onTurnEnd?.(turns);
      } else if (message.role === "toolResult") {
        options.onToolActivity?.({ type: "end", toolName: message.toolName });
      }
    }
  };
  sync();
  const unsubscribe = tail.subscribe((event) => {
    if (event.type === "compaction_end" && !event.aborted && event.result !== undefined) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
    sync();
  });
  return () => {
    unsubscribe();
    // One last look, for a child that settled between two ticks.
    sync();
  };
}

/** How many completed assistant turns a run's messages hold. */
function countTurns(messages: RunHandle["messages"]): number {
  let turns = 0;
  for (const message of messages) if (message.role === "assistant") turns++;
  return turns;
}

/** One assistant message's spend, in the units the manager accumulates. */
function lifetimeUsageOf(usage: unknown): LifetimeUsage {
  const record = (typeof usage === "object" && usage !== null ? usage : {}) as Record<string, unknown>;
  const cost = record.cost as { total?: unknown } | undefined;
  const count = (key: string) => (typeof record[key] === "number" ? (record[key] as number) : 0);
  return {
    input: count("input"),
    output: count("output"),
    cacheWrite: count("cacheWrite"),
    cacheRead: count("cacheRead"),
    cost: typeof cost?.total === "number" ? cost.total : 0,
  };
}

// ---------------------------------------------------------------------------
// Reaching the pane: steer, close
// ---------------------------------------------------------------------------

/**
 * Type a message into the child's pane.
 *
 * Refused unless the child's own program status says it is taking input, and
 * "taking input" is a whitelist: `working` and `idle` only. A `pi` at a dialog
 * ("password", "allow this tool?") reports `blocked` and text typed into one
 * lands in the dialog rather than in the conversation; `done` and `error` are
 * past the point of listening, and any state this runner has never seen is one
 * it cannot vouch for.
 *
 * The refusal is an error the caller reports — `steer_subagent` turns it into
 * the tool's message, and the manager reports a queued steer's refusal through
 * `onWarning` — because a silently dropped steer reads as a delivered one.
 *
 * `steerableState()` is the one wait: a `pi` that has only just started reports
 * no program status at all, and a steer that lands in that window is early, not
 * late.
 */
async function steerPane(deps: PaneDeps, state: RunState, message: string): Promise<void> {
  const blockId = state.pane.blockId;
  const process = await steerableState(deps, blockId);
  if (process.lastExit !== null) {
    throw new Error(`agent "${state.inputs.label}" has already exited; the message was not sent`);
  }
  if (process.status === null) {
    throw new Error(`agent "${state.inputs.label}" is not answering in its pane; the message was not sent`);
  }
  if (!STEERABLE_PROGRAM_STATES.has(process.status)) {
    const why =
      process.status === "blocked"
        ? "is waiting on a prompt in its pane"
        : `reports \`${process.status}\``;
    throw new Error(
      `agent "${state.inputs.label}" ${why} — answer it in the pane, or abort the agent; the message was not sent`,
    );
  }
  if (UNTYPEABLE.test(message)) {
    // A newline submits the prompt in the pane, and every remaining control
    // character either does something to the terminal or changes what `rex`
    // parses — either way the message that lands is not the one that was
    // sent. Refused rather than rewritten: a steer quietly flattened into one
    // line is the same defect as one quietly dropped.
    throw new Error(
      `the steering message for agent "${state.inputs.label}" contains a line break or a control` +
        " character, which a pane cannot take as one prompt; the message was not sent",
    );
  }
  // `--` ends the CLI's option parsing: the message is one positional, and a
  // message that begins with `-` (`-b other`, `--help`) must not be read as
  // another flag for `rex send`.
  const sent = await deps.exec(["send", "-s", deps.sessionId, "-b", blockId, "--", message]);
  if (sent.code !== 0) {
    throw new Error(
      `the steering message could not be typed into the pane: ${failureReason(sent.stderr, `rex exited with status ${sent.code}`)}`,
    );
  }
  // The text arrives without a newline, so it sits on pi's prompt until Enter.
  const entered = await deps.exec(["send-key", "-s", deps.sessionId, "-b", blockId, "enter"]);
  if (entered.code !== 0) {
    throw new Error(
      "the steering message was typed but not submitted: " +
        failureReason(entered.stderr, `rex exited with status ${entered.code}`),
    );
  }
}

/**
 * The states a pane child accepts typed input in.
 *
 * A whitelist, not a blacklist of `blocked`: `working` and `idle` are the two
 * the design allows, `blocked`/`done`/`error` are all refusals, and so is
 * anything a later `pi` invents — a state this runner cannot vouch for is not
 * one to type into.
 */
const STEERABLE_PROGRAM_STATES = new Set(["working", "idle"]);

/**
 * What a typed steer may never carry.
 *
 * `rex send` types its text into a live terminal, so a newline submits the
 * prompt on the spot — a three-line message arrives as three prompts, and the
 * `enter` this runner sends afterwards submits a fourth, empty one. The rest of
 * the C0 controls (and DEL) are equally untypeable: some move the cursor, some
 * are eaten by the terminal, and none of them can be verified from here.
 * Tab is allowed — it is ordinary text in a prompt — and nothing above ASCII
 * is touched, so unicode and emoji steer normally.
 */
const UNTYPEABLE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/**
 * The child's state, waited for while it has reported none at all.
 *
 * Bounded by `STEER_STATUS_GRACE_MS`: a child that never reports is a child
 * this runner cannot reach, and the caller is told so rather than left waiting.
 */
async function steerableState(deps: PaneDeps, blockId: string): Promise<ProcessState> {
  const deadline = Date.now() + STEER_STATUS_GRACE_MS;
  for (;;) {
    const state = await readProcessState(deps, blockId);
    if (state.status !== null || state.lastExit !== null) return state;
    if (Date.now() >= deadline) return state;
    await delay(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/**
 * Close the run's current layer, once.
 *
 * An abort closes the layer and then the settle path closes it again, and a
 * dispose racing either of them wants to know when it is done: so the call is
 * made once and every caller awaits the same promise. A second call would be a
 * wasted round trip and, worse, a second chance to interleave with another
 * agent's pane creation. A resume clears the promise, because its pane is a new
 * one.
 *
 * The first caller's `timeoutMs` is the one that applies — the promise is shared,
 * and a shutdown close is the only caller that asks for a short one.
 */
function closeRunPane(
  deps: PaneDeps,
  state: RunState,
  options: { timeoutMs?: number } = {},
): Promise<CloseResult> {
  state.closing ??= closePane(deps, state.pane.layerId, options);
  return state.closing;
}

/** The pane's session and window, from the runner's own deps. */
function paneDeps(deps: PaneRunDeps): PaneDeps {
  return { exec: deps.exec, sessionId: deps.sessionId, windowId: deps.windowId };
}

/**
 * Tell whoever can tell the user when the pane is on screen instead of in a
 * capsule. Never a failed spawn — the child is running either way — but never
 * silent either: a pane left visible is a window nobody asked for.
 */
function reportMinimize(warn: (message: string) => void, inputs: RunInputs, pane: PaneHandle): void {
  if (pane.minimize.minimized) return;
  warn(
    `the pane for "${inputs.label}" was created but could not be minimized, so it stays visible` +
      ` (${pane.minimize.reason})`,
  );
}

/**
 * The child's session file, as far as it can be known at announcement time.
 *
 * pi names it `<timestamp>_<session id>.jsonl`, so the id is the part that is
 * known before the child writes anything — but the file itself appears lazily,
 * on the child's first turn, which can be well after the pane exists. `found`
 * says which of the two answers this is: the child's real file, or a path it has
 * not written yet (see `followSessionFile()`).
 *
 * The guess is still the right thing to hand a handle: a handle has to name
 * something, and a child that died before writing anything has no other name.
 */
async function findSessionFile(dir: string, agentId: string): Promise<{ file: string; found: boolean }> {
  const deadline = Date.now() + SESSION_FILE_GRACE_MS;
  for (;;) {
    const found = sessionFileIn(dir, agentId);
    if (found !== undefined) return { file: found, found: true };
    if (Date.now() >= deadline) return { file: join(dir, `${agentId}.jsonl`), found: false };
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * Keep looking for the child's session file after the grace window, and hand
 * the path to `onFound` the moment it turns up.
 *
 * Without this, a child slower than `SESSION_FILE_GRACE_MS` leaves the live view
 * permanently empty: the tail is bound to the guessed path for the life of the
 * run, so messages, turns, usage and the last assistant text in an error report
 * all stay blank while the child's real transcript sits beside it unread.
 *
 * Stops itself once it finds the file, and returns the stop (also used by the
 * run's `finally`, so a settled run leaves no interval behind).
 */
function followSessionFile(
  dir: string,
  agentId: string,
  onFound: (file: string) => void,
): () => void {
  const timer = setInterval(() => {
    const found = sessionFileIn(dir, agentId);
    if (found === undefined) return;
    clearInterval(timer);
    onFound(found);
  }, POLL_INTERVAL_MS);
  // Never the reason the parent process stays alive.
  timer.unref();
  return () => clearInterval(timer);
}

/** pi names a session file `<timestamp>_<session id>.jsonl`; the newest one is this run's. */
function sessionFileIn(dir: string, agentId: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const suffix = `_${agentId}.jsonl`;
  const match = entries.filter((name) => name.endsWith(suffix)).sort();
  return match.length === 0 ? undefined : join(dir, match[match.length - 1]);
}

/** The pane label: who it is, then just enough of the task to recognise it. */
function labelFor(handle: string, description: string): string {
  const task = description.replace(/\s+/g, " ").trim();
  const slice =
    task.length > LABEL_DESCRIPTION_CHARS ? `${task.slice(0, LABEL_DESCRIPTION_CHARS - 1).trimEnd()}…` : task;
  return slice === "" ? handle : `${handle} · ${slice}`;
}

/** A `rex` reply body as an object, or undefined when there is none to read. */
function replyBody(result: RexExecResult): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** True when Rex said the block is not there — the exit status went with it. */
function paneIsGone(result: RexExecResult): boolean {
  return /not found/i.test(result.stderr);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** Run `onAbort` when the signal fires. Returns the detach. */
function forwardAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
