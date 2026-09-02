# Remove Boundary "What Next?" Transition Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the spontaneous "What next?" boundary prompts (Kind A) from the workflow-monitor extension while preserving the finish-phase reminder and the skip-confirmation guardrails (Kind B), and fix the absolute-path bug that silently breaks artifact-based phase tracking.

**Architecture:** All changes are confined to `extensions/workflow-monitor.ts` and its `extensions/workflow-monitor/` support modules, plus their tests and docs. No new files except doc/test churn; one file deleted (`workflow-transitions.ts`) and its two dedicated test files deleted.

**Tech Stack:** TypeScript, Vitest, the pi extension SDK (`@earendil-works/pi-coding-agent`).

## Global Constraints

- Full suite (`npm test`) must be green (0 failures) at the end of every task below.
- No behavior change to Kind B (skip-confirmation / completion gates), or to the TDD/debug/verification monitors.
- The finish-phase reminder text must be preserved byte-for-byte (same "Before finishing:" copy), only relocated.
- Path normalization must use forward slashes regardless of OS (`path.sep` → `/` join), matching the existing `SPECS_DIR_RE`/`PLANS_DIR_RE` regex format.
- Reference spec: `docs/superpowers/specs/2026-07-28-remove-boundary-transition-prompts-design.md`.

---

### Task 1: Relocate the finish-phase reminder into the `/finish` command handler

