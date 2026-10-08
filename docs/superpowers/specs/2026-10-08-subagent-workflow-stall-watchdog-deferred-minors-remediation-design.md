# Subagent workflow stall watchdog — deferred minors remediation — Design

- **Date:** 2026-10-08
- **Status:** Approved (brainstorming complete; awaiting `/plan`)
- **Source bead:** `pi-packages-5k3fy` — "Deferred minors from the stall-watchdog branch
  (pi-packages-mol-mr91x)"
- **Workflow molecule:** `pi-packages-mol-vde40`
- **Area:** `packages/pi-subagents` (vendored fork) + `packages/pi-superpowers-plus` SDD scripts
- **Amends:** `docs/superpowers/specs/2026-10-08-subagent-workflow-stall-watchdog-design.md`
  (§1 and §5e wording examples, §3 `WorkflowSpawnRequest` echo)

## Problem

The stall-watchdog feature (`pi-packages-mol-abln`, implement step `pi-packages-mol-mr91x`,
merged as `8a6b5d9`) shipped clean, but its per-task reviews and the whole-branch review parked
38 non-blocking findings, grouped into `pi-packages-5k3fy` so the workspace could be deleted
without losing them. This spec is the triage outcome.

Reconnaissance at HEAD (`8a6b5d9`) re-checked every finding against the code:

- 33 are still true and worth remediating.
- 2 are deliberate behaviours, so the remediation is documentation rather than code (`T2.3`,
  `T3.1`).
- 3 are parked with a recorded ruling (`T7.5`, `T8.3`, `R6`).

## Scope

