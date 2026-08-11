# Langfuse Phase-Tag Visibility Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent transient Langfuse 404 responses caused by OpenTelemetry trace-ingestion latency from losing phase-tag updates or producing misleading warnings during Pi execution.

**Architecture:** Keep phase-event handling in `packages/langfuse/src/handlers/agent.ts` unchanged at the call-site level, but make the runtime's `getTraceTags()` operation tolerate Langfuse's eventual consistency. When the authenticated trace lookup returns a 404, retry with bounded exponential backoff; once the trace is visible, the existing read/replace/upsert flow preserves unrelated tags. Non-404 failures remain errors, and a permanently missing trace still fails harmlessly through the existing phase-sync warning path.

**Tech Stack:** TypeScript, Langfuse client v5.x, Node `node:test` via `tsx`, OpenTelemetry runtime, existing `LangfuseRuntime` test seams.

## Global Constraints

- Modify only the `pi-langfuse-plus` extension under `packages/langfuse/` plus its implementation plan documentation.
- Preserve the existing phase-tag contract: tags are namespaced as `phase:<phase>`, only one phase tag is retained, and clearing the phase removes all `phase:*` tags.
- Preserve unrelated Langfuse trace tags through the existing `getTraceTags()` and `replacePhaseTags()` flow.
- Retry only trace-visibility 404s; do not retry authentication failures, other HTTP errors, malformed responses, or programming errors.
- Phase-tag synchronization failures must not disable tracing or interrupt Pi event handling.
- Use a bounded retry window so a permanently missing or cross-project trace cannot keep the process alive indefinitely.
- Never pass a raw Langfuse/SDK error object to `console.warn`, `console.error`, or Pi UI notification APIs from the phase-tag path; format a compact, human-readable message without a stack trace.
- Run package-scoped commands from `packages/langfuse`: `npm test` and `npm run typecheck`.
- Do not change Langfuse credentials, host configuration, Pi core, Superpowers, or Langfuse server behavior.

---

### Task 1: Add failing tests for transient trace visibility

**Files:**
- Modify: `packages/langfuse/test/langfuse.test.ts`
- Test helpers: use the existing `state`, `__setRuntimeForTest`, `getRuntime`, `forceShutdownRuntime`, and `globalThis.fetch` seams already present in this file.

**Interfaces:**
- Consumes the existing runtime method `getTraceTags(traceId: string): Promise<string[]>`.
- Produces executable expectations for retry timing, retry classification, and final failure behavior.
- Does not change production interfaces.

- [ ] **Step 1: Add a test for a 404 followed by a visible trace**

Add a focused test around the real runtime's `getTraceTags()` implementation. Mock the trace GET request so the first two calls return an authorized-project-style 404 response and the third returns a successful trace payload:

```ts
test("retries trace tag reads while an OTel trace is not yet visible", async () => {
  const previousConfig = state.config;
  const originalFetch = globalThis.fetch;
  let traceReads = 0;

  try {
    state.config = {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    };
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/api/public/traces/trace-1")) {
        traceReads += 1;
        if (traceReads < 3) {
          return new Response(
            JSON.stringify({
              message: "Trace trace-1 not found within authorized project",
              error: "LangfuseNotFoundError",
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ tags: ["team:alpha"] }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const runtime = await getRuntime();
    assert.deepEqual(await runtime.getTraceTags("trace-1"), ["team:alpha"]);
    assert.equal(traceReads, 3);
  } finally {
    await forceShutdownRuntime();
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
  }
});
```

Use the implementation's actual retry delays; the assertion must not depend on wall-clock duration.

- [ ] **Step 2: Add a test proving non-404 errors are not retried**

Mock the same trace endpoint to return a 401 or 500 response. Assert that `runtime.getTraceTags("trace-1")` rejects and that the endpoint was requested exactly once. This prevents the eventual-consistency handling from masking bad credentials or server failures.

