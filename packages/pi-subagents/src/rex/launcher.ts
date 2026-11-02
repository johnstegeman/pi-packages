// The pane launcher's builders and its lifecycle calls: the child's files and
// spec, the argv a terminal block runs, the `session.new_layer` request that
// creates it, and the small set of `rex` calls that create, minimize and close
// it.
//
// The builders are value-in/values-out so the command shapes can be unit-tested
// without a Rex server and without spawning anything; the lifecycle calls on top
// of them are thin, and `test/rex-cli.test.ts` asserts their argv against a fake
// `rex` on PATH. Process watching is the read side of `rex-cli.ts`.
//
// The one rule that must not drift: an agent type's `isolated`, `extensions`,
// `exclude_extensions` and `skills` have to mean in the child process what they
// mean to `runAgent()`'s in-process session. `confinementFlags` is that second
// implementation, and `test/rex-launcher.test.ts` drives it from the same
// fixture agent files the in-process template tests use, so a divergence shows
// up as a failing test rather than as a quietly less-confined child.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  extensionCanonicalName,
  extensionCanonicalNames,
  normalizeMaxTurns,
  parseExtensionsSpec,
} from "../agent-runner.js";
import { getToolNamesForType } from "../agent-types.js";
import { sessionTaskDir } from "../output-file.js";
import type { AgentConfig } from "../types.js";
import { type PaneDeps, type RexExecResult, rexReply } from "./rex-cli.js";

/** The `pi` flags' documented file forms: `--system-prompt <text|path>`. */
const REPLACE_PROMPT_FLAG = "--system-prompt";
const APPEND_PROMPT_FLAG = "--append-system-prompt";

/**
 * Everything the child needs to know that the prompt and the flags do not carry.
 * Written to the child's `spec.json` and handed over in
 * `PI_SUBAGENTS_CHILD_SPEC`, which is why the pane's own `pi` is thinner than
 * the in-process runner: the parent resolved the model, the prompt, the tool
 * scope and the depth cap already.
 */
export interface ChildSpec {
  /** The parent's durable id for this agent; also the child's pi session id. */
  agentId: string;
  /** The session that started the whole cascade — the child session store is keyed by it. */
  rootSessionId: string;
  /** Set when this child is itself a subagent's spawn. */
  parentAgentId?: string;
  /** 0 is the main session; a depth at `maxSubagentDepth` may not spawn. */
  depth: number;
  maxSubagentDepth: number;
  /** Resolved copy of the agent type's `allowed_subagents`; false means no delegation tools. */
  allowedSubagents: string[] | "all" | false;
  /** Where the child writes `{ text, failure, usage, … }` before it shuts itself down. */
  resultPath: string;
  /** The child's working directory — the pane block's `cwd`. */
  cwd: string;
  /** Where the type's config was discovered, when that is not `cwd`. */
  configCwd?: string;
  maxTurns?: number;
  graceTurns?: number;
  /** Compiled structured-output schema the child must satisfy, when the caller asked for one. */
  structuredSchemaPath?: string;
  /**
   * The type's `ext:` tool selectors, verbatim. The in-process path narrows which
   * extension TOOLS surface with them (`parseExtSelectors()`); a pane child
   * cannot re-derive that from its tools, so it carries them here. Absent under
   * `isolated` and for a type that names none.
   */
  extSelectors?: string[];
  /** The active tool set and denylist, resolved from the type by the parent. */
  toolScope: { tools: string[]; excludeTools: string[] };
  model: string;
  thinking: string;
  /** The Rex session and window the pane lives in. Never a session other than the parent's. */
  pane: { sessionId: string; windowId: string };
}

/** The child's inputs on disk. `resultFile` is where the child reports back. */
export interface ChildFiles {
  /** The child's own directory, `<taskDir>/<agentId>/`. */
  dir: string;
  systemFile: string;
  promptFile: string;
  specFile: string;
  resultFile: string;
}

/**
 * What the parent discovered about the resources an agent file names.
 *
 * `extensions: [name]` and `skills: [name]` are bare names, not paths, so
 * something has to resolve them against the same discovery the in-process
 * loader does; that pass is the caller's. `cwd` rides here because the
 * agent-file syntax resolves relative path entries against the config cwd, and
 * `parseExtensionsSpec()` needs it.
 */
