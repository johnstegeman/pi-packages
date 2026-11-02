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

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { extractText } from "../context.js";
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
  childSpecFromSpawn,
  closePane,
  launchPane,
  type PaneHandle,
  type ResolvedResources,
  writeChildFiles,
} from "./launcher.js";
import { PaneSession } from "./pane-session.js";
import { captureTail, type PaneDeps, type RexExec, type RexExecResult, readProcessState } from "./rex-cli.js";
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

/** How long the child gets to create its session file before the tail follows a guess. */
const SESSION_FILE_GRACE_MS = 2_000;

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

  const start: RunStart = async (ctx, type, prompt, options) => {
    const inputs = await compose(deps, ctx, type, prompt, options);
    if (inputs === undefined) {
      // No model means no `--provider`/`--model`, and the rule that a child is
      // always told both explicitly has no exception: an in-process run is
      // better than a child that has to guess what it is.
      warn(`agent "${options.description ?? type}" could not be given a model for its pane; running it in-process`);
      return fallback.start(ctx, type, prompt, options);
    }
    const pane = await launchPane({
      deps: paneDeps(deps),
      label: inputs.label,
      command: childCommand(inputs, deps),
      cwd: inputs.cwd,
      index: live.size,
    });
    if (pane === undefined) {
      warn(`the pane for "${inputs.label}" could not be created; running the agent in-process instead`);
      return fallback.start(ctx, type, prompt, options);
    }
    return watch({ deps, warn, live, states, inputs, pane, options });
  };

  const resume: RunResume = async (session, prompt, options) => {
    const state = states.get(session);
    if (state === undefined) {
      // A handle this runner did not create: an in-process session whose record
      // is being resumed, which its own runner knows how to continue.
      return fallback.resume(session, prompt, options);
    }
    return relaunch({ deps, warn, live, state, prompt, options: options ?? {} });
  };

  return { start, resume };
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
}

/** The live state of one pane-backed run. */
interface RunState {
  inputs: RunInputs;
  /** The pane currently running this agent; a resume replaces it. */
  pane: PaneHandle;
  tail: SessionTail;
  /** The child's own pi session file, discovered once and reused by a resume. */
  sessionFile: string;
  /** Set once this run's layer has been closed, so an abort and a settle close it once. */
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Composing the child
// ---------------------------------------------------------------------------

/**
 * Resolve everything a child needs from the parent's spawn options.
 *
 * Undefined means "this run cannot be a pane child", and there is one such case:
 * no `pi` model was resolved, so the command could not name its provider and
 * model. Everything else that can go wrong fails later, where it can be
 * reported.
 */
async function compose(
  deps: PaneRunDeps,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunInputs | undefined> {
  const agentConfig = getAgentConfig(type);
  const cwd = options.cwd ?? ctx.cwd;
  const configCwd = options.configCwd ?? cwd;
  const model = options.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig?.model);
  if (model === undefined) return undefined;

  const isolated = options.isolated;
  const thinking = options.thinkingLevel ?? agentConfig?.thinking;
  const agentId = options.agentId ?? type;
  const rootSessionId = options.rootSessionId ?? ctx.sessionManager.getSessionId();
  const taskDir = sessionTaskDir(configCwd, rootSessionId);
  // The schema travels as a file: the child recompiles it with the same
  // validator the parent used, so `agent({ schema })` behaves in a pane exactly
  // as it does in-process.
  const schemaPath = options.structuredOutput ? join(taskDir, agentId, "schema.json") : undefined;

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
  const files = writeChildFiles({ taskDir, systemPrompt, prompt, spec });
  if (schemaPath !== undefined && options.structuredOutput !== undefined) {
    writeFileSync(schemaPath, JSON.stringify(options.structuredOutput.schema, null, 2), "utf-8");
  }
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
    projectTrusted: ctx.isProjectTrusted(),
  };
  return inputs;
}

