# Langfuse Phase Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve `superpowers_phase` metadata while synchronizing one namespaced `phase:<latest-phase>` tag on each Langfuse trace.

**Architecture:** Keep phase retention and metadata generation in `src/phase.ts`. Add pure tag formatting plus an explicit `updateTraceTags(traceId, tags)` runtime operation. Pass the initial tag through root trace propagation and invoke the runtime update whenever the phase event changes, with failures isolated from Pi event handling. Use the installed Langfuse client's supported trace-update path, with the existing REST ingestion fallback extended if required.

**Tech Stack:** TypeScript, Langfuse client/tracing packages, Node test runner via `tsx`.

## Global Constraints

- Tags are namespaced exactly as `phase:<phase>`.
- Blank, whitespace-only, `null`, and `undefined` phases produce no phase tag.
- Only the latest phase tag is retained; historical phase tags are not accumulated.
- Existing `superpowers_phase` metadata behavior must remain unchanged.
- Tag-update failures must be logged and must not disable tracing or interrupt Pi event handling.
- Run package-scoped tests from `packages/langfuse`: `npm test`; run type checking with `npm run typecheck`.

---

### Task 1: Add pure phase-tag formatting and tests

**Files:**
- Modify: `packages/langfuse/src/phase.ts`
- Test: `packages/langfuse/test/phase-tracker.test.ts`

**Interfaces:**
- Produces `buildPhaseTags(): string[]`, returning `[]` when no phase is retained and `["phase:<retainedPhase>"]` otherwise.
- Preserve `buildPhaseMetadata(): Record<string, string>` and its current output exactly.
- Change `setPhase(incoming)` to return the retained `string | null` after applying the existing clearing/replacement semantics, without changing its synchronous behavior.

- [ ] **Step 1: Write failing tests for tag formatting and returned phase**

Add assertions covering the public phase helpers:

```ts
import { applyPhaseUpdate, buildPhaseMetadata, buildPhaseTags, setPhase } from "../src/phase.js";

test("buildPhaseTags namespaces the retained phase", () => {
  setPhase(null);
  setPhase("development");
  assert.deepEqual(buildPhaseTags(), ["phase:development"]);
  setPhase(null);
});

test("buildPhaseTags is empty when the phase is cleared", () => {
  setPhase("development");
  assert.equal(setPhase("  "), null);
  assert.deepEqual(buildPhaseTags(), []);
  setPhase(null);
});

test("setPhase returns the replacement phase", () => {
  assert.equal(setPhase("brainstorming"), "brainstorming");
  assert.equal(setPhase("development"), "development");
  assert.equal(setPhase(null), null);
});
```

Also assert that existing metadata tests still return `{ superpowers_phase: "development" }` and `{}` after clearing.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd packages/langfuse && node --import tsx --test test/phase-tracker.test.ts`

Expected: FAIL because `buildPhaseTags` is not exported and `setPhase` does not yet return the retained phase.

- [ ] **Step 3: Implement the minimal phase helpers**

In `src/phase.ts`, return `retainedPhase` from `setPhase`, and add:

```ts
export function buildPhaseTags(): string[] {
  return retainedPhase ? [`phase:${retainedPhase}`] : [];
}
```

Do not alter `applyPhaseUpdate` or the metadata key/value behavior.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `cd packages/langfuse && node --import tsx --test test/phase-tracker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/langfuse/src/phase.ts packages/langfuse/test/phase-tracker.test.ts
git commit -m "feat: add namespaced phase tag helper"
```

---

### Task 2: Add explicit runtime trace-tag update support

**Files:**
- Modify: `packages/langfuse/src/types.ts`
- Modify: `packages/langfuse/src/langfuse.ts`
- Modify: `packages/langfuse/types/langfuse-runtime-shims.d.ts` if its tracing/client declarations need the new API
- Test: `packages/langfuse/test/langfuse.test.ts`

**Interfaces:**
- Consumes `traceId: string` and `tags: string[]`.
- Produces `LangfuseRuntime.updateTraceTags(traceId: string, tags: string[]): Promise<void>`.
- The implementation must use the installed Langfuse client’s supported trace-update API. If the client exposes no direct trace-update method, send an existing-ingestion-compatible trace update through the package’s current `ingestBatch`/REST fallback path; do not add a separate HTTP client implementation.

- [ ] **Step 1: Write failing runtime tests**

Add a focused test using the existing runtime injection/test seams. Verify that `updateTraceTags("trace-1", ["phase:development"])` produces a trace update with exactly that tag list, and that `updateTraceTags("trace-1", [])` produces the API’s clear-tags representation. Add a rejection case that verifies the public runtime operation rejects so its caller can isolate/log the failure, rather than swallowing implementation errors inside the transport layer.

Use the actual request shape exposed by the installed SDK/API declarations; the test should inspect the client call or mocked ingestion batch rather than making a network request.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd packages/langfuse && node --import tsx --test test/langfuse.test.ts`

Expected: FAIL because `LangfuseRuntime` has no `updateTraceTags` operation.

- [ ] **Step 3: Extend the runtime type and implementation**