export interface ResolvedResources {
  /** The directory relative extension paths resolve against — the spawn's config cwd. */
  cwd: string;
  /**
   * Every extension the parent's loader discovered, by every name it answers to
   * (lowercased canonical name and, for a package entry, the package's short
   * name), to its absolute path.
   */
  extensionPaths: Map<string, string>;
  /** Skill name as written in `skills:` → the skill file or directory to load. */
  skillPaths: Map<string, string>;
  /** Whether the parent session has the built-in codemode extension active. */
  codemodeAutoLoads: boolean;
  /** Whether the parent session has the built-in tool search extension active. */
  toolSearchAutoLoads: boolean;
}

/**
 * The pane's size and cascade.
 *
 * A capsule sits in the right-hand column and each one lands a little lower and
 * a little further right than the last, so a stack reads as a stack even while
 * it is briefly on screen before the minimize call. Six fit without leaving the
 * window, so the seventh starts the column again — by then the earlier panes are
 * minimized and overlap costs nothing.
 */
const PANE_ORIGIN: [number, number] = [0.55, 0.08];
const PANE_SIZE: [number, number] = [0.42, 0.12];
const PANE_STACK = 6;
const PANE_STEP_X = 0.005;
const PANE_STEP_Y = 0.14;

/**
 * Where the pane for the nth concurrent subagent of this parent sits, as
 * `[x, y, w, h]` fractions of its window.
 */
export function paneBoundsForIndex(index: number): [number, number, number, number] {
  const lane = (Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0) % PANE_STACK;
  return [
    PANE_ORIGIN[0] + lane * PANE_STEP_X,
    PANE_ORIGIN[1] + lane * PANE_STEP_Y,
    PANE_SIZE[0],
    PANE_SIZE[1],
  ];
}

/**
 * Reproduce an agent type's extension/skill restrictions as `pi` flags.
 *
 * Mirrors `runAgent()` (`agent-runner.ts:719-724`, `:775-860`) — the in-process
 * path is the authority on what these fields mean:
 *
 *   - `isolated: true` overrides everything: no extensions, no skills, no
 *     context files, no MCP. It also suppresses `exclude_extensions`, because
 *     there is nothing left to exclude.
 *   - `extensions: false` → `-ne`. `extensions: true` → nothing (the child's own
 *     discovery is the same discovery the parent has).
 *   - `extensions: [names, paths, "*"]` → `-ne` plus one `-e <path>` per
 *     survivor, because a shared loader cannot be filtered from here: the child
 *     is a fresh process and only explicit paths load under `-ne`.
 *     `builtin:codemode` (and `builtin:tool-search`) are re-added: the
 *     in-process path injects codemode as an inline factory regardless of the
 *     allowlist, so dropping it would hand an allowlisted child fewer tools than
 *     its in-process sibling.
 *   - `exclude_extensions` is subtracted from the include set first — exclude
 *     wins, exactly as the in-process override does.
 *   - `skills: false` → `-ns`; `skills: [a, b]` → `-ns --skill <path>` per skill.
 *
 * A name that resolves to no path is skipped: it is already absent in the
 * parent (a typo, or an extension that failed to load), and loading fewer
 * extensions confines the child more, never less.
 */
export function confinementFlags(input: {
  agentConfig: AgentConfig | undefined;
  isolated: boolean | undefined;
  resolved: ResolvedResources;
}): string[] {
  const isolated = input.isolated === true;
  const config = input.agentConfig;
  // `isolated` is the override, not another source of truth: it forces both
  // fields false before anything else reads them.
  const extensions = isolated ? false : (config?.extensions ?? true);
  const excludeExtensions = isolated ? undefined : config?.excludeExtensions;
  const skills = isolated ? false : (config?.skills ?? true);

  const flags: string[] = [];
  const excludeNames = new Set((excludeExtensions ?? []).map((name) => name.toLowerCase()));

  if (extensions === false) {
    flags.push("-ne");
  } else if (Array.isArray(extensions) || excludeNames.size > 0) {
    flags.push("-ne");
    for (const path of survivingExtensionPaths(extensions, excludeNames, input.resolved)) {
      flags.push("-e", path);
    }
    // Always on in the in-process path (Divergence 4), so always on here unless
    // the parent says otherwise.
    if (input.resolved.codemodeAutoLoads) flags.push("-e", "builtin:codemode");
    if (input.resolved.toolSearchAutoLoads) flags.push("-e", "builtin:tool-search");
  }

  if (skills === false) {
    flags.push("-ns");
  } else if (Array.isArray(skills)) {
    // The in-process path preloads the text into the prompt; the child loads them
    // as skills. Same knowledge, different carrier — and `-ns` keeps every skill
    // the type did not name out of the child.
    flags.push("-ns");
    for (const name of skills) {
      const path = input.resolved.skillPaths.get(name);
      if (path) flags.push("--skill", path);
    }
  }

  if (isolated) flags.push("-nc", "--no-mcp");
  return flags;
}

