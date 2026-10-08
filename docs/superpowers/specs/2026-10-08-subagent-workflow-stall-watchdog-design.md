# Subagent Workflow Stall Watchdog — Design

- **Date:** 2026-10-08
- **Status:** Approved (brainstorming)
- **Bead:** `pi-packages-mol-abln` (molecule root); explore `pi-packages-mol-0w80`
- **Area:** `packages/pi-subagents` (vendored fork) + `packages/pi-superpowers-plus` SDD scripts

## Problem

A `SubagentWorkflow` run can **hang forever with no notification**, wedging the
orchestrator until a human notices.

### The incident (primary evidence)

`pmm-iris-mn4e`, 2026-10-07 (EDT):

| time | event |
|---|---|
| 14:32 | `sdd-final-review` launched (`wf_2223ed5abdbe`, `final-review.js`) |
| 14:44:47 | the last verifier child issues a bash command; no further progress |
| 15:12 | user asks "is it still running?" — the agent cannot tell |
| 15:13:57 | user: **"its been running for 41 minutes i think it died"** |
| 15:14 | agent finds no process, confirms the workflow is dead |
| 16:02:21 | the workflow finally emits its notification: `Stopped`, `killed — 9/49 agents`, **90.3 min** |

The notification arrived only because `session_shutdown` aborted the run. By then
the orchestrator had hand-recovered the verdicts from the children's session
files and finished the branch.

### Root-cause chain

1. **Trigger — a child's bash command never exits.** The stuck verifier ran an
   inline `node --input-type=module -e` harness (esbuild + jsdom,
   `pretendToBeVisual`). It printed its full JSON result and then hung: the node
   process never exited (open handles). Tool-call → tool-result gap: **77.6 min**.
2. **pi's interactive bash tool has no default timeout.** Its schema is
   `timeout: Optional(Number({ description: "Timeout in seconds (optional, no default timeout)" }))`.
   Confirmed live (a `sleep 125` with no `timeout` arg ran to completion). The
   SDK/`beta` bash tool defaults to 120 s (`BASH_DEFAULT_TIMEOUT_MS`), but the
   interactive tool does not.
3. **The workflow runtime has no per-agent timeout, heartbeat, or liveness check.**
   The only timeout in the whole engine is the gate command's
   (`workflow/host.ts`, `DEFAULT_GATE_TIMEOUT_MS`). A child's `agent()` call is
   awaited indefinitely; `parallel()` waits for all; the worker thread stays
   alive, so no `exit`/`error` event fires and `runWorkflow()` never settles.
4. **The parent is structurally blind.** `get_subagent_result("wf_…")` returns
   `Agent not found` — workflow ids live in a separate in-memory `workflowTasks`
   map that no tool exposes, and workflow-child agents are excluded
   (`isTopLevelAgent`). There is no list/status tool; the dispatch text says
   "do NOT poll"; and a tool-launched run persists no terminal entry.

### Same class, other instances

- `pmm-iris-gv0l`, 2026-10-01: `sdd-final-review` killed at **107.6 min**; a
  verifier stuck **74.2 min** in a `bun -e` script that opened a Neo4j driver,
  printed its result, and never exited.
- 2026-09-17: `sdd-final-review` killed at 13.4 min.

Intermittent because it only bites when a child runs a command that leaves its
process alive.

## Goals / non-goals

**Goals**

- A hung child must not wedge the workflow. Detect it (inactivity-based), abort
  the child, and let the run finish **degraded** rather than hang.
- A degraded finish must be **legible** — the orchestrator and user can tell a
  partial review from a clean one, and can query a running workflow.
- Fix lives entirely in our vendored `pi-subagents` (no upstream pi change).

**Non-goals**

- Changing pi's bash tool or adding a default bash timeout (upstream, and it
  would affect every command including legitimate long builds).
- Retrying a stalled child automatically (degrade instead; a retry is a possible
  future addition).
- A run-level wall-clock cap (a 49-child review legitimately takes a while).

## Success criteria

Replaying the mn4e scenario: the stuck verifier is aborted after ~10 min of
silence; `final-review.js` completes with `degraded` set, writes its findings
file, and notifies **Done** — instead of sitting wedged and notifying **Stopped**
90 min later at shutdown.

## Design

### 1. Watchdog semantics & contract

