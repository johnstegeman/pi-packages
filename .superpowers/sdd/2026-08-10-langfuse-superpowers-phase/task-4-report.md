# Task 4 Report: Wire phase events and observation metadata

## Status

**Complete.** Task 4 is implemented and committed. Package/root documentation was not modified.

## Changes

- Extended the local `@earendil-works/pi-coding-agent` shim with `EventBus.emit`, `EventBus.on`, and `ExtensionAPI.events`.
- Registered the `superpowers:phase` listener in `packages/langfuse/index.ts`.
- Validated event payloads and clear retained phase state for malformed/non-string payloads.
- Attached `buildPhaseMetadata()` to root agent start metadata, root agent finish metadata, and generation-start metadata.
- Did not add phase metadata to tool/turn observations or generation response-time updates.
- Used optional chaining on `pi.events` to preserve compatibility with existing legacy test fixtures that omit the event bus; real event buses register the listener normally.

## Commits

- `a22a3337280ba855e3a5bc94afbcc3a0ed104836` — `feat: add superpowers phase to langfuse observations`

## Tests and results

Commands run from `packages/langfuse`:

1. `npm test` (baseline before implementation)
   - **Passed:** 80
   - **Failed:** 0

2. `npm run typecheck` (after implementation)
   - **Passed:** TypeScript compilation with `tsc --noEmit`

3. `npm test` (after initial implementation, before compatibility guard)
   - **Passed:** 78
   - **Failed:** 2
   - Both failures were existing `index.test.ts` fixtures that did not provide `pi.events`, causing the newly registered listener to access `undefined`.

4. `npm run typecheck` (final)
   - **Passed:** TypeScript compilation with `tsc --noEmit`

5. `npm test` (final)
   - **Passed:** 80
   - **Failed:** 0
   - **Cancelled:** 0
   - **Skipped:** 0

The final suite includes all upstream tests and phase-tracker tests; focused phase tests confirm clearing the phase yields `{}`.

## Concerns

- The local test fixtures do not yet model the upstream event bus, so listener registration is guarded with `pi.events?.on(...)`. The shim still declares `events` as required, matching the requested API contract.
- The repository contains an unrelated pre-existing untracked `.pi/` directory; it was not included in the commit.


## Review Fix Report

**Status:** Fixed the Task 4 review findings.

**Changes:**

- Changed `pi.events?.on(...)` to required `pi.events.on(...)` in `packages/langfuse/index.ts`.
- Added focused `index.test.ts` coverage that supplies a fake `events.on`, asserts registration on `superpowers:phase`, invokes the captured handler with `{ phase: "development" }`, verifies `superpowers_phase`, and clears retained phase state in `finally`.
- Updated existing index-test fixtures to provide lightweight event-bus stubs required by the non-optional API.

**Exact verification commands and results (from `packages/langfuse`):**

1. `node --import tsx --test test/index.test.ts`
   - **Passed:** 4; **Failed:** 0; **Cancelled:** 0; **Skipped:** 0.
2. `node --import tsx --test test/phase-tracker.test.ts`
   - **Passed:** 9; **Failed:** 0; **Cancelled:** 0; **Skipped:** 0.
3. `npm run typecheck`
   - **Passed:** TypeScript compilation with `tsc --noEmit`.
4. `npm test`
   - **Passed:** 81; **Failed:** 0; **Cancelled:** 0; **Skipped:** 0.

**Commit:** `fix: require superpowers phase event bus` (final commit includes this report update).


## Final review fix report: handler metadata coverage

**Status:** Completed and committed focused tests for the final Important review gap. No production behavior or package scope was changed.

**Changes:**
- Added root handler coverage proving retained `superpowers_phase` reaches the root start observation metadata and root finish update metadata using a fake Langfuse runtime/observation.
- Added generation-start coverage proving retained phase metadata is attached and cleared phase metadata omits `superpowers_phase`.
- Extended the existing listener fixture to verify malformed (`null`) and non-string (`{ phase: 42 }`) payloads clear retained state.
- Every test isolates module-global phase state with `setPhase(null)` in `finally` blocks.
- Clarification: upstream tests were not left unchanged; `test/index.test.ts` already contained prior Task 4 listener coverage and this fix adds further focused assertions there, alongside new generation-handler tests.

**Commits:**
- `0bc5ef754310579bade7d4a83088ed7377c1dc59` — `test: cover phase metadata in langfuse handlers`
- This report update follows the test commit.

**Exact verification results:**
1. `cd packages/langfuse && node --import tsx --test test/index.test.ts test/generation.test.ts` — passed: 9 tests, 9 passed, 0 failed, 0 cancelled, 0 skipped.
2. `cd packages/langfuse && npm run typecheck` — passed: TypeScript compilation with `tsc --noEmit`.
3. `cd packages/langfuse && npm test` — passed: 84 tests, 84 passed, 0 failed, 0 cancelled, 0 skipped.
4. `cd packages/bifrost && npm test` — passed: 12 tests, 12 passed, 0 failed, 0 cancelled, 0 skipped.
5. `cd packages/hashline-edit && npm test` — passed: 87 tests, 87 passed, 0 failed, 0 cancelled, 0 skipped.
6. `cd packages/statusline && npm test` — passed: 31 tests, 31 passed, 0 failed, 0 cancelled, 0 skipped.
7. `git diff --check` — passed.

**Concerns:**
- The existing bifrost, hashline-edit, and statusline test runs emitted Node `module.register()` deprecation warnings; they did not affect results.
- The pre-existing untracked `.pi/` directory remains intentionally unstaged.