/**
 * The absolute paths of the extensions that survive the include set and the
 * denylist, in the order the agent file named them.
 *
 * An exclude binds an extension however it is spelled: `exclude_extensions` is
 * matched against every canonical name of the resolved path, exactly as the
 * in-process override does (`agent-runner.ts:827-829`), so an extension named by
 * a path and an exclude naming its package short name still meet.
 */
function survivingExtensionPaths(
  extensions: true | string[],
  excludeNames: Set<string>,
  resolved: ResolvedResources,
): string[] {
  const spec = Array.isArray(extensions) ? parseExtensionsSpec(extensions, resolved.cwd) : undefined;
  const paths: string[] = [];
  const add = (path: string | undefined) => {
    if (path && !paths.includes(path)) paths.push(path);
  };
  const isExcluded = (name: string, path: string | undefined) =>
    excludeNames.has(name) ||
    (path !== undefined && extensionCanonicalNames(path).some((alias) => excludeNames.has(alias)));
  // Path entries carry their own absolute path; they are also the only source of
  // one for an entry written as a path.
  const byCanonicalName = new Map<string, string>();
  for (const path of spec?.paths ?? []) byCanonicalName.set(extensionCanonicalName(path), path);

  // `extensions: true` with excludes, or a "*" wildcard, means "everything
  // discovered" — which only the caller's discovery pass can enumerate. Two map
  // keys pointing at one path are one extension, so `add` de-duplicates the path.
  if (!spec || spec.wildcard) {
    for (const [name, path] of resolved.extensionPaths) {
      if (!isExcluded(name, path)) add(path);
    }
  }
  for (const name of spec?.names ?? []) {
    // Resolve the path first: the exclude answers to the extension, not to the
    // spelling the include list happened to use.
    const path = byCanonicalName.get(name) ?? resolved.extensionPaths.get(name);
    if (isExcluded(name, path)) continue; // exclude wins
    add(path);
  }
  return paths;
}

/**
 * Write the child's inputs into `<taskDir>/<agentId>/`.
 *
 * `taskDir` is the session scratch directory (`sessionTaskDir()`); the child gets
 * a subdirectory of it so a fan-out keeps one directory per agent. The result
 * file is not created here — the child writes it — so it is returned from the
 * spec, which is the single source for that path.
 */
export function writeChildFiles(input: {
  taskDir: string;
  systemPrompt: string;
  prompt: string;
  spec: ChildSpec;
}): ChildFiles {
  const dir = join(input.taskDir, input.spec.agentId);
  mkdirSync(dir, { recursive: true });
  const systemFile = join(dir, "system.md");
  const promptFile = join(dir, "prompt.md");
  const specFile = join(dir, "spec.json");
  writeFileSync(systemFile, input.systemPrompt, "utf-8");
  writeFileSync(promptFile, input.prompt, "utf-8");
  writeFileSync(specFile, JSON.stringify(input.spec, null, 2), "utf-8");
  return { dir, systemFile, promptFile, specFile, resultFile: input.spec.resultPath };
}

/**
 * The spec for one pane child, resolved from the parent's spawn options.
 *
 * Not pure in the strictest sense: it calls `sessionTaskDir()`, which creates
 * `<tmp>/pi-subagents-<uid>/<cwd>/<rootSessionId>/tasks` if it is missing. That is
 * the same directory the parent's own transcript and workflow scripts live in,
 * and the one call that guarantees it exists.
 *
 * `isolated` is not in the design's list of spawn options, but it has to be
 * here: `runAgent()` only injects the nested delegation tools when the type opted
 * in *and* the run is not isolated (`agent-runner.ts:952`), and the child cannot
 * make that call itself because the spec is the only thing it reads.
 *
 * `description` is likewise absent: it is the pane's label, not the child's
 * input — `buildNewLayerArgs()` takes it as `label`, and the task text reaches
 * the child as `prompt.md`.
 */
