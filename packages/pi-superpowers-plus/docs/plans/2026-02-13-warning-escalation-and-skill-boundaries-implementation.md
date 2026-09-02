# Warning Escalation & Skill Boundary Enforcement Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make workflow guardrails harder to ignore by enforcing phase-aware write boundaries, fixing broken UI prompts, and escalating repeated violations from warnings to hard blocks (with user override).

**Architecture:** Extend `extensions/workflow-monitor.ts` with (1) a `ui.select` adapter that uses string options and maps back to internal choices, (2) phase-aware “process violation” detection for file writes during brainstorm/plan, (3) phase-gated verification warnings, and (4) a per-session two-bucket strike counter that hard-blocks repeated violations via `ui.select`.

**Tech Stack:** TypeScript, Vitest, pi extension API (`ExtensionAPI`, `ExtensionContext`), existing workflow-monitor modules.

---

## Phase 1 — Fix broken `ui.select` prompts (no more `[object Object]`)

### Task 1: Skip-confirmation gate passes string options to `ui.select`

**Files:**
- Modify: `extensions/workflow-monitor.ts:153-233`
- Modify: `tests/extension/workflow-monitor/workflow-skip-confirmation.test.ts`

**Step 1: Write the failing test**

Add this test to `tests/extension/workflow-monitor/workflow-skip-confirmation.test.ts` (near the other interactive cases):

```ts
test("skip-confirmation prompts with string labels (not {label,value} objects)", async () => {
  const { onSessionSwitch, onInput } = setupWithState(
    createWorkflowState({ brainstorm: "complete", plan: "pending" }, "brainstorm")
  );

  const ctx = {
    hasUI: true,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: WORKFLOW_TRACKER_ENTRY_TYPE,
          data: createWorkflowState({ brainstorm: "complete", plan: "pending" }, "brainstorm"),
        },
      ],
    },
    ui: {
      setWidget: () => {},
      select: vi.fn().mockResolvedValue("Skip plan"),
      setEditorText: vi.fn(),
      notify: () => {},
    },
  };

  await onSessionSwitch({}, ctx);
  await onInput({ source: "user", input: "/skill:executing-plans" }, ctx);

  expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  const [_title, options] = (ctx.ui.select as any).mock.calls[0];
  expect(Array.isArray(options)).toBe(true);
  expect(options).toEqual(["Do plan now", "Skip plan", "Cancel"]);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/workflow-monitor/workflow-skip-confirmation.test.ts -t "skip-confirmation prompts with string labels"`

Expected: FAIL because `options` is currently an array of objects like `{ label, value }`.

**Step 3: Write minimal implementation**

In `extensions/workflow-monitor.ts`, introduce a tiny adapter and update the skip-confirmation call sites (lines ~153-233) to pass string arrays:

```ts
type SelectOption<T extends string> = { label: string; value: T };

async function selectValue<T extends string>(
  ctx: ExtensionContext,
  title: string,
  options: SelectOption<T>[]
): Promise<T> {
  const labels = options.map((o) => o.label);
  const pickedLabel = await ctx.ui.select(title, labels);
  const picked = options.find((o) => o.label === pickedLabel);
  return (picked?.value ?? "cancel") as T;
}
```

Then replace calls like:

```ts
const result = await ctx.ui.select(title, options as any);
const choice = typeof result === "string" ? result : (result as any)?.value ?? "cancel";
```

with:

```ts
const choice = await selectValue(ctx, title, options);
```

Also update test mocks in `workflow-skip-confirmation.test.ts` that currently return `"skip" | "do_now" | "cancel"` so they instead return the *label string* shown to the user (e.g. `"Skip plan"`, `"Do plan now"`, `"Cancel"`, `"Skip all and continue"`).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/workflow-monitor/workflow-skip-confirmation.test.ts -t "skip-confirmation prompts with string labels"`

Expected: PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/workflow-skip-confirmation.test.ts
git commit -m "fix(workflow-monitor): use string ui.select options for skip confirmation"
```

---

### Task 2: Completion-action gate (`git commit`/`push`/`pr`) passes string options to `ui.select`

**Files:**
- Modify: `extensions/workflow-monitor.ts:241-324`
- Modify: `tests/extension/workflow-monitor/completion-action-gate.test.ts`

**Step 1: Write the failing test**

Add this test to `tests/extension/workflow-monitor/completion-action-gate.test.ts`:

```ts
test("completion gate prompts with string labels (not objects)", async () => {
  const state = createWorkflowState(
    {
      brainstorm: "complete",
      plan: "complete",
      execute: "complete",
      verify: "pending",
      review: "pending",
      finish: "pending",
    },
    "execute"
  );

  const { onSessionSwitch, onToolCall } = await setupExtension(state);

  const { ctx } = createCtx(state, true, ["Skip verify"]);

  await onSessionSwitch({}, ctx);

  await onToolCall(
    { toolCallId: "tc1", toolName: "bash", input: { command: "git commit -m 'x'" } },
    ctx
  );

  expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  const [_title, options] = (ctx.ui.select as any).mock.calls[0];
  expect(options).toEqual(["Do verify now", "Skip verify", "Cancel"]);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/workflow-monitor/completion-action-gate.test.ts -t "completion gate prompts with string labels"`

Expected: FAIL because the gate currently passes `{label,value}` objects.

**Step 3: Write minimal implementation**

Update `promptCompletionGate()` in `extensions/workflow-monitor.ts` (lines ~241-324) to use the `selectValue()` helper from Task 1.

Then update all test fixtures in `completion-action-gate.test.ts` that currently return values like `"do_now"`, `"skip"`, `"skip_all"`, `"cancel"` to instead return the appropriate label strings:
- `"Do verify now"`, `"Skip verify"`, `"Cancel"`
- `"Review one-by-one"`, `"Skip all and continue"`, `"Cancel"`

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/workflow-monitor/completion-action-gate.test.ts -t "completion gate prompts with string labels"`

Expected: PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/completion-action-gate.test.ts
git commit -m "fix(workflow-monitor): use string ui.select options for completion gate"
```

---

### Task 3: Boundary prompts at `agent_end` pass string options to `ui.select`

**Files:**
- Modify: `extensions/workflow-monitor.ts:504-566`
- Modify: `tests/extension/workflow-monitor/transition-prompt.test.ts`

**Step 1: Write the failing test**

Add this test to `tests/extension/workflow-monitor/transition-prompt.test.ts`:

```ts
test("boundary prompt passes string labels to ui.select", async () => {
  const fake = createFakePi();
  workflowMonitorExtension(fake.api as any);

  const onSessionSwitch = getSingleHandler(fake.handlers, "session_switch");
  const onAgentEnd = getSingleHandler(fake.handlers, "agent_end");

  const ctx = {
    hasUI: true,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: WORKFLOW_TRACKER_ENTRY_TYPE,
          data: {
            phases: {
              brainstorm: "complete",
              plan: "pending",
              execute: "active",
              verify: "pending",
              review: "pending",
              finish: "pending",
            },
            currentPhase: "execute",
            artifacts: { brainstorm: null, plan: null, execute: null, verify: null, review: null, finish: null },
            prompted: { brainstorm: false, plan: false, execute: false, verify: false, review: false, finish: false },
          },
        },
      ],
    },
    ui: {
      setWidget: () => {},
      select: async (_title: string, options: any[]) => {
        expect(options).toEqual([
          "Next step (this session)",
          "Fresh session → next step",
          "Skip",
          "Discuss",
        ]);
        return "Discuss";
      },
      setEditorText: () => {},
      notify: () => {},
    },
  };

  await onSessionSwitch({}, ctx);
  await onAgentEnd({}, ctx);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/workflow-monitor/transition-prompt.test.ts -t "boundary prompt passes string labels"`

Expected: FAIL because `agent_end` currently passes objects.

**Step 3: Write minimal implementation**

In `extensions/workflow-monitor.ts` (lines ~504-566):
- Replace `options = prompt.options.map((o) => ({ label: o.label, value: o.choice }))` with the string label array `prompt.options.map((o) => o.label)`
- Map the returned label back to `TransitionChoice` with `prompt.options.find((o) => o.label === pickedLabel)?.choice`

Then update existing tests in `transition-prompt.test.ts` that return `"discuss" | "skip" | "next"` to return the label equivalents:
- `"Discuss"`, `"Skip"`, `"Next step (this session)"`

Also update any test logic that inspects `options` objects (e.g. `o.value === "skip_all"`) to instead check string presence (e.g. `options.includes("Skip all and continue")`).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/workflow-monitor/transition-prompt.test.ts -t "boundary prompt passes string labels"`

Expected: PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/transition-prompt.test.ts
git commit -m "fix(workflow-monitor): pass string ui.select options for boundary prompts"
```

---

## Checkpoint A

