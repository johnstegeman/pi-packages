# Cost tracking on task beads via subagents lifecycle events

Molecule: `pi-packages-mol-v81b` · Task: `pi-packages-l8x9.2` (epic `pi-packages-l8x9`)

Date: 2026-09-10 · Status: approved design (`review.verdict=done` on `pi-packages-mol-r9rw`)

## Problem

Answer "how much did this feature cost, and how much did each step cost" at the
task-bead level. pi-subagents ≥0.19 emits `subagents:completed` / `subagents:failed`
on the shared `pi.events` bus; both payloads carry the run's spend as a pi
`Usage` (`usage.cost.total` in USD, token components including `cacheRead`) plus
the spawn-time `description`. Today nothing writes that spend onto the bead that
the run was for, so "what did step X cost" is unrecoverable after the session.

Constraints that shape everything below (from the epic's plan-approval gate
`pi-packages-l8x9.1`):

1. Per-task cost attribution REQUIRES per-task implementation to stay on
   Agent-tool spawns: SubagentWorkflow children emit no lifecycle events, hence
   no per-child `usage.cost.total`. Workflows are for aggregate phases only.
2. Degrade gracefully: hosts on pi-subagents <0.19 / pi <0.84 keep the existing
   behavior unchanged (superpowers-plus peerDependencies are `*`).
3. Beads/ledger state stays controller-owned; the extension is a designated
   **metadata-only** writer and never touches status/parent/description.
4. The SDD ledger remains the record of truth; workflow results are not
   persisted cross-session.

## Design decisions (resolved in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Correlation key | `bead:<id>` token in the agent's `description`, parsed from the completion event payload | `completed`/`failed` payloads carry the spawn-time `description`, so correlation needs **zero in-memory state** and survives compaction/session resume; the token is unambiguous; the description is human-visible in `/agents`. Rejected: scraping the `Agent` tool-call `prompt` via a `tool_call` hook (long free text, false-positive risk, must track ids across spawn/resume); an explicit attach tool (extra tool + controller round-trip). |
| Hosting | `packages/pi-beads` (new `src/cost-tracking.ts`) | pi-beads already owns `bd()`, `dirForPrefix()` id→repo routing, `afterWrite()` + `beads:changed` emission, and the merge-semantics `--set-metadata` path. |
| Metadata shape | Per-agent lines + rollup totals | Per-agent provenance (role/status breakdown, failed-run costs) plus derived rollups; last-write-wins per agent id keeps resume rounds correct. |
| Epic/session rollup | None (v1) | Session totals are pi's `SessionStats`/`Usage`/`reportUsage` concern; epic totals are a read-side sum of children (`cost.total`), which the widget or a `beads_show` enhancement can do later. No write contention on shared epics during wave-parallel work. |
| Main-loop (controller) work | Out of scope — follow-on | Controller turns never emit `subagents:*` events. Follow-on design: `beads_cost_focus <beadId>` + `message_end` accumulation of `event.message.usage.cost.total` into `cost.main.*`. Feasibility verified: pi exposes per-assistant-message usage (`message_end`). |

## Design

### 1. Extension (`packages/pi-beads/src/cost-tracking.ts`)