export function childSpecFromSpawn(input: {
  agentId: string;
  rootSessionId: string;
  parentAgentId?: string;
  depth: number;
  maxSubagentDepth: number;
  agentConfig: AgentConfig | undefined;
  type: string;
  cwd: string;
  configCwd?: string;
  isolated?: boolean;
  maxTurns?: number;
  graceTurns?: number;
  structuredSchemaPath?: string;
  model: string;
  thinking: string;
  pane: { sessionId: string; windowId: string };
}): ChildSpec {
  // The result file lives beside the agent's other scratch files, in the
  // *parent's* task directory: a worktree spawn changes the child's cwd, but the
  // parent that reads the result back still lives where the config was found.
  const taskDir = sessionTaskDir(input.configCwd ?? input.cwd, input.rootSessionId);
  const config = input.agentConfig;
  // Same precedence as the in-process runner (`resolveEffectiveMaxTurns`): the
  // caller's override, else the type's own `max_turns`, with 0 meaning unlimited.
  // The project default is not carried here — the child loads the same settings
  // and applies it itself, so copying it would only risk disagreeing.
  const maxTurns = normalizeMaxTurns(input.maxTurns ?? config?.maxTurns);
  const spec: ChildSpec = {
    agentId: input.agentId,
    rootSessionId: input.rootSessionId,
    depth: input.depth,
    maxSubagentDepth: input.maxSubagentDepth,
    allowedSubagents: input.isolated ? false : (config?.allowedSubagents ?? false),
    resultPath: join(taskDir, `${input.agentId}.result.json`),
    cwd: input.cwd,
    toolScope: {
      tools: config?.builtinToolNames ?? getToolNamesForType(input.type),
      excludeTools: config?.disallowedTools ?? [],
    },
    model: input.model,
    thinking: input.thinking,
    pane: input.pane,
  };
  // Absent rather than undefined: the spec is JSON on disk, and a null field reads
  // as "explicitly unset" to anyone debugging it.
  if (input.parentAgentId !== undefined) spec.parentAgentId = input.parentAgentId;
  if (input.configCwd !== undefined) spec.configCwd = input.configCwd;
  if (maxTurns !== undefined) spec.maxTurns = maxTurns;
  if (input.graceTurns !== undefined) spec.graceTurns = input.graceTurns;
  if (input.structuredSchemaPath !== undefined) spec.structuredSchemaPath = input.structuredSchemaPath;
  // `ext:` selectors are dropped when the run is isolated, exactly as
  // `parseExtSelectors()` receives nothing in that case in-process.
  const extSelectors = input.isolated ? undefined : config?.extSelectors;
  if (extSelectors && extSelectors.length > 0) spec.extSelectors = extSelectors;
  return spec;
}

/**
 * The trust answer a pane child is launched with. `-a` trusts the project's
 * `.pi` files for the run, `-na` ignores them — the same two answers pi offers a
 * human, so the child runs under the trust decision the parent session made
 * rather than stopping to ask in a pane nobody is reading.
 */
const TRUST_FLAG = "-a";
const NO_TRUST_FLAG = "-na";

/**
 * The argv the pane runs: `pi` as the parent's own build, told which spec it is
 * the child of.
 *
 * The prompt travels as `@<promptFile>` and the system prompt as a file path, so
 * argv stays a few hundred bytes however large the task is. `--provider` and
 * `--model` are passed by the caller and must both be there: `-ne` (or an
 * allowlist that omits the provider's own extension) makes `--provider`
 * unresolvable, so nothing may be inferred from the environment.
 *
 * The child's pi session id is the agent id. That is what lets the parent find
 * the transcript it tails (`<agentSessionDir>/…<id>.jsonl`) and reopen it from
 * `/agents` after the pane is gone; a uuid slice starts and ends alphanumeric,
 * which is what pi requires of a session id.
 *
 * A resume passes `sessionFile` instead, and then pi is told to open that file:
 * the same transcript continues under a second process, which is the only way
 * a pane run can be continued after its first child has exited.
 */
