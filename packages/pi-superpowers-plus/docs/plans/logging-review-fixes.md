# Plan: Address Code Review Feedback for Logging & Error Handling

## Context
Code review of `feat/logging-error-handling` branch identified 3 Important issues to fix before merge.

## Tasks

### Task 1: Replace brittle source inspection tests with behavioral tests

**Files to modify:**
- `tests/extension/subagent/index-error-handling.test.ts`
- `tests/extension/tdd-guard/tdd-guard-error-handling.test.ts`
- `tests/extension/workflow-monitor/reference-tool-error-handling.test.ts`

**What to do:**
- Remove tests that read source files and check for string patterns (e.g. `expect(source).toContain("log.debug")`)
- Replace with behavioral tests that:
  - Mock the logger module
  - Trigger actual error conditions (bad input, missing files, etc.)
  - Verify the mock logger was called with expected arguments
- Use `agents-error-handling.test.ts` as the reference pattern for how to write these correctly

**Done when:** All three test files use behavioral assertions, no source file reading, all tests pass.

### Task 2: Fix log rotation for long-running processes

**Files to modify:**
- `extensions/logging.ts`
- `tests/extension/logging.test.ts`

**What to do:**
- Replace the `rotatedThisSession` boolean flag with a time-based check (e.g. check size at most once per hour)
- Store last rotation check timestamp instead of a boolean
- Add a test that verifies rotation can trigger more than once if enough time passes (mock `Date.now`)
- Add JSDoc comment documenting rotation behavior

**Done when:** Rotation can re-trigger after a configurable interval, test covers the scenario, existing rotation tests still pass.

### Task 3: Add message truncation and document sync I/O choice

**Files to modify:**
- `extensions/logging.ts`
- `tests/extension/logging.test.ts`

**What to do:**
- Add message truncation: if a single log message exceeds 10KB, truncate with `...(truncated)` marker
- Add a test for truncation behavior
- Add a JSDoc comment on `appendToFile` explaining why synchronous I/O is used (simplicity, ordering guarantees, acceptable for low-volume diagnostic logging)
- Add comment on the timestamp regex explaining intent

**Done when:** Truncation works and is tested, sync I/O and timestamp format are documented in code comments.