Add the method to `LangfuseRuntime`. Implement it in the runtime object created by `getRuntime()` using the installed Langfuse API. Preserve the existing runtime error tracking and request/flush behavior. For a REST fallback, keep the operation within the existing authenticated ingestion helper and serialize the trace ID plus complete `tags` array, including an empty array when clearing the phase tag.

Update all local runtime test fixtures and shims so TypeScript continues to enforce the new required interface.

- [ ] **Step 4: Run the focused and type checks**

Run: `cd packages/langfuse && node --import tsx --test test/langfuse.test.ts && npm run typecheck`

Expected: PASS with no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/langfuse/src/types.ts packages/langfuse/src/langfuse.ts packages/langfuse/types packages/langfuse/test/langfuse.test.ts
git commit -m "feat: support Langfuse trace tag updates"
```

---

### Task 3: Apply initial and live phase tags to agent traces

**Files:**
- Modify: `packages/langfuse/src/handlers/agent.ts`
- Modify: `packages/langfuse/index.ts`
- Modify: `packages/langfuse/src/state.ts` only if a tag-sync retry/desired-state field is required by the implementation
- Test: `packages/langfuse/test/index.test.ts`

**Interfaces:**
- Consumes `buildPhaseTags()`, `setPhase()`, `state.agentState.root`, `state.agentState.traceId`, and `LangfuseRuntime.updateTraceTags()`.
- Produces an initial `tags` attribute in the root `propagateAttributes` call when tags are non-empty, plus an exported/internal `syncActiveTracePhaseTags(): Promise<void>` helper used by the phase event listener.

- [ ] **Step 1: Write failing integration tests**

Extend `test/index.test.ts` and its fake runtime/observation to assert:

```ts
assert.deepEqual(propagatedAttributes.tags, ["phase:development"]);
```

Add a test that starts an agent with no phase, emits a phase event after the root exists, and verifies the fake runtime received `("trace-id", ["phase:development"])`. Emit a second phase and verify the second call contains only `["phase:brainstorming"]`; emit a clearing event and verify the call contains `[]`. Add a failure case where `updateTraceTags` rejects and assert the phase handler does not reject.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd packages/langfuse && node --import tsx --test test/index.test.ts`

Expected: FAIL because root propagation does not pass tags and phase events do not synchronize active traces.

- [ ] **Step 3: Add initial tags to root trace creation**

In `startAgentRun`, import `buildPhaseTags()` and add `tags` to the `propagateAttributes` parameters only when the returned array is non-empty. Keep the existing `metadata: stringMetadata(captured.metadata)` untouched. The root observation body must continue receiving the existing metadata.

- [ ] **Step 4: Add live phase synchronization with failure isolation**

Add a helper in the agent handler that checks for an active root/trace ID, obtains the runtime, and calls `updateTraceTags(traceId, buildPhaseTags())`. Catch failures and log a warning such as `📊 Langfuse: Failed to update phase tags`; never set `state.isTracingDisabled` for this failure.

In the `superpowers:phase` listener, call `setPhase(...)` first, then invoke the helper without awaiting it (`void syncActiveTracePhaseTags()`). This permits phases emitted before trace creation to remain retained for initial tagging and ensures late phase changes update the existing trace.

If rapid phase events require ordering protection, maintain a single promise chain in the helper so updates are sent in event order and each request sends the latest complete tag list; do not append tags locally.

- [ ] **Step 5: Run the focused tests and type check**

Run: `cd packages/langfuse && node --import tsx --test test/index.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/langfuse/src/handlers/agent.ts packages/langfuse/index.ts packages/langfuse/src/state.ts packages/langfuse/test/index.test.ts
git commit -m "feat: sync Langfuse tags with phase changes"
```

---

### Task 4: Update package documentation and run the complete verification suite

**Files:**
- Modify: `packages/langfuse/README.md`
- Test: `packages/langfuse/test/phase-tracker.test.ts`, `packages/langfuse/test/index.test.ts`, and the full package test suite

- [ ] **Step 1: Document phase tags next to phase metadata**

Update the existing Superpowers phase section to state that the extension preserves `superpowers_phase` metadata and also maintains one trace-level tag named `phase:<latest-phase>`. Document that traces can begin untagged, phase changes replace the previous phase tag, and clearing the phase removes the tag.

- [ ] **Step 2: Run the full package test suite**

Run: `cd packages/langfuse && npm test`

Expected: PASS for every test file.

- [ ] **Step 3: Run type checking and inspect the final diff**

Run: `cd packages/langfuse && npm run typecheck && git diff HEAD~3 --check`

Expected: no type errors and no whitespace errors. Confirm that existing metadata assertions and the new trace-tag assertions are both present.

- [ ] **Step 4: Commit**

```bash
git add packages/langfuse/README.md packages/langfuse/test
 git commit -m "docs: describe Langfuse phase tags"
```

---

## Verification

After all tasks, run:

```bash
cd packages/langfuse
npm test
npm run typecheck
```

Confirm in the implementation that:

- Root traces begin with no phase tag when no phase is retained.
- A later phase event updates the existing trace with exactly one `phase:<phase>` tag.
- A subsequent phase event replaces, rather than appends to, the tag.
- Clearing the phase removes the trace tag.
- `superpowers_phase` metadata remains unchanged on root and generation observations.
- A failed tag request logs a warning but does not interrupt the agent.
