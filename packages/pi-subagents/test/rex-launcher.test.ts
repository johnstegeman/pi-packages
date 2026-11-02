/**
 * rex-launcher.test.ts — the pure builders that compose a pane child.
 *
 * Nothing here talks to Rex or spawns a process: `buildChildCommand` returns
 * the argv a terminal block will run, `buildNewLayerArgs` the `rex api call`
 * vector that creates the block, and `confinementFlags` the flags that make the
 * child as confined as `runAgent()`'s in-process session would be.
 *
 * The confinement cases are driven from the package's own fixture agent files
 * (`test/fixtures/.pi/agents/*.md`), which is the same source the in-process
 * `ext-templates-e2e.test.ts` uses. That is deliberate: the flag mapping is a
 * second implementation of a rule that lives in `agent-runner.ts`, so a drift
 * between the two must surface as a failing test rather than as a quietly
 * less-confined child (design §Risks 6).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { sessionTaskDir } from "../src/output-file.js";
import {
  buildChildCommand,
  buildNewLayerArgs,
  type ChildFiles,
  type ChildSpec,
  childMayTrustProject,
  childSpecFromSpawn,
  confinementFlags,
  paneBoundsForIndex,
  type ResolvedResources,
  writeChildFiles,
  writeStructuredSchema,
} from "../src/rex/launcher.js";
import type { AgentConfig } from "../src/types.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";

const FIXTURES_DIR = resolve(fileURLToPath(new URL("./fixtures", import.meta.url)));
const EXT_ALPHA = join(FIXTURES_DIR, "ext-alpha.mjs");
const EXT_BETA = join(FIXTURES_DIR, "ext-beta.mjs");
const PROBE_SKILL = join(FIXTURES_DIR, ".pi", "skills", "probe-skill.md");
const PI_BINARY = "/fake/bin/pi";
/** The record's handle, which is what pi is told to call this session. */
const HANDLE = "explore-2";

/**
 * The discovered-resource maps a caller hands the builders. Both fixture
 * extensions are named by path in the agent files, so the map only has to
 * answer for bare names — but the bare-name case is tested too, because that is
 * the form that needs a discovery pass (and therefore this map) to resolve.
 */
function resources(overrides: Partial<ResolvedResources> = {}): ResolvedResources {
  return {
    cwd: FIXTURES_DIR,
    extensionPaths: new Map([
      ["ext-alpha.mjs", EXT_ALPHA],
      ["ext-beta.mjs", EXT_BETA],
    ]),
    skillPaths: new Map([["probe-skill", PROBE_SKILL]]),
    codemodeAutoLoads: true,
    toolSearchAutoLoads: false,
    ...overrides,
  };
}

/** A hand-built config for cases no fixture file covers (bare names, wildcards). */
function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "probe",
    description: "probe",
    extensions: true,
    skills: true,
    systemPrompt: "",
    promptMode: "replace",
    ...overrides,
  };
}

function spec(overrides: Partial<ChildSpec> = {}): ChildSpec {
  return {
    agentId: "0f8a4b7c-2d3e-4a5b",
    rootSessionId: "root-session",
    depth: 1,
    maxSubagentDepth: 2,
    allowedSubagents: false,
    resultPath: join(tmpdir(), "0f8a4b7c-2d3e-4a5b.result.json"),
    cwd: FIXTURES_DIR,
    toolScope: { tools: ["read"], excludeTools: [] },
    model: "claude-sonnet-4",
    thinking: "medium",
    pane: { sessionId: "session:pane", windowId: "window:1" },
    ...overrides,
  };
}

/** A `ChildFiles` value shaped like `writeChildFiles`'s return, without touching disk. */
function files(overrides: Partial<ChildFiles> = {}): ChildFiles {
  const dir = join(tmpdir(), "rex-launcher-files");
  return {
    dir,
    systemFile: join(dir, "system.md"),
    promptFile: join(dir, "prompt.md"),
    specFile: join(dir, "spec.json"),
    resultFile: join(dir, "0f8a4b7c-2d3e-4a5b.result.json"),
    ...overrides,
  };
}
let agents: Map<string, AgentConfig> = new Map();
let hermeticAgentDir = "";
let previousAgentDir: string | undefined;

// Hermetic discovery for the whole file, and the map outlives one describe so
// every case reads the same configs: the developer's own ~/.pi/agents must not
// bleed in, and nothing may reload the agents after the environment is restored.
beforeAll(() => {
  hermeticAgentDir = mkdtempSync(join(tmpdir(), "subagents-launcher-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
  agents = loadCustomAgents(FIXTURES_DIR);
});

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(hermeticAgentDir, { recursive: true, force: true });
});

/** A fixture agent file, loaded above. */
function configOf(name: string): AgentConfig {
  const config = agents.get(name);
  if (!config) throw new Error(`fixture agent "${name}" was not loaded`);
  return config;
}

