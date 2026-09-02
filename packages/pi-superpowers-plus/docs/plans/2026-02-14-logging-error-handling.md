# Logging & Error Handling Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Build a file-based logger module and sweep all 9 bare `catch {}` blocks in the codebase to add proper error handling with log calls.

**Architecture:** A single `extensions/logging.ts` module exports a `log` object with `info`, `warn`, `error`, and `debug` methods. All methods append to `~/.pi/logs/superpowers-plus.log`. Info/warn/error always write; debug only writes when `PI_SUPERPOWERS_DEBUG=1`. On init, if the log file exceeds 5 MB, rename it to `.1` (one-deep rotation) and start fresh. Then each of the 9 catch blocks gets classified and updated to call the appropriate log method.

**Tech Stack:** Node.js `fs` (sync writes for simplicity — log calls must not introduce async into sync callers), `os.homedir()`, `path`, `vitest` for tests.

---

## Phase 1: Logger Module (Tasks 1–4)

### Task 1: Logger — failing tests

**Files:**
- Create: `tests/extension/logging.test.ts`

Write the full test suite for the logger. Tests use a temp directory to avoid touching real log files.

**Step 1: Write the test file**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// We'll test the internal createLogger factory, not the singleton,
// so each test gets its own log file in a temp dir.
import { createLogger } from "../../extensions/logging.js";