A new pi extension factory, exported alongside `src/index.ts` (registered in the
package's `pi.extensions` and the root manifest). It shares the `pi` instance
and reuses pi-beads' in-module helpers: `bd()`, `dirForPrefix()`, `afterWrite()`.
No new tools are registered — the extension is purely event-driven.

### 2. Correlation (spawn-time convention)

SDD dispatch marks the `Agent` call's `description` with the task bead id —
`"Implement task bead pi-packages-l8x9.2"` → `bead:pi-packages-l8x9.2`. The
convention applies to every dispatch aimed at a tracked task bead (implementer,
task-reviewer, re-reviewer, resumed rounds). Skill docs + the implementer/
task-reviewer prompt templates in `packages/pi-superpowers-plus` are updated to
carry the token; agents not aimed at a bead simply omit it.

### 3. Data flow (stateless)

1. Controller spawns an agent whose `description` contains `bead:<task-id>`.
2. pi-subagents emits `subagents:completed` (or `:failed`) with the spawn-time
   `description` in the payload (`buildEventData` carries `record.description`).
3. `pi.events.on("subagents:completed" | "subagents:failed")` handler:
   - Extract `bead:([A-Za-z0-9.\-]+)` from `event.description`; no match → ignore.
   - `event.usage?.cost?.total` absent → record nothing ("spent nothing" stays
     distinguishable, mirroring pi-subagents'.
   - `dirForPrefix(beadId)` → `bd update <beadId> --set-metadata …`
     (read current metadata → update per-agent line + rollups → merge-write),
     then `afterWrite(repoDir)` so the molecule widget refreshes via
     `beads:changed` (already emitted there).
4. Nothing is cached: the id travels in the event payload, so extension
   compaction or a resumed session loses no correlation state.

Top-level agents only: nested subagents and SubagentWorkflow children emit no
events and never reach the handler — satisfying constraint 1 by construction.

### 4. Metadata schema

Flat dotted keys (`bd` stores them flat — verified empirically); `--set-metadata`
merges additively (verified empirically).

Per completion, one **per-agent line** under `cost.agents.<agentId>`:

| key | value |
|---|---|
| `cost.agents.<id>.total` | USD, `usage.cost.total` |
| `cost.agents.<id>.tokens.input` / `.output` | `usage.input` / `usage.output` |
| `cost.agents.<id>.tokens.cacheRead` | `usage.cacheRead` (billed number) |
| `cost.agents.<id>.role` | `event.type` (implementer, task-reviewer, …) |
| `cost.agents.<id>.status` | `event.status`, default `"completed"` (failed runs carry `error` \| `stopped` \| `aborted`) |

`<agentId>` is pid-style (`auth-audit-2`) — alphanumeric + dash, a valid bare key.

**Rollups** — recomputed every write from the full current set of `cost.agents.*`
lines (no incremental counters to drift):

- `cost.total` (USD)
- `cost.tokens.input` / `cost.tokens.output` / `cost.tokens.cacheRead`
- `cost.agents.count`

**Accumulation rules:**

- Merge semantics: rest-of-metadata (`review.verdict`, labels history) is never clobbered.
- **Last-write-wins per agent id**: a resumed agent (fix-loop rounds share one
  id) completes again with lifetime-accumulated usage → its line is overwritten,
  not summed; totals stay correct.
- Rollups always derived from the full current line set.

### 5. Error handling

- Any `bd` failure (lock, unknown bead, repo missing) → `try/catch` +
  single `console.error` (pi-beads' existing style). Never throw into the event
  bus; never block the agent's own completion flow.
- No match / no `usage` / unknown `dirForPrefix` → silent skip.
- No retries: cost writes are best-effort bookkeeping; bead *state* remains the
  ledger's job, spend is not retried.

### 6. Interaction with `showCost` / `reportUsage`

The extension records **regardless** of `showCost` — that setting governs what a
human is shown, not what events carry (pi-subagents' `usage` is ungated by it).
Per-session totals from `reportUsage`/`SessionStats` remain separate and are not
written to beads.

## Testing

`packages/pi-beads/test/pi-beads.test.mjs` (existing node:test file):

- **Unit**: `bead:` regex extraction (match, no-match, multiple); read-modify-write
  metadata diff construction; rollup recomputation (two agents; resume same-id
  overwrite; failed agent included; absent-usage skipped).
- **Fake-event harness**: feed synthetic `subagents:completed|failed` payloads to
  the handler with `bd()` stubbed to a temp repo (same temp-dir isolation pattern
  statusline uses), assert `cost.*` metadata lands and merges without clobbering
  pre-existing keys.
- **No E2E**: real-agent cost assertions need a live pi + paid model; the manual
  QA step records one real completion.

## Out of scope

- **Main-loop (controller) cost attribution** — the follow-on: `beads_cost_focus
  <beadId>` tool + `message_end` handler accumulating `event.message.usage.cost.total`
  into `cost.main.*` on the focused bead. Tracked as a separate bead; this design
  covers subagent-event attribution only.
- Epic/molecule-level rollups (read-side feature on top of children's `cost.total`).
- Workflow-based attribution (children emit no usage-bearing events — constraining).
- Filtering or UI rendering of cost in the beads widget (later, read-side).