One branch, one plan. Everything in buckets **A** (behaviour/correctness), **B** (mechanical),
and **C** (tests) below is in scope. Bucket **D** is out of scope, with the ruling recorded here
rather than in a new bead — the same shape the pi-beads deferred-minors pass took
(`pi-packages-3iej.9` → spec → PR #55).

**Non-goals:**

- Any behaviour change outside the enumerated items. No refactor of untouched code.
- Upstream sync of any kind. `packages/pi-subagents` is our copy; the vendored-fork discipline
  holds (a new surgical divergence gets a `LOCAL PATCH` marker **and** a
  `docs/pi-subagents-local-patch.md` entry; purely additive blocks are named in that doc
  instead).
- **`T7.5` — flag-launched (`--subagents-workflow-file`) interrupted detection.** Out of scope
  by design §5d, which targets tool-launched runs: the flag path writes its terminal entry
  itself, so "started but never settled" is not observable there the way it is for a tool run.
- **`T8.3` — "the documented-defaults drift test had no RED evidence".** A process observation
  about how the test was written, not a defect; the assertion is a legitimate guard on the
  documented default and stays as it is.
- **`R6` — the e2e waits a real 4 s window.** Shrinking it to the 1 s the setting allows would
  save ~3 s of suite time but leaves the load-bearing mn4e replay one slow tick away from a
  healthy child looking silent. The controller already ruled it compliant in spirit; it stays.

## Decisions (from brainstorming)

1. **Scope.** Remediate every still-true finding; document the two deliberate ones; park the
   three above.
2. **`R2` — a skip that races the watchdog.** The skip wins. The timed-out branch becomes the
   single place a watchdog-stopped child is shaped, and the intent picks the row, so a child
   that resolved `ok` after the abort can no longer read as a clean `done` with its gate never
   run.
3. **`R3` — the live `wf_` result.** Cap it with the same `truncateWorkflowResult` the persisted
   snapshot uses, so the tool answer is the same before and after a reload.
4. **`T2.2` — a retry that stalls again.** Key the toast set by `index:attempt` rather than
   clearing a key from another module; a new attempt is a new key, hence a new toast.
5. **Timeout wording.** Reuse `formatRunDuration` for both the per-child row and the run-level
   message, and update the design doc's examples to the shipped wording. This is the
   extension's own convention and it also fixes the sub-second `Timed out after 0s`.
6. **`T5.1`.** A non-finite `runStallTimeoutMs` is treated as unset; `0` and negatives keep
   their present meaning (the run-level timer is disabled at `<= 0`).
7. **`T1.4`.** The force-settle warning fires only when a force-settle actually happened.
8. **`R1`.** Keep the second-tick grace; name the coupling to the scan cadence in the comment
   instead of leaving it implied by `window/10`.
9. **`T2.3` (deliberate, documented not changed).** A `"timed-out"` row does not appear under
   the dialog's `"failed"` filter. A timeout is not the failure the user chose: it gets its own
   state and its own filter, and `stats()`/`summarize()` already bucket `state:"error"` as
   failed, so the counts stay right.
10. **`T3.1` (deliberate, documented not changed).** `sanitize()` requires
    `Number.isInteger` for `workflowStallTimeoutSecs`, so a finite `1.5` is dropped. Every other
    numeric field in that function has the same shape; a fractional inactivity window is not a
    thing a user means to set.
11. **`T3.2`.** The settings menu enforces the ceiling through a shared pure validator, and an
    entry it rejects is reported with `ctx.ui.notify(…, "warning")` — deliberately **not**
    `notifyApplied`, which saves the settings snapshot and emits a changed event that an
    unchanged value must not cause.
12. **Delivery.** Approach A: one branch, tasks grouped risk-first (behaviour first, cosmetics
    last), each behaviour change carrying its own test in the same task.

## Design

### 1. Behaviour and correctness (bucket A)

**`R2` — skip races the watchdog (`src/workflow/runtime.ts`, post-settle branches).**
The condition becomes `if (live.timedOut === true)`, with the row chosen by intent inside:

- `intent() === "skip"` → `{ state: "error", skipped: true, error: "Stopped." }`,
  `respond(callId, true, null)`, `recordJournal({ ok: false })`, output tokens counted. This is
  the same call a plain skip makes: the gate did not run, so the script must not receive text
  nothing verified.
- otherwise → the existing `{ timedOut: true, error: stallMessage(…) }` row, unchanged.

This absorbs the non-`ok` skip case into the same branch instead of leaving it to the generic
failure branch, so exactly one skip shape exists. A skipped child is still absent from
`completedByLabel`, so `agent({ resume })` re-runs it.

*Test:* a stub whose `spawnAgent` resolves `{ ok: true, text: "late" }` when `abortAgent` is
called, and whose `abortAgent` calls `control.skip(0)` before returning — that sets the intent
before the settle path observes the result, so the race is deterministic rather than
timing-dependent. Assert one `{ state: "error", skipped: true }` row with no `timedOut`, a
`null` script value, no gate run, and no `completedByLabel` entry.

**`R3` — cap the live `wf_` result (`src/index.ts`, `workflowRunStatusView`).**
The live branch's `result: workflowResultText(task)` becomes
`truncateWorkflowResult(workflowResultText(task))`. The recovered branch already reads the
capped snapshot field, so both answers agree.

*Test:* a settled run whose result exceeds the cap answers identically live and after a
rehydrated `session_start`.

**`T2.2` — a re-stall re-toasts (`src/workflow/task.ts`).**
`notifiedTimedOut` becomes `Set<string>` keyed by `` `${entry.index}:${entry.attempt ?? 0}` ``,
using the `attempt` the row already carries. A retry is a new attempt, hence a new key, hence a
new toast; a re-emitted row for the same attempt still toasts once.

*Test:* a timed-out row at attempt 0 then the same index at attempt 1 returns the label twice;
repeating attempt 1's row returns nothing.

**`T5.1` — non-finite run-level window (`src/workflow/runtime.ts`).**
`Number.isFinite(options.runStallTimeoutMs)` gates the default, so `NaN` (today: fires
immediately) and `±Infinity` (today: never fires) behave as unset. `0` and negatives keep
disabling the run-level timer.

*Test:* `NaN`/`Infinity` behave as the default; `0` still disables.

**`T5.2` — the silence clock starts before the worker exists.**
The `Date.now()` seed moves to immediately after `new Worker(...)`, so the window is measured
from a thread that exists. The two existing re-arms (a child settles with nothing in flight;
every worker message) are unchanged.

*Test:* the first run-level check cannot fire before the worker was constructed.

**`T1.4` — the force-settle warning (`checkStalls`).**
Read `live.forceSettle` once and `continue` when it is `undefined`, before the force-settle
block, so the warning only accompanies a force-settle that happened. Nothing else about the
branch changes: an entry whose call cannot be answered stays marked `timedOut`, exactly as
today.

*Test:* a child marked `timedOut` with no `forceSettle` wired emits no warning.

**`T3.2` — the settings menu enforces the ceiling (`src/settings.ts` + `src/index.ts`).**
`STALL_TIMEOUT_SECS_CEILING` is exported, and a pure
`parseStallTimeoutSecs(value: string): number | undefined` lives beside it, rejecting
non-integers, negatives and anything above the ceiling. The menu's `workflowStallTimeoutSecs`
branch uses it; a rejected entry reports the bound and leaves the setting alone.

*Test:* the validator's boundaries (`0`, `1`, `86_400` accepted; `86_401`, `-1`, `1.5`, `abc`,
`""` rejected), plus a test pinning that `sanitize()` and the validator agree at `86_400` /
`86_401`.