describe("confinementFlags — the agent type's restrictions, as CLI flags", () => {
  it("isolated: true forces -ne -ns -nc --no-mcp, overriding extensions: and ext: selectors", () => {
    const config = configOf("isolated-overrides-all");
    // The file sets extensions: and an ext: selector; isolation outranks both.
    expect(config.extensions).not.toBe(false);
    expect(confinementFlags({ agentConfig: config, isolated: true, resolved: resources() })).toEqual(
      ["-ne", "-ns", "-nc", "--no-mcp"],
    );
  });

  it("extensions: false yields -ne alone", () => {
    expect(
      confinementFlags({ agentConfig: configOf("extensions-disabled"), isolated: false, resolved: resources() }),
    ).toEqual(["-ne"]);
  });

  it("an extensions: allowlist yields -ne, one -e per survivor, then builtin:codemode", () => {
    // narrow-alpha-read narrows alpha's TOOLS via ext:; loading still covers both
    // extensions, because ext: selectors never control what loads.
    expect(
      confinementFlags({ agentConfig: configOf("narrow-alpha-read"), isolated: false, resolved: resources() }),
    ).toEqual(["-ne", "-e", EXT_ALPHA, "-e", EXT_BETA, "-e", "builtin:codemode"]);
  });

  it("exclude_extensions wins over the include set", () => {
    expect(
      confinementFlags({ agentConfig: configOf("exclude-beta"), isolated: false, resolved: resources() }),
    ).toEqual(["-ne", "-e", EXT_ALPHA, "-e", "builtin:codemode"]);
  });

  it("skills: [name] yields -ns plus a --skill path per resolved skill", () => {
    expect(
      confinementFlags({ agentConfig: configOf("skills-preload"), isolated: false, resolved: resources() }),
    ).toEqual(["-ns", "--skill", PROBE_SKILL]);
  });

  it("extends: true with no excludes yields no flags at all", () => {
    expect(confinementFlags({ agentConfig: agentConfig(), isolated: false, resolved: resources() })).toEqual([]);
    expect(confinementFlags({ agentConfig: undefined, isolated: false, resolved: resources() })).toEqual([]);
  });

  it("resolves a bare extension name through the discovered-path map", () => {
    const config = agentConfig({ extensions: ["alpha-pkg"] });
    const resolved = resources({
      extensionPaths: new Map([["alpha-pkg", EXT_ALPHA]]),
    });
    expect(confinementFlags({ agentConfig: config, isolated: false, resolved })).toEqual([
      "-ne",
      "-e",
      EXT_ALPHA,
      "-e",
      "builtin:codemode",
    ]);
  });

  it("adds builtin:tool-search only when the child has it active", () => {
    const config = configOf("narrow-alpha-read");
    expect(
      confinementFlags({
        agentConfig: config,
        isolated: false,
        resolved: resources({ toolSearchAutoLoads: true }),
      }),
    ).toEqual(["-ne", "-e", EXT_ALPHA, "-e", EXT_BETA, "-e", "builtin:codemode", "-e", "builtin:tool-search"]);
  });

  it("loads no built-in codemode when the parent does not have it active", () => {
    expect(
      confinementFlags({
        agentConfig: configOf("extensions-disabled"),
        isolated: false,
        resolved: resources({ codemodeAutoLoads: false }),
      }),
    ).toEqual(["-ne"]);
    expect(
      confinementFlags({
        agentConfig: configOf("narrow-alpha-read"),
        isolated: false,
        resolved: resources({ codemodeAutoLoads: false }),
      }),
    ).toEqual(["-ne", "-e", EXT_ALPHA, "-e", EXT_BETA]);
  });

  it("treats a * wildcard as: everything discovered, minus excludes", () => {
    const config = agentConfig({ extensions: ["*"], excludeExtensions: ["ext-beta.mjs"] });
    expect(confinementFlags({ agentConfig: config, isolated: false, resolved: resources() })).toEqual([
      "-ne",
      "-e",
      EXT_ALPHA,
      "-e",
      "builtin:codemode",
    ]);
  });

  it("applies exclude_extensions to extensions: true by loading the survivors explicitly", () => {
    const config = agentConfig({ extensions: true, excludeExtensions: ["ext-alpha.mjs"] });
    expect(confinementFlags({ agentConfig: config, isolated: false, resolved: resources() })).toEqual([
      "-ne",
      "-e",
      EXT_BETA,
      "-e",
      "builtin:codemode",
    ]);
  });

  it("ignores exclude_extensions when extensions: false leaves nothing to exclude", () => {
    const config = agentConfig({ extensions: false, excludeExtensions: ["ext-alpha.mjs"] });
    expect(confinementFlags({ agentConfig: config, isolated: false, resolved: resources() })).toEqual(["-ne"]);
  });

  it("keeps -ns but drops a skill it cannot resolve to a path", () => {
    const config = agentConfig({ skills: ["probe-skill", "gone-skill"] });
    expect(confinementFlags({ agentConfig: config, isolated: false, resolved: resources() })).toEqual([
      "-ns",
      "--skill",
      PROBE_SKILL,
    ]);
  });

  it("excludes an extension under every name it answers to, not just the one the map key used", () => {
    // One file, two names: `ext-alpha.mjs` is the path-derived canonical name and
    // `alpha-pkg` is the short name of the package that declares it. The in-process
    // override matches every canonical name of the loaded path, so an exclude
    // naming the canonical form must bind even when discovery filed it under the
    // package name (or vice versa).
    // The include list names the package; the denylist names the file's canonical
    // form. They are the same extension, so the exclude has to bind.
    const config = agentConfig({ extensions: ["alpha-pkg"], excludeExtensions: ["ext-alpha.mjs"] });
    const resolved = resources({
      extensionPaths: new Map([["alpha-pkg", EXT_ALPHA]]),
    });

    expect(confinementFlags({ agentConfig: config, isolated: false, resolved })).toEqual([
      "-ne",
      "-e",
      "builtin:codemode",
    ]);
  });

  it("loads a path listed under two discovered names once", () => {
    const config = agentConfig({ extensions: ["*", "alpha-pkg"] });
    const resolved = resources({
      extensionPaths: new Map([
        ["alpha-pkg", EXT_ALPHA],
        ["ext-alpha.mjs", EXT_ALPHA],
      ]),
    });

    expect(confinementFlags({ agentConfig: config, isolated: false, resolved })).toEqual([
      "-ne",
      "-e",
      EXT_ALPHA,
      "-e",
      "builtin:codemode",
    ]);
  });

  it("skills: false yields -ns without any --skill", () => {
    const config = agentConfig({ skills: false });
    expect(confinementFlags({ agentConfig: config, isolated: false, resolved: resources() })).toEqual(["-ns"]);
  });

  it("isolated outranks an allowlist and its extensions: selector", () => {
    const config = configOf("narrow-alpha-read");
    expect(confinementFlags({ agentConfig: config, isolated: true, resolved: resources() })).toEqual([
      "-ne",
      "-ns",
      "-nc",
      "--no-mcp",
    ]);
  });
});

