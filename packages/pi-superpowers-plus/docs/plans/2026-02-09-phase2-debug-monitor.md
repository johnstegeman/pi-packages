# Phase 2: Debug Monitor + Review Fixes Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Ship the debug monitor — track fix-fail cycles during debugging, warn on fix-without-investigation and excessive fix attempts, show state in widget. Also fix 4 review issues from Phase 1. Lean the systematic-debugging skill and extract reference content.

**Architecture:** `DebugMonitor` class (same pattern as `TddMonitor`) activates on test failure, tracks investigation signals and fix-fail cycles. Wired into the existing `WorkflowHandler` and `workflow-monitor.ts` extension. Warning content and reference topics extend existing modules.

**Tech Stack:** TypeScript, pi extension API, Vitest.

**Existing patterns:** `tdd-monitor.ts` for monitor class, `workflow-handler.ts` for wiring, `warnings.ts` for violation content, `reference-tool.ts` for topic loading.

---

## Task 1: Debug Monitor State Machine

**Files:**
- Create: `extensions/workflow-monitor/debug-monitor.ts`
- Test: `tests/extension/workflow-monitor/debug-monitor.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/extension/workflow-monitor/debug-monitor.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { DebugMonitor } from "../../../extensions/workflow-monitor/debug-monitor";

describe("DebugMonitor", () => {
  let monitor: DebugMonitor;

  beforeEach(() => {
    monitor = new DebugMonitor();
  });

  // --- Activation ---

  test("starts inactive", () => {
    expect(monitor.isActive()).toBe(false);
  });

  test("activates on test failure", () => {
    monitor.onTestFailed();
    expect(monitor.isActive()).toBe(true);
  });

  test("does not activate on test pass", () => {
    monitor.onTestPassed();
    expect(monitor.isActive()).toBe(false);
  });

  // --- Investigation tracking ---

  test("starts without investigation", () => {
    monitor.onTestFailed();
    expect(monitor.hasInvestigated()).toBe(false);
  });

  test("marks investigated on file read", () => {
    monitor.onTestFailed();
    monitor.onInvestigation();
    expect(monitor.hasInvestigated()).toBe(true);
  });

  test("investigation resets after fix-fail cycle", () => {
    monitor.onTestFailed();
    monitor.onInvestigation();
    monitor.onSourceWritten("src/foo.ts");
    monitor.onTestFailed(); // failed fix
    expect(monitor.hasInvestigated()).toBe(false);
  });

  // --- Fix attempt counting ---

  test("starts with 0 fix attempts", () => {
    expect(monitor.getFixAttempts()).toBe(0);
  });

  test("increments fix attempts on source-write then test-fail cycle", () => {
    monitor.onTestFailed();         // initial failure
    monitor.onInvestigation();
    monitor.onSourceWritten("src/foo.ts");
    monitor.onTestFailed();         // fix attempt failed
    expect(monitor.getFixAttempts()).toBe(1);
  });

  test("does not increment without source write", () => {
    monitor.onTestFailed();
    monitor.onTestFailed(); // no source edit between failures
    expect(monitor.getFixAttempts()).toBe(0);
  });

  test("tracks multiple fix attempts", () => {
    monitor.onTestFailed();
    monitor.onInvestigation();
    monitor.onSourceWritten("src/foo.ts");
    monitor.onTestFailed(); // attempt 1
    monitor.onInvestigation();
    monitor.onSourceWritten("src/foo.ts");
    monitor.onTestFailed(); // attempt 2
    monitor.onSourceWritten("src/foo.ts");
    monitor.onTestFailed(); // attempt 3
    expect(monitor.getFixAttempts()).toBe(3);
  });

  // --- Violation detection ---

  test("returns fix-without-investigation violation", () => {
    monitor.onTestFailed();
    const violation = monitor.onSourceWritten("src/foo.ts");
    expect(violation).not.toBeNull();
    expect(violation?.type).toBe("fix-without-investigation");
  });

  test("no violation when investigated first", () => {
    monitor.onTestFailed();
    monitor.onInvestigation();
    const violation = monitor.onSourceWritten("src/foo.ts");
    expect(violation).toBeNull();
  });

  test("returns excessive-fix-attempts violation at 3+", () => {
    monitor.onTestFailed();
    monitor.onInvestigation();
    monitor.onSourceWritten("src/foo.ts");
    monitor.onTestFailed(); // 1
    monitor.onInvestigation();
    monitor.onSourceWritten("src/foo.ts");
    monitor.onTestFailed(); // 2
    monitor.onInvestigation();
    monitor.onSourceWritten("src/foo.ts");
    monitor.onTestFailed(); // 3
    monitor.onInvestigation();
    const violation = monitor.onSourceWritten("src/bar.ts");
    expect(violation).not.toBeNull();
    expect(violation?.type).toBe("excessive-fix-attempts");
  });

  test("no violation when not active", () => {
    const violation = monitor.onSourceWritten("src/foo.ts");
    expect(violation).toBeNull();
  });

  // --- Reset ---

  test("resets on test pass", () => {
    monitor.onTestFailed();
    monitor.onInvestigation();
    monitor.onSourceWritten("src/foo.ts");
    monitor.onTestFailed(); // attempt 1
    monitor.onTestPassed();
    expect(monitor.isActive()).toBe(false);
    expect(monitor.getFixAttempts()).toBe(0);
  });

  test("resets on commit", () => {
    monitor.onTestFailed();
    monitor.onSourceWritten("src/foo.ts");
    monitor.onCommit();
    expect(monitor.isActive()).toBe(false);
    expect(monitor.getFixAttempts()).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/workflow-monitor/debug-monitor.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// extensions/workflow-monitor/debug-monitor.ts
import { isSourceFile } from "./heuristics";

export type DebugViolationType = "fix-without-investigation" | "excessive-fix-attempts";

export interface DebugViolation {
  type: DebugViolationType;
  file: string;
  fixAttempts: number;
}

export class DebugMonitor {
  private active = false;
  private investigated = false;
  private fixAttempts_ = 0;
  private sourceWrittenSinceLastTest = false;

  isActive(): boolean {
    return this.active;
  }

  hasInvestigated(): boolean {
    return this.investigated;
  }

  getFixAttempts(): number {
    return this.fixAttempts_;
  }

  onTestFailed(): void {
    if (this.active && this.sourceWrittenSinceLastTest) {
      this.fixAttempts_++;
    }
    this.active = true;
    this.investigated = false;
    this.sourceWrittenSinceLastTest = false;
  }

  onTestPassed(): void {
    this.reset();
  }

  onInvestigation(): void {
    this.investigated = true;
  }

  onSourceWritten(path: string): DebugViolation | null {
    if (!this.active) return null;
    if (!isSourceFile(path)) return null;

    this.sourceWrittenSinceLastTest = true;

    if (this.fixAttempts_ >= 3) {
      return {
        type: "excessive-fix-attempts",
        file: path,
        fixAttempts: this.fixAttempts_,
      };
    }

    if (!this.investigated) {
      return {
        type: "fix-without-investigation",
        file: path,
        fixAttempts: this.fixAttempts_,
      };
    }

    return null;
  }

  onCommit(): void {
    this.reset();
  }

  private reset(): void {
    this.active = false;
    this.investigated = false;
    this.fixAttempts_ = 0;
    this.sourceWrittenSinceLastTest = false;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/workflow-monitor/debug-monitor.test.ts`
