# Gated fix loop: covering tests as a hard gate

Molecule: `pi-packages-mol-cimu` · Task: `pi-packages-l8x9.5` (epic `pi-packages-l8x9`)

Date: 2026-09-10 · Status: approved design (`review.verdict=done` on `pi-packages-mol-k199`)

## Problem

SDD's fix loop (§4 of `subagent-driven-development/SKILL.md`) verifies fixes with
**prose evidence**: the implementer writes "covering tests, command, output" into its
report file, the controller manually confirms the three are present, and reviewers
never re-run tests. An LLM is the judge of whether a fix works — weaker than running
the suite. pi-subagents ≥0.19's workflow `gate` option (a shell command that must
pass after an agent finishes) replaces that prose trust with a hard command gate,
but only inside `SubagentWorkflow` scripts (the plain `Agent` tool has no `gate`).

Where a task has a covering-test command, the fix loop should verify by **running**
it: `agent(prompt, { gate: '<covering tests>', resume: 'fix' })` retry loop (pattern:
pi-subagents `docs/workflows.md` / `examples/workflows/gated-fix.js`). A non-zero exit
fails the agent and its output becomes the error; a gate-rejected child stays
resumable for the next retry. When a fix loop runs inside a workflow, re-review
becomes the next pipeline stage.

## Constraints (from plan-approval gate `pi-packages-l8x9.1`)

1. Per-task cost attribution REQUIRES per-task implementation on Agent-tool spawns:
   SubagentWorkflow children emit no lifecycle events, hence no per-child
   `usage.cost.total`. Keep the initial implementation (and the whole no-command
   path) on plain `Agent` dispatch.
2. Degrade gracefully: hosts on pi-subagents <0.19 / pi <0.84 keep the existing
   Agent-dispatch loop unchanged (superpowers-plus peerDependencies are `*`).
3. Beads/ledger state stays controller-owned; workflow scripts and their children
   are read-only on beads.
4. The SDD ledger stays the record of truth — workflow results are not persisted
   cross-session.
5. Never parallel-implement on a shared branch without a file-conflict gate.
6. Workflows add ~5k tokens of system-prompt context; spend deliberately.

## Resolved decisions (brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Where the gate command comes from | **Implementer-named**: the initial implementer records a re-runnable covering-test command in its report; fallback to the task package's `npm test` (`cd packages/<name> && npm test`) when the report omits it | The implementer alone knows what covers its code; the existing report contract already asks for "the covering tests you ran, the command, the output" — this promotes that line from prose to gate input. No command anywhere → plain path |
| Gated-loop retry budget | **One gate, one resume, one verify per round**, then `{ passed: false }` → controller adjudicates (breaker rules unchanged) | Cap-syncs the workflow to today's round discipline; no raw retry-until-green spiral; continuing after a failed gate would burn guaranteed-failing rounds |
| Two dispatch paths | **Split on command existence**: covering-test command present → gated workflow path (fix-loop.js); absent → existing plain-`Agent` path verbatim (rounds 1–3 resume `<agent_id>`, 4–5 fresh) | Keeps per-agent cost events on the plain path (constraint 1) and preserves today's behavior exactly where no gate applies |
| Where the code lives | **Skill-local `scripts/fix-loop.js` + structural test `fix-loop.test.mjs`** (mirrors the final-review.js precedent from l8x9.4) | Matches repo precedent; testable; re-review-as-pipeline-stage falls out naturally; no coupling to a sibling package's examples dir |
| Re-review as pipeline stage | Stage 2 of the same pipeline: one item = one fix round, stages = [gated fix, scoped re-review]; a failed stage 1 drops the item so re-review never runs on an unproven fix | "Fix round = fix dispatch + scoped re-review" maps 1:1 onto `pipeline`; gate failure skips re-review for free |

## Design

### 1. Path selection (controller, before the loop starts)

When a review reports findings eligible for the fix loop (spec ❌, Critical or
Important finding, or ⚠️ confirmed as a real gap), the controller resolves the
covering-test command:

