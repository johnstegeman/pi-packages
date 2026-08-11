# Final Fix Report: Langfuse phase-tag visibility

## Fixes

- Captured each generated runtime instance in its `updateTraceTags` closure, so delayed phase-tag work cannot resolve the mutable global runtime after shutdown or reconfiguration.
- Added per-runtime lifecycle cancellation for trace-visibility retry delays; shutdown and test/runtime replacement abort pending waits before releasing the old runtime.
- Kept 404 classification based on the installed SDK's `statusCode` shape and strengthened the phase-sync regression to assert the 404 diagnostic produced from a direct SDK-shaped error.
- Strengthened non-404 and exhausted-404 rejection assertions to verify the SDK error `statusCode` (401, 500, and 404 respectively).
- Changed successful trace reads with non-array `tags` to fail with a stable `LangfuseMalformedTraceError`, preventing unsafe replacement with an empty tag list. Valid arrays remain unchanged.

## Verification

- `cd packages/langfuse && npm test` — 104 passed.
- `cd packages/langfuse && npm run typecheck` — passed.
- `git diff --check` — passed.

The full test run contains the existing expected OTel force-flush warning from the example-host shutdown fixture; it does not fail the suite.