Expected: all PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor/debug-monitor.ts tests/extension/workflow-monitor/debug-monitor.test.ts
git commit -m "feat: add debug monitor state machine"
```

---

## Task 2: Investigation Signal Detection

**Files:**
- Create: `extensions/workflow-monitor/investigation.ts`
- Test: `tests/extension/workflow-monitor/investigation.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/extension/workflow-monitor/investigation.test.ts
import { describe, test, expect } from "vitest";
import { isInvestigationCommand } from "../../../extensions/workflow-monitor/investigation";

describe("isInvestigationCommand", () => {
  // grep variants
  test("matches grep", () => {
    expect(isInvestigationCommand("grep -rn 'error' src/")).toBe(true);
  });
  test("matches rg (ripgrep)", () => {
    expect(isInvestigationCommand("rg 'pattern' src/")).toBe(true);
  });
  test("matches ag (silver searcher)", () => {
    expect(isInvestigationCommand("ag 'pattern' src/")).toBe(true);
  });

  // git investigation
  test("matches git log", () => {
    expect(isInvestigationCommand("git log --oneline -10")).toBe(true);
  });
  test("matches git diff", () => {
    expect(isInvestigationCommand("git diff HEAD~1")).toBe(true);
  });
  test("matches git show", () => {
    expect(isInvestigationCommand("git show abc123")).toBe(true);
  });
  test("matches git blame", () => {
    expect(isInvestigationCommand("git blame src/foo.ts")).toBe(true);
  });

  // directory/file inspection
  test("matches find", () => {
    expect(isInvestigationCommand("find src -name '*.ts'")).toBe(true);
  });
  test("matches ls", () => {
    expect(isInvestigationCommand("ls -la src/")).toBe(true);
  });
  test("matches cat", () => {
    expect(isInvestigationCommand("cat src/foo.ts")).toBe(true);
  });
  test("matches head/tail", () => {
    expect(isInvestigationCommand("head -20 src/foo.ts")).toBe(true);
    expect(isInvestigationCommand("tail -50 src/foo.ts")).toBe(true);
  });

  // diagnostic instrumentation
  test("matches echo (diagnostic output)", () => {
    expect(isInvestigationCommand("echo $PATH")).toBe(true);
  });
  test("matches env/printenv", () => {
    expect(isInvestigationCommand("env | grep NODE")).toBe(true);
    expect(isInvestigationCommand("printenv NODE_ENV")).toBe(true);
  });

  // NOT investigation
  test("does not match test commands", () => {
    expect(isInvestigationCommand("npx vitest run")).toBe(false);
    expect(isInvestigationCommand("npm test")).toBe(false);
    expect(isInvestigationCommand("pytest")).toBe(false);
  });
  test("does not match build commands", () => {
    expect(isInvestigationCommand("npm run build")).toBe(false);
    expect(isInvestigationCommand("tsc")).toBe(false);
  });
  test("does not match git commit", () => {
    expect(isInvestigationCommand("git commit -m 'fix'")).toBe(false);
  });
  test("does not match git add", () => {
    expect(isInvestigationCommand("git add .")).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/workflow-monitor/investigation.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// extensions/workflow-monitor/investigation.ts
const INVESTIGATION_PATTERNS = [
  // Search tools
  /\bgrep\b/,
  /\brg\b/,
  /\bag\b/,
  // Git investigation (not commit/add/push)
  /\bgit\s+(log|diff|show|blame)\b/,
  // File/directory inspection
  /\bfind\b/,
  /\bls\b/,
  /\bcat\b/,
  /\bhead\b/,
  /\btail\b/,
  /\bless\b/,
  /\bwc\b/,
  // Diagnostic
  /\becho\b/,
  /\bprintf\b/,
  /\benv\b/,
  /\bprintenv\b/,
];

export function isInvestigationCommand(command: string): boolean {
  return INVESTIGATION_PATTERNS.some((p) => p.test(command));
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/workflow-monitor/investigation.test.ts`
Expected: all PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor/investigation.ts tests/extension/workflow-monitor/investigation.test.ts
git commit -m "feat: add investigation signal detection"
```

---

## Task 3: Debug Warning Content

**Files:**
- Modify: `extensions/workflow-monitor/warnings.ts`
- Modify: `tests/extension/workflow-monitor/warnings.test.ts`

**Step 1: Write the failing tests**

Add to existing `warnings.test.ts`:

```typescript
import { getDebugViolationWarning } from "../../../extensions/workflow-monitor/warnings";

describe("getDebugViolationWarning", () => {
  test("returns fix-without-investigation warning", () => {
    const warning = getDebugViolationWarning("fix-without-investigation", "src/foo.ts", 0);
    expect(warning).toContain("DEBUG VIOLATION");
    expect(warning).toContain("src/foo.ts");
    expect(warning).toContain("investigating");
  });

  test("returns excessive-fix-attempts warning with count", () => {
    const warning = getDebugViolationWarning("excessive-fix-attempts", "src/foo.ts", 3);
    expect(warning).toContain("fix attempt #3");
    expect(warning).toContain("architecture");
    expect(warning).toContain("human partner");
  });

  test("returns excessive-fix-attempts warning with higher count", () => {
    const warning = getDebugViolationWarning("excessive-fix-attempts", "src/foo.ts", 5);
    expect(warning).toContain("fix attempt #5");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/workflow-monitor/warnings.test.ts`
Expected: FAIL — `getDebugViolationWarning` not exported

**Step 3: Write the implementation**

Add to `warnings.ts`:

```typescript
export type TddViolationType = "source-before-test" | "source-during-red";
export type DebugViolationType = "fix-without-investigation" | "excessive-fix-attempts";

export function getDebugViolationWarning(
  type: DebugViolationType,
  file: string,
  fixAttempts: number
): string {
  if (type === "fix-without-investigation") {
    return `
⚠️ DEBUG VIOLATION: You edited production code (${file}) without investigating first.

The Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.

Before editing code, you must:
1. Read the error messages and stack traces carefully
2. Read the relevant source files to understand the code
3. Trace the data flow to find where the bad value originates

You're treating symptoms, not causes. Symptom fixes create new bugs.

Stop. Read. Understand. Then fix.
`.trim();
  }

  if (type === "excessive-fix-attempts") {
    return `
⚠️ DEBUG WARNING: This is fix attempt #${fixAttempts} for ${file}. Previous attempts failed.

When 3+ fixes fail, this is NOT a failed hypothesis — it's a wrong architecture.

Pattern indicating architectural problem:
- Each fix reveals new problems in different places
- Fixes require "massive refactoring" to implement
- Each fix creates new symptoms elsewhere

STOP and question fundamentals:
- Is this pattern fundamentally sound?
- Are we sticking with it through sheer inertia?
- Should we refactor architecture vs. continue fixing symptoms?

Discuss with your human partner before attempting more fixes.
`.trim();
  }

  return `⚠️ DEBUG WARNING: Unexpected violation type "${type}" for ${file}`;
}
```

Also update `getTddViolationWarning` signature to use `TddViolationType` instead of `string` (review issue #4).

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/workflow-monitor/warnings.test.ts`
Expected: all PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor/warnings.ts tests/extension/workflow-monitor/warnings.test.ts
git commit -m "feat: add debug violation warnings, type-narrow TDD warnings"
```

---

## Task 4: Wire Debug Monitor into WorkflowHandler

**Files:**
- Modify: `extensions/workflow-monitor/workflow-handler.ts`
- Modify: `tests/extension/workflow-monitor/workflow-monitor.test.ts`

**Step 1: Write the failing tests**

Add to existing `workflow-monitor.test.ts`:

```typescript
  // --- Debug monitor integration ---

  test("activates debug mode on test failure", () => {
    handler.handleBashResult("npx vitest run", "1 failing", 1);
    expect(handler.isDebugActive()).toBe(true);
  });

  test("detects fix-without-investigation on source write after test failure", () => {
    handler.handleBashResult("npx vitest run", "1 failing", 1);
    const result = handler.handleToolCall("edit", { path: "src/foo.ts", oldText: "a", newText: "b" });
    expect(result.violation?.type).toBe("fix-without-investigation");
  });

  test("no debug violation when investigated first", () => {
    handler.handleBashResult("npx vitest run", "1 failing", 1);
    handler.handleReadOrInvestigation("read", "src/foo.ts");
    const result = handler.handleToolCall("edit", { path: "src/foo.ts", oldText: "a", newText: "b" });
    expect(result.violation).toBeNull();
  });

  test("no debug violation when investigation bash command used", () => {
    handler.handleBashResult("npx vitest run", "1 failing", 1);
    handler.handleBashInvestigation("grep -rn 'error' src/");
    const result = handler.handleToolCall("edit", { path: "src/foo.ts", oldText: "a", newText: "b" });
    expect(result.violation).toBeNull();
  });

  test("tracks fix attempts across cycles", () => {
    handler.handleBashResult("npx vitest run", "1 failing", 1); // initial fail
    handler.handleReadOrInvestigation("read", "src/foo.ts");
    handler.handleToolCall("edit", { path: "src/foo.ts", oldText: "a", newText: "b" });
    handler.handleBashResult("npx vitest run", "1 failing", 1); // attempt 1
    handler.handleReadOrInvestigation("read", "src/foo.ts");
    handler.handleToolCall("edit", { path: "src/foo.ts", oldText: "b", newText: "c" });
    handler.handleBashResult("npx vitest run", "1 failing", 1); // attempt 2
    handler.handleReadOrInvestigation("read", "src/foo.ts");
    handler.handleToolCall("edit", { path: "src/foo.ts", oldText: "c", newText: "d" });
    handler.handleBashResult("npx vitest run", "1 failing", 1); // attempt 3
    handler.handleReadOrInvestigation("read", "src/foo.ts");
    const result = handler.handleToolCall("edit", { path: "src/foo.ts", oldText: "d", newText: "e" });
    expect(result.violation?.type).toBe("excessive-fix-attempts");
  });

  test("debug resets on test pass", () => {
    handler.handleBashResult("npx vitest run", "1 failing", 1);
    handler.handleReadOrInvestigation("read", "src/foo.ts");
    handler.handleToolCall("edit", { path: "src/foo.ts", oldText: "a", newText: "b" });
    handler.handleBashResult("npx vitest run", "1 passing", 0); // pass
    expect(handler.isDebugActive()).toBe(false);
  });

  test("debug resets on commit", () => {
    handler.handleBashResult("npx vitest run", "1 failing", 1);
    handler.handleBashResult("git commit -m 'fix'", "", 0);
    expect(handler.isDebugActive()).toBe(false);
  });

  test("widget shows debug state when active", () => {
    handler.handleBashResult("npx vitest run", "1 failing", 1);
    expect(handler.getWidgetText()).toContain("Debug");
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/workflow-monitor/workflow-monitor.test.ts`
Expected: FAIL — `isDebugActive`, `handleReadOrInvestigation`, `handleBashInvestigation` not on handler

**Step 3: Write the implementation**

Update `workflow-handler.ts` to integrate DebugMonitor:

```typescript
import { TddMonitor, type TddViolation } from "./tdd-monitor";
import { DebugMonitor, type DebugViolation } from "./debug-monitor";
import { parseTestCommand, parseTestResult } from "./test-runner";
import { isInvestigationCommand } from "./investigation";
import { isSourceFile } from "./heuristics";

export type Violation = TddViolation | DebugViolation;

export interface ToolCallResult {
  violation: Violation | null;
}

export interface WorkflowHandler {
  handleToolCall(toolName: string, input: Record<string, any>): ToolCallResult;
  handleBashResult(command: string, output: string, exitCode: number | undefined): void;
  handleReadOrInvestigation(toolName: string, path: string): void;
  handleBashInvestigation(command: string): void;
  getTddPhase(): string;
  isDebugActive(): boolean;
  getDebugFixAttempts(): number;
  getWidgetText(): string;
  getTddState(): ReturnType<TddMonitor["getState"]>;
  restoreTddState(phase: any, testFiles: string[], sourceFiles: string[]): void;
}

export function createWorkflowHandler(): WorkflowHandler {
  const tdd = new TddMonitor();
  const debug = new DebugMonitor();

  return {
    handleToolCall(toolName: string, input: Record<string, any>): ToolCallResult {
      if (toolName === "write" || toolName === "edit") {
        const path = input.path as string | undefined;
        if (path) {
          // Check debug violations first (debug is more specific context)
          const debugViolation = debug.onSourceWritten(path);
          if (debugViolation) return { violation: debugViolation };

          // Then TDD violations
          const tddViolation = tdd.onFileWritten(path);
          if (tddViolation) return { violation: tddViolation };
        }
      }
      return { violation: null };
    },

    handleBashResult(command: string, output: string, exitCode: number | undefined): void {
      if (/\bgit\s+commit\b/.test(command)) {
        tdd.onCommit();
        debug.onCommit();
        return;
      }

      if (parseTestCommand(command)) {
        const passed = parseTestResult(output, exitCode);
        if (passed === true) {
          tdd.onTestResult(true);
          debug.onTestPassed();
        } else if (passed === false) {
          tdd.onTestResult(false);
          debug.onTestFailed();
        }
      }

      // Check investigation signals for debug monitor
      if (isInvestigationCommand(command)) {
        debug.onInvestigation();
      }
    },

    handleReadOrInvestigation(toolName: string, _path: string): void {
      if (toolName === "read") {
        debug.onInvestigation();
      }
    },

    handleBashInvestigation(command: string): void {
      if (isInvestigationCommand(command)) {
        debug.onInvestigation();
      }
    },

    getTddPhase(): string {
      return tdd.getPhase();
    },

    isDebugActive(): boolean {
      return debug.isActive();
    },

    getDebugFixAttempts(): number {
      return debug.getFixAttempts();
    },

    getWidgetText(): string {
      const parts: string[] = [];

      const phase = tdd.getPhase();
      if (phase !== "idle") {
        parts.push(`TDD: ${phase.toUpperCase()}`);
      }

      if (debug.isActive()) {
        const attempts = debug.getFixAttempts();
        if (attempts === 0) {
          parts.push("Debug: investigating");
        } else {
          parts.push(`Debug: ${attempts} fix attempt${attempts !== 1 ? "s" : ""}`);
        }
      }

      return parts.join("  |  ");
    },

    getTddState() {
      return tdd.getState();
    },

    restoreTddState(phase: any, testFiles: string[], sourceFiles: string[]) {
      tdd.setState(phase, testFiles, sourceFiles);
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/workflow-monitor/workflow-monitor.test.ts`
Expected: all PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor/workflow-handler.ts tests/extension/workflow-monitor/workflow-monitor.test.ts
git commit -m "feat: wire debug monitor into workflow handler"
```

---

## Task 5: Wire Debug Monitor into Extension Entry Point

**Files:**
- Modify: `extensions/workflow-monitor.ts`

This task also addresses review issues #2 (move pendingViolation into handler) and wires up the debug monitor's `read` tool and bash investigation hooks.

**Step 1: Update the extension**

Refactor `workflow-monitor.ts`:

```typescript
/**
 * Workflow Monitor Extension
 *
 * Observes tool_call and tool_result events to:
 * - Track TDD phase (RED→GREEN→REFACTOR) and inject warnings on violations
 * - Track debug fix-fail cycles and inject warnings on investigation skips / thrashing
 * - Show workflow state in TUI widget
 * - Register workflow_reference tool for on-demand reference content
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { createWorkflowHandler, type Violation } from "./workflow-monitor/workflow-handler";
import { getTddViolationWarning } from "./workflow-monitor/warnings";
import { getDebugViolationWarning, type DebugViolationType } from "./workflow-monitor/warnings";
import { loadReference, REFERENCE_TOPICS } from "./workflow-monitor/reference-tool";

export default function (pi: ExtensionAPI) {
  const handler = createWorkflowHandler();

  // Pending violation: set during tool_call, injected during tool_result
  // Scoped here because tool_call and tool_result fire sequentially per call.
  let pendingViolation: Violation | null = null;

  // --- State reconstruction on session events ---
  for (const event of [
    "session_start",
    "session_switch",
    "session_fork",
    "session_tree",
  ] as const) {
    pi.on(event, async (_event, ctx) => {
      handler.restoreTddState("idle", [], []);
      // Debug monitor resets implicitly (new handler would reset, but we reuse)
      updateWidget(ctx);
    });
  }

  // --- Tool call observation (detect file writes) ---
  pi.on("tool_call", async (event, _ctx) => {
    const result = handler.handleToolCall(event.toolName, event.input as Record<string, any>);
    pendingViolation = result.violation;
  });

  // --- Tool result modification (inject warnings + track investigation) ---
  pi.on("tool_result", async (event, ctx) => {
    // Handle read tool as investigation signal
    if (event.toolName === "read") {
      const path = (event.input as Record<string, any>).path as string ?? "";
      handler.handleReadOrInvestigation("read", path);
    }

    // Inject violation warning on write/edit
    if ((event.toolName === "write" || event.toolName === "edit") && pendingViolation) {
      const violation = pendingViolation;
      pendingViolation = null;
      const warning = formatViolationWarning(violation);
      const existingText = event.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      updateWidget(ctx);
      return {
        content: [{ type: "text", text: `${existingText}\n\n${warning}` }],
      };
    }
    pendingViolation = null;

    // Handle bash results (test runs, commits, investigation)
    if (event.toolName === "bash") {
      const command = (event.input as Record<string, any>).command as string ?? "";
      const output = event.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const exitCode = (event.details as any)?.exitCode as number | undefined;
      handler.handleBashResult(command, output, exitCode);
    }

    updateWidget(ctx);
    return undefined;
  });

  // --- Format violation warning based on type ---
  function formatViolationWarning(violation: Violation): string {
    if (violation.type === "source-before-test" || violation.type === "source-during-red") {
      return getTddViolationWarning(violation.type, violation.file);
    }
    return getDebugViolationWarning(
      violation.type as DebugViolationType,
      violation.file,
      (violation as any).fixAttempts ?? 0
    );
  }

  // --- TUI Widget ---
  function updateWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const text = handler.getWidgetText();
    if (!text) {
      ctx.ui.setWidget("workflow_monitor", undefined);
    } else {
      ctx.ui.setWidget("workflow_monitor", (_tui, theme) => {
        const parts: string[] = [];

        // TDD phase
        const tddPhase = handler.getTddPhase().toUpperCase();
        if (tddPhase !== "IDLE") {
          const colorMap: Record<string, string> = {
            RED: "error",
            GREEN: "success",
            REFACTOR: "accent",
          };
          parts.push(theme.fg(colorMap[tddPhase] ?? "muted", `TDD: ${tddPhase}`));
        }

        // Debug state
        if (handler.isDebugActive()) {
          const attempts = handler.getDebugFixAttempts();
          if (attempts >= 3) {
            parts.push(theme.fg("error", `Debug: ${attempts} fix attempts ⚠️`));
          } else if (attempts > 0) {
            parts.push(theme.fg("warning", `Debug: ${attempts} fix attempt${attempts !== 1 ? "s" : ""}`));
          } else {
            parts.push(theme.fg("accent", "Debug: investigating"));
          }
        }

        return parts.length > 0
          ? new Text(parts.join(theme.fg("dim", "  |  ")), 0, 0)
          : undefined;
      });
    }
  }

  // --- Reference Tool ---
  pi.registerTool({
    name: "workflow_reference",
    label: "Workflow Reference",
    description: `Detailed guidance for workflow skills. Topics: ${REFERENCE_TOPICS.join(", ")}`,
    parameters: Type.Object({
      topic: StringEnum(REFERENCE_TOPICS as unknown as readonly [string, ...string[]], {
        description: "Reference topic to load",
      }),
    }),
    async execute(_toolCallId, params) {
      const content = await loadReference(params.topic);
      return {
        content: [{ type: "text", text: content }],
        details: { topic: params.topic },
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("workflow_reference "));
      text += theme.fg("accent", args.topic);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const topic = (result.details as any)?.topic ?? "unknown";
      const content = result.content[0];
      const len = content?.type === "text" ? content.text.length : 0;
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("muted", `${topic} (${len} chars)`),
        0,
        0
      );
    },
  });
}
```

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: all PASS

**Step 3: Commit**

```bash
git add extensions/workflow-monitor.ts
git commit -m "feat: wire debug monitor into extension, fix pendingViolation scoping"
```

---

## Task 6: Review Issue #1 — Warn on Source Write During RED Phase

**Files:**
- Modify: `extensions/workflow-monitor/tdd-monitor.ts`
- Modify: `extensions/workflow-monitor/warnings.ts`
- Modify: `tests/extension/workflow-monitor/tdd-monitor.test.ts`
- Modify: `tests/extension/workflow-monitor/warnings.test.ts`

**Step 1: Write the failing tests**

Add to `tdd-monitor.test.ts`:

```typescript
  test("returns source-during-red violation when source written in red phase", () => {
    monitor.onFileWritten("src/utils.test.ts"); // → RED
    const violation = monitor.onFileWritten("src/utils.ts");
    expect(violation).not.toBeNull();
    expect(violation?.type).toBe("source-during-red");
  });
```

Add to `warnings.test.ts`:

```typescript
  test("returns source-during-red warning", () => {
    const warning = getTddViolationWarning("source-during-red", "src/utils.ts");
    expect(warning).toContain("RED phase");
    expect(warning).toContain("run your failing test");
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/workflow-monitor/tdd-monitor.test.ts tests/extension/workflow-monitor/warnings.test.ts`
Expected: FAIL — no `source-during-red` violation returned; no such warning type

**Step 3: Write the implementation**

In `tdd-monitor.ts`, update `onFileWritten` — when in RED phase and source is written, return a `source-during-red` violation:

```typescript
  onFileWritten(path: string): TddViolation | null {
    if (isTestFile(path)) {
      this.testFilesWritten.add(path);
      if (this.phase === "idle") {
        this.phase = "red";
      }
      return null;
    }

    if (isSourceFile(path)) {
      this.sourceFilesWritten.add(path);

      if (this.testFilesWritten.size === 0) {
        return { type: "source-before-test", file: path };
      }

      if (this.phase === "red") {
        return { type: "source-during-red", file: path };
      }

      if (this.phase === "green") {
        this.phase = "refactor";
      }
      return null;
    }

    return null;
  }
```

Update `TddViolation` type:

```typescript
export interface TddViolation {
  type: "source-before-test" | "source-during-red";
  file: string;
}
```

In `warnings.ts`, add `source-during-red` case to `getTddViolationWarning`:

```typescript
  if (type === "source-during-red") {
    return `
⚠️ TDD VIOLATION: You wrote production code (${file}) during RED phase.

You wrote a test but haven't run it yet. Run your failing test first.

The TDD cycle: Write test → Run it (RED) → Write code → Run it (GREEN)

You're in RED. Run the test. Watch it fail. THEN write the production code.
`.trim();
  }
```

Update `getTddViolationWarning` signature to use `TddViolationType`:

```typescript
export function getTddViolationWarning(type: TddViolationType, file: string): string {
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor/tdd-monitor.ts extensions/workflow-monitor/warnings.ts \
  tests/extension/workflow-monitor/tdd-monitor.test.ts tests/extension/workflow-monitor/warnings.test.ts
git commit -m "fix: warn on source write during RED phase (review issue #1)"
```

---

## Task 7: Review Issue #3 — Fix Package Root Discovery

**Files:**
- Modify: `extensions/workflow-monitor/reference-tool.ts`
- Modify: `tests/extension/workflow-monitor/reference-tool.test.ts`

**Step 1: Write the failing test**

Add to `reference-tool.test.ts`:

```typescript
  test("resolves reference paths relative to package structure", async () => {
    // loadReference should find files without walking up to wrong package.json
    const content = await loadReference("tdd-rationalizations");
    expect(content).not.toContain("file not found");
  });
```

(This test already exists and passes, but validates the fix doesn't break anything.)

**Step 2: Update the implementation**

Replace `getPackageRoot()` in `reference-tool.ts` with `import.meta.url`-based resolution:

```typescript
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

// extensions/workflow-monitor/reference-tool.ts is 2 levels below package root
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
```

Remove the `getPackageRoot()` function and `accessSync` import. Update `loadReference` to use `PACKAGE_ROOT` constant.

**Step 3: Run tests to verify they pass**

Run: `npx vitest run tests/extension/workflow-monitor/reference-tool.test.ts`
Expected: all PASS

**Step 4: Commit**

```bash
git add extensions/workflow-monitor/reference-tool.ts tests/extension/workflow-monitor/reference-tool.test.ts
git commit -m "fix: resolve package root via import.meta.url (review issue #3)"
```

---

## Task 8: Extract Debug Reference Content

**Files:**
- Create: `skills/systematic-debugging/reference/rationalizations.md`
- Modify: `extensions/workflow-monitor/reference-tool.ts`

**Step 1: Create reference file**

Extract from current `SKILL.md` into `skills/systematic-debugging/reference/rationalizations.md`:

```markdown
# Debugging Rationalizations & Red Flags

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll write test after confirming fix works" | Untested fixes don't stick. Test first proves it. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question pattern, don't fix again. |

## Red Flags — STOP and Follow Process

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Pattern says X but I'll adapt it differently"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- "One more fix attempt" (when already tried 2+)
- Each fix reveals new problem in different place

**ALL of these mean: STOP. Return to Phase 1.**

**If 3+ fixes failed:** Question the architecture (see Phase 4.5)

## Your Human Partner's Signals You're Doing It Wrong

**Watch for these redirections:**
- "Is that not happening?" — You assumed without verifying
- "Will it show us...?" — You should have added evidence gathering
- "Stop guessing" — You're proposing fixes without understanding
- "Ultrathink this" — Question fundamentals, not just symptoms
- "We're stuck?" (frustrated) — Your approach isn't working

**When you see these:** STOP. Return to Phase 1.

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Create test, fix, verify | Bug resolved, tests pass |

## Real-World Impact

From debugging sessions:
- Systematic approach: 15-30 minutes to fix
- Random fixes approach: 2-3 hours of thrashing
- First-time fix rate: 95% vs 40%
- New bugs introduced: Near zero vs common
```

**Step 2: Wire into reference tool**

Add to `TOPIC_MAP` in `reference-tool.ts`:

```typescript
  "debug-rationalizations": "skills/systematic-debugging/reference/rationalizations.md",
  "debug-tracing": "skills/systematic-debugging/root-cause-tracing.md",
  "debug-defense-in-depth": "skills/systematic-debugging/defense-in-depth.md",
  "debug-condition-waiting": "skills/systematic-debugging/condition-based-waiting.md",
```

**Step 3: Add test**

Add to `reference-tool.test.ts`:

```typescript
  test("loads debug-rationalizations topic", async () => {
    const content = await loadReference("debug-rationalizations");
    expect(content).toContain("Rationalizations");
    expect(content).not.toContain("file not found");
  });

  test("loads debug-tracing topic", async () => {
    const content = await loadReference("debug-tracing");
    expect(content).toContain("Root Cause");
    expect(content).not.toContain("file not found");
  });

  test("loads debug-defense-in-depth topic", async () => {
    const content = await loadReference("debug-defense-in-depth");
    expect(content).toContain("Defense");
    expect(content).not.toContain("file not found");
  });

  test("loads debug-condition-waiting topic", async () => {
    const content = await loadReference("debug-condition-waiting");
    expect(content).toContain("condition");
    expect(content).not.toContain("file not found");
  });
```

**Step 4: Run tests**

Run: `npx vitest run`
Expected: all PASS

**Step 5: Commit**

```bash
git add skills/systematic-debugging/reference/rationalizations.md \
  extensions/workflow-monitor/reference-tool.ts \
  tests/extension/workflow-monitor/reference-tool.test.ts
git commit -m "feat: extract debug reference content, wire into reference tool"
```

---

## Task 9: Lean the Systematic Debugging Skill

**Files:**
- Modify: `skills/systematic-debugging/SKILL.md`

**Step 1: Rewrite SKILL.md**

Target: ~150 lines. Keep iron law, 4 phases (condensed), 3+ fix rule, supporting techniques, cross-references. Remove rationalization table, red flags, human partner signals, quick reference table, real-world impact, verbose multi-component example.

```markdown
---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---

> **Related skills:** Write a failing test for the bug with `/skill:test-driven-development`. Verify the fix with `/skill:verification-before-completion`.

# Systematic Debugging

## Overview

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

> The workflow-monitor extension actively tracks your debugging: it detects fix-without-investigation and counts failed fix attempts. Use `workflow_reference` with debug topics for detailed guidance.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## When to Use

Use for ANY technical issue: test failures, bugs, unexpected behavior, performance problems, build failures, integration issues.

**Use this ESPECIALLY when:**
- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You've already tried multiple fixes
- Previous fix didn't work
- You don't fully understand the issue

**Don't skip when:**
- Issue seems simple (simple bugs have root causes too)
- You're in a hurry (rushing guarantees rework)

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

1. **Read Error Messages Carefully** — Don't skip past errors or warnings. Read stack traces completely. Note line numbers, file paths, error codes.

2. **Reproduce Consistently** — Can you trigger it reliably? What are the exact steps? If not reproducible → gather more data, don't guess.

3. **Check Recent Changes** — Git diff, recent commits, new dependencies, config changes, environmental differences.

4. **Gather Evidence in Multi-Component Systems** — For each component boundary: log what enters, what exits, verify config propagation. Run once to see WHERE it breaks, then investigate that component.

5. **Trace Data Flow** — Where does the bad value originate? What called this with the bad value? Keep tracing up until you find the source. Fix at source, not at symptom. See `root-cause-tracing.md` for the complete technique.

### Phase 2: Pattern Analysis

1. **Find Working Examples** — Locate similar working code in same codebase.
2. **Compare Against References** — Read reference implementation COMPLETELY. Don't skim.
3. **Identify Differences** — List every difference, however small. Don't assume "that can't matter."
4. **Understand Dependencies** — What components, settings, config, environment does this need?

### Phase 3: Hypothesis and Testing

1. **Form Single Hypothesis** — State clearly: "I think X is the root cause because Y." Be specific, not vague.
2. **Test Minimally** — Make the SMALLEST possible change. One variable at a time. Don't fix multiple things at once.
3. **Verify Before Continuing** — Did it work? Yes → Phase 4. No → Form NEW hypothesis. DON'T add more fixes on top.

### Phase 4: Implementation

1. **Create Failing Test Case** — Use `/skill:test-driven-development` for writing proper failing tests. MUST have before fixing.

2. **Implement Single Fix** — ONE change at a time. No "while I'm here" improvements. No bundled refactoring.

3. **Verify Fix** — Test passes? No other tests broken? Issue actually resolved?

4. **If Fix Doesn't Work:**
   - If < 3 attempts: Return to Phase 1, re-analyze with new information
   - **If ≥ 3 attempts: STOP (see below)**

### When 3+ Fixes Fail: Question Architecture

**This is NOT a failed hypothesis — it's a wrong architecture.**

Pattern indicating architectural problem:
- Each fix reveals new shared state/coupling in different places
- Fixes require "massive refactoring" to implement
- Each fix creates new symptoms elsewhere

**STOP and question fundamentals:**
- Is this pattern fundamentally sound?
- Are we sticking with it through sheer inertia?
- Should we refactor architecture vs. continue fixing symptoms?

**Discuss with your human partner before attempting more fixes.**

## When Process Reveals "No Root Cause"

If investigation reveals issue is truly environmental, timing-dependent, or external:
1. Document what you investigated
2. Implement appropriate handling (retry, timeout, error message)
3. Add monitoring/logging for future investigation

**But:** 95% of "no root cause" cases are incomplete investigation.

## Supporting Techniques

These techniques are part of systematic debugging and available in this directory:

- **`root-cause-tracing.md`** — Trace bugs backward through call stack to find original trigger
- **`defense-in-depth.md`** — Add validation at multiple layers after finding root cause
- **`condition-based-waiting.md`** — Replace arbitrary timeouts with condition polling

Use `workflow_reference` for: `debug-rationalizations`, `debug-tracing`, `debug-defense-in-depth`, `debug-condition-waiting`
```

**Step 2: Verify line count**

Run: `wc -l skills/systematic-debugging/SKILL.md`
Expected: ~140-155 lines

**Step 3: Commit**

```bash
git add skills/systematic-debugging/SKILL.md
git commit -m "feat: lean systematic-debugging skill (298 → ~150 lines)"
```

---

## Task 10: Final Integration Test + Docs

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: all PASS

**Step 2: Update phase1-review-issues.md**

Mark issues #1, #2, #3, #4 as resolved. Note remaining deferred items.

**Step 3: Update README if needed**

Add debug monitor to the extension description if not already covered.

**Step 4: Final commit**

```bash
git add -A
git commit -m "docs: update review issues and README for phase 2"
```