1. Implementer's report names a re-runnable command
   (`cd packages/<name> && <cmd>`) → **gated path**.
2. Report omits it but the task's package has a test script → fallback
   `cd packages/<name> && npm test` → **gated path**.
3. No command exists (doc-only task, no package test script) → **plain path** —
   existing §4 loop verbatim.

### 2. Components

| File | Change |
|---|---|
| `packages/pi-superpowers-plus/skills/subagent-driven-development/scripts/fix-loop.js` | **NEW** deterministic SubagentWorkflow script (modeled on gated-fix.js + final-review.js) |
| `.../scripts/fix-loop.test.mjs` | **NEW** structural regression test, mirroring final-review.test.mjs (the script cannot run outside a live pi session) |
| `.../implementer-prompt.md` | Report contract gains one required line: `Covering-test command (re-runnable from the repo root or with explicit cd): <command>` — or `none` |
| `.../SKILL.md` §4 | New "Gated path" sub-block with invocation snippet + cap-sync rules; existing prose path stays verbatim with a lead-in naming it the no-command path |
| `CHANGELOG.md` (pi-superpowers-plus) | Entry for the gated fix loop |

### 3. Script contract: `fix-loop.js`

- **Args in:** `{ taskBeadId, reportFilePath, findings, gate, fixBase, head, gateBeadId, packagePath }`
- **Envelope out:** `{ passed: boolean, gateOutput?: string, agentSummary?: string, reReview?: verdicts, reason?: string }`
  — `passed: false` means the controller adjudicates (breaker rules, unchanged); `reason`
  distinguishes `'bad-args'` (fall back to plain path) from gate/test failure (adjudicate).
- **Shape:** `meta = { name: 'sdd-fix-loop', phases: [{ title: 'Fix' }, { title: 'Re-review' }] }`.
  One pipeline item (= one fix round) through two stages; a `null`/throw in stage 1
  drops the item, so re-review never runs on an unproven fix.