```ts
test("does not retry non-404 trace lookup failures", async () => {
  const previousConfig = state.config;
  const originalFetch = globalThis.fetch;
  let traceReads = 0;
  try {
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.com" };
    globalThis.fetch = (async (input) => {
      traceReads += 1;
      assert.ok(String(input).endsWith("/api/public/traces/trace-1"));
      return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    }) as typeof fetch;
    const runtime = await getRuntime();
    await assert.rejects(() => runtime.getTraceTags("trace-1"));
    assert.equal(traceReads, 1);
  } finally {
    await forceShutdownRuntime();
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
  }
});
```

The test must use a concrete status and expected rejection rather than a vague “handles errors” assertion.

- [ ] **Step 3: Add a test for an exhausted 404 retry window**

Return the authorized-project-style 404 for every request. Assert that `getTraceTags()` rejects after the configured maximum number of attempts, and assert that the request count equals the documented attempt count. This verifies the retry is bounded.

```ts
test("stops retrying when a trace never becomes visible", async () => {
  const previousConfig = state.config;
  const originalFetch = globalThis.fetch;
  let traceReads = 0;
  try {
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.com" };
    globalThis.fetch = (async (input) => {
      traceReads += 1;
      assert.ok(String(input).endsWith("/api/public/traces/trace-1"));
      return new Response(JSON.stringify({ message: "not found within authorized project" }), { status: 404 });
    }) as typeof fetch;
    const runtime = await getRuntime();
    await assert.rejects(() => runtime.getTraceTags("trace-1"));
    assert.equal(traceReads, 5);
  } finally {
    await forceShutdownRuntime();
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
  }
});
```

If the retry-attempt constant is intentionally not exported, assert against the expected numeric count in the test and keep the constant private to `src/langfuse.ts`.

- [ ] **Step 4: Run the focused tests and verify they fail**

Run:

```bash
cd packages/langfuse
node --import tsx --test test/langfuse.test.ts
```

Expected: the new transient-404 test fails because the current `client.api.trace.get(traceId)` call performs only one request, while the non-404 and exhaustion tests should establish the intended contract.

- [ ] **Step 5: Commit the failing tests**

```bash
git add packages/langfuse/test/langfuse.test.ts
git commit -m "test(langfuse): define trace visibility retry behavior"
```

---

### Task 2: Implement bounded retry for trace-tag reads

**Files:**
- Modify: `packages/langfuse/src/langfuse.ts:509-568, 712-803`
- Modify: `packages/langfuse/test/langfuse.test.ts` only if test cleanup or request mocks need the implementation's final shape.

**Interfaces:**
- Consumes `LangfuseClient.api.trace.get(traceId)` and its thrown HTTP error/status information.
- Produces the existing runtime method `getTraceTags(traceId: string): Promise<string[]>`; no caller changes are required.
- Preserves the existing `updateTraceTags()` ingestion path and `syncActiveTracePhaseTags()` behavior.

- [ ] **Step 1: Add private retry constants and error classification**

Near the existing Langfuse timeout constants, define a bounded schedule, for example:

```ts
const TRACE_TAG_READ_DELAYS_MS = [100, 250, 500, 1_000] as const;

function isTraceNotVisibleError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}
```

If the installed SDK exposes `status` rather than `statusCode` on its error type, support the actual SDK property used by the package and retain a test for the SDK-shaped error. Do not classify every error whose message contains “not found” as retryable; the status must indicate HTTP 404.

- [ ] **Step 2: Implement one bounded retrying trace-tag reader**

Define a structural client type rather than adding a static dependency import for the dynamically loaded SDK:

```ts
type TraceTagClient = {
  api: {
    trace: {
      get(traceId: string): Promise<{ tags?: unknown }>;
    };
  };
};
```

Then add a private helper that accepts that client and trace ID, performs the first GET immediately, and retries only after a classified 404:

```ts
async function readTraceTagsWithRetry(
  client: TraceTagClient,
  traceId: string,
): Promise<string[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await client.api.trace.get(traceId);
      return Array.isArray(response?.tags) ? response.tags : [];
    } catch (error) {
      const delayMs = TRACE_TAG_READ_DELAYS_MS[attempt];
      if (!isTraceNotVisibleError(error) || delayMs === undefined) {
        throw error;
      }
      await delay(delayMs);
    }
  }
}
```

