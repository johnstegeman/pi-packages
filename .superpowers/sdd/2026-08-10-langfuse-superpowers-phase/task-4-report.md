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