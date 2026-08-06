# x-superpowers-phase Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Bifrost provider model request carry an `x-superpowers-phase` header reflecting the latest non-empty phase emitted on the `superpowers:phase` event bus.

**Architecture:** A pure reducer `applyPhaseUpdate(current, incoming)` turns each `superpowers:phase` payload `{ phase }` into the retained phase (non-empty string retained verbatim, `null`/`""`/`undefined` clears). The extension factory keeps an in-memory `superpowersPhase` string, updates it via a `pi.events.on("superpowers:phase")` listener, and the existing `before_provider_headers` hook (already gated to `bifrost`) adds the header when a phase is retained.

**Tech Stack:** TypeScript, pi extension API (`pi.events` EventBus, `before_provider_headers` hook), `node:test` + `node:assert/strict` via `tsx`.

## Global Constraints

- Header name is exactly `x-superpowers-phase`; value is the retained phase string verbatim (untrimmed).
- Header is added **only** to `bifrost` provider model requests (keep the existing `ctx.model?.provider !== "bifrost"` gate first).
- Retained phase lives in memory only — no persistence.
- On `""`/`null`/`undefined` phase events the retained value clears (header stops being sent until a non-empty phase arrives).
- Existing behavior is unchanged: `x-pi-session` headers, provider registration, model discovery all stay as-is.
- Follow repo TDD pattern: pure reducer in `packages/bifrost/index.ts`, `node:test` file in `packages/bifrost/test/`.

---

### Task 1: Pure reducer `applyPhaseUpdate` + unit tests

**Files:**
- Modify: `packages/bifrost/index.ts` — add `applyPhaseUpdate` export in the new "Superpowers phase tracking" section, placed after `fetchModels` and immediately before the `// Extension entry point` section comment (mirrors where `toProviderModel` lives).
- Create: `packages/bifrost/test/phase-tracker.test.ts`

**Interfaces:**
- Consumes: nothing (standalone pure function).
- Produces: `applyPhaseUpdate(current: string | null, incoming: string | null | undefined): string | null` — returns `incoming` as-is when it is a non-empty string, else `null`. `current` is accepted but currently unused (kept in the signature for future non-breaking evolution).

- [ ] **Step 1: Write the failing test**

Create `packages/bifrost/test/phase-tracker.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { applyPhaseUpdate } from "../index.ts";

test("non-empty string is retained", () => {
  assert.equal(applyPhaseUpdate(null, "brainstorming"), "brainstorming");
});

test("empty string clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", ""), null);
});

test("null clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", null), null);
});

test("undefined clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", undefined), null);
});

test("whitespace-only string clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", "  "), null);
});

test("retained value is replaced by a new non-empty phase", () => {
  assert.equal(applyPhaseUpdate("old", "new"), "new");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from the package directory:

```bash
cd packages/bifrost
node --import tsx --test test/phase-tracker.test.ts
```

Expected: FAIL — import error, `Cannot find module` / `does not provide an export named 'applyPhaseUpdate'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/bifrost/index.ts`, after the `fetchModels` function and before the `// Extension entry point` section comment, add:

```ts
// ---------------------------------------------------------------------------
// Superpowers phase tracking
// ---------------------------------------------------------------------------

/**
 * Reduce a `superpowers:phase` event payload into the retained phase value.
 *
 * Returns the incoming value verbatim when it is a non-empty string (trimmed
 * only to test emptiness, so the exact payload value is preserved), and
 * `null` when the incoming value is null/undefined/empty — which clears any
 * previously retained phase.
 */
export function applyPhaseUpdate(
  _current: string | null,
  incoming: string | null | undefined,
): string | null {
  return incoming && incoming.trim() !== "" ? incoming : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/bifrost
node --import tsx --test test/phase-tracker.test.ts
```

Expected: PASS — all 6 tests green.

- [ ] **Step 5: Run the full suite (no regressions)**

