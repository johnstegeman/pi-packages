# v0.3.0 Cleanup Sprint Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Resolve all Biome lint warnings and all 10 code-review debt items in a single batch.

**Architecture:** Mechanical lint fixes first (auto-fix + selective suppress), then bottom-up monitor refactoring (TDD monitor → debug monitor → investigation → workflow-handler integration → heuristics cleanup), then docs.

**Tech Stack:** TypeScript, Vitest, Biome

---

## Phase 1: Biome Lint Cleanup (Tasks 1–2)

### Task 1: Auto-fixable Biome Issues

**Files:**
- Modify: `extensions/logging.ts:74` (useTemplate)
- Modify: `tests/extension/subagent/extensions-frontmatter.test.ts:9-10` (noNonNullAssertion)

**Step 1: Auto-fix template literals and non-null assertions**

Run:
```bash
npx biome check --write --unsafe
```

This will fix:
- `extensions/logging.ts:74` — string concatenation → template literal
- `tests/extension/subagent/extensions-frontmatter.test.ts:9-10` — `!` → optional chain or guard

**Step 2: Run tests to verify no regressions**

Run: `npm test`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add -A
git commit -m "fix: auto-fix biome lint warnings (template literals, non-null assertions)"
```

### Task 2: Suppress `noExplicitAny` at SDK Boundaries

**Files:**
- Modify: `extensions/tdd-guard.ts:43,51,75`
- Modify: `extensions/workflow-monitor/workflow-handler.ts:17`
- Modify: `extensions/workflow-monitor/workflow-tracker.ts:188-189`
- Modify: `tests/extension/subagent/structured-result.test.ts:14`
- Modify: `tests/extension/subagent/subagent-smoke.test.ts:12`
- Modify: `tests/extension/tdd-guard/tdd-guard-error-handling.test.ts:31,78`
- Modify: `tests/extension/workflow-monitor/workflow-widget.test.ts:8,10,15`

**Step 1: Add biome-ignore comments for SDK-boundary `any` types**

For each file, add `// biome-ignore lint/suspicious/noExplicitAny: pi SDK event type` above the offending line. Where a proper type exists (e.g. `Record<string, unknown>`), use that instead.

Rules:
- `event.input`, handler callbacks `(event: any, ctx: any)` → suppress (pi SDK boundary)
- Test mocks `as any` → suppress (test mocking boundary)
- `workflow-handler.ts:17` `Record<string, any>` → change to `Record<string, unknown>`
- `workflow-tracker.ts:188-189` — review whether `unknown` works; suppress if not

**Step 2: Verify zero warnings**

