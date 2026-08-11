# Lifecycle Fix Report: Langfuse phase-tag synchronization

## Changes

- Captured the active `LangfuseRuntime` before phase-tag work enters the per-session promise chain.
- Added a runtime identity/lifecycle guard before reading tags, after reads, and immediately before updates so queued work is skipped after shutdown or runtime replacement.
- Preserved per-session ordering and failure isolation; stale work clears its deduplication marker without emitting a warning.
- Added cancellation checks immediately before retrying a trace-tag read and before applying an update.
- Validated every returned trace tag is a string; malformed arrays now use the stable `LangfuseMalformedTraceError` classification.
- Added a regression proving queued phase-tag work cannot use a replacement runtime, and strengthened malformed-tag coverage for non-string entries.

## Verification

- `cd packages/langfuse && npm test` — 105 passed.
- `cd packages/langfuse && npm run typecheck` — passed.
- `git diff --check` — passed.

The test suite includes its existing expected OTel force-flush warning from the example-host shutdown fixture; it does not fail the suite.