Call the existing `delay(ms: number, signal?: AbortSignal)` helper directly. The helper must not retry after the final delay and must not swallow the final 404.

- [ ] **Step 3: Route the runtime method through the helper**

In the runtime object created by `getRuntime()`, replace the direct call:

```ts
getTraceTags: async (traceId: string) => {
  const response = await client.api.trace.get(traceId);
  return Array.isArray(response?.tags) ? response.tags : [];
},
```

with:

```ts
getTraceTags: (traceId: string) => readTraceTagsWithRetry(client, traceId),
```

Do not alter the `updateTraceTags()` request body, the complete known-trace field preservation, runtime error tracking, or shutdown behavior.

- [ ] **Step 4: Run the focused tests and type check**

Run:

```bash
cd packages/langfuse
node --import tsx --test test/langfuse.test.ts
npm run typecheck
```

Expected: all focused tests pass, including transient 404 recovery, non-404 single-attempt failure, bounded exhaustion, and existing trace-tag/update tests; type checking passes.

- [ ] **Step 5: Commit the implementation**

```bash
git add packages/langfuse/src/langfuse.ts packages/langfuse/test/langfuse.test.ts
git commit -m "fix(langfuse): retry transient trace visibility failures"
```

---

### Task 3: Isolate phase-sync failures and emit compact diagnostics

**Files:**
- Modify: `packages/langfuse/src/handlers/agent.ts`
- Modify: `packages/langfuse/test/index.test.ts`

**Interfaces:**
- Consumes the existing `syncActiveTracePhaseTags(): Promise<void>` behavior and the runtime `getTraceTags()` retry implementation from Task 2.
- Produces compact diagnostic formatting for expected and unexpected phase-tag failures, with no raw SDK error object passed to the console.
- Produces regression coverage proving a permanent phase-tag failure does not reject the phase handler or print a raw SDK stack trace.

- [ ] **Step 1: Add an integration regression test for permanent phase-sync failure**

Extend the existing phase-event synchronization fixtures in `test/index.test.ts`. Configure the fake runtime's `getTraceTags()` to reject with a 404-shaped error, emit one phase event, await the handler's returned promise or existing microtask boundary, and assert that the phase handler does not reject. This test targets the handler's isolation and output behavior; the real-runtime retry is covered by `test/langfuse.test.ts` in Task 1.

```ts
test("phase tag sync isolates a permanently missing trace", async () => {
  const previousConfig = state.config;
  const observation = { traceId: "trace-id", setTraceIO() {}, update() {}, end() {} };
  const runtime: LangfuseRuntime = {
    startObservation: () => observation,
    propagateAttributes: (_attributes, fn) => fn(),
    scoreClient: {},
    getTraceTags: async () => {
      throw Object.assign(new Error("Trace trace-id not found within authorized project"), { statusCode: 404 });
    },
    updateTraceTags: async () => {
      throw new Error("update must not run after a failed tag read");
    },
  };
  // Register the extension with the existing fixture, start the agent, replace console.warn with a collector, emit one phase event, and await the handler's promise.
  // Assert the handler resolves and the collector contains one compact string mentioning that tracing continues.
  state.config = previousConfig;
});
```

Adapt the fixture to the existing registration seams rather than introducing a second event emitter or a new production hook. The test should prove recovery from the actual warning scenario, not merely test the pure tag replacement helper.

- [ ] **Step 2: Add compact formatting for phase-tag failures**

In `packages/langfuse/src/handlers/agent.ts`, add a private formatter used only by the phase-tag synchronization catch block. It must inspect structured status information before generic error text:

```ts
function formatPhaseTagSyncError(error: unknown): string {
  if (typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode?: unknown }).statusCode === 404) {
    return "trace is not visible yet or is outside the configured Langfuse project";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.split("\\n", 1)[0].slice(0, 240);
  }
  return "unknown Langfuse error";
}
```

Change the catch block so it logs one string and never passes `error` as a second console argument:

```ts
console.warn(`📊 Langfuse: Phase tag sync unavailable (${formatPhaseTagSyncError(e)}); tracing continues.`);
```

