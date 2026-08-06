# x-superpowers-phase Header — Design

**Date:** 2026-08-06
**Status:** Approved (brainstorming)

## Goal

Extend the `pi-bifrost` extension so that every Bifrost provider model request
carries an `x-superpowers-phase` header reflecting the current Superpowers
workflow phase.

## Background / Context

- The Superpowers skill bundle ships a `set_phase` tool that emits events on
  the shared extension event bus channel `superpowers:phase`, with payload
  `{ phase: <string> }`. No timestamp, session id, or other fields.
- `pi-bifrost` already subscribes to pi's `before_provider_headers` hook to
  add an `x-pi-session` header for Bifrost model requests, gated by
  `ctx.model?.provider !== "bifrost"`.
- This feature reuses that same hook and gating so the new header is added
  **only to Bifrost provider model requests**.

## Requirements

1. **Listen** on the `superpowers:phase` event (`pi.events.on`), reading the
   `phase` string off the event payload.
2. **Retain** the phase value in memory.
3. **Emit header:** when the retained value is a non-empty string, add a header
   to each Bifrost model request:
   - name: `x-superpowers-phase`
   - value: the retained phase string (verbatim)
4. **Clear:** when a `superpowers:phase` event fires with an empty string
   (`""`) or `null`, clear the retained value so subsequent Bifrost requests
   stop carrying the header, until a new non-empty phase arrives.
5. The header must be added **only to Bifrost** provider requests (the
   existing `before_provider_headers` gating already enforces this).
6. Phase tracking logic is factored into a **pure, testable utility**.

## Design

### 1. Pure reducer (`applyPhaseUpdate`)

Exported from `packages/bifrost/index.ts`:

```ts
export function applyPhaseUpdate(
  _current: string | null,
  incoming: string | null | undefined,
): string | null {
  return incoming && incoming.trim() !== "" ? incoming : null;
}
```

Semantics:

- Non-empty incoming string → retained (`incoming` returned as-is, untrimmed;
  `.trim()` is used only for the emptiness check, so the exact payload value is
  preserved).
- `null` / `undefined` / `""` / whitespace-only → `null` (clear).
- `_current` is accepted but intentionally unused today; keeping it in the
  signature lets future semantics (e.g. merge/append/change-history) evolve
  without a breaking change to the caller shape.

### 2. In-memory state + event listener

In the extension factory:

```ts
let superpowersPhase: string | null = null;

pi.events.on("superpowers:phase", (data) => {
  superpowersPhase = applyPhaseUpdate(superpowersPhase, data?.phase);
});
```

- Value lives in memory only; **no persistence**.
- `data?.phase` guards against an event with no/empty payload.

### 3. Hook wiring (existing `before_provider_headers`)

Extend the existing hook, keeping the bifrost gate first:

```ts
pi.on("before_provider_headers", (event, ctx) => {
  if (ctx.model?.provider !== "bifrost") return;
  event.headers["x-pi-session"] = path.basename(ctx.cwd);
  if (superpowersPhase) {
    event.headers["x-superpowers-phase"] = superpowersPhase;
  }
});
```

- Header added only when a phase is currently retained; otherwise the header
  is simply absent (no stale empty value sent).

### Data flow

```
set_phase tool (other extension)
  └─ pi.events.emit("superpowers:phase", { phase })
       └─ bifrost listener ──applyPhaseUpdate──▶ in-memory `superpowersPhase`
                                                  │
before_provider_headers (bifrost request) ◀───────┘
  └─ headers["x-superpowers-phase"] = phase (when retained)
```

### Error handling

- Missing/empty event payload → `data?.phase` is `undefined` → reducer clears.
- No explicit error paths: the listener and reducer are synchronous and
  exception-free.

### Testing

New `packages/bifrost/test/phase-tracker.test.ts` (repo's existing
`node:test` + `node:assert/strict` pattern). Because `applyPhaseUpdate` is
pure and deterministic, the unit tests fully characterize retain/clear:

- non-empty string retained: `applyPhaseUpdate(null, "brainstorming")` → `"brainstorming"`
- empty string clears: `applyPhaseUpdate("brainstorming", "")` → `null`
- `null` clears: `applyPhaseUpdate("brainstorming", null)` → `null`
- `undefined` clears: `applyPhaseUpdate("brainstorming", undefined)` → `null`
- whitespace-only clears: `applyPhaseUpdate("brainstorming", "  ")` → `null`
- semantics preserved: `applyPhaseUpdate("old", "new")` → `"new"`

The wiring (event listener + header injection) stays inline in the factory,
mirroring the repo's existing, untested `x-pi-session` hook pattern.

## Files Changed

- `packages/bifrost/index.ts` — add `applyPhaseUpdate`; add event listener and
  extend `before_provider_headers`.
- `packages/bifrost/test/phase-tracker.test.ts` — new unit tests.

## Out of Scope

- Persistence of the retained phase (memory only, per requirement).
- Adding the header to non-Bifrost providers.
- Any changes to the `set_phase` emitter extension or other packages.