**`T7.2` — persist `totalPausedMs` (`src/workflow/entry.ts` + `src/index.ts`).**
`WorkflowEntryData` gains an optional `totalPausedMs`; `workflowEntryData` writes it when
non-zero; `workflowRunStatusView`'s recovered branch passes it into `elapsedMs`, which already
subtracts it. A snapshot written before the field existed reads as 0 — today's behaviour.

*Test:* a snapshot carrying paused time reports the same elapsed live and recovered; a legacy
snapshot without the field still reports its frozen duration.

### 2. Mechanical (bucket B)

- `src/workflow/runtime.ts`
  - `T1.1`: delete the retry branch's `noteActivity(agentId)`. It is a no-op against an entry
    the settle path already deleted, and it reads as if the retry path were watched; the loop's
    own `lastActivity.set` on the next iteration is what starts the new clock.
  - `T1.2` / `T4.2` / `T5.4`: `stallMessage` and `finishRunStall` render through
    `formatRunDuration` — `Timed out after 10m00s of inactivity.`,
    `Workflow stalled: no progress for 20m00s.`, `340ms` for a sub-second window.
  - `R1`: keep the second-tick grace; the comment states that the grace **is** one scan tick,
    so it tracks `min(30s, max(100ms, window/10))` rather than being an independent bound.
- `src/workflow/worker-source.ts` — `T4.4`: interpolate `${STALL_TIMEOUT_SECS_CEILING}` into
  the worker string in both the comparison and the `[0, …]` error message. The template already
  interpolates for the determinism prelude, so this is the established mechanism and the
  literal stops being a second source of truth.
- `src/workflow/tool-description.ts` — `T4.3`: the inline `opts?: { … }` signature lists
  `stallTimeout`.
- `src/index.ts`
  - `T6.2`: the unknown-`wf_` structured error names the id
    (`No workflow run "wf_…" in this session.`), matching the agent-miss shape; the interrupted
    branch keeps its distinct `error`.
  - `T6.1`: the `agent_id` parameter doc gains the caveat that `wait`/`verbose` apply to agents
    only.
  - `T7.1`: the swallowed `appendEntry` failure logs through the sibling `console.warn`
    pattern.