Run:
```bash
npx biome check 2>&1 | tail -5
```
Expected: `Found 0 warnings.` or no warnings line at all.

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add -A
git commit -m "fix: suppress noExplicitAny at SDK boundaries, fix remaining lint"
```

---

## Phase 2: TDD Monitor Redesign (Tasks 3–5)

### Task 3: Add `red-pending` Phase to TDD Monitor

**Files:**
- Modify: `extensions/workflow-monitor/tdd-monitor.ts`
- Modify: `tests/extension/workflow-monitor/tdd-monitor.test.ts`

**Step 1: Write failing tests for `red-pending` phase**

Add a new `describe("TddMonitor (red-pending phase)")` block to the test file:

```typescript
describe("TddMonitor (red-pending phase)", () => {
  let tdd: TddMonitor;

  beforeEach(() => {
    tdd = new TddMonitor();
  });

  test("transitions to red-pending (not red) when test file is written", () => {
    tdd.onFileWritten("src/utils.test.ts");
    expect(tdd.getPhase()).toBe("red-pending");
  });

  test("transitions from red-pending to red on first test run (fail)", () => {
    tdd.onFileWritten("src/utils.test.ts");
    tdd.onTestResult(false);
    expect(tdd.getPhase()).toBe("red");
  });

  test("transitions from red-pending to green on first test run (pass)", () => {
    tdd.onFileWritten("src/utils.test.ts");
    tdd.onTestResult(true);
    expect(tdd.getPhase()).toBe("green");
  });

  test("source edit in red-pending returns source-during-red violation", () => {
    tdd.onFileWritten("src/utils.test.ts");
    const violation = tdd.onFileWritten("src/utils.ts");
    expect(violation?.type).toBe("source-during-red");
  });

  test("source edit in red (after test run) is allowed", () => {
    tdd.onFileWritten("src/utils.test.ts");
    tdd.onTestResult(false); // red-pending → red
    const violation = tdd.onFileWritten("src/utils.ts");
    expect(violation).toBeNull();
  });

  test("source edit in red stays in red", () => {
    tdd.onFileWritten("src/utils.test.ts");
    tdd.onTestResult(false);
    tdd.onFileWritten("src/utils.ts");
    expect(tdd.getPhase()).toBe("red");
  });

  test("new test file during red re-enters red-pending", () => {
    tdd.onFileWritten("tests/first.test.ts");
    tdd.onTestResult(false); // → red
    tdd.onFileWritten("tests/second.test.ts"); // → red-pending again
    expect(tdd.getPhase()).toBe("red-pending");
    const violation = tdd.onFileWritten("src/utils.ts");
    expect(violation?.type).toBe("source-during-red");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/extension/workflow-monitor/tdd-monitor.test.ts`
Expected: New tests FAIL (phase is `"red"` not `"red-pending"`).

**Step 3: Implement `red-pending` phase**

In `extensions/workflow-monitor/tdd-monitor.ts`:

1. Change type: `export type TddPhase = "idle" | "red-pending" | "red" | "green" | "refactor";`

2. In `onFileWritten()`, when a test file is written:
```typescript
if (isTestFile(path)) {
  this.testFilesWritten.add(path);
  this.phase = "red-pending";
  this.redVerificationPending = true;
  return null;
}
```

3. In `onFileWritten()`, the `source-during-red` check becomes:
```typescript
if (this.phase === "red-pending") {
  return { type: "source-during-red", file: path };
}
```

4. Source edits in `red` are allowed — no violation. But don't transition to refactor:
```typescript
if (this.phase === "green") {
  this.phase = "refactor";
}
// red phase: source edits allowed, stay in red
return null;
```

5. In `onTestResult()`:
```typescript
onTestResult(passed: boolean): void {
  if (this.phase === "red-pending") {
    this.redVerificationPending = false;
    if (passed) {
      this.phase = "green";
    } else {
      this.phase = "red";
    }
    return;
  }

  if (passed && (this.phase === "red" || this.phase === "refactor")) {
    this.phase = "green";
  }
}
```

**Step 4: Update existing tests that expect `"red"` instead of `"red-pending"`**

In the existing test file, update:
- `"transitions to red when test file is written"` → expect `"red-pending"`
- `"returns source-during-red violation when source written in red phase"` — this already tests `red-pending` behavior (test written, no test run), keep as-is but update the setup comment
- The RED verification semantics `describe` block's first test already tests the right thing. The second test (does NOT violate after test run) also works correctly. The third test (re-enters RED verification) needs to expect `"red-pending"`.

**Step 5: Run tests**

Run: `npm test -- tests/extension/workflow-monitor/tdd-monitor.test.ts`
Expected: All pass.

**Step 6: Commit**

```bash
git add extensions/workflow-monitor/tdd-monitor.ts tests/extension/workflow-monitor/tdd-monitor.test.ts
git commit -m "feat: add red-pending phase to TDD monitor"
```

### Task 4: Update Warning Text and Widget for `red-pending`

**Files:**
- Modify: `extensions/workflow-monitor/warnings.ts`
- Modify: `extensions/workflow-monitor.ts` (widget color map, ~line 685)
- Modify: `tests/extension/workflow-monitor/warnings.test.ts` (if exists, otherwise `workflow-widget.test.ts`)

**Step 1: Write failing test for updated warning text**

Check if `warnings.test.ts` exists. If so, add test there. Otherwise add to the widget test file. The test should verify:

```typescript
test("source-during-red warning mentions running the test first", () => {
  const warning = getTddViolationWarning("source-during-red", "src/foo.ts");
  expect(warning).toContain("Run your new test before editing source code");
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/extension/workflow-monitor/warnings.test.ts`
Expected: FAIL — current text doesn't contain this exact string.

**Step 3: Update warning text**

In `extensions/workflow-monitor/warnings.ts`, update the `source-during-red` block:

```typescript
if (type === "source-during-red") {
  return `
⚠️ TDD VIOLATION: You wrote production code (${file}) during RED-PENDING phase.

Run your new test before editing source code.

The TDD cycle: Write test → Run it (RED) → Write code → Run it (GREEN)

You wrote a test but haven't run it yet. Run the test suite now. Watch the new test fail. THEN write the production code.
`.trim();
}
```

**Step 4: Update widget color map**

In `extensions/workflow-monitor.ts` (~line 685), add `"RED-PENDING"` to the color map:

```typescript
const colorMap: Record<string, string> = {
  "RED-PENDING": "error",
  RED: "error",
  GREEN: "success",
  REFACTOR: "accent",
};
```

**Step 5: Run all tests**

Run: `npm test`
Expected: All pass.

**Step 6: Commit**

```bash
git add extensions/workflow-monitor/warnings.ts extensions/workflow-monitor.ts tests/
git commit -m "feat: update warning text and widget for red-pending phase"
```

### Task 5: DebugMonitor Defers to Active TDD

**Files:**
- Modify: `extensions/workflow-monitor/workflow-handler.ts`
- Modify: `tests/extension/workflow-monitor/workflow-monitor.test.ts`

**Step 1: Write failing test**

Add to `workflow-monitor.test.ts` (or a new `debug-tdd-interaction.test.ts`):

```typescript
describe("DebugMonitor defers to TDD", () => {
  test("debug monitor does not activate on test failure when TDD is active", () => {
    const handler = createWorkflowHandler();
    // Enter TDD red-pending
    handler.handleToolCall("write", { path: "tests/foo.test.ts" });
    // Run test, fails → red
    handler.handleBashResult("npx vitest run", "FAIL tests/foo.test.ts", 1);
    // Another failure should NOT activate debug
    handler.handleBashResult("npx vitest run", "FAIL tests/foo.test.ts", 1);
    expect(handler.isDebugActive()).toBe(false);
  });

  test("debug monitor activates on test failure when TDD is idle", () => {
    const handler = createWorkflowHandler();
    // No TDD activity — surprise failure
    handler.handleBashResult("npx vitest run", "FAIL tests/foo.test.ts", 1);
    handler.handleBashResult("npx vitest run", "FAIL tests/foo.test.ts", 1);
    expect(handler.isDebugActive()).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/extension/workflow-monitor/workflow-monitor.test.ts`
Expected: First test FAILS — debug activates even during TDD.

**Step 3: Implement the guard**

In `workflow-handler.ts`, in the `handleBashResult` method, where `debug.onTestFailed()` is called (~line that has `debugFailStreak >= 2`), add a TDD phase check:

```typescript
} else if (!excludeFromDebug) {
  debugFailStreak += 1;
  const tddPhase = tdd.getPhase();
  if (debugFailStreak >= 2 && tddPhase === "idle") {
    debug.onTestFailed();
  }
}
```

**Step 4: Run tests**

Run: `npm test`
Expected: All pass.

**Step 5: Commit**

```bash
git add extensions/workflow-monitor/workflow-handler.ts tests/
git commit -m "feat: debug monitor defers to active TDD phase"
```

---

## Phase 3: Investigation + Fix Counter + Heuristics (Tasks 6–8)

### Task 6: Expand Investigation Detection

**Files:**
- Modify: `extensions/workflow-monitor/investigation.ts`
- Modify: `tests/extension/workflow-monitor/investigation.test.ts`
- Modify: `extensions/workflow-monitor/workflow-handler.ts`

**Step 1: Write failing tests**

Add to `investigation.test.ts`:

```typescript
import { isInvestigationToolCall } from "../../../extensions/workflow-monitor/investigation";

describe("isInvestigationToolCall", () => {
  test("matches LSP definition action", () => {
    expect(isInvestigationToolCall("lsp", { action: "definition" })).toBe(true);
  });

  test("matches LSP references action", () => {
    expect(isInvestigationToolCall("lsp", { action: "references" })).toBe(true);
  });

  test("matches LSP hover action", () => {
    expect(isInvestigationToolCall("lsp", { action: "hover" })).toBe(true);
  });

  test("matches LSP symbols action", () => {
    expect(isInvestigationToolCall("lsp", { action: "symbols" })).toBe(true);
  });

  test("does not match LSP rename action", () => {
    expect(isInvestigationToolCall("lsp", { action: "rename" })).toBe(false);
  });

  test("matches kota_search", () => {
    expect(isInvestigationToolCall("kota_search", {})).toBe(true);
  });

  test("matches kota_deps", () => {
    expect(isInvestigationToolCall("kota_deps", {})).toBe(true);
  });

  test("matches kota_usages", () => {
    expect(isInvestigationToolCall("kota_usages", {})).toBe(true);
  });

  test("matches kota_impact", () => {
    expect(isInvestigationToolCall("kota_impact", {})).toBe(true);
  });

  test("matches web_search", () => {
    expect(isInvestigationToolCall("web_search", {})).toBe(true);
  });

  test("matches fetch_content", () => {
    expect(isInvestigationToolCall("fetch_content", {})).toBe(true);
  });

  test("does not match write tool", () => {
    expect(isInvestigationToolCall("write", {})).toBe(false);
  });

  test("does not match edit tool", () => {
    expect(isInvestigationToolCall("edit", {})).toBe(false);
  });
});
```

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/extension/workflow-monitor/investigation.test.ts`
Expected: FAIL — `isInvestigationToolCall` doesn't exist.

**Step 3: Implement `isInvestigationToolCall`**

In `extensions/workflow-monitor/investigation.ts`, add:

```typescript
const INVESTIGATION_TOOL_NAMES = new Set([
  "kota_search",
  "kota_deps",
  "kota_usages",
  "kota_impact",
  "kota_task_context",
  "web_search",
  "fetch_content",
]);

const INVESTIGATION_LSP_ACTIONS = new Set([
  "definition",
  "references",
  "hover",
  "symbols",
  "diagnostics",
  "workspace-diagnostics",
]);

export function isInvestigationToolCall(toolName: string, params?: Record<string, unknown>): boolean {
  if (INVESTIGATION_TOOL_NAMES.has(toolName)) return true;
  if (toolName === "lsp" && params?.action && INVESTIGATION_LSP_ACTIONS.has(params.action as string)) return true;
  return false;
}
```

**Step 4: Wire into workflow-handler**

In `workflow-handler.ts`, in `handleToolCall()`, before the write/edit check, add:

```typescript
// Track investigation from tool calls
if (isInvestigationToolCall(toolName, input as Record<string, unknown>)) {
  debug.onInvestigation();
}
```

And in `handleReadOrInvestigation()`, also check:

```typescript
handleReadOrInvestigation(toolName: string, _path: string): void {
  if (toolName === "read") {
    debug.onInvestigation();
  }
},
```

(This stays the same — `read` is already covered.)

Add import: `import { isInvestigationCommand, isInvestigationToolCall } from "./investigation";`

**Step 5: Run tests**

Run: `npm test`
Expected: All pass.

**Step 6: Commit**

```bash
git add extensions/workflow-monitor/investigation.ts extensions/workflow-monitor/workflow-handler.ts tests/
git commit -m "feat: expand investigation detection to LSP and kota tools"
```

### Task 7: Fix Attempt Counter Display Fix

**Files:**
- Modify: `extensions/workflow-monitor/warnings.ts`
- Modify: `tests/extension/workflow-monitor/warnings.test.ts` (or create one)

**Step 1: Write failing test**

```typescript
test("excessive-fix-attempts warning shows correct attempt count", () => {
  const warning = getDebugViolationWarning("excessive-fix-attempts", "src/foo.ts", 3);
  expect(warning).toContain("3 failed fix attempts");
  expect(warning).not.toContain("fix attempt #3");
});
```

**Step 2: Run test to verify failure**

Expected: FAIL — current text says `fix attempt #3`.

**Step 3: Update warning text**

In `warnings.ts`, update the `excessive-fix-attempts` block:

```typescript
if (type === "excessive-fix-attempts") {
  return `
⚠️ DEBUG WARNING: ${fixAttempts} failed fix attempts on ${file}.

${fixAttempts} fix attempts haven't resolved the issue. Consider stepping back to investigate root cause.

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
```

**Step 4: Run tests**

Run: `npm test`
Expected: All pass.

**Step 5: Commit**

```bash
git add extensions/workflow-monitor/warnings.ts tests/
git commit -m "fix: correct fix-attempt counter display in debug warnings"
```

### Task 8: Heuristics Cleanup

**Files:**
- Modify: `extensions/workflow-monitor/heuristics.ts`
- Modify: `tests/extension/workflow-monitor/heuristics.test.ts`
- Modify: `extensions/workflow-monitor/test-runner.ts`
- Modify: `tests/extension/workflow-monitor/test-runner.test.ts`

**Step 1: Write failing tests for tightened pass pattern**

In `test-runner.test.ts`, find or add:

```typescript
test("does not match bare 'passed' without numeric prefix", () => {
  expect(parseTestResult("All checks passed", 0)).toBe(true);
  // The pass-detection should rely on exit code, not bare "passed"
});
```

Review `parseTestResult` to understand how "passed" is used before making this change. The fix is: change any `/\bpassed\b/i` pattern to `/\d+\s+(tests?\s+)?passed/i`.

**Step 2: Deduplicate TEST_PATTERNS**

In `heuristics.ts`, the patterns `^tests?\//` and `\/tests?\//` overlap (the second matches everything the first does when the path has a leading segment). Simplify:

Current:
```typescript
/^tests?\//,
/\/__tests__\//,
/\/tests?\//,
```

Replace with:
```typescript
/(^|\/)tests?\//,
/\/__tests__\//,
```

**Step 3: Write a test verifying the deduplication didn't break anything**

```typescript
test("matches test directory paths", () => {
  expect(isTestFile("tests/foo.test.ts")).toBe(true);
  expect(isTestFile("test/foo.test.ts")).toBe(true);
  expect(isTestFile("src/tests/foo.test.ts")).toBe(true);
  expect(isTestFile("src/test/foo.test.ts")).toBe(true);
});
```

**Step 4: Run tests**

Run: `npm test`
Expected: All pass.

**Step 5: Commit**

```bash
git add extensions/workflow-monitor/heuristics.ts extensions/workflow-monitor/test-runner.ts tests/
git commit -m "fix: deduplicate test patterns, tighten pass-detection regex"
```

---

## Phase 4: Cleanup + Docs (Tasks 9–10)

### Task 9: Add `@internal` JSDoc to `handleBashInvestigation`

**Files:**
- Modify: `extensions/workflow-monitor/workflow-handler.ts`

**Step 1: Add JSDoc**

Above the `handleBashInvestigation` interface definition (~line 20):

```typescript
/** @internal Used in tests; will be wired to bash events in future */
handleBashInvestigation(command: string): void;
```

**Step 2: Run tests**

Run: `npm test`
Expected: All pass (no functional change).

**Step 3: Commit**

```bash
git add extensions/workflow-monitor/workflow-handler.ts
git commit -m "docs: mark handleBashInvestigation as @internal"
```

### Task 10: TDD State Machine Developer Reference

**Files:**
- Create: `docs/tdd-state-machine.md`

**Step 1: Write the reference doc**

```markdown
# TDD Monitor State Machine

Developer reference for the workflow-monitor extension's TDD phase tracking.

## Phases

| Phase | Meaning | Entry Condition |
|-------|---------|-----------------|
| `idle` | No TDD activity | Initial state, or after `git commit` |
| `red-pending` | Test written, not yet run | Test file written (write/edit to `*.test.*`) |
| `red` | Test run, failing | First test run after `red-pending` (fail result) |
| `green` | Tests passing | Test pass in `red`, `red-pending`, or `refactor` |
| `refactor` | Refactoring with green tests | Source file edit while in `green` |

## Transitions

```
idle ──[test file written]──→ red-pending
red-pending ──[test run, fail]──→ red
red-pending ──[test run, pass]──→ green
red ──[test pass]──→ green
red ──[test file written]──→ red-pending
green ──[source edit]──→ refactor
green ──[test file written]──→ red-pending
refactor ──[test pass]──→ green
any ──[git commit]──→ idle
```

## Violations

| Violation | Phase | Trigger | Meaning |
|-----------|-------|---------|---------|
| `source-before-test` | `idle` | Source file written with no test files in session | Wrote production code without any test context |
| `source-during-red` | `red-pending` | Source file written | Wrote production code before running the new test |

**Note:** Source edits in `red` phase (after test has been run) are allowed — the developer is making the failing test pass.

## DebugMonitor Interaction

The DebugMonitor only activates when TDD phase is `idle`. During active TDD (any phase ≠ `idle`), test failures are TDD's domain. This prevents false "fix-without-investigation" warnings during normal RED→GREEN work.
```

**Step 2: Commit**

```bash
git add docs/tdd-state-machine.md
git commit -m "docs: TDD state machine developer reference"
```

---

## Verification Checkpoint

After all 10 tasks:

```bash
# Full test suite
npm test

# Zero biome warnings
npx biome check

# Review all changes
git log --oneline v0.3.0/cleanup-sprint ^main
```

Expected:
- All tests pass
- Biome: 0 warnings, 0 errors
- ~10 clean commits