Run the full test suite before moving to behavior changes:

Run: `npm test`

Expected: PASS

---

## Phase 2 — Phase-aware enforcement (process vs practice)

### Task 4: Verification gate does not warn on `git commit` until workflow is in execute+

**Files:**
- Modify: `extensions/workflow-monitor.ts:351-380`
- Create: `tests/extension/workflow-monitor/verification-gate-phase.test.ts`

**Step 1: Write the failing test**

Create `tests/extension/workflow-monitor/verification-gate-phase.test.ts`:

```ts
import { describe, test, expect, vi } from "vitest";
import workflowMonitorExtension from "../../../extensions/workflow-monitor";
import { WORKFLOW_TRACKER_ENTRY_TYPE } from "../../../extensions/workflow-monitor/workflow-tracker";

type Handler = (event: any, ctx: any) => any;

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    api: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
    },
  };
}

function getSingleHandler(handlers: Map<string, Handler[]>, event: string): Handler {
  const list = handlers.get(event) ?? [];
  expect(list.length).toBeGreaterThan(0);
  return list[0]!;
}

describe("verification gate phase-awareness", () => {
  test("does not inject verification warning for git commit during brainstorm", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as any);

    const onSessionSwitch = getSingleHandler(fake.handlers, "session_switch");
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: WORKFLOW_TRACKER_ENTRY_TYPE,
            data: {
              phases: {
                brainstorm: "active",
                plan: "pending",
                execute: "pending",
                verify: "pending",
                review: "pending",
                finish: "pending",
              },
              currentPhase: "brainstorm",
              artifacts: { brainstorm: null, plan: null, execute: null, verify: null, review: null, finish: null },
              prompted: { brainstorm: false, plan: false, execute: false, verify: false, review: false, finish: false },
            },
          },
        ],
      },
      ui: { setWidget: () => {} },
    };

    await onSessionSwitch({}, ctx);

    await onToolCall({ toolCallId: "c1", toolName: "bash", input: { command: "git commit -m 'docs'" } }, ctx);

    const res = await onToolResult(
      {
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git commit -m 'docs'" },
        content: [{ type: "text", text: "ok" }],
        details: { exitCode: 0 },
      },
      ctx
    );

    const text = (res?.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    expect(text).not.toContain("VERIFICATION REQUIRED");
    expect(text).not.toContain("without running verification");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/workflow-monitor/verification-gate-phase.test.ts`

Expected: FAIL (warning currently injected even during brainstorm).

**Step 3: Write minimal implementation**

In `extensions/workflow-monitor.ts` (around lines 351-380), gate `handler.checkCommitGate(command)` behind the workflow phase:

```ts
const state = handler.getWorkflowState();
const phaseIdx = state?.currentPhase ? WORKFLOW_PHASES.indexOf(state.currentPhase) : -1;
const executeIdx = WORKFLOW_PHASES.indexOf("execute");

if (phaseIdx >= executeIdx) {
  const verificationViolation = handler.checkCommitGate(command);
  if (verificationViolation) pendingVerificationViolations.set(toolCallId, verificationViolation);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/workflow-monitor/verification-gate-phase.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/verification-gate-phase.test.ts
git commit -m "fix(workflow-monitor): gate verification warnings to execute+ phases"
```

---

### Task 5: Process violation warning when writing outside `docs/plans/` during brainstorm/plan

**Files:**
- Modify: `extensions/workflow-monitor.ts:347-453`
- Create: `tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts`

**Step 1: Write the failing test**

Create `tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import workflowMonitorExtension from "../../../extensions/workflow-monitor";
import { WORKFLOW_TRACKER_ENTRY_TYPE } from "../../../extensions/workflow-monitor/workflow-tracker";

type Handler = (event: any, ctx: any) => any;

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    api: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
    },
  };
}

function getSingleHandler(handlers: Map<string, Handler[]>, event: string): Handler {
  const list = handlers.get(event) ?? [];
  expect(list.length).toBeGreaterThan(0);
  return list[0]!;
}

describe("phase-aware file write enforcement", () => {
  test("warns when writing outside docs/plans during brainstorm", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as any);

    const onSessionSwitch = getSingleHandler(fake.handlers, "session_switch");
    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const onToolResult = getSingleHandler(fake.handlers, "tool_result");

    const ctx = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: WORKFLOW_TRACKER_ENTRY_TYPE,
            data: {
              phases: {
                brainstorm: "active",
                plan: "pending",
                execute: "pending",
                verify: "pending",
                review: "pending",
                finish: "pending",
              },
              currentPhase: "brainstorm",
              artifacts: { brainstorm: null, plan: null, execute: null, verify: null, review: null, finish: null },
              prompted: { brainstorm: false, plan: false, execute: false, verify: false, review: false, finish: false },
            },
          },
        ],
      },
      ui: { setWidget: () => {} },
    };

    await onSessionSwitch({}, ctx);

    await onToolCall(
      { toolCallId: "w1", toolName: "write", input: { path: "extensions/foo.ts", content: "x" } },
      ctx
    );

    const res = await onToolResult(
      {
        toolCallId: "w1",
        toolName: "write",
        input: { path: "extensions/foo.ts", content: "x" },
        content: [{ type: "text", text: "ok" }],
        details: {},
      },
      ctx
    );

    const text = (res?.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    expect(text).toContain("⚠️ PROCESS VIOLATION");
    expect(text).toContain("docs/plans/");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts`