- Docs
  - `T7.3`: `docs/pi-subagents-local-patch.md` names `appendWorkflowEntry`,
    `rehydrateWorkflowRuns` and `workflowRunStatusView` among the deliberately unmarked
    additive blocks and states the rule they follow.
  - `T4.1`: the stall-watchdog design's §3 gains the line that
    `WorkflowSpawnRequest.stallTimeout` is a self-describing echo the host does not read.
  - `T8.2`: `reference/subagent-workflows.md` stops listing `stallTimeout` as a primitive — it
    is an `agent()` option.
  - `R4`: the same file's paraphrase becomes "degraded for any task that reached neither `done`
    nor `done_with_concerns`" (verified against `wave-parallel.js:217`, which sets `degraded` only
    when the status is neither `done` nor `done_with_concerns`).
- Deliberate rulings — `T2.3` and `T3.1` get a one-line comment at their site (the `"timed-out"`
  derivation in `progress.ts`; the integer check in `sanitize`), so the next reader sees a
  ruling rather than an oversight. Decisions 9 and 10 above are its record.

### 3. Tests (bucket C)

- **new** `test/workflow-host.test.ts` — `T1.3`: `spawnAgent` forwards
  `onToolActivity`/`onTurnEnd`/`onAssistantUsage` into `request.onActivity`; a request without
  it is untouched. No host-level test file exists today.
- `test/workflow-runtime.test.ts` — `T1.5` de-flake: await the abort through a deferred instead
  of the 200×2 ms poll, and widen the window/cadence margins so a loaded box cannot starve the
  second attempt. The assertion still catches the stale verdict, because an unreset `timedOut`
  force-settles on the very next tick regardless of activity. Plus `T5.3` (`worker.terminate`
  asserted on the run-level stall) and `R5` (both watchdogs pinned as *armed*, not only
  cleared), and the §1 tests for `R2`, `T5.1`, `T5.2` and `T1.4`.
- `test/workflow-stall-wiring.test.ts` — `T2.1`: the mocked `runWorkflow` feeds `onProgress` a
  timed-out row and the test asserts the `Workflow child timed out (stalled): …` toast through
  the real extension boot.
- `test/workflow-task.test.ts` — `T2.2`.
- `test/settings.test.ts` — `T3.3` / `T3.4`.
- `test/workflow-tool.test.ts` — `T6.3` (`WorkflowTask[]`), `R3`, `T7.2`, and `T7.4` (the
  id-less entry is skipped; recovered wins over interrupted).
- `test/workflow-claude-code-compat.test.ts` — `T4.5`: trailing newline.
- `packages/pi-superpowers-plus/…/scripts/{wave-parallel,fix-loop}.test.mjs` — `T8.1`: the
  `stallTimeout: 3600` counts stay (they guard call sites the behaviour test cannot enumerate)
  but count over a comment-stripped copy, so a comment can no longer inflate them.

### 4. Disposition of all 38 findings