describe("buildChildCommand — the child pi launch", () => {
  it("leads with /usr/bin/env, the spec variable and the pi binary", () => {
    const argv = buildChildCommand({
      files: files(),
      spec: spec(),
      agentConfig: undefined,
      isolated: false,
      resolved: resources(),
      piBinary: PI_BINARY,
      projectTrusted: true,
      name: HANDLE,
      modelFlag: ["--provider", "anthropic", "--model", "claude-sonnet-4"],
      thinkingFlag: ["--thinking", "medium"],
      toolFlags: ["-t", "read"],
      agentSessionDir: "/tmp/subagent-sessions/root-session",
    });

    expect(argv.slice(0, 3)).toEqual([
      "/usr/bin/env",
      `PI_SUBAGENTS_CHILD_SPEC=${files().specFile}`,
      PI_BINARY,
    ]);
  });

  it("carries the session, the name, the system prompt file, model and tool flags, and the prompt by @file", () => {
    const f = files();
    const argv = buildChildCommand({
      files: f,
      spec: spec(),
      agentConfig: agentConfig(),
      isolated: false,
      resolved: resources(),
      piBinary: PI_BINARY,
      projectTrusted: true,
      name: HANDLE,
      modelFlag: ["--provider", "anthropic", "--model", "claude-sonnet-4"],
      thinkingFlag: ["--thinking", "medium"],
      toolFlags: ["-t", "read"],
      agentSessionDir: "/tmp/subagent-sessions/root-session",
    });

    expect(argv).toEqual([
      "/usr/bin/env",
      `PI_SUBAGENTS_CHILD_SPEC=${f.specFile}`,
      PI_BINARY,
      "--session-id",
      "0f8a4b7c-2d3e-4a5b",
      "--session-dir",
      "/tmp/subagent-sessions/root-session",
      "--name",
      HANDLE,
      "-a",
      "--system-prompt",
      f.systemFile,
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-4",
      "--thinking",
      "medium",
      "-t",
      "read",
      `@${f.promptFile}`,
    ]);
    // The prompt rides as @file, and the provider is always explicit: an
    // allowlist that omits the provider's own extension makes --provider
    // unresolvable, so it can never be inferred from the environment.
    expect(argv[argv.length - 1]).toBe(`@${f.promptFile}`);
    expect(argv).toContain("--provider");
    expect(argv).toContain("--model");
  });

  it("puts the confinement flags between the system prompt and the model flags", () => {
    const f = files();
    const argv = buildChildCommand({
      files: f,
      spec: spec(),
      agentConfig: agentConfig({
        extensions: ["./ext-alpha.mjs"],
        skills: false,
        disallowedTools: ["bash"],
      }),
      isolated: false,
      resolved: resources(),
      piBinary: PI_BINARY,
      projectTrusted: true,
      name: HANDLE,
      modelFlag: ["--provider", "anthropic", "--model", "claude-sonnet-4"],
      thinkingFlag: [],
      toolFlags: ["-t", "read", "-xt", "bash"],
      agentSessionDir: "/tmp/subagent-sessions/root-session",
    });

    expect(argv).toEqual([
      "/usr/bin/env",
      `PI_SUBAGENTS_CHILD_SPEC=${f.specFile}`,
      PI_BINARY,
      "--session-id",
      "0f8a4b7c-2d3e-4a5b",
      "--session-dir",
      "/tmp/subagent-sessions/root-session",
      "--name",
      HANDLE,
      "-a",
      "--system-prompt",
      f.systemFile,
      "-ne",
      "-e",
      EXT_ALPHA,
      "-e",
      "builtin:codemode",
      "-ns",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-4",
      "-t",
      "read",
      "-xt",
      "bash",
      `@${f.promptFile}`,
    ]);
  });

  it("uses --system-prompt for prompt_mode: replace and --append-system-prompt for append", () => {
    const base = {
      files: files(),
      spec: spec(),
      isolated: false,
      resolved: resources(),
      piBinary: PI_BINARY,
      projectTrusted: true,
      name: HANDLE,
      modelFlag: ["--provider", "anthropic", "--model", "claude-sonnet-4"],
      thinkingFlag: [],
      toolFlags: [],
      agentSessionDir: "/tmp/subagent-sessions/root-session",
    };

    for (const name of ["prompt-mode-replace", "minimal"]) {
      const config = configOf(name);
      const argv = buildChildCommand({ ...base, agentConfig: config });
      expect(argv.slice(argv.indexOf("--system-prompt"), argv.indexOf("--system-prompt") + 2)).toEqual([
        "--system-prompt",
        base.files.systemFile,
      ]);
      expect(argv).not.toContain("--append-system-prompt");
    }

    const append = configOf("prompt-mode-append");
    const argv = buildChildCommand({ ...base, agentConfig: append });
    expect(argv.slice(argv.indexOf("--append-system-prompt"), argv.indexOf("--append-system-prompt") + 2)).toEqual([
      "--append-system-prompt",
      base.files.systemFile,
    ]);
    expect(argv).not.toContain("--system-prompt");
  });

  it("defaults to --append-system-prompt when the agent type is unknown, matching getConfig()'s fallback", () => {
    const argv = buildChildCommand({
      files: files(),
      spec: spec(),
      agentConfig: undefined,
      isolated: false,
      resolved: resources(),
      piBinary: PI_BINARY,
      projectTrusted: true,
      name: HANDLE,
      modelFlag: ["--provider", "anthropic", "--model", "claude-sonnet-4"],
      thinkingFlag: [],
      toolFlags: [],
      agentSessionDir: "/tmp/subagent-sessions/root-session",
    });
    // The unknown type resolves to the general-purpose fallback in-process, whose
    // prompt_mode is `append` — so the parent prompt is appended, not replaced.
    expect(argv).toContain("--append-system-prompt");
    expect(argv).not.toContain("--system-prompt");
  });

  it("keeps every argument small for a 1 MB prompt, which travels as @file", () => {
    const taskDir = mkdtempSync(join(tmpdir(), "rex-launcher-big-"));
    try {
      const huge = `${"0123456789abcdef".repeat(64 * 1024)}\n`.slice(0, 1024 * 1024);
      const written = writeChildFiles({
        taskDir,
        systemPrompt: "system",
        prompt: huge,
        spec: spec(),
      });
      const argv = buildChildCommand({
        files: written,
        spec: spec(),
        agentConfig: undefined,
        isolated: false,
        resolved: resources(),
        piBinary: PI_BINARY,
        projectTrusted: true,
        name: HANDLE,
        modelFlag: ["--provider", "anthropic", "--model", "claude-sonnet-4"],
        thinkingFlag: [],
        toolFlags: [],
        agentSessionDir: "/tmp/subagent-sessions/root-session",
      });

      for (const arg of argv) expect(arg.length).toBeLessThanOrEqual(4096);
      expect(argv[argv.length - 1]).toBe(`@${written.promptFile}`);
      // The file the argv points at holds the prompt exactly.
      expect(readFileSync(written.promptFile, "utf-8")).toBe(huge);
      expect(huge.length).toBe(1024 * 1024);
    } finally {
      rmSync(taskDir, { recursive: true, force: true });
    }
  });

  // A pane child has nobody to answer a trust prompt: it runs under the decision
  // the parent session already made, or it would sit there forever.
  it("carries the parent session's trust answer, whichever way it went", () => {
    const base = {
      files: files(),
      spec: spec(),
      agentConfig: undefined,
      isolated: false,
      resolved: resources(),
      piBinary: PI_BINARY,
      modelFlag: ["--provider", "anthropic", "--model", "claude-sonnet-4"],
      thinkingFlag: [],
      toolFlags: [],
      agentSessionDir: "/tmp/subagent-sessions/root-session",
    };

    const trusted = buildChildCommand({ ...base, projectTrusted: true });
    expect(trusted).toContain("-a");
    expect(trusted).not.toContain("-na");

    const untrusted = buildChildCommand({ ...base, projectTrusted: false });
    expect(untrusted).toContain("-na");
    expect(untrusted).not.toContain("-a");
  });

  // A resume is a second process on the same transcript, so pi is told to open
  // the file rather than to reuse an id in a session directory.
  it("opens the child's session file directly on a resume", () => {
    const f = files();
    const base = {
      files: f,
      spec: spec(),
      agentConfig: undefined,
      isolated: false,
      resolved: resources(),
      piBinary: PI_BINARY,
      projectTrusted: true,
      name: HANDLE,
      modelFlag: ["--provider", "anthropic", "--model", "claude-sonnet-4"],
      thinkingFlag: [],
      toolFlags: [],
      agentSessionDir: "/tmp/subagent-sessions/root-session",
    };

    const argv = buildChildCommand({ ...base, sessionFile: "/tmp/subagent-sessions/root-session/x_agent.jsonl" });

    expect(argv.slice(3, 5)).toEqual(["--session", "/tmp/subagent-sessions/root-session/x_agent.jsonl"]);
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--session-dir");
    // Everything else is unchanged: the same spec, name, prompt and confinement.
    expect(argv[1]).toBe(`PI_SUBAGENTS_CHILD_SPEC=${f.specFile}`);
    expect(argv).toContain("-a");
    expect(argv[argv.length - 1]).toBe(`@${f.promptFile}`);
  });
});