Expected: FAIL (no process warning exists yet).

**Step 3: Write minimal implementation**

In `extensions/workflow-monitor.ts`:

1) Add a new per-toolCall pending warning map near the other maps:

```ts
const pendingProcessWarnings = new Map<string, string>();
```

2) In the `tool_call` handler (around lines 390-411), detect brainstorm/plan writes outside `docs/plans/`:

```ts
const state = handler.getWorkflowState();
const phase = state?.currentPhase;
const isThinkingPhase = phase === "brainstorm" || phase === "plan";
const isPlansWrite = typeof path === "string" && path.startsWith("docs/plans/");

if (isThinkingPhase && !isPlansWrite) {
  pendingProcessWarnings.set(
    toolCallId,
    `⚠️ PROCESS VIOLATION: Wrote ${path} during ${phase} phase.\n` +
      "During brainstorming/planning you may only write to docs/plans/. Stop and return to docs/plans/ or advance workflow phases intentionally."
  );
}
```

3) In the `tool_result` handler (around lines 446-453), inject `pendingProcessWarnings` for write/edit results:

```ts
const processWarning = pendingProcessWarnings.get(toolCallId);
if (processWarning) injected.push(processWarning);
pendingProcessWarnings.delete(toolCallId);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts
git commit -m "feat(workflow-monitor): warn on writes outside docs/plans during thinking phases"
```

---

## Phase 3 — Escalation: repeated violations become hard blocks

> **Note:** Hard-blocking must occur in `tool_call` (before the action executes). Soft warnings remain injected in `tool_result`.

### Task 6: Process bucket strike counter blocks on 2nd thinking-phase write violation

**Files:**
- Modify: `extensions/workflow-monitor.ts:88-115,347-421`
- Modify: `tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts`

**Step 1: Write the failing test**

Extend `tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts` with:

```ts
test("second process violation hard-blocks (interactive)", async () => {
  const fake = createFakePi();
  workflowMonitorExtension(fake.api as any);

  const onSessionSwitch = getSingleHandler(fake.handlers, "session_switch");
  const onToolCall = getSingleHandler(fake.handlers, "tool_call");

  let promptCount = 0;
  const ctx = {
    hasUI: true,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: WORKFLOW_TRACKER_ENTRY_TYPE,
          data: {
            phases: { brainstorm: "active", plan: "pending", execute: "pending", verify: "pending", review: "pending", finish: "pending" },
            currentPhase: "brainstorm",
            artifacts: { brainstorm: null, plan: null, execute: null, verify: null, review: null, finish: null },
            prompted: { brainstorm: false, plan: false, execute: false, verify: false, review: false, finish: false },
          },
        },
      ],
    },
    ui: {
      setWidget: () => {},
      select: async (_title: string, options: string[]) => {
        promptCount += 1;
        expect(options).toEqual(["Yes, continue", "No, stop"]);
        return "No, stop";
      },
      setEditorText: () => {},
      notify: () => {},
    },
  };

  await onSessionSwitch({}, ctx);

  // 1st violation: allowed
  await onToolCall({ toolCallId: "w1", toolName: "write", input: { path: "extensions/a.ts", content: "x" } }, ctx);

  // 2nd violation: should block
  const res = await onToolCall({ toolCallId: "w2", toolName: "write", input: { path: "extensions/b.ts", content: "y" } }, ctx);

  expect(promptCount).toBe(1);
  expect(res).toEqual({ blocked: true });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts -t "second process violation hard-blocks"`

