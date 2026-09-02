# Workflow Reset & Active-Phase Fix Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add `WorkflowTracker.reset()`, use it to auto-reset on backward/same-phase navigation in `advanceTo()`, register a `/workflow-reset` command, fix `isPhaseUnresolved` to not treat `"active"` as unresolved, and add git hygiene check to the brainstorming skill.

**Architecture:** Changes are isolated across three layers: (1) `WorkflowTracker` gets a `reset()` method and updated `advanceTo()` logic; (2) the extension entry point registers a new slash command; (3) the skip-confirmation helper narrows its definition of "unresolved". The brainstorm skill change is a SKILL.md text edit only — no code.

**Tech Stack:** TypeScript, Vitest (run with `npm test`), Biome (linter).

---

### Task 1: Add `reset()` to `WorkflowTracker`

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `extensions/workflow-monitor/workflow-tracker.ts` (add method to `WorkflowTracker` class)
- Test: `tests/extension/workflow-monitor/workflow-tracker.test.ts`

---

**Step 1: Write the failing test**

In `tests/extension/workflow-monitor/workflow-tracker.test.ts`, inside the first `describe("WorkflowTracker", ...)` block (after the existing tests), add:

```ts
test("reset() restores tracker to empty state regardless of prior state", () => {
  tracker.advanceTo("execute");
  tracker.recordArtifact("plan", "docs/plans/2026-02-20-foo.md");
  tracker.markPrompted("brainstorm");

  tracker.reset();

  const s = tracker.getState();
  expect(s.currentPhase).toBeNull();
  for (const p of WORKFLOW_PHASES) expect(s.phases[p]).toBe("pending");
  for (const p of WORKFLOW_PHASES) expect(s.artifacts[p]).toBeNull();
  for (const p of WORKFLOW_PHASES) expect(s.prompted[p]).toBe(false);
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extension/workflow-monitor/workflow-tracker.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `tracker.reset is not a function`

**Step 3: Add `reset()` to `WorkflowTracker`**

In `extensions/workflow-monitor/workflow-tracker.ts`, inside the `WorkflowTracker` class, add this method after `setState`:

```ts
reset(): void {
  this.state = emptyState();
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extension/workflow-monitor/workflow-tracker.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: all tests PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor/workflow-tracker.ts tests/extension/workflow-monitor/workflow-tracker.test.ts
git commit -m "feat: add WorkflowTracker.reset() method"
```

---

### Task 2: Update `advanceTo()` to reset on backward/same-phase navigation

**TDD scenario:** Modifying tested code — update the failing test first, then update the implementation.

**Files:**
- Modify: `extensions/workflow-monitor/workflow-tracker.ts` (`advanceTo` method)
- Test: `tests/extension/workflow-monitor/workflow-tracker.test.ts`

---

**Step 1: Update the existing backward-navigation test**

Find and replace this test in `tests/extension/workflow-monitor/workflow-tracker.test.ts`:

Old:
```ts
test("advanceTo is forward-only (no-op when going backwards)", () => {
  tracker.advanceTo("plan");
  tracker.advanceTo("brainstorm");
  expect(tracker.getState().currentPhase).toBe("plan");
});
```

New:
```ts
test("advanceTo backward triggers full reset and activates the target phase", () => {
  tracker.advanceTo("plan");
  tracker.recordArtifact("plan", "docs/plans/foo.md");
  tracker.markPrompted("plan");

  const result = tracker.advanceTo("brainstorm");

  const s = tracker.getState();
  expect(result).toBe(true);
  expect(s.currentPhase).toBe("brainstorm");
  expect(s.phases.brainstorm).toBe("active");
  // plan should be wiped by the reset
  expect(s.phases.plan).toBe("pending");
  expect(s.artifacts.plan).toBeNull();
  expect(s.prompted.plan).toBe(false);
});

test("advanceTo same phase triggers full reset and reactivates that phase", () => {
  tracker.advanceTo("plan");
  tracker.completeCurrent();
  expect(tracker.getState().phases.plan).toBe("complete");

  const result = tracker.advanceTo("plan");

  const s = tracker.getState();
  expect(result).toBe(true);
  expect(s.currentPhase).toBe("plan");
  expect(s.phases.plan).toBe("active");
});
```

**Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/extension/workflow-monitor/workflow-tracker.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: the two new tests FAIL (one because `currentPhase` is still `"plan"`, one because phase is `"complete"` not `"active"`).

**Step 3: Update `advanceTo()` implementation**

In `extensions/workflow-monitor/workflow-tracker.ts`, find the `advanceTo` method and replace the inner `if (current)` block:

Old:
```ts
if (current) {
  const curIdx = WORKFLOW_PHASES.indexOf(current);
  if (nextIdx <= curIdx) return false;

  if (this.state.phases[current] === "active") {
    this.state.phases[current] = "complete";
  }
}
```

New:
```ts
if (current) {
  const curIdx = WORKFLOW_PHASES.indexOf(current);
  if (nextIdx <= curIdx) {
    // Backward or same-phase navigation = new task. Reset everything.
    this.reset();
    // Fall through to activate the target phase below.
  } else {
    // Forward advance: auto-complete the current phase.
    if (this.state.phases[current] === "active") {
      this.state.phases[current] = "complete";
    }
  }
}
```

**Step 4: Run the full tracker test file**

```bash
npx vitest run tests/extension/workflow-monitor/workflow-tracker.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: all tests PASS (including the unchanged tests — the key one is "continues scanning when first recognized /skill line is a no-op and later line advances", which still reaches `"verify"` because after the backward reset to `"brainstorm"` the forward skip to `"verify"` works normally).

**Step 5: Run the full test suite to catch regressions**

```bash
npm test 2>&1 | tail -30
```

Expected: all tests PASS

**Step 6: Commit**

```bash
git add extensions/workflow-monitor/workflow-tracker.ts tests/extension/workflow-monitor/workflow-tracker.test.ts
git commit -m "feat: advanceTo() resets on backward/same-phase navigation"
```

---

### Task 3: Fix `isPhaseUnresolved` — `"active"` is not unresolved

**TDD scenario:** Modifying tested code — update tests first, then fix implementation.

**Files:**
- Modify: `extensions/workflow-monitor/skip-confirmation.ts`
- Test: `tests/extension/workflow-monitor/skip-confirmation.test.ts`

---

**Step 1: Update failing tests in `skip-confirmation.test.ts`**

Four tests need updating. Make these replacements:

**Test 1** — update the `isPhaseUnresolved` contract test:

Old:
```ts
test("treats pending and active as unresolved statuses", () => {
  expect(isPhaseUnresolved("pending")).toBe(true);
  expect(isPhaseUnresolved("active")).toBe(true);
  expect(isPhaseUnresolved("complete")).toBe(false);
  expect(isPhaseUnresolved("skipped")).toBe(false);
});
```

New:
```ts
test("treats only pending as unresolved; active, complete, skipped are resolved", () => {
  expect(isPhaseUnresolved("pending")).toBe(true);
  expect(isPhaseUnresolved("active")).toBe(false);
  expect(isPhaseUnresolved("complete")).toBe(false);
  expect(isPhaseUnresolved("skipped")).toBe(false);
});
```

**Test 2** — `"returns unresolved phases strictly before target"` uses `execute: "active"` which should now NOT be unresolved:

Old:
```ts
test("returns unresolved phases strictly before target", () => {
  const state = createState({
    plan: "pending",
    execute: "active",
    verify: "pending",
  });

  expect(getUnresolvedPhasesBefore("verify", state)).toEqual(["plan", "execute"]);
});
```

New:
```ts
test("returns unresolved phases strictly before target (active is not unresolved)", () => {
  const state = createState({
    plan: "pending",
    execute: "active",
    verify: "pending",
  });

  // execute is "active" (already engaged) so not unresolved; only plan is
  expect(getUnresolvedPhasesBefore("verify", state)).toEqual(["plan"]);
});
```

**Test 3** — `"returns only unresolved phases before finish"` uses `review: "active"`:

Old:
```ts
test("returns only unresolved phases before finish", () => {
  const state = createState({
    brainstorm: "pending",
    plan: "complete",
    review: "active",
    finish: "pending",
  });

  expect(getUnresolvedPhasesBefore("finish", state)).toEqual(["brainstorm", "review"]);
});
```

New:
```ts
test("returns only unresolved phases before finish (active is not unresolved)", () => {
  const state = createState({
    brainstorm: "pending",
    plan: "complete",
    review: "active",
    finish: "pending",
  });

  // review is "active" (engaged), so only brainstorm is unresolved
  expect(getUnresolvedPhasesBefore("finish", state)).toEqual(["brainstorm"]);
});
```

**Test 4** — `"excludes unresolved target phase itself"` uses `brainstorm: "active"`:

Old:
```ts
test("excludes unresolved target phase itself", () => {
  const state = createState({
    brainstorm: "active",
    plan: "pending",
    execute: "pending",
  });

  expect(getUnresolvedPhasesBefore("execute", state)).toEqual(["brainstorm", "plan"]);
});
```

New:
```ts
test("excludes active and target phase — only pending phases before target are unresolved", () => {
  const state = createState({
    brainstorm: "active",
    plan: "pending",
    execute: "pending",
  });

  // brainstorm is "active" (engaged); only pending plan is unresolved
  expect(getUnresolvedPhasesBefore("execute", state)).toEqual(["plan"]);
});
```

**Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/extension/workflow-monitor/skip-confirmation.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: the four updated tests FAIL

**Step 3: Fix `isPhaseUnresolved`**

In `extensions/workflow-monitor/skip-confirmation.ts`, replace:

```ts
export function isPhaseUnresolved(status: PhaseStatus): boolean {
  return status === "pending" || status === "active";
}
```

With:

```ts
export function isPhaseUnresolved(status: PhaseStatus): boolean {
  return status === "pending";
}
```

**Step 4: Run the skip-confirmation tests**

```bash
npx vitest run tests/extension/workflow-monitor/skip-confirmation.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: all PASS

**Step 5: Run the full test suite**

```bash
npm test 2>&1 | tail -30
```

Expected: all PASS

**Step 6: Commit**

```bash
git add extensions/workflow-monitor/skip-confirmation.ts tests/extension/workflow-monitor/skip-confirmation.test.ts
git commit -m "fix: isPhaseUnresolved only treats pending as unresolved, not active"
```

---

### Task 4: Register `/workflow-reset` command

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `tests/extension/workflow-monitor/workflow-reset-command.test.ts`
- Modify: `extensions/workflow-monitor.ts`

---

**Step 1: Write the failing tests**

Create `tests/extension/workflow-monitor/workflow-reset-command.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import workflowMonitorExtension from "../../../extensions/workflow-monitor";

/**
 * Boots the extension and returns a map of { commandName → handler }.
 * Also captures appendedEntries so we can inspect persisted state.
 */
function setup() {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const appendedEntries: Array<{ customType: string; data: any }> = [];

  const fakePi: any = {
    on() {},
    registerTool() {},
    appendEntry(customType: string, data: any) {
      appendedEntries.push({ customType, data });
    },
    registerCommand(name: string, opts: any) {
      commands.set(name, opts.handler);
    },
  };

  workflowMonitorExtension(fakePi);
  return { commands, appendedEntries };
}

describe("/workflow-reset command", () => {
  test("command is registered with the expected name and description", () => {
    const descriptions = new Map<string, string>();
    const fakePi: any = {
      on() {},
      registerTool() {},
      appendEntry() {},
      registerCommand(name: string, opts: any) {
        descriptions.set(name, opts.description);
      },
    };
    workflowMonitorExtension(fakePi);
    expect(descriptions.has("workflow-reset")).toBe(true);
    expect(descriptions.get("workflow-reset")).toMatch(/reset/i);
  });

  test("resets persisted state — workflow, tdd, debug, verification all return to defaults", async () => {
    const { commands, appendedEntries } = setup();

    const ctx: any = {
      hasUI: false,
      ui: { notify: vi.fn(), setWidget: () => {} },
    };

    // Call the command
    const handler = commands.get("workflow-reset");
    expect(handler).toBeDefined();
    await handler!("", ctx);

    // State should have been persisted
    expect(appendedEntries.length).toBeGreaterThan(0);
    const lastEntry = appendedEntries.at(-1)!;
    expect(lastEntry.data.workflow).toBeDefined();

    // Workflow should be empty
    const wf = lastEntry.data.workflow;
    expect(wf.currentPhase).toBeNull();
    for (const phase of ["brainstorm", "plan", "execute", "verify", "review", "finish"]) {
      expect(wf.phases[phase]).toBe("pending");
    }

    // TDD, debug, verification should be at defaults
    expect(lastEntry.data.tdd.phase).toBe("idle");
    expect(lastEntry.data.debug.active).toBe(false);
    expect(lastEntry.data.verification.verified).toBe(false);
  });

  test("notifies user with info level when UI is present", async () => {
    const { commands } = setup();

    const notifications: Array<[string, string]> = [];
    const ctx: any = {
      hasUI: true,
      ui: {
        notify: (msg: string, level: string) => notifications.push([msg, level]),
        setWidget: () => {},
      },
    };

    const handler = commands.get("workflow-reset");
    await handler!("", ctx);

    expect(notifications.length).toBe(1);
    expect(notifications[0]![1]).toBe("info");
    expect(notifications[0]![0]).toMatch(/reset/i);
  });

  test("does not throw and does not notify when UI is absent", async () => {
    const { commands } = setup();

    const ctx: any = {
      hasUI: false,
      ui: { notify: vi.fn(), setWidget: () => {} },
    };

    const handler = commands.get("workflow-reset");
    await expect(handler!("", ctx)).resolves.not.toThrow();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/extension/workflow-monitor/workflow-reset-command.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: tests about command registration FAIL (command not found in the map)

**Step 3: Register the command in `extensions/workflow-monitor.ts`**

At the end of the `workflow-monitor.ts` default export function, just before the `pi.registerTool(...)` call for the reference tool, add:

```ts
pi.registerCommand("workflow-reset", {
  description: "Reset workflow tracker to fresh state for a new task",
  async handler(_args, ctx) {
    handler.resetState();
    persistState();
    updateWidget(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify("Workflow reset. Ready for a new task.", "info");
    }
  },
});
```

> **Note:** The `handler`, `persistState`, and `updateWidget` variables are all in scope at that location — they are defined earlier in the outer function closure. The `handler` here is the `WorkflowHandler` created at the top (`const handler = createWorkflowHandler()`), not to be confused with the command's `handler` function argument (named `_args` to avoid shadowing).

**Step 4: Run command tests**

```bash
npx vitest run tests/extension/workflow-monitor/workflow-reset-command.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: all PASS

**Step 5: Run the full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all PASS

**Step 6: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/workflow-reset-command.test.ts
git commit -m "feat: register /workflow-reset command"
```

---

### Task 5: Add git state check to brainstorming skill

**TDD scenario:** Trivial change — skill doc edit, no code, no automated tests.

**Files:**
- Modify: `skills/brainstorming/SKILL.md`

---

**Step 1: Add the git hygiene section**

In `skills/brainstorming/SKILL.md`, replace the `## The Process` section header and `**Understanding the idea:**` block opening as follows.

Find:
```markdown
## The Process

**Understanding the idea:**
```

Replace with:
```markdown
## The Process

**Before anything else — check git state:**
- Run `git status` and `git log --oneline -5`
- If on a feature branch with uncommitted or unmerged work, ask the user:
  - "You're on `<branch>` with uncommitted changes. Want to finish/merge that first, stash it, or continue here?"
- Require exactly one of: finish prior work, stash, or explicitly continue here
- If the topic is new, suggest creating a new branch before brainstorming

**Understanding the idea:**
```

**Step 2: Verify the file looks right**

```bash
head -40 skills/brainstorming/SKILL.md
```

Confirm the new section appears between `## The Process` and `**Understanding the idea:**`.

**Step 3: Commit**

```bash
git add skills/brainstorming/SKILL.md
git commit -m "docs: add git state check to brainstorming skill"
```

---

### Final: Verify everything

**Step 1: Run full test suite one last time**

```bash
npm test 2>&1 | tail -30
```

Expected: all tests PASS, zero failures.

**Step 2: Run linter**

```bash
npm run lint 2>&1 | tail -20
```

Expected: no errors.