- **Unit of protection:** each in-flight `agent()` call (one child), not the run.
- **Activity signal:** the child's **tool start/end** events, forwarded from the
  host, plus **turn end** and **assistant usage** (cheap, same plumbing). Not
  token/stream deltas — a wedged provider can still dribble keepalives, and a
  hung bash is exactly "tool started, never ended". Both failure shapes read as
  silence.
- **Threshold:** an **inactivity** window, default **600 s**, configurable, and
  overridable per call.
- **On timeout — the contract:**
  - abort the child via `host.abortAgent(id)`, let `spawnAndWait` resolve;
  - return **`null`** to the script (same shape as `settleSkipped`,
    `runtime.ts:951`), **not** a fatal error. `null` is what `final-review.js`
    already degrades on (`dimStatus.ok=false` → `degraded`;
    `verdictShape → "unverified (refuter skipped)"`);
  - emit a terminal progress row `{ state: "error", timedOut: true, error: "Timed out after 10m00s of inactivity." }` (`200ms` for a sub-second window);
  - do **not** register the child in `completedByLabel` (so `agent({ resume })`
    cannot continue it — consistent with existing failure semantics);
  - do **not** run the child's `gate`.
- **Interaction with existing mechanics:** `skip`/`retry` unchanged and take
  precedence over a timeout when they race; a timeout is distinct from a user
  skip; the watchdog is cleared on settle and never fires after a run abort;
  aborting goes through the normal child abort, so worktree cleanup still runs.

### 2. Heartbeat + timer plumbing

Everything is in one thread (the runtime owns the run and calls the host).

- **Host → runtime heartbeat (`host.ts`):** add `onActivity?: () => void` to
  `WorkflowSpawnRequest` (`runtime.ts:52`). In `spawnAgent`, forward it into the
  existing `spawnAndWait` options as
  `onToolActivity`/`onTurnEnd`/`onAssistantUsage` callbacks — `SpawnOptions`
  already exposes all three (`agent-manager.ts:282/315`), no new manager API.
- **Runtime timer (`runtime.ts` `handleAgent`):** a `Map<agentId, { index, lastActivity }>`
  beside `inflight`. **Arm only after** `semaphore.acquire()` and
  `inflight.add(agentId)`, so time parked behind the concurrency limit is never
  counted. Reset `lastActivity` on every heartbeat.