```bash
cd packages/bifrost
npm test
```

Expected: PASS — existing `to-provider-model.test.ts` tests still green.

- [ ] **Step 6: Commit**

```bash
git add packages/bifrost/index.ts packages/bifrost/test/phase-tracker.test.ts
git commit -m "feat(bifrost): pure applyPhaseUpdate reducer for x-superpowers-phase tracking"
```

---

### Task 2: In-memory state, event listener, and header injection

**Files:**
- Modify: `packages/bifrost/index.ts` — add `superpowersPhase` state + `pi.events.on("superpowers:phase")` listener in a new section after `register();`, and extend the existing `before_provider_headers` hook (currently around lines 354-367).

**Interfaces:**
- Consumes: `applyPhaseUpdate(current: string | null, incoming: string | null | undefined): string | null` from Task 1.
- Produces: no new exports. Behavior: after the listener fires, subsequent Bifrost model requests carry `headers["x-superpowers-phase"] = <retained phase>` when a non-empty phase is retained.

- [ ] **Step 1: Add state variable and event listener**

In `packages/bifrost/index.ts`, after `register();` and before the `// ---- Per-session cost attribution` section, add a new section:

```ts
  // ---- Superpowers phase header -------------------------------------------
  //
  // The Superpowers skills emit `{ phase }` on the superpowers:phase event
  // bus. Retain the latest non-empty phase in memory and carry it on every
  // Bifrost request as `x-superpowers-phase`, so the gateway can attribute
  // usage to a workflow phase (brainstorming, development, ...).

  let superpowersPhase: string | null = null;

  pi.events.on("superpowers:phase", (data) => {
    superpowersPhase = applyPhaseUpdate(superpowersPhase, data?.phase);
  });
```

- [ ] **Step 2: Extend the existing `before_provider_headers` hook**

In the same file, update the existing hook body to add the phase header after `x-pi-session`:

```ts
  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== "bifrost") return;
    // Use the workspace directory basename (e.g. the worktree name) as a
    // human-readable session identifier for Bifrost cost attribution.
    event.headers["x-pi-session"] = path.basename(ctx.cwd);
    // Tag the request with the current Superpowers workflow phase, when known.
    if (superpowersPhase) {
      event.headers["x-superpowers-phase"] = superpowersPhase;
    }
  });
```

- [ ] **Step 3: Run the full test suite**

```bash
cd packages/bifrost
npm test
```

Expected: PASS — all tests (existing + Task 1's) still green; this task's wiring is not unit-tested, matching the existing untested `x-pi-session` hook pattern.

- [ ] **Step 4: Manual verification (read-only)**

Confirm the wiring compiles cleanly under the package's toolchain — the suite above already type-checks the file via `tsx`. No further action required here beyond noting that end-to-end behavior (listener → header) depends on a live pi session with the `set_phase` emitter extension loaded.

- [ ] **Step 5: Commit**

```bash
git add packages/bifrost/index.ts
git commit -m "feat(bifrost): send x-superpowers-phase header on Bifrost requests"
```

---

## Verification

- `cd packages/bifrost && npm test` passes (all task commits green).
- `packages/bifrost/index.ts` contains: `applyPhaseUpdate` export, a `superpowers:phase` EventBus listener updating an in-memory `superpowersPhase`, and the `x-superpowers-phase` header added inside the bifrost-gated `before_provider_headers` hook.
- Header is absent from non-Bifrost requests (existing `ctx.model?.provider !== "bifrost"` guard early-returns).
- Header is absent after a `""`/`null` phase event (retained value cleared → `if (superpowersPhase)` is false).

## Summary

Two tasks: (1) the pure, unit-tested `applyPhaseUpdate` reducer, and (2) factory wiring — an in-memory phase + `superpowers:phase` listener plus header injection in the existing bifrost-gated headers hook. Both commits leave the suite green and preserve all existing bifrost behavior.