describe("buildChildCommand — the names a child is given", () => {
  it("names the session with the handle while the session id stays the agent id", () => {
    // Two different names on purpose: `--session-id` is what finds the transcript
    // the parent tails, `--name` is what the user types to reach the agent.
    const argv = buildChildCommand({
      files: files(),
      spec: spec(),
      agentConfig: undefined,
      isolated: false,
      resolved: resources(),
      piBinary: PI_BINARY,
      projectTrusted: true,
      name: HANDLE,
      modelFlag: ["--provider", "anthropic", "--model", "claude-sonnet-4"],
      thinkingFlag: [],
      toolFlags: [],
      agentSessionDir: "/tmp/subagent-sessions/root-session",
    });

    expect(argv[argv.indexOf("--session-id") + 1]).toBe("0f8a4b7c-2d3e-4a5b");
    expect(argv[argv.indexOf("--name") + 1]).toBe(HANDLE);
  });
});

describe("childMayTrustProject — whose `.pi` files the child is trusted with", () => {
  const project = "/repos/mine";

  it("trusts the parent's own project and anything inside it", () => {
    const base = { parentTrusted: true, projectRoot: project, projectCopy: false };
    expect(childMayTrustProject({ ...base, childCwd: project })).toBe(true);
    expect(childMayTrustProject({ ...base, childCwd: join(project, "packages", "a") })).toBe(true);
    // A sibling whose name merely starts with the project's is not inside it.
    expect(childMayTrustProject({ ...base, childCwd: "/repos/mine-other" })).toBe(false);
  });

  it("refuses a child working in another repo, which pi would have prompted a human about", () => {
    expect(
      childMayTrustProject({
        parentTrusted: true,
        projectRoot: project,
        childCwd: "/repos/somebody-else",
        projectCopy: false,
      }),
    ).toBe(false);
  });

  it("trusts a worktree spawn, which is the parent's own copy of the project", () => {
    expect(
      childMayTrustProject({
        parentTrusted: true,
        projectRoot: project,
        childCwd: join(tmpdir(), "pi-agent-abc123"),
        projectCopy: true,
      }),
    ).toBe(true);
  });

  it("never trusts anything when the parent session does not", () => {
    const base = { parentTrusted: false, projectRoot: project, projectCopy: false };
    expect(childMayTrustProject({ ...base, childCwd: project })).toBe(false);
    expect(childMayTrustProject({ ...base, childCwd: project, projectCopy: true })).toBe(false);
  });
});