Expected: FAIL (no blocking/escalation yet).

**Step 3: Write minimal implementation**

In `extensions/workflow-monitor.ts`:

1) Add strike counters near module state:

```ts
type ViolationBucket = "process" | "practice";
const strikes: Record<ViolationBucket, number> = { process: 0, practice: 0 };
```

Reset them inside the session reset handlers (near line ~95-115):

```ts
strikes.process = 0;
strikes.practice = 0;
```

2) Add a helper:

```ts
async function maybeEscalate(bucket: ViolationBucket, ctx: ExtensionContext): Promise<"allow" | "block"> {
  strikes[bucket] += 1;
  if (strikes[bucket] < 2) return "allow";

  if (!ctx.hasUI) return "allow"; // non-interactive: can’t prompt, so never hard-block

  const choice = await ctx.ui.select(
    `The agent has repeatedly violated ${bucket} guardrails. Allow it to continue?`,
    ["Yes, continue", "No, stop"]
  );

  if (choice === "Yes, continue") {
    strikes[bucket] = 0;
    return "allow";
  }

  return "block";
}
```

3) When a thinking-phase process violation is detected in `tool_call`, call `maybeEscalate("process", ctx)` and return `{ blocked: true }` when it returns `"block"`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts -t "second process violation hard-blocks"`

Expected: PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts
git commit -m "feat(workflow-monitor): hard-block repeated process violations with user override"
```

---

### Task 7: Practice bucket escalation blocks on 2nd TDD violation write

**Files:**
- Modify: `extensions/workflow-monitor.ts:382-453`
- Create: `tests/extension/workflow-monitor/warning-escalation-practice.test.ts`

**Step 1: Write the failing test**

Create `tests/extension/workflow-monitor/warning-escalation-practice.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import workflowMonitorExtension from "../../../extensions/workflow-monitor";

type Handler = (event: any, ctx: any) => any;

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    api: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
    },
  };
}

function getSingleHandler(handlers: Map<string, Handler[]>, event: string): Handler {
  const list = handlers.get(event) ?? [];
  expect(list.length).toBeGreaterThan(0);
  return list[0]!;
}

describe("practice escalation", () => {
  test("second TDD violation blocks the write (interactive)", async () => {
    const fake = createFakePi();
    workflowMonitorExtension(fake.api as any);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");

    let promptCount = 0;
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        setWidget: () => {},
        select: async () => {
          promptCount += 1;
          return "No, stop";
        },
        setEditorText: () => {},
        notify: () => {},
      },
    };

    // 1st TDD violation: allowed (warn later in tool_result)
    await onToolCall({ toolCallId: "t1", toolName: "write", input: { path: "src/a.ts", content: "x" } }, ctx);

    // 2nd TDD violation: should block
    const res = await onToolCall({ toolCallId: "t2", toolName: "write", input: { path: "src/b.ts", content: "y" } }, ctx);

    expect(promptCount).toBe(1);
    expect(res).toEqual({ blocked: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/workflow-monitor/warning-escalation-practice.test.ts`

Expected: FAIL (writes are never blocked today).

**Step 3: Write minimal implementation**

