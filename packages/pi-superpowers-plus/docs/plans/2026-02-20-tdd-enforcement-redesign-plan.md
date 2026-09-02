# TDD Enforcement Redesign Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Replace hard TDD blocks with warnings-only, restore critical inline skill content, suppress verification prompts during execution.

**Architecture:** Remove `tdd-guard.ts` entirely. Simplify TDD violation handling in workflow-monitor to short warnings (no escalation/blocking). Restore red flags, rationalizations, and verification checklists to skill text inline. Update agent profiles and prompt templates with three-scenario TDD guidance.

**Tech Stack:** TypeScript (extensions), Markdown (skills/agents), Vitest (tests)

---

## Phase 1: Extension Changes

### Task 1: Delete tdd-guard extension and its tests

**TDD scenario:** N/A — pure deletion

**Files:**
- Delete: `extensions/tdd-guard.ts`
- Delete: `tests/extension/tdd-guard/tdd-guard.test.ts`
- Delete: `tests/extension/tdd-guard/tdd-guard-error-handling.test.ts`

**Step 1: Delete the files**

```bash
rm extensions/tdd-guard.ts
rm -rf tests/extension/tdd-guard/
```

**Step 2: Verify no remaining references break the build**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: All remaining tests pass. The tdd-guard tests are gone, nothing else imports from tdd-guard.

**Step 3: Commit**

```bash
git add -A
git commit -m "refactor: delete tdd-guard extension and tests"
```

---

### Task 2: Simplify TDD warning text in warnings.ts

**TDD scenario:** Modifying tested code — run existing tests first

**Files:**
- Modify: `extensions/workflow-monitor/warnings.ts`

**Step 1: Run existing tests to confirm green**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: All tests pass.

**Step 2: Replace `getTddViolationWarning` function**

In `extensions/workflow-monitor/warnings.ts`, replace the entire `getTddViolationWarning` function with a short, non-judgmental version:

```typescript
export function getTddViolationWarning(type: TddViolationType, file: string, _phase?: string): string {
  if (type === "source-before-test") {
    return `⚠️ TDD: Writing source code (${file}) without a failing test. Consider whether this change needs a test first, or if existing tests already cover it.`;
  }

  if (type === "source-during-red") {
    return `⚠️ TDD: Writing source code (${file}) before running your new test. Run the test suite to verify your test fails, then implement.`;
  }

  return `⚠️ TDD: Unexpected violation type "${type}" for ${file}`;
}
```

Key changes:
- No "Iron Law" language
- No rationalizations list inline in the warning
- No "Delete this code" directives
- Short, actionable, 1-2 sentences
- Acknowledges that existing tests may already cover the change

**Step 3: Run tests to confirm green**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: All tests pass. Warning text isn't directly asserted in most tests.

**Step 4: Commit**

```bash
git add extensions/workflow-monitor/warnings.ts
git commit -m "refactor: simplify TDD warning text — short, non-judgmental, actionable"
```

---

### Task 3: Remove TDD escalation logic from workflow-monitor.ts

**TDD scenario:** Modifying tested code — run existing tests first

**Files:**
- Modify: `extensions/workflow-monitor.ts`

**Step 1: Run existing tests to confirm green**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: All tests pass.

**Step 2: Remove TDD practice escalation from tool_call handler**

In `extensions/workflow-monitor.ts`, in the `pi.on("tool_call", ...)` handler, find this block:

```typescript
    const result = handler.handleToolCall(event.toolName, input);
    if (result.violation) {
      const state = handler.getWorkflowState();
      const phase = state?.currentPhase;
      const isThinkingPhase = phase === "brainstorm" || phase === "plan";

      // During brainstorm/plan, practice escalation is intentionally skipped.
      // Process violations already block non-plan writes in thinking phases,
      // making practice escalation redundant and noisy.
      if (!isThinkingPhase) {
        const escalation = await maybeEscalate("practice", ctx);
        if (escalation === "block") {
          return { blocked: true };
        }
      }

      pendingViolations.set(toolCallId, result.violation);
      persistState();
    }
```

Replace with:

```typescript
    const result = handler.handleToolCall(event.toolName, input);
    if (result.violation) {
      pendingViolations.set(toolCallId, result.violation);
      persistState();
    }
```

This removes the `maybeEscalate("practice", ...)` call entirely for TDD/debug violations. Violations are still detected, stored, and will be injected as warnings in tool_result — they just never escalate to blocking prompts.