describe("writeStructuredSchema — the file the child recompiles", () => {
  it("writes the schema the caller compiled, so the child's recompile agrees", () => {
    const dir = mkdtempSync(join(tmpdir(), "rex-launcher-schema-"));
    try {
      const path = join(dir, "schema.json");
      const compiled = compileJsonSchema({ type: "object", properties: { answer: { type: "string" } } });
      if (!compiled.ok) throw new Error(compiled.message);

      expect(writeStructuredSchema(path, compiled.compiled)).toBeUndefined();
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(compiled.compiled.schema);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the problem instead of launching a child with no schema behind it", () => {
    const dir = mkdtempSync(join(tmpdir(), "rex-launcher-schema-"));
    try {
      // A directory where the file should go: the write fails, and the caller
      // has to hear about it before a child is launched pointing at a path that
      // holds no schema.
      const path = join(dir, "schema.json");
      mkdirSync(path);
      const compiled = compileJsonSchema({ type: "object" });
      if (!compiled.ok) throw new Error(compiled.message);

      expect(writeStructuredSchema(path, compiled.compiled)).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeChildFiles — the child's inputs on disk", () => {
  it("writes system.md, prompt.md and spec.json and returns the paths plus the result file", () => {
    const taskDir = mkdtempSync(join(tmpdir(), "rex-launcher-"));
    try {
      const childSpec = spec({ agentId: "child-1", resultPath: "" });
      childSpec.resultPath = join(taskDir, "child-1.result.json");
      const out = writeChildFiles({
        taskDir,
        systemPrompt: "system prompt — ünïcode",
        prompt: "the task",
        spec: childSpec,
      });

      expect(out.dir).toBe(join(taskDir, "child-1"));
      expect(out.systemFile).toBe(join(taskDir, "child-1", "system.md"));
      expect(out.promptFile).toBe(join(taskDir, "child-1", "prompt.md"));
      expect(out.specFile).toBe(join(taskDir, "child-1", "spec.json"));
      expect(out.resultFile).toBe(childSpec.resultPath);

      expect(readFileSync(out.systemFile, "utf-8")).toBe("system prompt — ünïcode");
      expect(readFileSync(out.promptFile, "utf-8")).toBe("the task");
      expect(JSON.parse(readFileSync(out.specFile, "utf-8"))).toEqual(childSpec);
    } finally {
      rmSync(taskDir, { recursive: true, force: true });
    }
  });
});

describe("childSpecFromSpawn — what the child needs to know", () => {
  it("widens a memory agent's tool scope exactly as the in-process runner does", () => {
    // `runAgent()` completes the memory tool set before choosing the block, so a
    // pane child has to arrive with the same scope: otherwise it is told to
    // write memory with `write` but no `edit`, or (write denied) told it can
    // write at all.
    const taskDir = mkdtempSync(join(tmpdir(), "rex-launcher-memory-"));
    try {
      const spec = (type: string) =>
        childSpecFromSpawn({
          agentId: `${type}-1`,
          rootSessionId: "root-session",
          depth: 1,
          maxSubagentDepth: 2,
          agentConfig: configOf(type),
          type,
          cwd: taskDir,
          model: "claude-sonnet-4",
          thinking: "medium",
          pane: { sessionId: "session:pane", windowId: "window:1" },
        });

      // `tools: read, write` and no denylist: `edit` is auto-added.
      expect(spec("memory-readwrite").toolScope.tools).toEqual(["read", "write", "edit"]);
      // `tools: read, grep` — no write capability, so nothing is added.
      expect(spec("memory-readonly").toolScope.tools).toEqual(["read", "grep"]);
      // `tools: read, write` with `write` denied: the denylist decides, and a
      // read-only agent needs no widening beyond the read it already has.
      const denied = spec("memory-denied-write").toolScope;
      expect(denied.tools).toEqual(["read", "write"]);
      expect(denied.excludeTools).toEqual(["write"]);
    } finally {
      rmSync(taskDir, { recursive: true, force: true });
    }
  });

  it("carries identity, depth, tool scope, model and pane ids", () => {
    const configCwd = mkdtempSync(join(tmpdir(), "rex-launcher-spec-"));
    try {
      const out = childSpecFromSpawn({
        agentId: "child-1",
        rootSessionId: "root-session",
        parentAgentId: "parent-1",
        depth: 1,
        maxSubagentDepth: 2,
        agentConfig: agentConfig({
          builtinToolNames: ["read", "grep"],
          disallowedTools: ["grep"],
          allowedSubagents: ["explore"],
          thinking: "high",
          maxTurns: 12,
        }),
        type: "probe",
        cwd: configCwd,
        configCwd,
        maxTurns: 12,
        model: "claude-sonnet-4",
        thinking: "high",
        pane: { sessionId: "session:pane", windowId: "window:1" },
      });

      expect(out).toEqual({
        agentId: "child-1",
        rootSessionId: "root-session",
        parentAgentId: "parent-1",
        depth: 1,
        maxSubagentDepth: 2,
        allowedSubagents: ["explore"],
        resultPath: join(sessionTaskDir(configCwd, "root-session"), "child-1.result.json"),
        cwd: configCwd,
        configCwd,
        maxTurns: 12,
        // No `graceTurns`: the spec does not carry one. The grace comes from the
        // project's settings, which the child loads itself.
        toolScope: { tools: ["read", "grep"], excludeTools: ["grep"] },
        model: "claude-sonnet-4",
        thinking: "high",
        pane: { sessionId: "session:pane", windowId: "window:1" },
      });
    } finally {
      rmSync(configCwd, { recursive: true, force: true });
    }
  });

  it("omits the optional keys it was not given rather than writing undefined into the spec", () => {
    const out = childSpecFromSpawn({
      agentId: "child-1",
      rootSessionId: "root-session",
      depth: 0,
      maxSubagentDepth: 2,
      agentConfig: undefined,
      type: "no-such-agent",
      cwd: FIXTURES_DIR,
      model: "claude-sonnet-4",
      thinking: "",
      pane: { sessionId: "session:pane", windowId: "window:1" },
    });

    expect(Object.keys(out).sort()).toEqual([
      "agentId",
      "allowedSubagents",
      "cwd",
      "depth",
      "maxSubagentDepth",
      "model",
      "pane",
      "resultPath",
      "rootSessionId",
      "thinking",
      "toolScope",
    ]);
    expect(out.cwd).toBe(FIXTURES_DIR);
    // Unknown type → the built-ins the in-process runner would install.
    expect(out.toolScope).toEqual({ tools: [...BUILTIN_TOOL_NAMES], excludeTools: [] });
    expect(out.allowedSubagents).toBe(false);
  });

  it("turns allowed_subagents off under isolated, exactly as runAgent does", () => {
    const config = agentConfig({ allowedSubagents: "all" });
    const out = childSpecFromSpawn({
      agentId: "child-1",
      rootSessionId: "root-session",
      depth: 1,
      maxSubagentDepth: 2,
      agentConfig: config,
      type: "probe",
      cwd: FIXTURES_DIR,
      isolated: true,
      model: "claude-sonnet-4",
      thinking: "",
      pane: { sessionId: "session:pane", windowId: "window:1" },
    });

    expect(out.allowedSubagents).toBe(false);
  });

  it("derives the result path from the parent's task dir, not the child's cwd", () => {
    const parentCwd = mkdtempSync(join(tmpdir(), "rex-launcher-parent-"));
    const worktree = mkdtempSync(join(tmpdir(), "rex-launcher-worktree-"));
    try {
      const out = childSpecFromSpawn({
        agentId: "child-1",
        rootSessionId: "root-session",
        depth: 1,
        maxSubagentDepth: 2,
        agentConfig: undefined,
        type: "probe",
        cwd: worktree,
        configCwd: parentCwd,
        model: "claude-sonnet-4",
        thinking: "",
        pane: { sessionId: "session:pane", windowId: "window:1" },
      });

      expect(out.cwd).toBe(worktree);
      expect(out.resultPath).toBe(join(sessionTaskDir(parentCwd, "root-session"), "child-1.result.json"));
    } finally {
      rmSync(parentCwd, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("carries the type's ext: selectors so the child can narrow extension tools", () => {
    const config = configOf("narrow-alpha-read");
    expect(config.extSelectors).toEqual(["ext:ext-alpha.mjs/alpha_read"]);

    const out = childSpecFromSpawn({
      agentId: "child-1",
      rootSessionId: "root-session",
      depth: 1,
      maxSubagentDepth: 2,
      agentConfig: config,
      type: "narrow-alpha-read",
      cwd: FIXTURES_DIR,
      model: "claude-sonnet-4",
      thinking: "",
      pane: { sessionId: "session:pane", windowId: "window:1" },
    });

    expect(out.extSelectors).toEqual(["ext:ext-alpha.mjs/alpha_read"]);

    // And it survives the trip through spec.json, which is how the child reads it.
    const taskDir = mkdtempSync(join(tmpdir(), "rex-launcher-extsel-"));
    try {
      const written = writeChildFiles({ taskDir, systemPrompt: "s", prompt: "p", spec: out });
      const onDisk = JSON.parse(readFileSync(written.specFile, "utf-8")) as ChildSpec;
      expect(onDisk.extSelectors).toEqual(["ext:ext-alpha.mjs/alpha_read"]);
    } finally {
      rmSync(taskDir, { recursive: true, force: true });
    }
  });

  it("drops ext: selectors under isolated, where the in-process path drops them too", () => {
    const config = configOf("isolated-overrides-all");
    expect(config.extSelectors?.length).toBeGreaterThan(0);

    const out = childSpecFromSpawn({
      agentId: "child-1",
      rootSessionId: "root-session",
      depth: 1,
      maxSubagentDepth: 2,
      agentConfig: config,
      type: "isolated-overrides-all",
      cwd: FIXTURES_DIR,
      isolated: true,
      model: "claude-sonnet-4",
      thinking: "",
      pane: { sessionId: "session:pane", windowId: "window:1" },
    });

    expect(out.extSelectors).toBeUndefined();
  });

  it("takes the caller's max_turns first, the type's own second, and neither as unlimited", () => {
    const base = {
      agentId: "child-1",
      rootSessionId: "root-session",
      depth: 1,
      maxSubagentDepth: 2,
      type: "probe",
      cwd: FIXTURES_DIR,
      model: "claude-sonnet-4",
      thinking: "",
      pane: { sessionId: "session:pane", windowId: "window:1" },
    };
    const typed = agentConfig({ maxTurns: 7 });

    // Caller's override wins over the type's cap.
    expect(childSpecFromSpawn({ ...base, agentConfig: typed, maxTurns: 12 }).maxTurns).toBe(12);
    // A caller that passes nothing keeps the type's frontmatter cap.
    expect(childSpecFromSpawn({ ...base, agentConfig: typed }).maxTurns).toBe(7);
    // 0 means unlimited, as it does in-process, so the key is dropped entirely.
    expect(childSpecFromSpawn({ ...base, agentConfig: typed, maxTurns: 0 }).maxTurns).toBeUndefined();
    expect(childSpecFromSpawn({ ...base, agentConfig: agentConfig() }).maxTurns).toBeUndefined();
  });
});

describe("buildNewLayerArgs — the session.new_layer request", () => {
  it("emits the rex api call vector in the documented shape", () => {
    const command = [
      "/usr/bin/env",
      "PI_SUBAGENTS_CHILD_SPEC=/tmp/x/spec.json",
      PI_BINARY,
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-4",
      "@/tmp/x/prompt.md",
    ];
    const argv = buildNewLayerArgs({
      sessionId: "session:pane",
      windowId: "window:1",
      label: "explore · find the launcher",
      command,
      cwd: "/work/dir",
      bounds: [0.55, 0.08, 0.42, 0.12],
    });

    expect(argv.slice(0, 5)).toEqual(["api", "call", "-s", "session:pane", "session.new_layer"]);
    expect(argv).toHaveLength(6);
    const body = JSON.parse(argv[5]) as Record<string, unknown>;
    expect(body).toEqual({
      session_id: "session:pane",
      window_id: "window:1",
      bounds: [0.55, 0.08, 0.42, 0.12],
      focus: false,
      layout: {
        block: {
          flavor: "com.superlogical.terminal.shell",
          label: "explore · find the launcher",
          options: { command, cwd: "/work/dir", exit: { on_completion: true } },
        },
      },
    });
  });

  it("never sends a shell key, which would run the command under /usr/bin/login and hide its exit status", () => {
    const argv = buildNewLayerArgs({
      sessionId: "session:pane",
      windowId: "window:1",
      label: "a",
      command: ["/usr/bin/env", "X=1", PI_BINARY],
      cwd: "/work/dir",
      bounds: [0.55, 0.08, 0.42, 0.12],
    });
    const body = JSON.parse(argv[5]) as {
      layout: { block: { options: Record<string, unknown> } };
    };
    expect(Object.keys(body.layout.block.options).sort()).toEqual(["command", "cwd", "exit"]);
    expect(body.layout.block.options).not.toHaveProperty("shell");
    expect("shell" in body).toBe(false);
  });

  it("keeps the command array verbatim and its own exit on_completion true", () => {
    const command = ["/usr/bin/env", "PI_SUBAGENTS_CHILD_SPEC=/tmp/a b/spec.json", PI_BINARY];
    const argv = buildNewLayerArgs({
      sessionId: "session:pane",
      windowId: "window:1",
      label: "a",
      command,
      cwd: "/work/dir",
      bounds: [0.55, 0.08, 0.42, 0.12],
    });
    const body = JSON.parse(argv[5]) as {
      layout: { block: { options: { command: string[]; exit: { on_completion: boolean } } } };
    };
    expect(body.layout.block.options.command).toEqual(command);
    expect(body.layout.block.options.exit).toEqual({ on_completion: true });
  });
});

describe("paneBoundsForIndex — a cascade of capsules", () => {
  it("starts at 0.55, 0.08 with a 0.42 x 0.12 window", () => {
    expect(paneBoundsForIndex(0)).toEqual([0.55, 0.08, 0.42, 0.12]);
  });

  it("cascades down and right and wraps every six panes", () => {
    const first = paneBoundsForIndex(0);
    const second = paneBoundsForIndex(1);
    expect(second[0]).toBeGreaterThan(first[0]); // right
    expect(second[1]).toBeGreaterThan(first[1]); // down
    expect(second[2]).toBe(first[2]);
    expect(second[3]).toBe(first[3]);

    const sixth = paneBoundsForIndex(5);
    expect(sixth[0]).toBeCloseTo(0.55 + 5 * (second[0] - first[0]), 10);
    expect(sixth[1]).toBeCloseTo(0.08 + 5 * (second[1] - first[1]), 10);

    const wrapped = paneBoundsForIndex(6);
    wrapped.forEach((value, i) => {
      expect(value).toBeCloseTo(first[i], 10);
    });
  });

  it("keeps every pane inside the window", () => {
    for (let index = 0; index < 12; index++) {
      const [x, y, w, h] = paneBoundsForIndex(index);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(1);
      expect(y + h).toBeLessThanOrEqual(1);
    }
  });

  it("treats a negative or fractional index as the first pane", () => {
    expect(paneBoundsForIndex(-1)).toEqual(paneBoundsForIndex(0));
    expect(paneBoundsForIndex(0.7)).toEqual(paneBoundsForIndex(0));
  });
});
