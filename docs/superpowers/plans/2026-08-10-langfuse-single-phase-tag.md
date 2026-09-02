# Langfuse Single Phase Tag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every Langfuse trace has zero or one `phase:*` tag by reading existing tags, removing stale phase tags, preserving unrelated tags, and applying the current phase.

**Architecture:** Add trace-tag retrieval to the `LangfuseRuntime` boundary, backed by the existing Langfuse client trace API. Keep tag replacement logic as a pure helper in the phase-tracking module, then have the existing serialized `syncActiveTracePhaseTags()` fetch current tags, compute the replacement list, and update the trace. A failed read aborts the write.

**Tech Stack:** TypeScript, Node test runner, `tsx`, Langfuse client API, existing `LangfuseRuntime` test doubles.

## Global Constraints

- Every successful synchronization leaves zero or one `phase:*` tag on the trace.
- All tags unrelated to phase tracking must be preserved.
- Clearing the phase removes all `phase:*` tags while preserving unrelated tags.
- A failed current-tag read must not perform a replacement write.
- Existing per-session serialization, deduplication, cross-session isolation, and observation metadata behavior must remain intact.
- Changes are limited to `packages/langfuse`, its tests, and documentation needed for accuracy.

---

### Task 1: Add and test pure phase-tag replacement logic

**Files:**
- Modify: `packages/langfuse/src/phase.ts`
- Test: `packages/langfuse/test/phase-tracker.test.ts`

**Interfaces:**
- Produces `replacePhaseTags(currentTags: readonly string[], desiredPhaseTags: readonly string[]): string[]`.
- The function removes every tag beginning with `phase:`, preserves all other tags in their existing order, and appends the desired phase tag list (which is zero or one item).

- [ ] **Step 1: Write failing tests for replacement behavior**

Add tests that establish the exact contract:

```ts
test("replaces all existing phase tags while preserving unrelated tags", () => {
  assert.deepEqual(
    replacePhaseTags(
      ["team:alpha", "phase:old", "environment:test", "phase:older"],
      ["phase:development"],
    ),
    ["team:alpha", "environment:test", "phase:development"],
  );
});

test("removes phase tags when the desired phase is cleared", () => {
  assert.deepEqual(
    replacePhaseTags(["phase:old", "owner:pi"], []),
    ["owner:pi"],
  );
});
```

Import `replacePhaseTags` from `../src/phase.js` alongside the existing phase helpers.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd packages/langfuse && node --import tsx --test test/phase-tracker.test.ts`

Expected: FAIL because `replacePhaseTags` is not exported yet.

- [ ] **Step 3: Implement the minimal pure helper**

In `packages/langfuse/src/phase.ts`, filter with `!tag.startsWith("phase:")` and return the preserved tags followed by `desiredPhaseTags`. Do not trim, deduplicate, or otherwise alter unrelated tags; only the phase namespace is special.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `cd packages/langfuse && node --import tsx --test test/phase-tracker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/langfuse/src/phase.ts packages/langfuse/test/phase-tracker.test.ts
git commit -m "test(langfuse): define single phase tag replacement"
```

---

### Task 2: Expose current trace tags through the runtime

**Files:**
- Modify: `packages/langfuse/src/types.ts:79-109`
- Modify: `packages/langfuse/src/langfuse.ts` runtime construction near the existing `updateTraceTags` binding
- Test: `packages/langfuse/test/langfuse.test.ts`
- Test: `packages/langfuse/test/index.test.ts` test runtime fixtures that exercise phase synchronization

**Interfaces:**
- Add `getTraceTags: (traceId: string) => Promise<string[]>` to `LangfuseRuntime`.
- The production implementation calls the configured Langfuse client trace-get API and returns the trace’s `tags` array, or `[]` when the response has no tags.
- A rejected API call remains rejected so the caller can abort the replacement write.

- [ ] **Step 1: Write the failing runtime test**

Extend the existing `getRuntime()`/fetch-based tests in `packages/langfuse/test/langfuse.test.ts` with a trace-get case. Mock the trace API response shape used by the installed `@langfuse/client` version and assert that `runtime.getTraceTags("trace-1")` returns the response tags, including multiple stale phase tags and unrelated tags. Also assert that a failed response rejects.

The test must verify the production runtime delegates to the client’s trace retrieval API rather than reading the local ingestion fallback, because the purpose is to clean up tags already present on the remote trace.

- [ ] **Step 2: Run the focused runtime tests and verify they fail**

Run: `cd packages/langfuse && node --import tsx --test test/langfuse.test.ts`

Expected: FAIL because the runtime interface and production object have no `getTraceTags` method.

- [ ] **Step 3: Add the runtime interface and production binding**

Add the method to `LangfuseRuntime`. In `getRuntime()`, bind `getTraceTags` to the initialized `LangfuseClient` trace API using the SDK’s installed response type/shape. Normalize a missing or non-array `tags` field to `[]`; propagate HTTP/client errors unchanged.

Update every `LangfuseRuntime` object literal in the affected tests with a simple `getTraceTags: async () => []` default or a test-specific implementation so TypeScript fixtures remain valid.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
cd packages/langfuse && node --import tsx --test test/langfuse.test.ts
cd packages/langfuse && npm run typecheck
```