**Files:**
- Modify: `extensions/workflow-monitor.ts:210-247` (the `input` handler's `finish()` closure)
- Modify: `tests/extension/workflow-monitor/command-driven-input.test.ts` (existing test at line 87, `"/finish transforms to /skill:finishing-a-development-branch"`)

**Interfaces:**
- Consumes: existing `finish()` closure structure (the `phase === "execute"` special case at lines 235-246 is the pattern to mirror).
- Produces: `/finish` (and any other route that resolves `phase === "finish"`) now returns `{ action: "handled" }` after calling `ctx.ui.setEditorText(...)` with the reminder + skill command pre-filled, instead of `{ action: "transform", text: "/skill:finishing-a-development-branch" }`.

Currently the finish-phase reminder text only exists inside the `agent_end` handler (removed in Task 2), fired only after a boundary-prompt selection — so it will disappear entirely unless moved here first.

- [ ] **Step 1: Update the existing test to the target behavior**

In `tests/extension/workflow-monitor/command-driven-input.test.ts`, replace the test at line 87:

```ts
  test("/finish transforms to /skill:finishing-a-development-branch", async () => {
    const { inputHandlers, appended } = setup();
    const result = await runInput(inputHandlers, { text: "/finish", source: "interactive" }, makeCtx());
    expect(result.action).toBe("transform");
    expect(result.text).toBe("/skill:finishing-a-development-branch");
    expect(getPhase(appended)).toBe("finish");
  });
```

with:

```ts
  test("/finish presents the reminder pre-fill (handled, not transform)", async () => {
    const { inputHandlers, appended } = setup();
    const ctx = makeCtx();
    const result = await runInput(inputHandlers, { text: "/finish", source: "interactive" }, ctx);
    expect(result.action).toBe("handled");
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith(
      "Before finishing:\n" +
        "- Does this work require documentation updates? (README, CHANGELOG, API docs, inline docs)\n" +
        "- What was learned during this implementation? (surprises, codebase knowledge, things to do differently)\n\n" +
        "/skill:finishing-a-development-branch",
    );
    expect(getPhase(appended)).toBe("finish");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extension/workflow-monitor/command-driven-input.test.ts -t "reminder pre-fill"`
Expected: FAIL — `result.action` is `"transform"`, not `"handled"` (current code doesn't special-case `finish`).

- [ ] **Step 3: Implement the finish-phase special case**

In `extensions/workflow-monitor.ts`, replace the `finish()` closure:

```ts
    const finish = (): InputEventResult => {
      if (phase === "execute") {
        const choice =
          "Implementation phase. Two execution options:\n\n" +
          "1. /skill:subagent-driven-development (recommended, same session)\n" +
          "2. /skill:executing-plans (parallel session, batched)\n\n" +
          "Type the /skill: command for your chosen approach.";
        if (ctx.hasUI) {
          ctx.ui.setEditorText(choice);
          ctx.ui.notify("Stage set to execute. Pick an execution approach.", "info");
        }
        return { action: "handled" };
      }

      if (skillPhase) return { action: "continue" };

      const skill = phaseToSkill[phase];
      const args = trimmed.slice(firstToken.length).trim();
      return { action: "transform", text: args ? `/skill:${skill} ${args}` : `/skill:${skill}` };
    };
```

with:

```ts
    const finish = (): InputEventResult => {
      if (phase === "execute") {
        const choice =
          "Implementation phase. Two execution options:\n\n" +
          "1. /skill:subagent-driven-development (recommended, same session)\n" +
          "2. /skill:executing-plans (parallel session, batched)\n\n" +
          "Type the /skill: command for your chosen approach.";
        if (ctx.hasUI) {
          ctx.ui.setEditorText(choice);
          ctx.ui.notify("Stage set to execute. Pick an execution approach.", "info");
        }
        return { action: "handled" };
      }

      if (phase === "finish") {
        const finishReminder =
          "Before finishing:\n" +
          "- Does this work require documentation updates? (README, CHANGELOG, API docs, inline docs)\n" +
          "- What was learned during this implementation? (surprises, codebase knowledge, things to do differently)\n\n";
        if (ctx.hasUI) {
          ctx.ui.setEditorText(`${finishReminder}/skill:finishing-a-development-branch`);
        }
        return { action: "handled" };
      }

      if (skillPhase) return { action: "continue" };

      const skill = phaseToSkill[phase];
      const args = trimmed.slice(firstToken.length).trim();
      return { action: "transform", text: args ? `/skill:${skill} ${args}` : `/skill:${skill}` };
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/workflow-monitor/command-driven-input.test.ts`
Expected: PASS (all tests in the file, including the updated one).

Run: `npm test`
Expected: PASS (full suite still green — Task 2 hasn't run yet, so the old `agent_end`-driven finish-reminder test in `transition-prompt.test.ts` still passes unchanged; both mechanisms coexist until Task 2 removes the old one).

- [ ] **Step 5: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/command-driven-input.test.ts
git commit -m "feat(workflow-monitor): relocate finish-phase reminder to /finish command handler"
```

---

### Task 2: Remove the Kind A boundary "What next?" prompt mechanism

**Files:**
- Modify: `extensions/workflow-monitor.ts` (remove imports, the `boundaryToPhase` map, and the `agent_end` handler block)
- Modify: `extensions/workflow-monitor/workflow-tracker.ts` (remove `computeBoundaryToPrompt` and `TransitionBoundary`)
- Delete: `extensions/workflow-monitor/workflow-transitions.ts`
- Delete: `tests/extension/workflow-monitor/transition-prompt.test.ts`
- Delete: `tests/extension/workflow-monitor/workflow-transitions.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no more `pi.on("agent_end", ...)` registration in this extension; `computeBoundaryToPrompt`/`TransitionBoundary`/`getTransitionPrompt` no longer exist.

- [ ] **Step 1: Delete the two Kind-A-only test files**

```bash
git rm tests/extension/workflow-monitor/transition-prompt.test.ts tests/extension/workflow-monitor/workflow-transitions.test.ts
```

- [ ] **Step 2: Remove the `agent_end` handler block**

In `extensions/workflow-monitor.ts`, delete the entire block (currently lines ~640-691, immediately after the two `pi.on("session_tree", ...)`/input-handler code and before the `formatViolationWarning` function):

```ts
  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const latestState = handler.getWorkflowState();
    if (!latestState) return;

    const boundary = computeBoundaryToPrompt(latestState);
    if (!boundary) return;

    const boundaryPhase = boundaryToPhase[boundary];
    const prompt = getTransitionPrompt(boundary, latestState.artifacts[boundaryPhase]);

    const options = prompt.options.map((o) => o.label);
    const pickedLabel = await ctx.ui.select(prompt.title, options);

    const selected = prompt.options.find((o) => o.label === pickedLabel)?.choice ?? null;

    const marked = handler.markWorkflowPrompted(boundaryPhase);
    if (marked) {
      persistState();
      updateWidget(ctx);
    }

    const nextSkill = phaseToSkill[prompt.nextPhase] ?? "writing-plans";
    const nextInSession = `/skill:${nextSkill}`;
    const fresh = `/workflow-next ${prompt.nextPhase}${prompt.artifactPath ? ` ${prompt.artifactPath}` : ""}`;
    const finishReminder =
      "Before finishing:\n" +
      "- Does this work require documentation updates? (README, CHANGELOG, API docs, inline docs)\n" +
      "- What was learned during this implementation? (surprises, codebase knowledge, things to do differently)\n\n";

    if (selected === "next") {
      ctx.ui.setEditorText(prompt.nextPhase === "finish" ? finishReminder + nextInSession : nextInSession);
    } else if (selected === "fresh") {
      ctx.ui.setEditorText(prompt.nextPhase === "finish" ? finishReminder + fresh : fresh);
    } else if (selected === "skip") {
      // Explicit user-confirmed skip: mark the next phase as skipped, then move on.
      handler.skipWorkflowPhases([prompt.nextPhase]);

      const nextIdx = WORKFLOW_PHASES.indexOf(prompt.nextPhase);
      const phaseAfterSkip = WORKFLOW_PHASES[nextIdx + 1] ?? null;

      if (phaseAfterSkip) {
        const currentState = handler.getWorkflowState();
        const currentIdx = currentState?.currentPhase ? WORKFLOW_PHASES.indexOf(currentState.currentPhase) : -1;
        const afterSkipIdx = WORKFLOW_PHASES.indexOf(phaseAfterSkip);
        if (afterSkipIdx > currentIdx) {
          handler.advanceWorkflowTo(phaseAfterSkip);
          const skipSkill = phaseToSkill[phaseAfterSkip] ?? "writing-plans";
          ctx.ui.setEditorText(`/skill:${skipSkill}`);
        }
      }

      persistState();
      updateWidget(ctx);
    }
  });

```

Delete the whole block, including the trailing blank line, so the file flows directly from the `session_tree` registration into the `// --- Format violation warning based on type ---` section.

- [ ] **Step 3: Remove the now-unused `boundaryToPhase` map**

In `extensions/workflow-monitor.ts`, delete:

```ts
  const boundaryToPhase: Record<TransitionBoundary, Phase> = {
    design_committed: "brainstorm",
    plan_ready: "plan",
    execution_complete: "execute",
    verification_passed: "verify",
    review_complete: "review",
  };
```

- [ ] **Step 4: Remove now-unused imports**

In `extensions/workflow-monitor.ts`, change:

```ts
import {
  computeBoundaryToPrompt,
  type Phase,
  parseSkillName,
  SKILL_TO_PHASE,
  type TransitionBoundary,
  WORKFLOW_PHASES,
  WORKFLOW_TRACKER_ENTRY_TYPE,
  type WorkflowTrackerState,
} from "./workflow-monitor/workflow-tracker";
import { getTransitionPrompt } from "./workflow-monitor/workflow-transitions";
```

to:

```ts
import {
  type Phase,
  parseSkillName,
  SKILL_TO_PHASE,
  WORKFLOW_PHASES,
  WORKFLOW_TRACKER_ENTRY_TYPE,
  type WorkflowTrackerState,
} from "./workflow-monitor/workflow-tracker";
```

- [ ] **Step 5: Delete `workflow-transitions.ts`**

```bash
git rm extensions/workflow-monitor/workflow-transitions.ts
```

- [ ] **Step 6: Remove `computeBoundaryToPrompt` and `TransitionBoundary` from the tracker**

In `extensions/workflow-monitor/workflow-tracker.ts`, delete:

```ts
export type TransitionBoundary =
  | "design_committed"
  | "plan_ready"
  | "execution_complete"
  | "verification_passed"
  | "review_complete";

export function computeBoundaryToPrompt(state: WorkflowTrackerState): TransitionBoundary | null {
  if (state.phases.brainstorm === "complete" && !state.prompted.brainstorm) {
    return "design_committed";
  }
  if (state.phases.plan === "complete" && !state.prompted.plan) {
    return "plan_ready";
  }
  if (state.phases.execute === "complete" && !state.prompted.execute) {
    return "execution_complete";
  }
  if (state.phases.verify === "complete" && !state.prompted.verify) {
    return "verification_passed";
  }
  if (state.phases.review === "complete" && !state.prompted.review) {
    return "review_complete";
  }
  return null;
}
```

Leave everything else in the file untouched for now (the `prompted` field itself is removed in Task 3).

- [ ] **Step 7: Run the full suite to confirm nothing else depended on the removed code**

Run: `npm test`
Expected: PASS. (TypeScript compile errors here would mean something still references the deleted exports — fix by grep'ing for `computeBoundaryToPrompt`, `TransitionBoundary`, `getTransitionPrompt`, `boundaryToPhase` across `extensions/` and `tests/` and removing any remaining references before proceeding. `workflow-handler-tracker.test.ts` still imports `computeBoundaryToPrompt` — Task 3 handles that file; if `npm test` fails to *compile* because of it, that's expected and resolved in Task 3.)

If Step 7 fails only because of `workflow-handler-tracker.test.ts` and `workflow-tracker.test.ts`/`state-persistence.test.ts` referencing removed exports, that is expected — proceed to Task 3 immediately (these two tasks are tightly coupled; do not commit Task 2 alone if the suite doesn't compile). Otherwise, if everything is green already:

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(workflow-monitor): remove boundary \"what next?\" transition prompts"
```

(If Step 7 required proceeding into Task 3 first, fold this commit into Task 3's commit instead — do not leave a broken intermediate commit.)

---

### Task 3: Remove the `prompted` bookkeeping (dead once Task 2 lands)

**Files:**
- Modify: `extensions/workflow-monitor/workflow-tracker.ts` (remove `prompted` field, `markPrompted` method, `emptyState()` initialization)
- Modify: `extensions/workflow-monitor/workflow-handler.ts` (remove `markWorkflowPrompted` from interface + implementation, remove `prompted` from `SuperpowersStatePatch`'s workflow shape, remove the `prompted` merge line in `setFullState`)
- Modify: `tests/extension/workflow-monitor/workflow-tracker.test.ts` (remove `markPrompted`/`prompted` assertions)
- Modify: `tests/extension/workflow-monitor/workflow-handler-tracker.test.ts` (remove the `prompted`-specific test + now-unused import)
- Modify: `tests/extension/workflow-monitor/state-persistence.test.ts` (strip `prompted: {...}` blocks from fixture objects)
- Modify: `tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts` (strip `prompted: {...}` from its one fixture)

**Interfaces:**
- Consumes: nothing new.
- Produces: `WorkflowTrackerState` no longer has a `prompted` field; `WorkflowHandler` no longer has `markWorkflowPrompted`.

- [ ] **Step 1: Remove `prompted` from the tracker's state shape and API**

In `extensions/workflow-monitor/workflow-tracker.ts`, change:

```ts
export interface WorkflowTrackerState {
  phases: Record<Phase, PhaseStatus>;
  currentPhase: Phase | null;
  artifacts: Record<Phase, string | null>;
  prompted: Record<Phase, boolean>;
}
```

to:

```ts
export interface WorkflowTrackerState {
  phases: Record<Phase, PhaseStatus>;
  currentPhase: Phase | null;
  artifacts: Record<Phase, string | null>;
}
```

Change `emptyState()`:

```ts
function emptyState(): WorkflowTrackerState {
  const phases = Object.fromEntries(WORKFLOW_PHASES.map((p) => [p, "pending"])) as Record<Phase, PhaseStatus>;

  const artifacts = Object.fromEntries(WORKFLOW_PHASES.map((p) => [p, null])) as Record<Phase, string | null>;

  const prompted = Object.fromEntries(WORKFLOW_PHASES.map((p) => [p, false])) as Record<Phase, boolean>;

  return { phases, currentPhase: null, artifacts, prompted };
}
```

to:

```ts
function emptyState(): WorkflowTrackerState {
  const phases = Object.fromEntries(WORKFLOW_PHASES.map((p) => [p, "pending"])) as Record<Phase, PhaseStatus>;

  const artifacts = Object.fromEntries(WORKFLOW_PHASES.map((p) => [p, null])) as Record<Phase, string | null>;

  return { phases, currentPhase: null, artifacts };
}
```

Delete the `markPrompted` method:

```ts
  markPrompted(phase: Phase): boolean {
    if (this.state.prompted[phase]) return false;
    this.state.prompted[phase] = true;
    return true;
  }

```

- [ ] **Step 2: Remove `markWorkflowPrompted` and the `prompted` patch shape from the handler**

In `extensions/workflow-monitor/workflow-handler.ts`, change:

```ts
export type SuperpowersStatePatch = {
  workflow?: Partial<WorkflowTrackerState> & {
    phases?: Partial<Record<Phase, PhaseStatus>>;
    artifacts?: Partial<Record<Phase, string | null>>;
    prompted?: Partial<Record<Phase, boolean>>;
  };
```

to:

```ts
export type SuperpowersStatePatch = {
  workflow?: Partial<WorkflowTrackerState> & {
    phases?: Partial<Record<Phase, PhaseStatus>>;
    artifacts?: Partial<Record<Phase, string | null>>;
  };
```

Remove from the `WorkflowHandler` interface:

```ts
  markWorkflowPrompted(phase: Phase): boolean;
```

Remove the implementation:

```ts
    markWorkflowPrompted(phase: Phase) {
      return tracker.markPrompted(phase);
    },

```

In `setFullState`, change:

```ts
        tracker.setState({
          ...defaultWorkflow,
          ...snapshot.workflow,
          phases: { ...defaultWorkflow.phases, ...snapshot.workflow.phases },
          artifacts: { ...defaultWorkflow.artifacts, ...snapshot.workflow.artifacts },
          prompted: { ...defaultWorkflow.prompted, ...snapshot.workflow.prompted },
        });
```

to:

```ts
        tracker.setState({
          ...defaultWorkflow,
          ...snapshot.workflow,
          phases: { ...defaultWorkflow.phases, ...snapshot.workflow.phases },
          artifacts: { ...defaultWorkflow.artifacts, ...snapshot.workflow.artifacts },
        });
```

- [ ] **Step 3: Update `workflow-tracker.test.ts`**

Remove the `tracker.markPrompted("plan");` line and the `expect(s.prompted.plan).toBe(false);` assertion from the `"advanceTo backward triggers full reset..."` test (~line 72, 83). Remove the `tracker.markPrompted("brainstorm");` line and the `for (const p of WORKFLOW_PHASES) expect(s.prompted[p]).toBe(false);` line from the `"reset() restores tracker to empty state..."` test (~line 115, 123).

- [ ] **Step 4: Update `workflow-handler-tracker.test.ts`**

Replace the whole file's contents (it currently has one unaffected test and one `prompted`-only test) with:

```ts
import { beforeEach, describe, expect, test } from "vitest";
import { createWorkflowHandler, type WorkflowHandler } from "../../../extensions/workflow-monitor/workflow-handler";

describe("WorkflowHandler workflow-tracker integration", () => {
  let handler: WorkflowHandler;

  beforeEach(() => {
    handler = createWorkflowHandler();
  });

  test("advanceWorkflowTo(plan) activates plan phase", () => {
    handler.advanceWorkflowTo("plan");
    expect(handler.getWorkflowState()?.currentPhase).toBe("plan");
  });

  test("advanceWorkflowTo(execute) auto-completes the prior active phase", () => {
    handler.advanceWorkflowTo("plan");
    handler.advanceWorkflowTo("execute");

    const state = handler.getWorkflowState()!;
    expect(state.currentPhase).toBe("execute");
    expect(state.phases.plan).toBe("complete");
  });
});
```

(This replaces the deleted `computeBoundaryToPrompt` assertion with a direct assertion of the underlying forward-auto-complete behavior it used to indirectly exercise — this is the Task 4 Step 4 regression coverage referenced in the design's Completion Marking section, added here since this file already has the right shape for it.)

- [ ] **Step 5: Strip `prompted` from `state-persistence.test.ts` fixtures**

At each of the 6 occurrences (originally ~lines 133, 297, 376, 430, 527, 553), delete the `prompted: { ... }` block. Each occurrence is a sibling key to `phases`/`currentPhase`/`artifacts` inside a `workflow: { ... }` object literal — delete only the `prompted` key and its value object, leaving the rest of the fixture (`phases`, `currentPhase`, `artifacts`, and the sibling `tdd`/`debug`/`verification` blocks) unchanged. Example (the ~line 133 occurrence) — before:

```ts
        artifacts: {
          brainstorm: "docs/superpowers/specs/2026-02-15-feature-design.md",
          plan: null,
          execute: null,
          verify: null,
          review: null,
          finish: null,
        },
        prompted: {
          brainstorm: true,
          plan: false,
          execute: false,
          verify: false,
          review: false,
          finish: false,
        },
      },
      tdd: {
```

after:

```ts
        artifacts: {
          brainstorm: "docs/superpowers/specs/2026-02-15-feature-design.md",
          plan: null,
          execute: null,
          verify: null,
          review: null,
          finish: null,
        },
      },
      tdd: {
```

Apply the same removal pattern at the other 5 occurrences.

- [ ] **Step 6: Strip `prompted` from `phase-aware-write-enforcement.test.ts`'s fixture**

Delete the `prompted: { brainstorm: false, plan: false, execute: false, verify: false, review: false, finish: false },` line from the one `data: { ... }` fixture object in this file (the "warns when writing outside docs/superpowers/specs during brainstorm" test).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures, no TypeScript compile errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(workflow-monitor): remove now-dead prompted bookkeeping"
```

---

### Task 4: Fix the absolute-path artifact-tracking bug

**Files:**
- Modify: `extensions/workflow-monitor.ts:497-521` (the write/edit tool_call handler's boundary-check + `handleFileWritten` call site)
- Modify: `tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts` (add: absolute-path artifact write test)
- Modify: `tests/extension/workflow-monitor/command-driven-input.test.ts` or `workflow-handler-tracker.test.ts` — already covered by Task 3 Step 4's new "auto-completes the prior active phase" test; no further forward-complete regression test needed here.

**Interfaces:**
- Consumes: the `resolved` absolute path already computed in the existing boundary-check code (`path.resolve(process.cwd(), normalizedForCheck)`).
- Produces: `handler.handleFileWritten(...)` now receives a cwd-relative, forward-slash-normalized path regardless of whether the tool call supplied a relative or absolute path.

- [ ] **Step 1: Write the failing test**

In `tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts`, add a new test (using the same `createFakePi`/`getSingleHandler` pattern as the existing tests in this file):

```ts
  test("writing to an absolute path under docs/superpowers/specs advances the brainstorm phase", async () => {
    const fake = createFakePi({ withAppendEntry: true });
    workflowMonitorExtension(fake.api as any);

    const onToolCall = getSingleHandler(fake.handlers, "tool_call");
    const ctx = { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: () => {} } };

    const absolutePath = `${process.cwd()}/docs/superpowers/specs/2026-01-01-example-design.md`;
    await onToolCall(
      { toolCallId: "w1", toolName: "write", input: { path: absolutePath, content: "# design" } },
      ctx,
    );

    const latest = fake.appendedEntries.at(-1)?.data;
    expect(latest.workflow.phases.brainstorm).toBe("active");
    expect(latest.workflow.artifacts.brainstorm).toBe("docs/superpowers/specs/2026-01-01-example-design.md");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts -t "absolute path"`
Expected: FAIL — `latest.workflow.phases.brainstorm` is `"pending"` (or `latest` itself reflects no change), because `SPECS_DIR_RE` doesn't match the absolute path currently passed to `handleFileWritten`.

- [ ] **Step 3: Implement the fix**

In `extensions/workflow-monitor.ts`, change:

```ts
        const isAllowedWrite = allowedRoot !== null && resolved.startsWith(allowedRoot);

        if (isThinkingPhase && !isAllowedWrite) {
          const escalation = await maybeEscalate("process", ctx);
          if (escalation === "block") {
            return { block: true };
          }

          const allowedDir = phase === "brainstorm" ? "docs/superpowers/specs/" : "docs/superpowers/plans/";
          pendingProcessWarnings.set(
            toolCallId,
            `⚠️ PROCESS VIOLATION: Wrote ${filePath} during ${phase} phase.\n` +
              `During ${phase} you may only write to ${allowedDir}. Stop and return to ${allowedDir} or advance workflow phases intentionally.`,
          );
        }

        changed = handler.handleFileWritten(filePath) || changed;
```

to:

```ts
        const isAllowedWrite = allowedRoot !== null && resolved.startsWith(allowedRoot);

        if (isThinkingPhase && !isAllowedWrite) {
          const escalation = await maybeEscalate("process", ctx);
          if (escalation === "block") {
            return { block: true };
          }

          const allowedDir = phase === "brainstorm" ? "docs/superpowers/specs/" : "docs/superpowers/plans/";
          pendingProcessWarnings.set(
            toolCallId,
            `⚠️ PROCESS VIOLATION: Wrote ${filePath} during ${phase} phase.\n` +
              `During ${phase} you may only write to ${allowedDir}. Stop and return to ${allowedDir} or advance workflow phases intentionally.`,
          );
        }

        // Artifact-tracking regexes (SPECS_DIR_RE/PLANS_DIR_RE) are anchored to a
        // cwd-relative path. Tool calls may supply either a relative or absolute
        // path, so normalize to cwd-relative + forward slashes before handing off.
        const relativePath = path.relative(process.cwd(), resolved).split(path.sep).join("/");
        changed = handler.handleFileWritten(relativePath) || changed;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures. (Existing tests that write with relative paths like `"extensions/foo.ts"` or `"./docs/superpowers/specs/..."` must still behave identically — `path.relative(process.cwd(), path.resolve(process.cwd(), "extensions/foo.ts"))` normalizes back to `"extensions/foo.ts"`, so this is a no-op for already-relative inputs.)

- [ ] **Step 6: Commit**

```bash
git add extensions/workflow-monitor.ts tests/extension/workflow-monitor/phase-aware-write-enforcement.test.ts
git commit -m "fix(workflow-monitor): normalize absolute paths for artifact-based phase tracking"
```

---

### Task 5: Update docs

**Files:**
- Modify: `README.md`
- Modify: `docs/workflow-phases.md`
- Modify: `docs/oversight-model.md` (only if it references Kind A specifically — verify first)
- Modify: `CHANGELOG.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `README.md`'s "Workflow Tracker" section**

Find the paragraph beginning "At phase boundaries, prompts the agent once (non-enforcing) with options:" and its numbered list (1. Next step, 2. Fresh session, 3. Skip, 4. Discuss). Replace that paragraph and list with:

```markdown
Phase transitions are driven by the workflow skills themselves (e.g. `brainstorming` invokes
`writing-plans` on completion) and by explicit user commands (`/brainstorm`…`/finish`,
`/superpowers stage <phase>`, `/workflow-next`). The tracker does not proactively prompt at phase
boundaries — it tracks state and displays the phase strip in the TUI widget.

If a phase command or a ship action (`git commit`/`git push`/`gh pr create`) would skip past a
phase still in `pending` status, a skip-confirmation prompt asks whether to do that phase now,
skip it, or cancel — this is the only prompt that fires unprompted by explicit user action.
```

- [ ] **Step 2: Update the `/workflow-next` deprecation note in `README.md`**

Find the line describing `/workflow-next` and `/workflow-reset` as deprecated in favor of `/superpowers`, and remove any wording that frames them as replacing the boundary-prompt "Fresh session" option specifically (they remain manual hand-off/reset tools; there is no automatic prompt they are "subsuming" anymore). Keep the rest of the deprecation note (commands still work, will be removed in a future release) unchanged.

- [ ] **Step 3: Update `docs/workflow-phases.md`**

Under "## Boundary prompts and skipping", remove the paragraph:

```markdown
The workflow-monitor extension can prompt at boundaries (e.g. after `agent_end`) with options like:
- Next step (this session)
- Fresh session → next step
- Skip
- Discuss

```

Keep the following paragraph about the skip-confirmation gate ("For some transitions (e.g. attempting to execute without a plan), a **skip-confirmation gate** may appear...") unchanged, and reword the section heading/lead-in if needed so it reads coherently without the removed paragraph (e.g. "## Skip confirmation" instead of "## Boundary prompts and skipping").

- [ ] **Step 4: Check `docs/oversight-model.md`**

Read the file and check for any wording specific to the boundary "what next?" prompts (as opposed to the general process/practice violation escalation model, which is unaffected). If none is found, no change is needed — note this in the commit message.

- [ ] **Step 5: Add a `CHANGELOG.md` entry**

Under `## [Unreleased]`, add a new subsection (or extend the existing `### Fixed`/`### Changed` as appropriate) describing:
- Removal of the boundary "What next?" transition prompts (Kind A), with the false-premise and UX-collision rationale.
- Preservation of the finish-phase reminder via the `/finish` command handler.
- The absolute-path artifact-tracking fix.

- [ ] **Step 6: Run the full suite one more time**

Run: `npm test`
Expected: PASS, 0 failures (docs changes shouldn't affect this, but confirms nothing was left broken).

- [ ] **Step 7: Commit**

```bash
git add README.md docs/workflow-phases.md docs/oversight-model.md CHANGELOG.md
git commit -m "docs: update workflow-tracker docs for removed boundary prompts"
```