- **Stage 1 — gated fix:**
  1. `agent(fixPrompt, { label: 'fix', gate: <covering-test cmd> })` — gate runs
     after the agent finishes; non-zero exit fails the agent, folding the command
     output into its error. The call returns `null` exactly when the suite did not
     pass — no model judges prose evidence.
  2. On `null`: `agent("<cmd> is still failing. Read the failure above, fix the
     cause, and stop.", { label: 'fix', resume: 'fix' })` — resume the same child
     (context intact), ungated because `gate` + `resume` cannot combine. This is the
     entire retry budget; no further retries inside the script.
  3. Re-verify with a fresh gated call: `agent("Run <cmd> and report the result.
     Change nothing.", { label: 'verify', gate: <cmd>, effort: 'low' })`.
     `null` here (or at step 1) → round failed → `{ passed: false, gateOutput, ... }`
     → controller adjudicates.
  4. Agent type: `implementer` (matches today's fix dispatches).
- **Stage 2 — scoped re-review** (only when stage 1 passed): the re-reviewer stage
  receives `findings`, `fixBase..head`, `taskBeadId`, `reportFilePath`, and
  `gateBeadId`. It runs `review-package <id> FIX_BASE HEAD` itself via bash (a shell
  script, not a bead mutation — permitted by the adoption contract), then verdicts
  each finding ADDRESSED / NOT ADDRESSED and flags new breakage in the fix diff only
  — the existing `re-review-prompt.md` rules, embedded as the stage prompt.
  `reReview` (verdicts) rides out in the envelope.
- **Defensive guards (port final-review.js lessons):** JSON-string `args`
  normalization; malformed args → empty object, never a fatal throw; no
  sandbox-forbidden globals (`Date.now`, `Math.random`, `Function`, `eval`).

### 4. Controller-side integration (SKILL.md §4)

- Insert a "Gated path" sub-block after the "two routes leave immediately"
  paragraph, before the existing rounds text. The existing rounds 1–3 / 4–5 prose
  becomes the no-command path (with a lead-in sentence), otherwise untouched.
- **Gated round cycle** — the controller drives rounds; one round = one
  `fix-loop.js` invocation. `fixBase` for round R+1 = round R's `head`; open
  findings (including new Critical/Important breakage flagged by the re-review)
  are passed forward.
- `envelope.passed == false` → adjudicate immediately per breaker rules
  (park / defer / BLOCKED). Gate failure after one resume is a cap-quality signal;
  continuing would burn guaranteed-failing rounds.
- `passed == true` but open findings remain → next round. Five rounds max per task;
  breaker text at the cap applies unchanged.
- Round cap stays 5 on both paths; a gated round that ends `passed: false` is
  adjudicated without waiting for the cap.
- **Behavioral consequences (named):** within-round resume (`label: 'fix'` +
  `resume: 'fix'`) replaces the plain path's rounds 1–3 controller resume; across
  rounds, workflow children are fresh — rounds ≥2 use the existing "a prior
  implementer attempted this task [N] times; you own it now" framing, with the
  report file (shared tree) as the continuity mechanism.

### 5. Ledger lines

Gated rounds annotate the existing format:

```
Task <N>: fix round <R>/5 gated: <cmd> passed — <X> addressed, <Y> open; commits <base>..<head>
Task <N>: fix round <R>/5 GATE FAILED (<cmd>) — <output tail>; <ruling>
```

The "After each round" line keeps its `<X> addressed, <Y> open — commits <a7>..<b7>`
spine. `passed: false` rulings use the existing breaker entries
(parked / deferred / `Task <N>: BLOCKED — <reason>`).

### 6. Error handling & graceful degradation

| Failure | Handling |
|---|---|
| No covering-test command | Plain path (unchanged) |
| `SubagentWorkflow` unavailable (pi <0.84, disabled, or user skips) | Fall back to plain path for that task — prose evidence as today; never fake a gate |
| `args` JSON string / malformed | Normalize / degrade to empty object, never a fatal throw; envelope `{ passed: false, reason: 'bad-args' }` → controller falls back to plain path |
| Gate command broken (exit 127 / "command not found" in `gateOutput`) | Controller distinguishes broken-command → repair or drop the gate → plain path; genuine test-failure → adjudicate |
| Stage-1 agent dies | Envelope `passed: false` → controller adjudicates or falls back from `gateOutput`; loop must not silently end |
| Workflow skipped by the user / tool returns null | Same as unavailable → fall back to plain path for that task; no half-applied round |
| Re-review stage returns null | Controller re-runs the scoped re-review on the plain path once; the round is not silently assumed clean |
| New Critical/Important breakage in fix diff | Joins open findings → next round (same rule as today) |

### 7. Testing

`fix-loop.test.mjs` structural assertions (mirrors final-review.test.mjs):

1. `meta` pure literal: `name: 'sdd-fix-loop'`, `phases` = Fix + Re-review
2. Stage 1: first `agent()` has `gate:` bound to the covering-test command and `label: 'fix'`
3. Resume rule: second `agent()` uses `resume: 'fix'` and must *not* combine `gate`
4. Verify call carries its own `gate` + `effort: 'low'`
5. Envelope shape `{ passed, gateOutput, agentSummary, reReview }` on both branches
6. Pipeline guard: re-review stage reachable only when stage 1 returned non-null
7. `args` normalization branches present; no bare throw on malformed args
8. No sandbox-forbidden globals
9. Re-review stage prompt references `review-package`, ADDRESSED / NOT ADDRESSED, and reads `findings` / `fixBase` / `head`

The package's `npm test` gate (biome + widget/phase tests + final-review.test.mjs)
extends to run `fix-loop.test.mjs`. Live behavior verification is a smoke test at
implement time (script can only run inside a real pi session, like final-review.js).

## Out of scope

- Final whole-branch review's "ONE fix dispatch, one scoped re-review" (l8x9.4's flow) — unchanged.
- Wave-parallel implementation (l8x9.6) and named agents / @handle recovery (l8x9.7) — later beads, built on this contract.
- Any change to the plain-path fix loop's prose evidence rules for tasks without a covering-test command.