Expected: PASS for runtime tests and typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/langfuse/src/types.ts packages/langfuse/src/langfuse.ts packages/langfuse/test/langfuse.test.ts packages/langfuse/test/index.test.ts
git commit -m "feat(langfuse): retrieve existing trace tags"
```

---

### Task 3: Synchronize phase tags using remote tag state

**Files:**
- Modify: `packages/langfuse/src/handlers/agent.ts:37-65`
- Test: `packages/langfuse/test/index.test.ts`

**Interfaces:**
- Consumes `LangfuseRuntime.getTraceTags(traceId)` from Task 2.
- Consumes `replacePhaseTags(currentTags, desiredPhaseTags)` from Task 1.
- Produces the same `syncActiveTracePhaseTags(): Promise<void>` behavior, now using a complete replacement list.

- [ ] **Step 1: Update phase-sync tests with current-tag fixtures**

In the existing `phase events synchronize tags on the active trace` test, add a `currentTags` array and implement `getTraceTags` to return it. After each successful update, update the fixture’s current tags to the submitted list. Assert these calls:

```ts
getTraceTags("trace-id") -> ["team:alpha", "phase:development", "phase:legacy"]
updateTraceTags("trace-id", ["team:alpha", "phase:brainstorming"])
getTraceTags("trace-id") -> ["team:alpha", "phase:brainstorming"]
updateTraceTags("trace-id", ["team:alpha"])
```

Add a separate test where `getTraceTags` rejects and assert that `updateTraceTags` is never called, while the phase event remains safe to process. Keep the existing rejected-update assertion.

- [ ] **Step 2: Run the focused phase-sync tests and verify the new assertions fail**

Run: `cd packages/langfuse && node --import tsx --test test/index.test.ts`

Expected: FAIL because `syncActiveTracePhaseTags()` currently sends `buildPhaseTags()` directly and does not retrieve current tags.

- [ ] **Step 3: Implement the serialized read–compute–write flow**

Inside the existing queued callback in `syncActiveTracePhaseTags()`:

```ts
const rt = await getRuntime();
const currentTags = await rt.getTraceTags(traceId);
const replacementTags = replacePhaseTags(currentTags, desiredTags);
await rt.updateTraceTags(traceId, replacementTags);
```

Import `replacePhaseTags`. Keep the existing synchronous capture of `traceId` and `desiredTags`, the session queue, the deduplication key, and the warning catch. A retrieval error must reach the existing catch before `updateTraceTags` is invoked.

- [ ] **Step 4: Run phase-sync tests and the full package suite**

Run:

```bash
cd packages/langfuse && node --import tsx --test test/index.test.ts
cd packages/langfuse && npm test
cd packages/langfuse && npm run typecheck
```

Expected: all tests and typecheck pass, including the existing concurrency test. If concurrency fixtures need current-tag responses, return `[]` from each session’s `getTraceTags` and preserve the existing trace/tag assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/langfuse/src/handlers/agent.ts packages/langfuse/test/index.test.ts
git commit -m "fix(langfuse): replace stale phase trace tags"
```

---

### Task 4: Verify documentation and regression coverage

**Files:**
- Review: `packages/langfuse/README.md`
- Review: `docs/superpowers/specs/2026-08-10-langfuse-single-phase-tag-design.md`
- Test: `packages/langfuse/test/phase-tracker.test.ts`
- Test: `packages/langfuse/test/index.test.ts`
- Test: `packages/langfuse/test/langfuse.test.ts`

**Interfaces:**
- Consumes the completed runtime and synchronization behavior from Tasks 1–3.
- Produces a clean package-level verification result and documentation consistent with the implementation.

- [ ] **Step 1: Confirm the README describes the final semantics**

Verify the existing phase-tag documentation explicitly says that a phase transition replaces the previous `phase:*` tag and clearing removes it. If wording does not mention preservation of unrelated tags or cleanup of multiple stale phase tags, update only that paragraph.

- [ ] **Step 2: Run the complete verification commands**

Run:

```bash
cd packages/langfuse && npm test
cd packages/langfuse && npm run typecheck
git diff HEAD~3 --check
```

Expected: all package tests pass, typecheck passes, and Git reports no whitespace errors.

- [ ] **Step 3: Review the final diff against acceptance criteria**

Confirm the final diff demonstrates that successful synchronization produces zero or one `phase:*` tag, unrelated tags survive, failed reads perform no write, and existing concurrency/deduplication behavior is covered by tests.

- [ ] **Step 4: Commit documentation changes if needed**

```bash
git add packages/langfuse/README.md
git commit -m "docs(langfuse): clarify phase tag replacement"
```

If the README already accurately describes the behavior, do not create an empty commit.

---

## Verification

Run from `packages/langfuse`:

```bash
npm test
npm run typecheck
```

The expected result is a passing package test suite and TypeScript typecheck, with no changes outside the Langfuse package and the approved design/plan documentation.
