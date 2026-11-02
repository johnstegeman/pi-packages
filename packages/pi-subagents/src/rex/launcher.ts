// The pane launcher's pure builders: the child's files and spec, the argv a
// terminal block runs, and the `session.new_layer` request that creates it.
//
// Every function here is a value-in/values-out builder so the command shapes can
// be unit-tested without a Rex server and without spawning anything. The `rex`
// calls and the process watching land on top of this in later tasks.
//
// The one rule that must not drift: an agent type's `isolated`, `extensions`,
// `exclude_extensions` and `skills` have to mean in the child process what they
// mean to `runAgent()`'s in-process session. `confinementFlags` is that second
// implementation, and `test/rex-launcher.test.ts` drives it from the same
// fixture agent files the in-process template tests use, so a divergence shows
// up as a failing test rather than as a quietly less-confined child.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionCanonicalName, parseExtensionsSpec } from "../agent-runner.js";
import { getToolNamesForType } from "../agent-types.js";
import { sessionTaskDir } from "../output-file.js";
import type { AgentConfig } from "../types.js";

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
  // Path entries carry their own absolute path; they are also the only source of
  // one for an entry written as a path.
  const byCanonicalName = new Map<string, string>();
  for (const path of spec?.paths ?? []) byCanonicalName.set(extensionCanonicalName(path), path);

  // `extensions: true` with excludes, or a "*" wildcard, means "everything
  // discovered" — which only the caller's discovery pass can enumerate.
  if (!spec || spec.wildcard) {
    for (const [name, path] of resolved.extensionPaths) {
      if (!excludeNames.has(name)) add(path);
    }
  }
  for (const name of spec?.names ?? []) {
    if (excludeNames.has(name)) continue; // exclude wins
    add(byCanonicalName.get(name) ?? resolved.extensionPaths.get(name));
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
  if (input.maxTurns !== undefined) spec.maxTurns = input.maxTurns;
  if (input.graceTurns !== undefined) spec.graceTurns = input.graceTurns;
  if (input.structuredSchemaPath !== undefined) spec.structuredSchemaPath = input.structuredSchemaPath;
  return spec;
}

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
  /** `["--thinking", <level>]`, or empty when the type and caller inherited it. */
  thinkingFlag: string[];
  toolFlags: string[];
  /** `<getAgentDir()>/subagent-sessions/<rootSessionId>/`, outside the user's `/resume` list. */
  agentSessionDir: string;
}): string[] {
  // A terminal block's options have no `env` field, so the marker rides in the
  // command; child mode deletes it from `process.env` once read.
  const systemPromptFlag = input.agentConfig?.promptMode === "append" ? APPEND_PROMPT_FLAG : REPLACE_PROMPT_FLAG;
  return [
    "/usr/bin/env",
    `PI_SUBAGENTS_CHILD_SPEC=${input.files.specFile}`,
    input.piBinary,
    "--session-id",
    input.spec.agentId,
    "--session-dir",
    input.agentSessionDir,
    "--name",
    input.spec.agentId,
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