export function buildChildCommand(input: {
  files: ChildFiles;
  spec: ChildSpec;
  agentConfig: AgentConfig | undefined;
  isolated: boolean | undefined;
  resolved: ResolvedResources;
  /** `process.execPath`, so the child is the same build as the parent. */
  piBinary: string;
  /** `["--provider", <name>, "--model", <id>]`, from the resolved model. */
  modelFlag: string[];
  /** `["--thinking", <level>]`, or empty when nothing set it. Must mirror `spec.thinking`: the spec is what the child reads for its own turn loop, this is what pi starts with. */
  thinkingFlag: string[];
  toolFlags: string[];
  /** `<getAgentDir()>/subagent-sessions/<rootSessionId>/`, outside the user's `/resume` list. */
  agentSessionDir: string;
  /**
   * Whether the parent session trusts this project — the child is told `-a`
   * when it does and `-na` when it does not.
   *
   * Not optional: a child that inherits no answer stops on a trust prompt in a
   * pane nobody is looking at, and each of the two answers is wrong for the
   * other case. `-na` is what a human gets for an untrusted project, so the
   * child sees exactly the project-local files its parent was allowed to.
   */
  projectTrusted: boolean;
  /**
   * The child's session file, when it is being relaunched on an existing one
   * (a resume). Replaces `--session-id`/`--session-dir`: `--session <path>`
   * opens the file itself, and passing both would be two answers to one
   * question.
   */
  sessionFile?: string;
}): string[] {
  // A terminal block's options have no `env` field, so the marker rides in the
  // command; child mode deletes it from `process.env` once read.
  // An unknown type keeps the in-process fallback's mode: `getConfig()` resolves
  // it to the general-purpose agent, whose `prompt_mode` is `append`
  // (`default-agents.ts`), so the parent prompt flows in exactly as it would
  // have in an SDK session. A known type that omits the field is `replace`.
  const promptMode = input.agentConfig?.promptMode ?? "append";
  const systemPromptFlag = promptMode === "append" ? APPEND_PROMPT_FLAG : REPLACE_PROMPT_FLAG;
  // The child's pi session is the agent id, which is what lets the parent find
  // the transcript it tails and reopen it from `/agents` after the pane is gone.
  const sessionFlags =
    input.sessionFile !== undefined
      ? ["--session", input.sessionFile]
      : ["--session-id", input.spec.agentId, "--session-dir", input.agentSessionDir];
  return [
    "/usr/bin/env",
    `PI_SUBAGENTS_CHILD_SPEC=${input.files.specFile}`,
    input.piBinary,
    ...sessionFlags,
    "--name",
    input.spec.agentId,
    input.projectTrusted ? TRUST_FLAG : NO_TRUST_FLAG,
    systemPromptFlag,
    input.files.systemFile,
    ...confinementFlags({
      agentConfig: input.agentConfig,
      isolated: input.isolated,
      resolved: input.resolved,
    }),
    ...input.modelFlag,
    ...input.thinkingFlag,
    ...input.toolFlags,
    `@${input.files.promptFile}`,
  ];
}

/**
 * The `rex` argument vector that creates the child's pane: a floating terminal
 * layer in the parent's own window, created unfocused and running the command
 * verbatim.
 *
 * The `shell` option is deliberately absent. Measured on Rex 0.0.1793420730,
 * `"shell": "none"` with the default `login: true` runs the command under
 * `/usr/bin/login`, which then reports `exit_code: 0` for every outcome; leaving
 * the key out keeps argv verbatim and reports the real status, which is what the
 * pane run needs to tell a crash from a clean exit.
 *
 * `exit.on_completion` is left at Rex's default of true: the pane closes itself
 * when the child finishes, and a quick failure stays open so the error can be
 * read.
 *
 * The returned vector excludes the `rex` executable itself — the caller spawns
 * it.
 */
export function buildNewLayerArgs(input: {
  sessionId: string;
  windowId: string;
  label: string;
  command: string[];
  cwd: string;
  bounds: [number, number, number, number];
}): string[] {
  const request = {
    session_id: input.sessionId,
    window_id: input.windowId,
    bounds: input.bounds,
    focus: false,
    layout: {
      block: {
        flavor: "com.superlogical.terminal.shell",
        label: input.label,
        options: {
          command: input.command,
          cwd: input.cwd,
          exit: { on_completion: true },
        },
      },
    },
  };
  return ["api", "call", "-s", input.sessionId, "session.new_layer", JSON.stringify(request)];
}

