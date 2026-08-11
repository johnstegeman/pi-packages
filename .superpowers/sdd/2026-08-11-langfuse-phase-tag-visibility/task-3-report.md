# Task 3 Report: Isolate phase-sync failures and emit compact diagnostics

## Changes

- Added a phase-tag-only error formatter that prioritizes structured 404 status, truncates the first line of generic `Error` messages to 240 characters, and falls back to a stable unknown-error message.
- Changed phase-tag sync warnings to pass exactly one human-readable string to `console.warn`, explicitly stating that tracing continues.
- Added an integration regression using the existing phase event registration and fake runtime seams. It verifies permanent 404 failures do not reject the handler, do not leak SDK response/stack content, and allow a second synchronization attempt.

## Verification

- `cd packages/langfuse && node --import tsx --test test/index.test.ts` — 10 passed.
- `cd packages/langfuse && npm run typecheck` — passed.
- `git diff --check` — passed.

## Commit

Commit: `6d96a6e4ed6966a4884ca69679d41b75ee48b7d5`.


## Fix round (review findings)

- Replaced generic `Error.message` extraction with a stable, safe classification so arbitrary credentials, request headers, serialized response bodies, and stack content cannot reach the phase-sync warning. The structured 404 diagnostic and tracing-continues wording remain unchanged.
- Added a regression covering a long multiline generic error containing Authorization, credential-like, and response-body content. It verifies a single bounded warning string with no sensitive markers or newline/stack content.

### Verification

- `cd packages/langfuse && node --import tsx --test test/index.test.ts` — 11 passed.
- `cd packages/langfuse && npm run typecheck` — passed.
- `git diff --check` — passed.