Do not call `console.trace`, print `error.stack`, or show the full Langfuse response body. The message must explain that tracing continues and must not include credentials or request headers.

- [ ] **Step 3: Test failure isolation and clean output**

Complete the test from Step 1 by temporarily replacing `console.warn` with a collector. Assert that the phase handler resolves, the warning is a single string containing `Phase tag sync unavailable` and `tracing continues`, and the warning contains neither `LangfuseNotFoundError` response JSON nor a multiline stack trace. Invoke the phase handler a second time after the first failure and assert it remains usable, proving the failed deduplication state does not permanently disable later synchronization.

Use the existing registration and fake-runtime fixtures; do not introduce a new production event or test-only retry hook.

- [ ] **Step 4: Run the focused integration tests and type check**

Run:

```bash
cd packages/langfuse
node --import tsx --test test/index.test.ts
npm run typecheck
```

Expected: delayed visibility recovery, permanent-failure isolation, compact diagnostic assertions, and all existing phase/session tests pass; type checking passes.

- [ ] **Step 5: Commit the phase-sync hardening**

```bash
git add packages/langfuse/src/handlers/agent.ts packages/langfuse/test/index.test.ts
git commit -m "fix(langfuse): keep phase sync errors out of Pi output"
```

---

### Task 4: Document behavior and run the complete verification suite

**Files:**
- Modify: `packages/langfuse/README.md`
- Test: `packages/langfuse/test/phase-tracker.test.ts`, `packages/langfuse/test/index.test.ts`, and the full package test suite

- [ ] **Step 1: Document eventual consistency and user-facing diagnostics**

In the Superpowers phase section of `packages/langfuse/README.md`, add a short paragraph stating:

- phase-tag synchronization reads the existing trace tags before replacing `phase:*` tags;
- a newly created OpenTelemetry trace may briefly return 404 before Langfuse makes it queryable;
- the extension retries that transient visibility response for a bounded period;
- persistent 404s remain isolated from Pi execution and produce a compact warning rather than a raw SDK stack trace;
- a persistent authorized-project 404 may indicate stale credentials, a wrong host/project, or a trace that was never ingested.

Do not document environment-variable precedence changes or imply that retries repair project configuration.

- [ ] **Step 2: Run the full package test suite**

Run:

```bash
cd packages/langfuse
npm test
```

Expected: every test file passes.

- [ ] **Step 3: Run type checking and inspect the final diff**

Run:

```bash
cd packages/langfuse
npm run typecheck
git diff --check HEAD~3
git diff -- packages/langfuse/src/langfuse.ts packages/langfuse/src/handlers/agent.ts packages/langfuse/test/langfuse.test.ts packages/langfuse/test/index.test.ts packages/langfuse/README.md
```

Expected: no type errors or whitespace errors. Confirm that the final diff preserves existing metadata/tag behavior and never logs raw SDK errors from phase synchronization.

- [ ] **Step 4: Commit documentation and final verification changes**

```bash
git add packages/langfuse/README.md packages/langfuse/test
 git commit -m "docs(langfuse): describe safe phase tag diagnostics"
```


## Verification

After all tasks, run:

```bash
cd packages/langfuse
npm test
npm run typecheck
```

Confirm the following acceptance criteria:

- A phase event that arrives before Langfuse exposes the OTel trace eventually updates the trace tags without requiring another phase event.
- A trace GET returning 404 is retried only for the bounded visibility window.
- A non-404 failure is not retried and is still isolated by the existing phase-sync catch block.
- An exhausted 404 does not reject the Pi phase event or disable tracing.
- An exhausted 404 produces one compact warning string and does not dump the Langfuse response body or stack trace into the Pi window.
- Unexpected non-404 failures remain isolated and are reported as a compact first-line message without raw error objects.
- Existing unrelated tags survive the phase replacement.
- Existing phase metadata, initial phase tags, session serialization, and update ingestion behavior remain unchanged.
- Project/credential mismatch remains diagnosable rather than being silently treated as successful synchronization.

---