// ---------------------------------------------------------------------------
// The lifecycle calls: create, minimize, close
// ---------------------------------------------------------------------------

/**
 * Serialize the calls that make a pane visible and then take it off screen.
 *
 * `session.new_layer` and `session.set_layer_state` are two calls, so there is
 * a window (measured at 21-29 ms on Rex 0.0.1793420730) in which a pane is on
 * screen. Two spawns interleaving there do not lose a layer, but a 20-way
 * fan-out would put twenty panes on screen in whatever order the server
 * happened to answer, which reads as a flicker rather than as a queue. One
 * chain, one create-and-minimize pair at a time, is the whole concurrency
 * story: it costs a few tens of milliseconds per spawn and buys an order the
 * user can predict.
 */
let paneQueue: Promise<unknown> = Promise.resolve();

/**
 * Run `work` after every pane step already queued.
 *
 * The bookkeeping promise swallows both outcomes so one failed step cannot
 * wedge the chain: the returned promise is the caller's, and it is the one
 * that carries the failure.
 */
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  // No rejection arm: `paneQueue` is only ever reassigned to the promise below,
  // which already resolves either way, so the chain is never rejected.
  const result = paneQueue.then(work);
  paneQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** What `launchPane()` needs: the pane's session, its label and the child's argv. */
export interface LaunchPaneInput {
  deps: PaneDeps;
  label: string;
  command: string[];
  cwd: string;
  /** This pane's place in the current stack; see `paneBoundsForIndex()`. */
  index: number;
}

/**
 * What one minimize attempt achieved.
 *
 * A refusal is not a failed spawn: Rex rejects `set_layer_state` with
 * `bad_request` when the window would lose its last visible pane, and the pane
 * stays on screen with its child still running. The caller has to be able to
 * say that in the same breath as "the agent is running", so the failure carries
 * the reason Rex gave rather than a bare false.
 */
export type MinimizeResult = { minimized: true } | { minimized: false; reason: string };

/** A created pane: its ids, and whether it made it off screen. */
export interface PaneHandle {
  layerId: string;
  blockId: string;
  minimize: MinimizeResult;
}

/**
 * Create one child's pane and take it off screen.
 *
 * Returns the ids the server assigned with the minimize result, or undefined
 * when no pane was created. Undefined is the caller's signal to run that agent
 * in-process instead; a throw would take down a fan-out because one pane could
 * not be made, so nothing here throws. The minimize is awaited before
 * returning, so a caller that records a pane under these ids is not racing the
 * second call.
 *
 * A refused minimize still returns the ids: the child is running and the pane is
 * merely visible, which is why `minimize` is part of the value — the caller
 * reports it, and nothing here claims a pane was minimized when it was not.
 */
export function launchPane(input: LaunchPaneInput): Promise<PaneHandle | undefined> {
  return enqueue(() => createPane(input));
}

async function createPane(input: LaunchPaneInput): Promise<PaneHandle | undefined> {
  let ids: { layerId: string; blockId: string } | undefined;
  try {
    const result = await input.deps.exec(
      buildNewLayerArgs({
        sessionId: input.deps.sessionId,
        windowId: input.deps.windowId,
        label: input.label,
        command: input.command,
        cwd: input.cwd,
        bounds: paneBoundsForIndex(input.index),
      }),
    );
    ids = layerIds(result);
  } catch {
    // The exec seam is documented as never rejecting; a deps object that
    // does anyway still must not throw into the manager.
    return undefined;
  }
  if (!ids) return undefined;
  const minimize = await setLayerMinimized(input.deps, ids.layerId);
  if (!minimize.minimized) {
    // Not a failed launch — the child is already running — but the pane is on
    // screen where a capsule was promised. The reason travels back in
    // `minimize`; this line is only so a session that never surfaces the tool
    // result still leaves a trace.
    console.warn(
      `[pi-subagents] the pane for ${input.label} was created but could not be minimized; it stays visible (${ids.layerId}): ${minimize.reason}`,
    );
  }
  return { ...ids, minimize };
}

/**
 * The ids `session.new_layer` answered with.
 *
 * Both are required: the layer id is what minimizes and closes the pane, the
 * block id is what the run reads process state and captures from. A reply
 * missing either — a null `block_ids`, an error body the CLI still exited 0
 * on — is a launch that cannot be tracked, so it counts as no launch at all.
 */
