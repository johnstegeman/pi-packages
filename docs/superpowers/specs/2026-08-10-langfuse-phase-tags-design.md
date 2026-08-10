# Langfuse Phase Tags Design

## Goal

Keep the existing `superpowers_phase` metadata while also adding a trace-level Langfuse tag derived from the current Superpowers phase. This enables Langfuse dashboard widgets to segregate traces by phase.

## Requirements

- Namespace every phase tag as `phase:<phase>`.
- Emit no phase tag when the phase is blank, whitespace-only, `null`, or `undefined`.
- A trace may start without a phase and receive its first tag later.
- When the phase changes, retain only the latest phase tag; do not accumulate historical phase tags.
- Preserve all existing `superpowers_phase` metadata behavior.
- A tag-update failure must not disrupt Pi event handling, tracing, or the agent run.

## Architecture and data flow

The existing phase tracker remains the source of truth for the latest phase, and `buildPhaseMetadata()` continues to supply `superpowers_phase` metadata to observations.

Add an explicit trace-tag update operation to the Langfuse runtime abstraction:

1. When a root trace is created, derive its initial tag from the retained phase.
   - A phase is present: send `tags: ["phase:<phase>"]`.
   - No phase is present: omit tags or use the SDK/API equivalent of no tags.
2. When `superpowers:phase` fires, update the retained phase as today and notify the active trace of the desired tag set.
3. Replace the complete phase-tag set on every update:
   - `development` → `["phase:development"]`
   - `brainstorming` → `["phase:brainstorming"]`
   - phase cleared → `[]` or the API's equivalent for clearing tags.
4. Continue attaching `superpowers_phase` metadata to observations exactly as before. Observations created before a phase transition may retain their original metadata, while the trace-level tag reflects the latest phase.

The trace-tag operation is isolated behind the runtime interface. Phase tracking and handlers do not depend on Langfuse SDK implementation details.

## Components

### Phase tracker

Add a namespaced tag builder alongside `buildPhaseMetadata()`. The metadata and tag representations share the same retained phase and clearing semantics. Existing whitespace behavior is preserved: non-empty phase values remain verbatim for metadata, and the corresponding tag is derived consistently from that retained value.

`setPhase()` remains synchronous and safe for the event listener. Tag synchronization is separate and must not block Pi's phase event handling.

### Runtime and run state

Extend the runtime contract with an explicit trace-tag update method. Use the active root trace ID already associated with the agent run. The operation:

1. Requires an active trace.
2. Builds either the one latest phase tag or an empty tag list.
3. Sends a trace update through the supported Langfuse client/API path.
4. Catches and logs failures without disabling tracing or affecting the agent run.

If a phase event occurs before the root trace exists, retain the phase and apply its tag when the root trace starts. If a tag update fails, later phase events retry the latest desired tag; metadata capture remains independent.

### SDK/API compatibility

Use the installed Langfuse client's supported trace-update mechanism first. If the client abstraction does not expose trace updates directly, extend the existing ingestion/fallback layer with a trace-update request rather than introducing a second unrelated HTTP client path.

## Testing and acceptance criteria

Add tests while preserving all existing metadata assertions:

- Formatting produces `["phase:development"]` for `development`.
- Blank, whitespace-only, `null`, and `undefined` produce no tag.
- A phase change replaces the old tag rather than accumulating tags.
- A run that starts after a phase is set passes the namespaced tag at trace creation.
- A run that starts without a phase omits tags.
- A phase event after root creation invokes the explicit trace-tag update.
- Clearing a phase sends an empty tag set or equivalent clear operation.
- Existing root, generation, and finish metadata behavior remains unchanged.
- A rejected tag update is logged but does not throw into the phase event handler or disable tracing.
- A phase set before trace creation is applied when the trace starts.

The feature is accepted when Langfuse dashboard filters can use `phase:<latest-phase>` to segregate traces, while `superpowers_phase` remains available as observation metadata.