**Note:** The `maybeEscalate("process", ...)` call for brainstorm/plan boundary writes stays — that's a different concern (preventing code edits during planning phase).

**Step 3: Clean up unused escalation infrastructure (if "practice" bucket is now unused)**

Check if `maybeEscalate` is still called with `"practice"` anywhere else. If not, remove the `"practice"` strike counter and session allowed tracking. Keep `"process"` bucket.

Search:
```bash
grep -n "practice" extensions/workflow-monitor.ts
```

If only the deleted block references `"practice"`, the `strikes.practice` and `sessionAllowed.practice` entries are dead code. Leave the `maybeEscalate` function intact (it's still used for `"process"`) but remove `practice` initialization from the session reset handlers if desired. This is optional cleanup — no behavior change.

**Step 4: Run tests to confirm green**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: All tests pass.

**Step 5: Commit**

```bash
git add extensions/workflow-monitor.ts
git commit -m "refactor: remove TDD escalation — violations become warnings only, no blocking"
```

---

### Task 4: Suppress verification prompts during plan execution

**TDD scenario:** Modifying tested code — run existing tests first

**Files:**
- Modify: `extensions/workflow-monitor.ts`

**Step 1: Run existing tests to confirm green**

```bash
npx vitest run 2>&1 | tail -5
```

**Step 2: Add execution-detection logic to completion action gating**

In `extensions/workflow-monitor.ts`, find the completion action gating block inside `pi.on("tool_call", ...)`:

```typescript
      // Completion action gating (interactive only, execute+ phases)
      if (ctx.hasUI && state && phaseIdx >= executeIdx) {
        const actionTarget = getCompletionActionTarget(command);
        if (actionTarget) {
          const unresolved = getUnresolvedPhasesForAction(actionTarget, state);
          if (unresolved.length > 0) {
            const gateResult = await promptCompletionGate(unresolved, ctx);
            if (gateResult === "blocked") {
              return { blocked: true };
            }
            if (unresolved.includes("verify")) {
              handler.recordVerificationWaiver();
              persistState();
            }
          }
        }
      }
```

Add a check: if the current phase is `execute` and it's `active` (i.e., plan execution is in progress), skip the prompt entirely:

```typescript
      // Completion action gating (interactive only, execute+ phases)
      // Suppress during active plan execution — prompts only fire after execution completes
      const isExecuting = state?.currentPhase === "execute" && state.phases.execute === "active";
      if (ctx.hasUI && state && phaseIdx >= executeIdx && !isExecuting) {
        const actionTarget = getCompletionActionTarget(command);
        if (actionTarget) {
          const unresolved = getUnresolvedPhasesForAction(actionTarget, state);
          if (unresolved.length > 0) {
            const gateResult = await promptCompletionGate(unresolved, ctx);
            if (gateResult === "blocked") {
              return { blocked: true };
            }
            if (unresolved.includes("verify")) {
              handler.recordVerificationWaiver();
              persistState();
            }
          }
        }
      }
```

**Step 3: Run tests to confirm green**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: All tests pass. Existing skip-confirmation tests don't set execute phase to active.

**Step 4: Commit**

```bash
git add extensions/workflow-monitor.ts
git commit -m "fix: suppress verification prompts during active plan execution"
```

---

### Task 5: Update workflow-monitor tests for new behavior

**TDD scenario:** Modifying tested code — verify existing tests still pass, add new test for execution suppression

**Files:**
- Modify: `tests/extension/workflow-monitor/workflow-monitor.test.ts`

**Step 1: Run existing tests to confirm green**

```bash
npx vitest run tests/extension/workflow-monitor/ 2>&1 | tail -10
```

Expected: All tests pass.

**Step 2: Verify existing TDD violation tests still pass**

The existing tests in `workflow-monitor.test.ts` test that violations are *detected* (returned by `handleToolCall`). These should still pass because we didn't change detection — we only removed escalation in the extension's event handler (which tests don't exercise directly since they test the handler, not the extension).

Run specifically:

```bash
npx vitest run tests/extension/workflow-monitor/workflow-monitor.test.ts 2>&1 | tail -10
```

Expected: All pass.

**Step 3: Commit**

```bash
git add tests/extension/workflow-monitor/
git commit -m "test: verify workflow-monitor tests pass after escalation removal"
```

---

## Phase 2: Agent Profiles and Prompt Templates

### Task 6: Rewrite agents/implementer.md

**TDD scenario:** Trivial change — no tests for markdown agent profiles

**Files:**
- Rewrite: `agents/implementer.md`

**Step 1: Rewrite the file**

Replace entire contents with:

```markdown
---
name: implementer
description: Implement tasks via TDD and commit small changes
tools: read, write, edit, bash, lsp
model: claude-sonnet-4-5
---

You are an implementation subagent.

## TDD Approach

Determine which scenario applies before writing code:

**New files / new features:** Full TDD. Write a failing test first, verify it fails, implement minimal code to pass, refactor.

**Modifying code with existing tests:** Run existing tests first to confirm green. Make your change. Run tests again. If the change isn't covered by existing tests, add a test. If it is, you're done.

**Trivial changes (typo, config, rename):** Use judgment. Run relevant tests after if they exist.

**If you see a ⚠️ TDD warning:** Pause. Consider which scenario applies. If existing tests cover your change, run them and proceed. If not, write a test first.

## Rules
- Keep changes minimal and scoped to the task.
- Run the narrowest test(s) first, then the full suite when appropriate.
- Commit when the task's tests pass.
- Report: what changed, tests run, files changed, any concerns.
```

**Step 2: Commit**

```bash
git add agents/implementer.md
git commit -m "refactor: update implementer profile — three-scenario TDD, remove tdd-guard extension"
```

---

### Task 7: Rewrite agents/worker.md

**TDD scenario:** Trivial change — no tests for markdown agent profiles

**Files:**
- Rewrite: `agents/worker.md`

**Step 1: Rewrite the file**

Replace entire contents with:

```markdown
---
name: worker
description: General-purpose worker for isolated tasks
tools: read, write, edit, bash, lsp
model: claude-sonnet-4-5
---

You are a general-purpose subagent. Follow the task exactly.

## TDD (when changing production code)

- New files: write a failing test first, then implement.
- Modifying existing code: run existing tests first, make your change, run again. Add tests if not covered.
- Trivial changes: run relevant tests after if they exist.
- If you see a ⚠️ TDD warning, pause and decide which scenario applies before proceeding.

Prefer small, test-backed changes.
```

**Step 2: Commit**

```bash
git add agents/worker.md
git commit -m "refactor: update worker profile — three-scenario TDD, remove tdd-guard extension"
```

---

### Task 8: Update implementer-prompt.md

**TDD scenario:** Trivial change — no tests for markdown templates

**Files:**
- Modify: `skills/subagent-driven-development/implementer-prompt.md`

**Step 1: Replace the "Your Job" section**

Find:
```
    ## Your Job

    Once you're clear on requirements:
    1. Follow TDD for production code: write failing test first, verify it fails, then implement minimal code to pass
    2. Implement exactly what the task specifies
    3. Verify implementation works
    4. Commit your work
    5. Self-review (see below)
    6. Report back
```

Replace with:
```
    ## Your Job

    Once you're clear on requirements:
    1. Determine TDD scenario for this task:
       - New code → full TDD (failing test first)
       - Modifying tested code → run existing tests before and after
       - Trivial change → use judgment, run tests after
    2. Implement exactly what the task specifies
    3. Verify implementation works
    4. Commit your work
    5. Self-review (see below)
    6. Report back
```

**Step 2: Replace the Testing section in self-review**

Find:
```
    **Testing:**
    - Do tests actually verify behavior (not just mock behavior)?
    - Did I follow TDD (failing test first for all production code)?
    - Are tests comprehensive?
```

Replace with:
```
    **Testing:**
    - Did I follow the appropriate TDD scenario for this task?
    - For new code: did I write a failing test first?
    - For modified code: did I run existing tests before and after my change?
    - Do tests actually verify behavior (not just mock behavior)?
    - Are tests comprehensive?
```

**Step 3: Commit**

```bash
git add skills/subagent-driven-development/implementer-prompt.md
git commit -m "refactor: update implementer prompt — scenario-aware TDD instructions"
```

---

## Phase 3: Skill Text Restoration and Updates

### Task 9: Rewrite skills/test-driven-development/SKILL.md

**TDD scenario:** Trivial change — no tests for skill markdown

**Files:**
- Rewrite: `skills/test-driven-development/SKILL.md`

**Step 1: Rewrite the file**

This is the biggest content change. The new version:
- Adds three-scenario TDD model
- Restores red flags, rationalizations table, verification checklist inline
- Restores detailed phase instructions (paragraphs, not one-liners)
- Adds "Interpreting Runtime Warnings" section
- Keeps `workflow_reference` as supplemental
- Removes references to "hard enforcement" by workflow-monitor

Replace entire contents with:

```markdown
---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code
---

> **Related skills:** Before claiming done, use `/skill:verification-before-completion` to verify tests actually pass.

# Test-Driven Development (TDD)

## Overview

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

**Violating the letter of the rules is violating the spirit of the rules.**

## Prerequisites
- Active branch (not main) or user-confirmed intent to work on main
- Approved plan or clear task scope

## When to Use — Three Scenarios

Not every change requires the same TDD approach. Determine which scenario applies:

### Scenario 1: New Feature / New File

Full TDD cycle. No shortcuts.

1. Write a failing test
2. Watch it fail
3. Write minimal code to pass
4. Watch it pass
5. Refactor
6. Repeat

**This is the default.** If in doubt, use this scenario.

### Scenario 2: Modifying Code with Existing Tests

When changing code that already has test coverage:

1. Run existing tests — confirm green
2. Make your change
3. Run tests again — confirm still green
4. If your change isn't covered by existing tests, add a test for it
5. If existing tests already cover the changed behavior, you're done

**Key:** You must verify existing tests pass *before* and *after* your change. If you can't confirm test coverage, fall back to Scenario 1.

### Scenario 3: Trivial Change

For typo fixes, config tweaks, string changes, renames:

- Use judgment
- If relevant tests exist, run them after your change
- Don't write a new test for a string literal change

**Be honest:** If the change touches logic, it's not trivial. Use Scenario 1 or 2.

## Interpreting Runtime Warnings

The workflow monitor tracks your TDD phase and may inject warnings like:

```
⚠️ TDD: Writing source code (src/foo.ts) without a failing test.
```

**When you see this, pause and assess:**
- Which scenario applies to this change?
- If Scenario 2: run existing tests to confirm coverage, then proceed
- If Scenario 1: write a failing test first
- If Scenario 3: proceed, run tests after

The warning is a signal to think, not a hard stop.

## The Iron Law (Scenario 1)

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over.
- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Delete means delete. Implement fresh from tests.

## Red-Green-Refactor

### RED — Write Failing Test

Write one minimal test showing what should happen.

**Requirements:**
- One behavior per test
- Clear name describing behavior (if the name contains "and", split it)
- Real code (no mocks unless unavoidable)
- Shows desired API — demonstrates how code should be called

**Good:**
```typescript
test('retries failed operations 3 times', async () => {
  let attempts = 0;
  const operation = () => {
    attempts++;
    if (attempts < 3) throw new Error('fail');
    return 'success';
  };
  const result = await retryOperation(operation);
  expect(result).toBe('success');
  expect(attempts).toBe(3);
});
```

**Bad:**
```typescript
test('retry works', async () => {
  const mock = jest.fn().mockRejectedValueOnce(new Error()).mockResolvedValueOnce('ok');
  await retryOperation(mock);
  expect(mock).toHaveBeenCalledTimes(2);
});
```

### Verify RED — Watch It Fail

**MANDATORY. Never skip.**

Run the test. Confirm:
- Test **fails** (not errors from syntax/import issues)
- Failure message matches expectation
- Fails because the feature is missing (not because of typos)

**Test passes immediately?** You're testing existing behavior. Fix the test.
**Test errors instead of failing?** Fix the error, re-run until it fails correctly.

### GREEN — Minimal Code

Write the simplest code to pass the test. Nothing more.

Don't add features, refactor other code, or "improve" beyond what the test requires. If you're writing code that no test exercises, stop.

**Good:** Just enough to pass the test.
**Bad:** Adding options, config, generalization that no test asks for (YAGNI).

### Verify GREEN — Watch It Pass

**MANDATORY.**

Run the test. Confirm:
- New test passes
- All other tests still pass
- Output is pristine (no errors, no warnings)

**Test fails?** Fix code, not test.
**Other tests fail?** Fix now — don't move on with broken tests.

### REFACTOR — Clean Up

Only after green:
- Remove duplication
- Improve names
- Extract helpers

Keep tests green throughout. Don't add new behavior during refactor.

### Repeat

Next failing test for next behavior.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Tests after achieve same goals" | Tests-after = "what does this do?" Tests-first = "what should this do?" |
| "Already manually tested" | Ad-hoc ≠ systematic. No record, can't re-run. |
| "Deleting X hours is wasteful" | Sunk cost fallacy. Keeping unverified code is technical debt. |
| "Keep as reference, write tests first" | You'll adapt it. That's testing after. Delete means delete. |
| "Need to explore first" | Fine. Throw away exploration, start with TDD. |
| "Test hard = design unclear" | Listen to test. Hard to test = hard to use. |
| "TDD will slow me down" | TDD faster than debugging. Pragmatic = test-first. |
| "Existing code has no tests" | You're improving it. Add tests for the code you're changing. |
| "This is different because..." | It's not. Follow the process. |

## Red Flags — STOP and Start Over

If you catch yourself doing any of these, stop immediately:

- Writing production code before the test
- Writing tests after implementation
- Test passes immediately (didn't catch the bug)
- Can't explain why test failed
- Rationalizing "just this once"
- "I already manually tested it"
- "Keep as reference" or "adapt existing code"
- "Already spent X hours, deleting is wasteful"
- "TDD is dogmatic, I'm being pragmatic"

**All of these mean: Delete code. Start over with TDD.**

## Verification Checklist

Before marking work complete:

- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

Can't check all boxes? You skipped TDD. Start over.

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write wished-for API. Write assertion first. Ask your human partner. |
| Test too complicated | Design too complicated. Simplify interface. |
| Must mock everything | Code too coupled. Use dependency injection. |
| Test setup huge | Extract helpers. Still complex? Simplify design. |

## Debugging Integration

Bug found? Write failing test reproducing it. Follow TDD cycle. Test proves fix and prevents regression. Never fix bugs without a test.

## Testing Anti-Patterns

When adding mocks or test utilities, read `testing-anti-patterns.md` in this skill directory to avoid common pitfalls:
- Testing mock behavior instead of real behavior
- Adding test-only methods to production classes
- Mocking without understanding dependencies

## Reference

Use `workflow_reference` for additional detail:
- `tdd-rationalizations` — Extended rationalization discussion
- `tdd-examples` — More good/bad code examples, bug fix walkthrough
- `tdd-when-stuck` — Extended solutions for common blockers
- `tdd-anti-patterns` — Mock pitfalls, test-only methods, incomplete mocks

## Final Rule

```
Production code → test exists and failed first (Scenario 1)
Modifying tested code → existing tests verified before and after (Scenario 2)
Trivial change → relevant tests run after (Scenario 3)
```

No exceptions without your human partner's permission.

When the TDD implementation cycle is complete (all tests green, code committed), mark the implement phase complete: call `plan_tracker` with `{action: "update", status: "complete"}` for the current phase.
```

**Step 2: Commit**

```bash
git add skills/test-driven-development/SKILL.md
git commit -m "refactor: rewrite TDD skill — three scenarios, restore red flags/rationalizations/checklist"
```

---

### Task 10: Restore content to skills/systematic-debugging/SKILL.md

**TDD scenario:** Trivial change — no tests for skill markdown

**Files:**
- Modify: `skills/systematic-debugging/SKILL.md`

**Step 1: Add Red Flags section**

After the "When 3+ Fixes Fail" section, add:

```markdown
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
- **"One more fix attempt" (when already tried 2+)**
- **Each fix reveals new problem in different place**

**ALL of these mean: STOP. Return to Phase 1.**

**If 3+ fixes failed:** Question the architecture (see above).
```

**Step 2: Add Common Rationalizations table**

After the Red Flags section, add:

```markdown
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
```

**Step 3: Add multi-component diagnostic example to Phase 1, Step 4**

In the Phase 1 section, Step 4 "Gather Evidence in Multi-Component Systems" currently says:

> For each component boundary: log what enters, what exits, verify config propagation. Run once to see WHERE it breaks, then investigate that component.

Expand to include an example:

```markdown
4. **Gather Evidence in Multi-Component Systems** — For each component boundary: log what enters, what exits, verify config propagation. Run once to see WHERE it breaks, then investigate that component.

   **Example (multi-layer system):**
   ```bash
   # Layer 1: Workflow
   echo "=== Secrets available: ==="
   echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"

   # Layer 2: Build script
   echo "=== Env vars in build script: ==="
   env | grep IDENTITY || echo "IDENTITY not in environment"

   # Layer 3: Signing
   echo "=== Keychain state: ==="
   security list-keychains
   security find-identity -v
   ```
   **This reveals:** Which layer fails (e.g., secrets → workflow ✓, workflow → build ✗)
```

**Step 4: Update the workflow-monitor reference note**

Replace:
```
> The workflow-monitor extension actively tracks your debugging: it detects fix-without-investigation and counts failed fix attempts. Use `workflow_reference` with debug topics for detailed guidance.
```

With:
```
> The workflow-monitor extension tracks your debugging: it detects fix-without-investigation and counts failed fix attempts, surfacing warnings in tool results. Use `workflow_reference` with debug topics for additional guidance.
```

**Step 5: Commit**

```bash
git add skills/systematic-debugging/SKILL.md
git commit -m "refactor: restore red flags, rationalizations, diagnostic example to debugging skill"
```

---

### Task 11: Restore content to skills/verification-before-completion/SKILL.md

**TDD scenario:** Trivial change — no tests for skill markdown

**Files:**
- Modify: `skills/verification-before-completion/SKILL.md`

**Step 1: Add Common Failures table**

After the "The Gate Function" section, add:

```markdown
## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |
```

**Step 2: Add Rationalization Prevention table**

After Common Failures, add:

```markdown
## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |
```

**Step 3: Add "When To Apply" section**

After the Key Patterns section, add:

```markdown
## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases and paraphrases
- Implications of success
- ANY communication suggesting completion/correctness
```

**Step 4: Update enforcement note**

Replace:
```markdown
## Enforcement

The workflow-monitor extension gates `git commit`, `git push`, and `gh pr create`. If you haven't run a passing test suite since your last source file edit, the command gets a warning injected into its tool result. The gate clears automatically after a fresh passing test run.
```

With:
```markdown
## Enforcement

The workflow-monitor extension monitors `git commit`, `git push`, and `gh pr create`. If you haven't run a passing test suite since your last source file edit, a warning is injected into the tool result. The warning clears automatically after a fresh passing test run.
```

**Step 5: Commit**

```bash
git add skills/verification-before-completion/SKILL.md
git commit -m "refactor: restore common failures, rationalizations, trigger list to verification skill"
```

---

### Task 12: Update subagent-driven-development SKILL.md and writing-plans SKILL.md

**TDD scenario:** Trivial change — no tests for skill markdown

**Files:**
- Modify: `skills/subagent-driven-development/SKILL.md`
- Modify: `skills/writing-plans/SKILL.md`

**Step 1: Update subagent-driven TDD integration section**

In `skills/subagent-driven-development/SKILL.md`, find:

```markdown
- **TDD** - Failing test first for all production code (enforced by workflow-monitor, instructions in implementer prompt)
```

Replace with:

```markdown
- **TDD** - Runtime warnings on source-before-test patterns. Implementer subagents receive three-scenario TDD instructions via agent profile and prompt template: new feature (full TDD), modifying tested code (run existing tests), trivial change (judgment call).
```

**Step 2: Add TDD scenario hint guidance to writing-plans**

In `skills/writing-plans/SKILL.md`, in the "Task Structure" template section, after the `**Files:**` block, add a TDD scenario line:

```markdown
**TDD scenario:** [New feature — full TDD cycle | Modifying tested code — run existing tests first | Trivial change — use judgment]
```

So the template becomes:

```markdown
### Task N: [Component Name]

**TDD scenario:** [New feature — full TDD cycle | Modifying tested code — run existing tests first | Trivial change — use judgment]

**Files:**
- Create: `exact/path/to/file.py`
...
```

**Step 3: Commit**

```bash
git add skills/subagent-driven-development/SKILL.md skills/writing-plans/SKILL.md
git commit -m "refactor: update subagent-driven TDD reference, add TDD scenario hints to plan template"
```

---

## Phase 4: Final Verification

### Task 13: Run full test suite and verify

**Files:** None — verification only

**Step 1: Run full test suite**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: All tests pass. No references to deleted `tdd-guard.ts`.

**Step 2: Grep for stale references**

```bash
grep -rn "tdd-guard" --include="*.ts" --include="*.md" --include="*.json" . | grep -v node_modules | grep -v CHANGELOG | grep -v docs/plans
```

Expected: No results (or only historical references in CHANGELOG/plans).

**Step 3: Verify agent profiles load correctly**

```bash
cat agents/implementer.md | head -5
cat agents/worker.md | head -5
```

Expected: No `extensions:` line referencing tdd-guard.

**Step 4: Commit any cleanup**

If stale references found, clean them up and commit:

```bash
git add -A
git commit -m "chore: clean up stale tdd-guard references"
```