/** The argv that runs the child under the launcher's documented form. */
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
    sessionFile,
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
    const tools = new Set(inputs.spec.toolScope.tools);
    extras.memoryBlock =
      tools.has("write") || tools.has("edit")
        ? buildMemoryBlock(inputs.type, memory, inputs.configCwd)
        : buildReadOnlyMemoryBlock(inputs.type, memory, inputs.configCwd);
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
}): Promise<RunResult> {
  const { deps, warn, live, states, inputs, pane, options } = args;
  const paneDepsHere = paneDeps(deps);
  reportMinimize(warn, inputs, pane);

  // The child writes its own session file, and pi names it with a timestamp —
  // so it is discovered by the id it was launched with rather than predicted.
  const sessionFile = await findSessionFile(deps.agentSessionDir, inputs.agentId);
  const tail = new SessionTail(sessionFile);
  const state: RunState = { inputs, pane, tail, sessionFile, closed: false };
  const session = new PaneSession({
    tail,
    sessionFile,
    steer: (message) => steerPane(paneDepsHere, state, message),
    abort: () => closeRunPane(paneDepsHere, state),
  });
  states.set(session, state);
  tail.start();
  const stopActivity = feedActivity(tail, options, false);

  const ticket = Symbol(inputs.agentId);
  live.add(ticket);
  const stop = { requested: false };
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
    stopActivity();
    unlisten();
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
 */
async function relaunch(args: {
  deps: PaneRunDeps;
  warn: (message: string) => void;
  live: Set<symbol>;
  state: RunState;
  prompt: string;
  options: ResumeAgentOptions;
}): Promise<ResumeAgentResult> {
  const { deps, warn, live, state, prompt, options } = args;
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
  const pane = await launchPane({
    deps: paneDepsHere,
    label: inputs.label,
    command: childCommand({ ...inputs, files }, deps, state.sessionFile),
    cwd: inputs.cwd,
    index: live.size,
  });
  if (pane === undefined) {
    throw new Error(`the pane for "${inputs.label}" could not be created; the agent was not resumed`);
  }
  reportMinimize(warn, inputs, pane);
  state.pane = pane;
  state.closed = false;
  // The child appends to the same file, so the same tail keeps following it, and
  // what is already there belongs to the previous run.
  state.tail.start();
  const stopActivity = feedActivity(state.tail, options, true);

  const ticket = Symbol(inputs.agentId);
  live.add(ticket);
  const stop = { requested: false };
  const unlisten = forwardAbort(options.signal, () => {
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
      const message = await exitFailureMessage(paneDepsHere, state.pane.blockId, outcome.exitCode, state.tail);
      throw new Error(message);
    }
    return { text: outcome.text, failure: outcome.failure };
  } finally {
    stop.requested = true;
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
  stop: { requested: boolean };
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
function waitForResult(resultPath: string, stop: { requested: boolean }): Promise<PaneRunResult> {
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
 */
async function watchExit(
  deps: PaneDeps,
  blockId: string,
  warn: (message: string) => void,
  inputs: RunInputs,
  stop: { requested: boolean },
): Promise<number | null> {
  let warned = false;
  for (;;) {
    if (stop.requested) return null;
    const waited = await deps.exec(
      ["wait", "-s", deps.sessionId, blockId, "--json", "--for", `${WAIT_WINDOW_MS}ms`],
      { timeoutMs: WAIT_TIMEOUT_MS },
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
        `the pane for "${inputs.label}" could not be reached while watching it (${failureDetail(waited)});` +
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
 * Refused unless the child's own program status says it is taking input: a `pi`
 * at a dialog ("password", "allow this tool?") reports `blocked`, and text typed
 * into one lands in the dialog rather than in the conversation. The refusal is an
 * error the caller reports — `steer_subagent` turns it into the tool's message —
 * because a silently dropped steer reads as a delivered one.
 */
async function steerPane(deps: PaneDeps, state: RunState, message: string): Promise<void> {
  const blockId = state.pane.blockId;
  const process = await readProcessState(deps, blockId);
  if (process.status === "blocked") {
    throw new Error(
      `agent "${state.inputs.label}" is waiting on a prompt in its pane — answer it there, or abort the agent;` +
        " the message was not sent",
    );
  }
  if (process.lastExit !== null) {
    throw new Error(`agent "${state.inputs.label}" has already exited; the message was not sent`);
  }
  if (process.status === null) {
    throw new Error(`agent "${state.inputs.label}" is not answering in its pane; the message was not sent`);
  }
  const sent = await deps.exec(["send", "-s", deps.sessionId, "-b", blockId, message]);
  if (sent.code !== 0) {
    throw new Error(`the steering message could not be typed into the pane: ${failureDetail(sent)}`);
  }
  // The text arrives without a newline, so it sits on pi's prompt until Enter.
  const entered = await deps.exec(["send-key", "-s", deps.sessionId, "-b", blockId, "enter"]);
  if (entered.code !== 0) {
    throw new Error(`the steering message was typed but not submitted: ${failureDetail(entered)}`);
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/**
 * Close the run's current layer, once.
 *
 * An abort closes the layer and then the settle path closes it again; the second
 * call is a wasted round trip and, worse, a second chance to interleave with
 * another agent's pane creation. A resume clears the flag, because its pane is a
 * new one.
 */
async function closeRunPane(deps: PaneDeps, state: RunState): Promise<void> {
  if (state.closed) return;
  state.closed = true;
  await closePane(deps, state.pane.layerId);
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
 * The child's session file, discovered by the id it was launched with.
 *
 * pi names it `<timestamp>_<session id>.jsonl`, so the id is the part that is
 * known before the child writes anything. A child that never writes one (it died
 * during startup) leaves the guess as the handle's `sessionFile`: nothing is on
 * disk to name, and a handle has to name something — the run is about to settle as
 * a failure, and the path costs nothing until someone tries to reopen it.
 */
async function findSessionFile(dir: string, agentId: string): Promise<string> {
  const deadline = Date.now() + SESSION_FILE_GRACE_MS;
  for (;;) {
    const found = sessionFileIn(dir, agentId);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return join(dir, `${agentId}.jsonl`);
    await delay(POLL_INTERVAL_MS);
  }
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

/** Why a `rex` call failed, as it should be shown to a user. */
function failureDetail(result: RexExecResult): string {
  const detail = result.stderr.trim().replace(/^Error:\s*/i, "").trim();
  return detail === "" ? `rex exited with status ${result.code}` : detail;
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