function layerIds(result: RexExecResult): { layerId: string; blockId: string } | undefined {
  const reply = rexReply(result);
  const layerId = reply?.layer_id;
  const blockIds = reply?.block_ids;
  const blockId = Array.isArray(blockIds) ? blockIds[0] : undefined;
  if (typeof layerId !== "string" || layerId === "") return undefined;
  if (typeof blockId !== "string" || blockId === "") return undefined;
  return { layerId, blockId };
}

/**
 * Minimize one layer, and report what happened.
 *
 * `{ minimized: true }` means the pane is a capsule. `{ minimized: false,
 * reason }` means it is still on screen, and it is never reported as success:
 * Rex refuses with `bad_request` when the window would lose its last visible
 * pane, and a caller that assumed otherwise would leave a pane on screen it
 * believes is minimized. The reason is Rex's own text, so a user is told why
 * rather than only that a call failed.
 */
export function minimizePane(deps: PaneDeps, layerId: string): Promise<MinimizeResult> {
  return enqueue(() => setLayerMinimized(deps, layerId));
}

async function setLayerMinimized(deps: PaneDeps, layerId: string): Promise<MinimizeResult> {
  try {
    const result = await deps.exec([
      "api",
      "call",
      "-s",
      deps.sessionId,
      "session.set_layer_state",
      JSON.stringify({ layer_id: layerId, state: "minimized" }),
    ]);
    if (result.code === 0) return { minimized: true };
    return { minimized: false, reason: failureReason(result.stderr, "rex call failed") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { minimized: false, reason: failureReason(message, "rex call failed") };
  }
}

/**
 * Why a `rex` call failed, as it should be shown to a user.
 *
 * The CLI prefixes its diagnostics with `Error: `, which is its own
 * decoration rather than the message; after it is what went wrong
 * (`bad_request: a window must keep a visible pane`, a missing binary, a
 * timeout). A failure that said nothing gets the caller's `fallback`: an empty
 * diagnostic is no evidence of any particular cause, and naming one would be a
 * guess dressed as an answer.
 */
function failureReason(text: string, fallback: string): string {
  const detail = text.trim().replace(/^Error:\s*/i, "").trim();
  return detail === "" ? fallback : detail;
}

/**
 * What one close attempt achieved.
 *
 * `closed: true` also covers the ordinary case of a layer that was already gone:
 * `exit.on_completion` closes a pane with its child, so `not found` is the
 * success answer on the cleanup path rather than a failure. A real failure — a
 * server that stopped answering, a request it rejected — means the child may
 * still be running, which the caller has to be able to say out loud instead of
 * reporting a cleanup that did not happen.
 */
export type CloseResult = { closed: true } | { closed: false; reason: string };

/**
 * Close one pane and everything running in it.
 *
 * Tolerant by design: the pane closes itself when its child exits
 * (`exit.on_completion`), so the common case is a layer that is already gone
 * and a `not_found` from the server — reported as closed, because that is the
 * state the caller wanted. Only layers this module created are ever named here
 * — `close_layer` ends the programs in a pane, and closing a layer the user owns
 * is not cleanup.
 *
 * `timeoutMs` is for the shutdown path, where the pane is best-effort: a quit
 * cannot spend the whole default allowance waiting on a wedged server, and a
 * pane left behind by a process that is exiting anyway is the lesser evil.
 */
export async function closePane(
  deps: PaneDeps,
  layerId: string,
  options: { timeoutMs?: number } = {},
): Promise<CloseResult> {
  try {
    const result = await deps.exec(
      [
        "api",
        "call",
        "-s",
        deps.sessionId,
        "session.close_layer",
        JSON.stringify({ layer_id: layerId }),
      ],
      options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
    );
    if (result.code === 0) return { closed: true };
    // Already gone: the outcome this call exists to produce, whichever side
    // closed it first.
    if (/not[_ ]?found/i.test(result.stderr)) return { closed: true };
    return { closed: false, reason: failureReason(result.stderr, `rex exited with status ${result.code}`) };
  } catch (error) {
    // `execRex` never rejects, but the seam is injectable.
    const message = error instanceof Error ? error.message : String(error);
    return { closed: false, reason: failureReason(message, "rex call failed") };
  }
}