| Item | Finding (abbreviated) | Disposition |
|---|---|---|
| `T1.1` | retry-branch `noteActivity` redundant | B — delete the call |
| `T1.2` | `"600s"` vs design `"<N>m"` | B — `formatRunDuration`; design doc updated |
| `T1.3` | host `onActivity` forwarding untested | C — new `test/workflow-host.test.ts` |
| `T1.4` | `warnForceSettle` called unconditionally | A — gate on `forceSettle` |
| `T1.5` | retry test timing-sensitive | C — deferred await + wider margins |
| `T2.1` | stall toast line untested | C — wiring test |
| `T2.2` | `notifiedTimedOut` keyed by index, never cleared | A — key by `index:attempt` |
| `T2.3` | `"timed-out"` absent from the dialog's `failed` filter | B — deliberate; documented |
| `T3.1` | `sanitize` requires an integer | B — deliberate; documented |
| `T3.2` | settings menu does not enforce the ceiling | A — shared validator + rejection notice |
| `T3.3` | menu numeric path has no runtime test | C — validator unit test |
| `T3.4` | `86_401` covered, `86_400` not | C — boundary pair |
| `T4.1` | `WorkflowSpawnRequest.stallTimeout` echo exceeds §3 | B — document the echo |
| `T4.2` | sub-second window renders `0s` | B — `formatRunDuration` |
| `T4.3` | inline signature omits `stallTimeout` | B — add it |
| `T4.4` | `86400` literal vs `STALL_TIMEOUT_SECS_CEILING` | B — interpolate the constant |
| `T4.5` | missing trailing newline | C — add it |
| `T5.1` | non-finite `runStallTimeoutMs` unvalidated | A — treat as unset |
| `T5.2` | silence clock starts before the worker exists | A — seed after `new Worker` |
| `T5.3` | AC1 asserts the run resolves, not `terminate` | C — assert `worker.terminate` |
| `T5.4` | message renders `1200s` vs §5e `Xm` | B — `formatRunDuration` |
| `T6.1` | `wait`/`verbose` silently ignored for `wf_` | B — doc caveat |
| `T6.2` | unknown-`wf_` error shape differs from the agent miss | B — name the id |
| `T6.3` | `capturedTasks` typed `any[]` | C — `WorkflowTask[]` |
| `T7.1` | `appendEntry` failure swallowed with no log | B — `console.warn` |
| `T7.2` | recovered elapsed omits `totalPausedMs` | A — persist the field |
| `T7.3` | `LOCAL PATCH` marker convention stale for durability | B — name the helpers in the doc |
| `T7.4` | legacy id-less skip / recovered-wins branches untested | C — both covered |
| `T7.5` | flag-launched interrupted detection | D — out of scope by design §5d |
| `T8.1` | `stallTimeout` count assertions match source text | C — count over comment-stripped source |
| `T8.2` | reference doc lists `stallTimeout` as a primitive | B — reword |
| `T8.3` | documented-defaults drift test had no RED evidence | D — observation; guard stays |
| `R1` | force-settle grace couples to the scan cadence | B — keep; name the coupling |
| `R2` | skip-vs-watchdog race emits a `done` row with no gate | A — skip wins |
| `R3` | live result uncapped vs capped snapshot | A — cap the live path |
| `R4` | reference paraphrase loose about `done_with_concerns` | B — reword to "neither `done` nor `done_with_concerns`" |
| `R5` | timer test pins clearing, not arming | C — pin both |
| `R6` | e2e waits a real 4 s window | D — compliant in spirit; unchanged |

## Verification

- The real gate: `npm test` at the repo root (composes `pi-subagents`' `check` + vitest and
  `pi-superpowers-plus`' `check && test`) under the node 22 pin, using each package's installed
  `biome` — never `npx`.
- Every bucket-A item lands with RED evidence: the test fails before the change. The ones where
  that matters most are `R2`, `R3`, `T2.2`, `T5.1`, `T5.2`, `T1.4`, `T3.2`, `T7.2`.
- `test/e2e/workflow-stall.e2e.test.ts` is untouched and still green (the `R6` ruling), as are
  the tool-surface drift guards and `documented-defaults.test.ts`.
- No new dependencies, so no lockfile moves.

## Acceptance criteria

- Every bucket-A item is fixed with a covering test that fails before the change.
- Every bucket-B item is applied; `T2.3` and `T3.1` are documented (here plus a site comment).
- Every bucket-C item is in place; `T7.5`, `T8.3` and `R6` remain recorded as non-goals with
  their reasons.
- `npm test` at the repo root is green under the node pin; no new dependencies; no lockfile
  change.
- No behaviour change outside the enumerated items; the agent and workflow tool surfaces are
  unchanged (drift guards pass).
- `docs/pi-subagents-local-patch.md` and the in-code markers are current for every divergence
  this pass adds.
- Design and spec committed; implementation handed off via `/plan`.
- `pi-packages-5k3fy` is closed at the end with a close-reason naming the branch, the PR and
  the disposition — as `pi-packages-3iej.9` was.