- A **single `setInterval`** (tick ~30 s for the default window, `unref()`'d)
  scans the map; for any
  entry past its window it sets `live.timedOut`, records the reason, and calls
  `host.abortAgent(agentId)`. Cleared when the map empties, on `finish()`, and
  each entry deleted in the existing per-agent `finally`.
- **Timeout branch:** after `await host.spawnAgent(...)`, if `live.timedOut`,
  take a branch mirroring `settleSkipped` — emit the row, journal
  `{ ok: false }`, `respond(callId, true, null)`, skip `completedByLabel` and the
  gate.
- **Abort races:** the existing `if (aborted || settled)` / `if (settled) return`
  guards win; a timeout only converts a still-pending child into `null`.
- **Verified:** aborting reaches the hung command.
  `createLocalShellOperations.exec` spawns the shell `detached: true` and on the
  abort signal calls `killProcessTree(child.pid)`, then throws `"Command aborted"`.
  So `host.abortAgent` frees the child and the semaphore permit normally.
- **Defensive last resort:** if a child has not settled a bounded grace after its
  abort (a child ignoring abort), the runtime logs a warning and force-completes
  that call as `null`, so the run can never wedge. Force-completion may leak the
  child/worktree — hence warning + last resort only.

### 3. Per-call `stallTimeout` option

- **Name/unit:** `agent({ stallTimeout })` — **seconds**, an *inactivity* window.
  Not `timeout`, which reads as a total-duration cap. `undefined` → settings
  default; `0` → disabled for this call; positive number → that window.
- **Worker (`worker-source.ts`):** add `"stallTimeout"` to `AGENT_OPTIONS`; validate
  as a non-negative finite number with an upper bound (≤ 86400 s) in the same
  thrown-`Error` style as `effort`/`isolation`; add it to the
  `callHost("agent", { … })` payload.
- **Runtime:** add `stallTimeout?: number` (seconds) to `AgentCallPayload`
  (`runtime.ts:458`); resolve
  `stallMs = payload.stallTimeout === undefined ? options.stallTimeoutMs : payload.stallTimeout * 1000`.
  Per-call, so different children can have different patience. The resolved
  window is also carried on `WorkflowSpawnRequest.stallTimeout` as a
  self-describing echo — the host does not read it; the runtime owns the
  decision (it is the only place that can see the per-call override).
- **No `resume` exclusion:** this is about liveness, not spawn config, so it
  applies to a resumed child too (unlike `effort`/`isolation`/`schema`/`gate`).
- **Docs:** `workflow/tool-description.ts`, `docs/workflows.md`, and the SDD
  reference docs that enumerate `agent()` options.

### 4. Configuration & defaults

- **New setting:** `workflowStallTimeoutSecs?: number` on `SubagentsSettings`
  (seconds; `0` disables globally; unset → built-in default).
  - add to `SettingsAppliers` (`setWorkflowStallTimeout`), `applySettings`
    (`settings.ts:513`), `sanitize()`;
  - wire in the `applyAndEmitLoaded({ … })` block (`index.ts:1411`); hold in a
    module-level variable.
- **Precedence:** `agent({ stallTimeout })` → `workflowStallTimeoutSecs` →
  `DEFAULT_STALL_TIMEOUT_MS = 600_000` (exported from `runtime.ts` for tests).
- **Call site:** `runWorkflowTask` passes `stallTimeoutMs` into `runWorkflow`
  (`index.ts:2360`), read **per run** (unlike `workflowsEnabled`, which is frozen
  at init because the tool spec is fixed).
- **Default = 10 min:** review children finish in ~1–3 min; the longest
  legitimate *silent* stretch is one long reasoning call (a couple of minutes);
  the stuck children sat 74–78 min. 10 min is ~5× headroom.
- **UI parity:** one numeric entry in `/agents → Settings` beside
  `graceTurns`/`defaultMaxTurns` (`index.ts:3551,3585`), labelled
  "Workflow stall timeout (seconds, 0 = off)".

### 5. Visibility

**5a — a distinct "timed out" row.** Add `timedOut?: boolean` to
`WorkflowAgentEntry` (`progress.ts:52`) and `"timed-out"` to
`WorkflowDisplayState` (`progress.ts:24`); derive it in `displayState()`
(`progress.ts:176`). TS's exhaustive switches flag every renderer
(`ui/workflow-card.ts`, `ui/workflow-menu.ts`, dialog). `stats()`/`summarize()`
already bucket `state:"error"` as failed, so counts stay right.

**5b — make the finish legible.** `formatWorkflowNotification` (`task.ts:288`)
summary gains a timed-out count when > 0, e.g.
`… completed — 12/14 agents, 1 timed out (stalled)`. The `<result>` already
carries `degraded` via `workflowResultText`. The watchdog also raises a one-off
`ctx.ui.notify(…, "warning")` toast (not a turn-triggering `sendMessage` — the
run completes moments later).

**5c — `get_subagent_result` resolves `wf_` ids.** Extend the resolution path
(`index.ts:2796`): if the id is a known workflow, return a status payload
(`status`, `result` or "still running", elapsed, and a compact progress summary
including timed-out labels) instead of `Agent not found`. Update the tool
description + `promptSnippet`. This is a **LOCAL PATCH** — record it in
`docs/pi-subagents-local-patch.md`. Status-only; no `wait: true` for workflows.

**5d — durability.** On settle, append the same `WORKFLOW_ENTRY_TYPE` snapshot
the CLI-flag path already writes (`index.ts:2751`) for tool-launched runs, and
rebuild a minimal status map in `session_start`. Without this, 5c only answers
for the current process lifetime.

**5e — run-level liveness.** The per-agent watchdog only fires if a *child* goes
quiet. Reuse the same interval: if the runtime hears no
`progress`/`call`/response from the worker for a run-level window (default ~2×
the stall window), `finish({ status: "failed", error: "Workflow stalled: no progress for 20m00s." })`,
terminating the worker and notifying. This closes the "worker itself wedged"
gap. **Suspend this check while the run is `paused`** (a paused run makes no
progress by design).

## Interaction summary

| Feature | Behavior |
|---|---|
| `skip` / `retry` | unchanged; user intent wins a race with the watchdog |
| `resume` | a timed-out child journals `ok:false`; resume re-runs it live |
| `gate` | never runs for a timed-out child |
| pause | per-agent check unaffected; run-level check suspended |
| worktree isolation | abort goes through normal cleanup; only the R2 fallback may leak |
| nested `workflow()` | covered (same `handleAgent`); progress feeds run-level liveness |

## Risks & edge cases

- **R1 — False positives on a legitimately long single tool call (the real one).**
  A hung bash and a legitimately long bash are indistinguishable. **Decision:**
  `final-review.js` keeps the watchdog (default 10 min); `wave-parallel.js` and
  `fix-loop.js` set an explicit **high** window (3600 s) on their implementer
  calls, so a truly hung implementer is still caught eventually. Per-call
  override + settings remain as escape hatches, and the option doc names the
  ambiguity.
- **R2 — Abort reaches the hung command** (verified). The defensive last resort
  (Section 2) covers a child that ignores abort.
- **R3 — Paused runs** must not be failed by run-level liveness (suspended).
- **R4 — Long single-turn LLM reasoning** mitigated by the heartbeat signals and
  the window; configurable.
- **R5 — Resume** re-runs a timed-out child live; the prefix ends there.
- **R6/R7 — Retry/skip races:** `live.intent` is checked before converting to
  timed-out; never double-abort.
- **R8 — Gate:** skipped for a timed-out child (unchanged logic).
- **R9 — Worktree cleanup:** normal path; R2 fallback warns.
- **R10 — Nested workflows:** covered.
- **R11 — Rehydration:** a run that was *running* at process death has no
  terminal entry → report `unknown/interrupted`, never a stale `running`.
- **R12 — `get_subagent_result` shape:** the agent path is unchanged; unknown
  `wf_` id still errors clearly.
- **R13 — Timer hygiene:** one `unref()`'d interval per active run, cleared on
  settle.
- **R14 — Validation bounds:** `stallTimeout` non-negative finite number, ≤ 24 h.
- **R15 — Docs/defaults pinned:** README:441 and `documented-defaults.test.ts`
  must document and pin the new default.
- **R16 — Behavior change:** workflows that set nothing now get the watchdog on.
  Documented; SDD scripts choose explicit values.

## Testing

**Unit (`packages/pi-subagents`, vitest — the existing `stubHost` in
`test/workflow-runtime.test.ts` is the harness):**

- watchdog fires: a never-resolving `spawnAgent` → `abortAgent` called, `agent()`
  resolves `null`, run completes;
- heartbeat resets the window; per-call override; `0` disables;
- a timed-out child inside `parallel()` folds to `null`, siblings still return;
- excluded from `completedByLabel`; gate never runs;
- progress row shape (`state:"error"`, `timedOut:true`);
- run-level liveness: a wedged worker (`while(true){}`) → run `failed`, worker
  terminated;
- timer hygiene (no leaked interval);
- option validation (`stallTimeout` accept / reject / `0`), payload round-trip;
- `displayState()` → `"timed-out"`; `stats()` counts it; notification includes
  the count;
- settings default pinned; `sanitize()` round-trips; `0` disables;
- tool description lists `stallTimeout`; `get_subagent_result` resolves a `wf_`
  id, errors on unknown, agent path unchanged;
- durability: terminal entry appended on settle; `session_start` rehydrates.

**Integration (`test/e2e/`, `test/helpers/faux-model-backend.ts`):**

- **The mn4e replay:** a final-review-shaped workflow where one verifier never
  returns → finishes `degraded` naming that dimension, findings file written.
- Regression: `workflow-gate-worktree`, `workflow-journal`, dialog skip/retry,
  `workflow-examples` still pass.

**Determinism:** inject the window and tick via `RunWorkflowOptions` test knobs
(alongside `stallTimeoutMs`); fall back to `vi.useFakeTimers()`. No test sleeps
more than a few hundred ms.

## Affected files

- `packages/pi-subagents/src/workflow/{runtime,host,worker-source,progress,task,tool-description}.ts`
- `packages/pi-subagents/src/{settings,index}.ts`
- `packages/pi-subagents/{README.md,docs/workflows.md}`
- `docs/pi-subagents-local-patch.md` (5c)
- `packages/pi-superpowers-plus/skills/subagent-driven-development/scripts/{final-review,wave-parallel,fix-loop}.js`
- `packages/pi-superpowers-plus/skills/subagent-driven-development/reference/*.md`
- tests under `packages/pi-subagents/test/`

## Open questions / future work

- Auto-retry a stalled child once before degrading (deferred).
- A `wait: true` mode for workflow status in `get_subagent_result` (deferred).
- Upstreaming the per-agent watchdog to `tintinweb/pi-subagents` (this fork owns
  the change; a future sync could carry it).