In `extensions/workflow-monitor.ts` `tool_call` handler:
- After `result = handler.handleToolCall(...)` detects `result.violation`, call `maybeEscalate("practice", ctx)`.
- If it returns `"block"`, do **not** record the pending warning and return `{ blocked: true }`.
- If it returns `"allow"`, keep the current behavior of recording the pending violation for tool_result warning injection.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/workflow-monitor/warning-escalation-practice.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/warning-escalation-practice.test.ts
git commit -m "feat(workflow-monitor): escalate repeated practice violations to hard blocks"
```

---

## Checkpoint B

Run: `npm test`

Expected: PASS

---

## Phase 4 — Skill boundary + prerequisite reinforcement

### Task 8: Add “Boundaries” to thinking-phase skills

**Files:**
- Modify: `skills/brainstorming/SKILL.md:10-16`
- Modify: `skills/writing-plans/SKILL.md:10-22`

**Step 1: Write the failing check (text verification)**

Run: `rg -n "^## Boundaries$" skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md`

Expected: 0 matches (FAIL for our intended change).

**Step 2: Apply the doc change**

In `skills/brainstorming/SKILL.md`, insert after the Overview paragraph (after line 14):

```md
## Boundaries
- Read code and docs: yes
- Write to docs/plans/: yes
- Edit or create any other files: no
```

In `skills/writing-plans/SKILL.md`, insert after “Save plans to …” (after line 20):

```md
## Boundaries
- Read code and docs: yes
- Write to docs/plans/: yes
- Edit or create any other files: no
```

**Step 3: Verify the change exists**

Run: `rg -n "^## Boundaries$" skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md`

Expected: 2 matches (PASS)

**Step 4: (Light) verify no tests broke**

Run: `npm test`

Expected: PASS

**Step 5: Commit**

```bash
git add skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md
git commit -m "docs(skills): add boundaries to brainstorming and writing-plans"
```

---

### Task 9: Add prerequisites + warning-respect lines to doing-phase skills

**Files:**
- Modify: `skills/test-driven-development/SKILL.md:10-20`
- Modify: `skills/executing-plans/SKILL.md:10-18`
- Modify: `skills/subagent-driven-development/SKILL.md:8-14`
- Modify: `skills/systematic-debugging/SKILL.md:10-20`
- Modify: `skills/verification-before-completion/SKILL.md:10-18`

**Step 1: Write the failing check (text verification)**

Run: `rg -n "If a tool result contains a ⚠️ workflow warning" skills -S`

Expected: 0 matches

**Step 2: Apply the doc changes**

1) Add to the following skills (near the top, after Overview):

```md
If a tool result contains a ⚠️ workflow warning, stop immediately and address it before continuing.
```

Apply to:
- `skills/test-driven-development/SKILL.md`
- `skills/executing-plans/SKILL.md`
- `skills/subagent-driven-development/SKILL.md`
- `skills/systematic-debugging/SKILL.md`
- `skills/verification-before-completion/SKILL.md`

2) Add prerequisites blocks to “doing” skills:

For `skills/test-driven-development/SKILL.md`, `skills/executing-plans/SKILL.md`, and `skills/subagent-driven-development/SKILL.md` add:

```md
## Prerequisites
- Active branch (not main) or user-confirmed intent to work on main
- Approved plan or clear task scope
```

3) Add boundaries to `skills/verification-before-completion/SKILL.md` (after Overview):

```md
## Boundaries
- Run verification commands: yes
- Read code and output: yes
- Edit source code: no
```

**Step 3: Verify the text is present**

Run: `rg -n "If a tool result contains a ⚠️ workflow warning" skills -S`

Expected: 5 matches

**Step 4: (Light) verify no tests broke**

Run: `npm test`

Expected: PASS

**Step 5: Commit**

```bash
git add skills/test-driven-development/SKILL.md skills/executing-plans/SKILL.md skills/subagent-driven-development/SKILL.md skills/systematic-debugging/SKILL.md skills/verification-before-completion/SKILL.md
git commit -m "docs(skills): add prerequisites, boundaries, and warning-respect lines"
```

---

## Phase 5 — User-facing documentation (do last, after behavior is stable)

### Task 10: Document the two-layer enforcement + escalation model

**Files:**
- Modify: `README.md`
- Create: `docs/oversight-model.md`
- Create: `docs/workflow-phases.md`

**Step 1: Write the failing check (doc existence)**

Run: `test -f docs/oversight-model.md && test -f docs/workflow-phases.md && echo ok`

Expected: command fails (non-zero) before creation.

**Step 2: Write docs**

1) `docs/oversight-model.md` should explain:
- Skill boundaries vs workflow monitor enforcement (defense in depth)
- Violation categories (process vs practice)
- Escalation path (soft warning → hard block → user override)
- Per-session counters and reset behavior

2) `docs/workflow-phases.md` should explain:
- What each phase permits (esp. “thinking” phases: only `docs/plans/` writes)
- How transitions work (`/skill:*`, boundary prompts, skip confirmations)

3) Update `README.md` with a concise summary linking to the above docs.

**Step 3: Verify docs exist**

Run: `test -f docs/oversight-model.md && test -f docs/workflow-phases.md && echo ok`

Expected: prints `ok`

**Step 4: Verify tests still pass**

Run: `npm test`

Expected: PASS

**Step 5: Commit**

```bash
git add README.md docs/oversight-model.md docs/workflow-phases.md
git commit -m "docs: explain oversight model and workflow phases"
```

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-02-13-warning-escalation-and-skill-boundaries-implementation.md`. Two execution options:

1) **Subagent-Driven (this session)** — Fresh subagent per task with two-stage review.

2) **Parallel Session (separate)** — Execute tasks in batches with checkpoints.

Which approach?
