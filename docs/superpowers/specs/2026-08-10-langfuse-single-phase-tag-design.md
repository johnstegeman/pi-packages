# Langfuse Single Phase Tag Design

## Goal

Ensure that each Langfuse trace has at most one Superpowers phase tag. When a phase is added or changed, all existing tags matching `phase:*` must be removed before the current `phase:<phase>` tag is applied. When the phase is cleared, all `phase:*` tags must be removed. Tags unrelated to phase tracking must remain unchanged.

## Current Context

The Langfuse extension retains the latest Superpowers phase and synchronizes a trace-level tag through `syncActiveTracePhaseTags()` in `packages/langfuse/src/handlers/agent.ts`. The current update submits the desired phase tag array, but Langfuse trace tag updates can preserve previously existing tags. As a result, phase transitions can leave multiple `phase:*` tags on a trace.

The existing implementation also serializes tag synchronization per session and deduplicates identical desired updates. That behavior is needed for concurrent sessions and remains part of this change.

## Architecture and Data Flow

The phase synchronization boundary will own phase-tag cleanup:

1. Determine the active trace and its desired phase tag using the existing state and `buildPhaseTags()` logic.
2. Read the trace's current tags through the Langfuse runtime.
3. Filter out every current tag whose value starts with `phase:`.
4. Preserve every unrelated current tag.
5. Append the desired `phase:<current-phase>` tag when a phase is retained.
6. Submit the complete replacement tag list through `updateTraceTags()`.

When no phase is retained, step 5 is omitted, leaving unrelated tags intact and no phase tags on the trace.

The runtime contract and test double will gain the minimal trace-tag retrieval capability needed for step 2. A focused helper may construct the replacement list so filtering and preservation are independently testable. The existing per-session queue and last-sent deduplication remain unchanged.

## Error Handling

A failure to read current trace tags must not result in a destructive update based on incomplete state. The synchronization operation will log through the existing warning path and leave the trace unchanged.

Failures while submitting the replacement tag list will continue to be caught and logged as they are today. They must not interrupt the agent run or break subsequent event handling.

## Testing

Add focused coverage for:

- Replacing one existing `phase:*` tag with the current phase tag.
- Removing multiple stale `phase:*` tags.
- Preserving unrelated tags during phase replacement.
- Removing all phase tags while preserving unrelated tags when the phase is cleared.
- Leaving the trace unchanged when current-tag retrieval fails.
- Preserving existing per-session serialization and deduplication behavior.
- Preserving cross-session trace and tag isolation.

Existing metadata behavior is unchanged: phase metadata continues to follow the retained phase independently of trace-tag cleanup.

## Scope and Acceptance Criteria

Changes are limited to `packages/langfuse`, its tests, and documentation if needed to keep the package description accurate. No unrelated Langfuse behavior will be refactored.

The implementation is complete when:

- Every successful phase synchronization leaves a trace with zero or one `phase:*` tag.
- A phase transition removes all stale phase tags before applying the new one.
- Clearing the phase removes all phase tags.
- Unrelated trace tags are preserved.
- A failed tag read performs no replacement write.
- Existing concurrency, deduplication, metadata, and error-isolation behavior remains intact.