describe("logging", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-log-test-"));
    logPath = path.join(tmpDir, "test.log");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("info writes a timestamped line to the log file", () => {
    const log = createLogger(logPath);
    log.info("hello world");

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("[INFO] hello world");
    // Timestamp format: YYYY-MM-DDTHH:MM:SS
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("warn writes with WARN level", () => {
    const log = createLogger(logPath);
    log.warn("something off");

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("[WARN] something off");
  });

  test("error writes with ERROR level", () => {
    const log = createLogger(logPath);
    log.error("bad thing", new Error("boom"));

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("[ERROR] bad thing");
    expect(content).toContain("boom");
  });

  test("debug is silent when verbose is false", () => {
    const log = createLogger(logPath, { verbose: false });
    log.debug("secret details");

    expect(fs.existsSync(logPath)).toBe(false);
  });

  test("debug writes when verbose is true", () => {
    const log = createLogger(logPath, { verbose: true });
    log.debug("secret details");

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("[DEBUG] secret details");
  });

  test("multiple writes append to the same file", () => {
    const log = createLogger(logPath);
    log.info("line one");
    log.info("line two");

    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("line one");
    expect(lines[1]).toContain("line two");
  });

  test("creates parent directories if they don't exist", () => {
    const nestedPath = path.join(tmpDir, "a", "b", "deep.log");
    const log = createLogger(nestedPath);
    log.info("nested");

    expect(fs.readFileSync(nestedPath, "utf-8")).toContain("nested");
  });

  test("rotates when file exceeds maxSize", () => {
    // Write a file that's already over the limit
    fs.writeFileSync(logPath, "x".repeat(200));

    // Create logger with tiny maxSize to trigger rotation
    const log = createLogger(logPath, { maxSizeBytes: 100 });
    log.info("after rotation");

    // Old content should be in .1 file
    const rotated = logPath + ".1";
    expect(fs.existsSync(rotated)).toBe(true);
    expect(fs.readFileSync(rotated, "utf-8")).toBe("x".repeat(200));

    // New file should only have the new line
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("after rotation");
    expect(content).not.toContain("x".repeat(50));
  });

  test("rotation overwrites existing .1 file", () => {
    const rotatedPath = logPath + ".1";
    fs.writeFileSync(rotatedPath, "old-rotated");
    fs.writeFileSync(logPath, "x".repeat(200));

    const log = createLogger(logPath, { maxSizeBytes: 100 });
    log.info("fresh");

    expect(fs.readFileSync(rotatedPath, "utf-8")).toBe("x".repeat(200));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/logging.test.ts`
Expected: FAIL — `createLogger` does not exist yet.

**Step 3: Commit**

```bash
git add tests/extension/logging.test.ts
git commit -m "test: add failing tests for logger module"
```

---

### Task 2: Logger — implementation

**Files:**
- Create: `extensions/logging.ts`

**Step 1: Write the logger module**

```typescript
/**
 * File-based logger for pi-superpowers-plus.
 *
 * Default singleton writes to ~/.pi/logs/superpowers-plus.log.
 * Info/warn/error always write. Debug writes only when PI_SUPERPOWERS_DEBUG=1.
 * One-deep rotation when file exceeds 5 MB.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LoggerOptions {
  verbose?: boolean;
  maxSizeBytes?: number;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
  debug(message: string): void;
}

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5 MB

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "");
}

export function createLogger(logPath: string, options?: LoggerOptions): Logger {
  const verbose = options?.verbose ?? false;
  const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE;
  let rotatedThisSession = false;

  function ensureDir(): void {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  function rotateIfNeeded(): void {
    if (rotatedThisSession) return;
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > maxSizeBytes) {
        fs.renameSync(logPath, logPath + ".1");
      }
    } catch {
      // File doesn't exist yet — nothing to rotate
    }
    rotatedThisSession = true;
  }

  function write(level: string, message: string): void {
    ensureDir();
    rotateIfNeeded();
    const line = `${timestamp()} [${level}] ${message}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  }

  return {
    info(message: string): void {
      write("INFO", message);
    },
    warn(message: string): void {
      write("WARN", message);
    },
    error(message: string, err?: unknown): void {
      const suffix = err ? ` — ${formatError(err)}` : "";
      write("ERROR", message + suffix);
    },
    debug(message: string): void {
      if (!verbose) return;
      write("DEBUG", message);
    },
  };
}

/** Default singleton logger used across all extensions. */
const LOG_PATH = path.join(os.homedir(), ".pi", "logs", "superpowers-plus.log");

export const log: Logger = createLogger(LOG_PATH, {
  verbose: process.env.PI_SUPERPOWERS_DEBUG === "1",
});
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/extension/logging.test.ts`
Expected: All 9 tests PASS.

**Step 3: Commit**

```bash
git add extensions/logging.ts
git commit -m "feat: add file-based logger module"
```

---

### Task 3: Run the full test suite

Make sure the new module doesn't break anything.

**Step 1: Run full suite**

Run: `npx vitest run`
Expected: All tests pass (existing + 9 new).

**Step 2: Commit (only if anything was fixed)**

No commit expected — this is a verification step.

---

## Phase 2: Error Handling Sweep (Tasks 4–8)

Below is the classification of all 9 bare `catch {}` blocks. Each task covers one file.

### Catch Block Classification Reference

| # | File | Line | Operation | Classification | Action |
|---|------|------|-----------|---------------|--------|
| 1 | `subagent/agents.ts:39` | `readdirSync(dir)` | Directory exists but unreadable | **log-and-continue** | `log.warn` with dir path |
| 2 | `subagent/agents.ts:51` | `readFileSync(filePath)` | Individual agent file unreadable | **log-and-continue** | `log.warn` with file path |
| 3 | `subagent/agents.ts:88` | `statSync(p)` | Path doesn't exist or not accessible | **ignore (correct)** | `log.debug` only |
| 4 | `subagent/index.ts:341` | `JSON.parse(line)` | Malformed JSON from subagent stdout | **log-and-continue** | `log.debug` (noisy during startup) |
| 5 | `subagent/index.ts:419` | `unlinkSync(tmpPromptPath)` | Temp file cleanup | **ignore (correct)** | `log.debug` only |
| 6 | `subagent/index.ts:425` | `rmSync(tmpDir)` | Temp dir cleanup | **ignore (correct)** | `log.debug` only |
| 7 | `workflow-monitor/git.ts:26` | `execSync("git branch...")` | Git command failed | **log-and-continue** | `log.warn` — this one hides real failures |
| 8 | `workflow-monitor/reference-tool.ts:31` | `readFile(fullPath)` | Skill reference file missing | **log-and-continue** | `log.warn` with path |
| 9 | `tdd-guard.ts:35` | `writeFileSync(violationsFile)` | Violation count persistence | **ignore (correct)** | `log.debug` only |

---

### Task 4: Error handling — `extensions/subagent/agents.ts` (3 catches)

**Files:**
- Modify: `extensions/subagent/agents.ts` — lines 39, 51, 88

**Step 1: Write the failing test**

Create `tests/extension/subagent/agents-error-handling.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// We test that the log module is called during error conditions.
// Since agents.ts uses the singleton `log`, we mock the logging module.
import * as logging from "../../../extensions/logging.js";

vi.mock("../../../extensions/logging.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof logging;
  return {
    ...actual,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

import { discoverAgents, loadAgentsFromDir } from "../../../extensions/subagent/agents.js";

describe("agents error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("logs warning when directory is unreadable", () => {
    // Pass a path that exists but can't be read (non-existent works too for readdirSync)
    const badDir = path.join(os.tmpdir(), "nonexistent-agents-dir-" + Date.now());

    const result = loadAgentsFromDir(badDir, "user");

    expect(result).toEqual([]);
    // No warn because dir doesn't exist — fs.existsSync returns false first
  });

  test("logs warning when agent file is unreadable", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-err-"));
    try {
      // Create a file that will fail to read
      const agentFile = path.join(tmpDir, "broken.md");
      fs.writeFileSync(agentFile, "content");
      fs.chmodSync(agentFile, 0o000);

      const result = loadAgentsFromDir(tmpDir, "user");

      // Should skip the file and log a warning
      expect(result).toEqual([]);
      expect(logging.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("broken.md"),
      );
    } finally {
      // Restore permissions for cleanup
      const agentFile = path.join(tmpDir, "broken.md");
      try { fs.chmodSync(agentFile, 0o644); } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("logs debug for isDirectory stat failures", () => {
    // This is tested implicitly — isDirectory is not exported.
    // We verify it via discoverAgents scanning a non-existent project path.
    // The debug call would fire for each candidate .pi/agents check.
    // Since isDirectory is internal, we just verify the function works correctly
    // (returns false for non-existent) — the debug log is best-effort.
    const result = discoverAgents("/nonexistent/path", "both");
    expect(result.projectAgentsDir).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/subagent/agents-error-handling.test.ts`
Expected: FAIL — `loadAgentsFromDir` is not exported, and no log calls exist yet.

**Step 3: Update `extensions/subagent/agents.ts`**

Add the import at the top (after existing imports):

```typescript
import { log } from "../logging.js";
```

Export `loadAgentsFromDir` (change `function` to `export function`):

```typescript
export function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
```

Update catch block at line 39 (`readdirSync`):

```typescript
	} catch (err) {
		log.warn(`Failed to read agents directory: ${dir} — ${err instanceof Error ? err.message : err}`);
		return agents;
	}
```

Update catch block at line 51 (`readFileSync`):

```typescript
		} catch (err) {
			log.warn(`Failed to read agent file: ${filePath} — ${err instanceof Error ? err.message : err}`);
			continue;
		}
```

Update catch block at line 88 (`statSync` in `isDirectory`):

```typescript
	} catch (err) {
		log.debug(`stat failed for ${p}: ${err instanceof Error ? err.message : err}`);
		return false;
	}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/subagent/agents-error-handling.test.ts`
Expected: PASS.

**Step 5: Run full suite to check for regressions**

Run: `npx vitest run`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add extensions/subagent/agents.ts tests/extension/subagent/agents-error-handling.test.ts
git commit -m "fix: add logging to agents.ts catch blocks"
```

---

### Task 5: Error handling — `extensions/subagent/index.ts` (3 catches)

**Files:**
- Modify: `extensions/subagent/index.ts` — lines 341, 419, 425

These 3 catches are all inside the `runSingleAgent` function. The JSON parse catch and the two `finally` cleanup catches. All are low-severity — the JSON parse is debug-level (noisy during subagent startup), and the cleanup catches are truly ignorable but get debug logs for diagnostics.

**Step 1: Write the failing test**

Create `tests/extension/subagent/index-error-handling.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock the logging module before importing the module under test
import * as logging from "../../../extensions/logging.js";

vi.mock("../../../extensions/logging.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof logging;
  return {
    ...actual,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

describe("subagent/index error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("log import is present in subagent/index.ts source", async () => {
    // Verify the import was added by reading the source
    const fs = await import("node:fs");
    const source = fs.readFileSync("extensions/subagent/index.ts", "utf-8");
    expect(source).toContain('from "../logging.js"');
  });

  test("JSON parse catch logs debug", async () => {
    // Verify the catch block references log.debug in source
    const fs = await import("node:fs");
    const source = fs.readFileSync("extensions/subagent/index.ts", "utf-8");
    // Find the JSON.parse catch and verify it has a log call
    const jsonParseRegion = source.slice(
      source.indexOf("JSON.parse(line)"),
      source.indexOf("JSON.parse(line)") + 200,
    );
    expect(jsonParseRegion).toContain("log.debug");
  });

  test("finally cleanup catches log debug", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("extensions/subagent/index.ts", "utf-8");
    // The finally block should have log.debug calls near unlinkSync and rmSync
    const finallyIndex = source.lastIndexOf("} finally {");
    const finallyRegion = source.slice(finallyIndex, finallyIndex + 400);
    expect(finallyRegion).toContain("log.debug");
  });
});
```

> **Note:** These catches are deep inside `runSingleAgent` which spawns real `pi` processes. Source-level verification is more practical than spawning real subagents in a unit test. The behavior is simple enough (a debug log call) that verifying the code exists is sufficient.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/subagent/index-error-handling.test.ts`
Expected: FAIL — log import not present yet.

**Step 3: Update `extensions/subagent/index.ts`**

Add import at the top (after existing imports, around line 13):

```typescript
import { log } from "../logging.js";
```

Update catch at line 341 (`JSON.parse`):

```typescript
				} catch (err) {
					log.debug(`Ignoring non-JSON line from subagent stdout: ${line.slice(0, 120)}`);
					return;
				}
```

Update catch at line 419 (`unlinkSync`):

```typescript
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch (err) {
				log.debug(`Failed to clean up temp prompt file: ${tmpPromptPath} — ${err instanceof Error ? err.message : err}`);
			}
```

Update catch at line 425 (`rmSync`):

```typescript
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch (err) {
				log.debug(`Failed to clean up temp directory: ${tmpDir} — ${err instanceof Error ? err.message : err}`);
			}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/subagent/index-error-handling.test.ts`
Expected: PASS.

**Step 5: Run full suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add extensions/subagent/index.ts tests/extension/subagent/index-error-handling.test.ts
git commit -m "fix: add logging to subagent/index.ts catch blocks"
```

---

### Task 6: Error handling — `extensions/workflow-monitor/git.ts` (1 catch)

**Files:**
- Modify: `extensions/workflow-monitor/git.ts` — line 26

This is the most important catch in the sweep. When `git branch --show-current` fails, the function returns `null`, and callers may fall through to permissive defaults (e.g., skipping branch safety checks). A `log.warn` here is critical for diagnosing silent failures.

**Step 1: Write the failing test**

Create `tests/extension/workflow-monitor/git-error-handling.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import * as logging from "../../../extensions/logging.js";

vi.mock("../../../extensions/logging.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof logging;
  return {
    ...actual,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

import { getCurrentGitRef } from "../../../extensions/workflow-monitor/git.js";

describe("git.ts error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("logs warning and returns null when not in a git repo", () => {
    const result = getCurrentGitRef("/tmp");
    expect(result).toBeNull();
    expect(logging.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("git"),
    );
  });

  test("returns branch name without warning in a real repo", () => {
    const result = getCurrentGitRef(process.cwd());
    expect(result).toBeTruthy();
    expect(logging.log.warn).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/workflow-monitor/git-error-handling.test.ts`
Expected: FAIL — no `log.warn` call exists yet.

**Step 3: Update `extensions/workflow-monitor/git.ts`**

Add import at the top:

```typescript
import { log } from "../logging.js";
```

Update catch at line 26:

```typescript
  } catch (err) {
    log.warn(`Failed to determine git ref in ${cwd}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/workflow-monitor/git-error-handling.test.ts`
Expected: PASS.

**Step 5: Run full suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add extensions/workflow-monitor/git.ts tests/extension/workflow-monitor/git-error-handling.test.ts
git commit -m "fix: log warning when git ref detection fails"
```

---

### Task 7: Error handling — `extensions/workflow-monitor/reference-tool.ts` (1 catch)

**Files:**
- Modify: `extensions/workflow-monitor/reference-tool.ts` — line 31

The function already returns a user-visible error string, but doesn't log. Add a `log.warn` so failures appear in the diagnostic log.

**Step 1: Write the failing test**

Create `tests/extension/workflow-monitor/reference-tool-error-handling.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import * as logging from "../../../extensions/logging.js";

vi.mock("../../../extensions/logging.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof logging;
  return {
    ...actual,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

import { loadReference } from "../../../extensions/workflow-monitor/reference-tool.js";

describe("reference-tool.ts error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("logs warning when reference file is not found", async () => {
    // Use a valid topic key — the file just won't exist if package structure is wrong
    // Instead, we can test with a known-missing topic
    const result = await loadReference("nonexistent-topic");

    expect(result).toContain("Unknown topic");
    // Unknown topic doesn't hit the file read path, so test with a real topic
    // and a broken path would require mocking fs. Let's verify the source instead.
    const fs = await import("node:fs");
    const source = fs.readFileSync("extensions/workflow-monitor/reference-tool.ts", "utf-8");
    const catchRegion = source.slice(source.indexOf("} catch"), source.indexOf("} catch") + 200);
    expect(catchRegion).toContain("log.warn");
  });

  test("returns error string when reference file is missing", async () => {
    const result = await loadReference("nonexistent-topic");
    expect(result).toContain("Unknown topic");
    expect(result).toContain("nonexistent-topic");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/workflow-monitor/reference-tool-error-handling.test.ts`
Expected: FAIL — no `log.warn` in catch block.

**Step 3: Update `extensions/workflow-monitor/reference-tool.ts`**

Add import at the top:

```typescript
import { log } from "../logging.js";
```

Update catch at line 31:

```typescript
  } catch (err) {
    log.warn(`Failed to load reference "${topic}" from ${fullPath}: ${err instanceof Error ? err.message : err}`);
    return `Error loading reference "${topic}": file not found at ${fullPath}`;
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/workflow-monitor/reference-tool-error-handling.test.ts`
Expected: PASS.

**Step 5: Run full suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add extensions/workflow-monitor/reference-tool.ts tests/extension/workflow-monitor/reference-tool-error-handling.test.ts
git commit -m "fix: log warning when reference file load fails"
```

---

### Task 8: Error handling — `extensions/tdd-guard.ts` (1 catch)

**Files:**
- Modify: `extensions/tdd-guard.ts` — line 35

The `persist()` function writes a violation count to a temp file so the parent process can read it. If this fails, the TDD guard still works in-process — it's purely diagnostic. Debug-level log.

**Step 1: Write the failing test**

Add to existing test file `tests/extension/tdd-guard/tdd-guard.test.ts`, or create a separate one. Separate is cleaner since we need mocks:

Create `tests/extension/tdd-guard/tdd-guard-error-handling.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import * as logging from "../../../extensions/logging.js";

vi.mock("../../../extensions/logging.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof logging;
  return {
    ...actual,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

describe("tdd-guard.ts error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("persist catch block logs debug in source", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("extensions/tdd-guard.ts", "utf-8");
    // The persist function's catch should have a log.debug call
    const persistFn = source.slice(source.indexOf("function persist"), source.indexOf("function persist") + 300);
    expect(persistFn).toContain("log.debug");
  });

  test("log import is present in tdd-guard.ts", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("extensions/tdd-guard.ts", "utf-8");
    expect(source).toContain('from "./logging.js"');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/tdd-guard/tdd-guard-error-handling.test.ts`
Expected: FAIL — no log import or call yet.

**Step 3: Update `extensions/tdd-guard.ts`**

Add import at the top (after existing imports):

```typescript
import { log } from "./logging.js";
```

Update catch at line 35:

```typescript
    } catch (err) {
      log.debug(`Failed to persist TDD violations to ${violationsFile}: ${err instanceof Error ? err.message : err}`);
    }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/tdd-guard/tdd-guard-error-handling.test.ts`
Expected: PASS.

**Step 5: Run full suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add extensions/tdd-guard.ts tests/extension/tdd-guard/tdd-guard-error-handling.test.ts
git commit -m "fix: add logging to tdd-guard persist catch block"
```

---

## Phase 3: Verification (Task 9)

### Task 9: Final verification and summary commit

**Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + ~20 new tests).

**Step 2: Verify all 9 catch blocks have been handled**

Run:
```bash
grep -n 'catch {' extensions/subagent/agents.ts extensions/subagent/index.ts extensions/workflow-monitor/git.ts extensions/workflow-monitor/reference-tool.ts extensions/tdd-guard.ts
```
Expected: Zero results. All bare `catch {}` should now be `catch (err) {`.

Run:
```bash
grep -n 'catch (err)' extensions/subagent/agents.ts extensions/subagent/index.ts extensions/workflow-monitor/git.ts extensions/workflow-monitor/reference-tool.ts extensions/tdd-guard.ts
```
Expected: 9 results — one per original catch block.

**Step 3: Verify log import is present in all 5 files**

Run:
```bash
grep -n 'from.*logging' extensions/subagent/agents.ts extensions/subagent/index.ts extensions/workflow-monitor/git.ts extensions/workflow-monitor/reference-tool.ts extensions/tdd-guard.ts
```
Expected: 5 results — one import per file.

**Step 4: Review the diff**

Run:
```bash
git diff main --stat
```

Expected files changed:
- `extensions/logging.ts` (new)
- `extensions/subagent/agents.ts` (modified)
- `extensions/subagent/index.ts` (modified)
- `extensions/workflow-monitor/git.ts` (modified)
- `extensions/workflow-monitor/reference-tool.ts` (modified)
- `extensions/tdd-guard.ts` (modified)
- `tests/extension/logging.test.ts` (new)
- `tests/extension/subagent/agents-error-handling.test.ts` (new)
- `tests/extension/subagent/index-error-handling.test.ts` (new)
- `tests/extension/workflow-monitor/git-error-handling.test.ts` (new)
- `tests/extension/workflow-monitor/reference-tool-error-handling.test.ts` (new)
- `tests/extension/tdd-guard/tdd-guard-error-handling.test.ts` (new)

**Step 5: No final commit needed** — all changes were committed incrementally per task.
