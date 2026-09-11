# Wave-parallel implementation from the beads ready frontier

Molecule: `pi-packages-mol-1nd7` · Task: `pi-packages-l8x9.6` (epic `pi-packages-l8x9`)

Date: 2026-09-10 · Status: approved design (`review.verdict=done` on `pi-packages-mol-yds9`)

## Problem

SDD implements tasks strictly sequentially: one implementer dispatched per task, one
review after each, "Never dispatch multiple implementation subagents in parallel".
For plans with many independent tasks this leaves a headline parallelism win on the
table: batches of independent tasks could implement concurrently, with each task's
review pipelined behind its implementation, and the per-task review-gate discipline
preserved.

pi-subagents ≥0.19's `SubagentWorkflow` offers engine-managed `pipeline()` pipelining
(no barrier: task A's review starts while task B still implements), `gate` on stages,
and schema-validated returns — the natural home for a batched implementation phase.

## Constraints (from plan-approval gate `pi-packages-l8x9.1`, as amended by this design)

1. **Per-task cost attribution.** Amended: waived for wave batches by explicit
   user decision — workflow children emit no lifecycle events, so no per-child
   `usage.cost.total`. The sequential plain-Agent path keeps its cost events; fix
   rounds (controller-side) are plain-Agent dispatches and keep their per-task costs.
2. **Degrade gracefully.** Hosts without `SubagentWorkflow` keep the sequential loop
   unchanged (the fallback is the sequential loop, never a fake wave).
3. **Beads/ledger state stays controller-owned.** Wave script and children are
   READ-ONLY on beads; only the envelope persists; the controller writes every bead
   change and ledger line.
4. **The SDD ledger stays the record of truth.**
5. **Never parallel-implement on a shared branch without a file-conflict check.**
   A wave contains only tasks with pairwise-disjoint file sets; tasks that collide
   on any file are withheld from the wave and picked up by the next ready frontier.
6. **Workflows add ~5k tokens/turn of context; spend deliberately.** A wave is a
   bounded, well-motivated batch phase.

## Resolved decisions (brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Mechanism | **Wave `SubagentWorkflow`**: `pipeline(wave, implement, review)` per wave — the choice-point option (b) | Engine-managed pipelining (A's review starts while B implements), stage `gate`, schema reviews, capped concurrency |
| Per-task cost | **Waived for wave batches** (explicit user decision) | Removes the epic's hard constraint that kept implementation on plain Agent; sequential path keeps costs |
| Working model | **Shared plan branch + file-scoped review diffs** | Implementers commit like today; the review stage diffs `base..HEAD -- <task files>` so interleaved commits cannot contaminate a task's review; no per-child worktrees (their resume/merge friction rejected) |
| File-overlap handling | **Scheduler**: tasks sharing a file are withheld from the wave (handled by the next frontier) — a lane *between* waves, not inside the run | Keeps the script single-item-pure; disjoint parallelism, collisions serialized across waves |
| Implement gate | **Task-bead-declared only**: writing-plans adds an optional `**Gate:** <re-runnable command>` line; wave gates only tasks with one | The covering-test command is otherwise only known *after* first implementation; a declared gate is trustworthy, absent gate = no gate |
| Fix rounds | **Controller-side, unchanged mechanisms** (plain prose loop or `fix-loop.js` per l8x9.5) | Breaker judgment and Q&A round-trip to the controller; the common no-findings case adds zero script machinery |
| Beads/widget fidelity | **Wave-level**: controller claims all wave task beads at dispatch, batched updates from the envelope after the run; ledger wave cursor | Workflow children are read-only on beads and the controller has no live channel mid-run; the ledger is the recovery map |
| Review granularity | `pipeline(tasks, implement, review)` — review schema-validated; fix rounds only on findings (decision iii) | Big wins (concurrency + pipelined schema reviews) without a full mini-SDD in a sandbox |

## Design

### 1. Components

| File | Change |
|---|---|
| `packages/pi-superpowers-plus/skills/subagent-driven-development/scripts/wave-parallel.js` | **NEW** deterministic wave script |
| `.../scripts/wave-parallel.test.mjs` | **NEW** structural regression test (final-review/fix-loop style) |
| `.../scripts/review-package` | File-scoping: optional trailing `-- <files...>` restricts stat + diff to those paths (commit list stays for context) |
| `.../SKILL.md` | New "Wave-parallel implementation" subsection + red-flag carve-out + Workflows batch-shapes bullet |
| `writing-plans` (its SKILL.md) | `**Gate:** <re-runnable command>` optional task-line convention |
| Adoption contract text | The "Per-task implementation stays on Agent dispatch" line rewritten: waves run on workflow; plain Agent when per-task costs are wanted |
| `CHANGELOG.md` | Entry |

### 2. Wave lifecycle (controller)

1. Read the ready frontier (`beads_mol_ready`), filter unclaimed, read each task
   bead's `Files:` (+ optional `Gate:`); compute file-overlap groups; **wave = one
   pairwise-disjoint set**; file-colliding tasks are withheld (next frontier).
2. Claim every wave task bead (wave-level fidelity), ledger cursor:
   `Wave <W>: dispatched — <task ids> on <base>`.
3. Run `SubagentWorkflow({ scriptPath: "<skill>/scripts/wave-parallel.js", args: {
   wave: [{ taskBeadId, gate?, files: [...] }], base, reportDir, gateBeadId,
   reviewPackage } })` — `base` = current HEAD (the review stage resolves HEAD
   itself at review time; `head` is deliberately not an arg — see §3).
4. Process the envelope per task (close / fix loop / Q&A / breaker).
5. Re-read the ready frontier; repeat until the implement step's tasks are closed;
   then the normal final whole-branch review runs once over the branch (it diffs
   merge-base..HEAD as usual — the wave is invisible to it).

### 3. Script contract: `wave-parallel.js`

- **`meta`:** `{ name: 'sdd-wave-parallel', description: 'Wave-parallel implementation: concurrent disjoint-file implementations gated by declared covering tests, schema-validated per-task reviews',
  phases: [{ title: 'Implement' }, { title: 'Review' }] }`. Standard guards: JSON-string
  `args` normalization; malformed args → empty wave, never a bare throw; no
  sandbox-forbidden globals (`Date.now(`, `Math.random(`, `eval(`, `new Date`).
- **Args in:** `{ wave: [{ taskBeadId, gate?, files: string[] }], base,
  reportDir, gateBeadId, reviewPackage }` — NO `head`: HEAD moves as implementers
  commit, so the review child resolves the current HEAD itself at review time.
- **Schemas:**
  - `IMPLEMENT_RESULT_SCHEMA`: `{ status: enum[done, done_with_concerns,
    needs_context, blocked], commits?, testSummary?, coveringTestCommand?, concerns?,
    reportFile }`
  - `REVIEW_SCHEMA`: `{ specCompliant: boolean, cannotVerify?: string[],
    issues: [{ severity: enum[critical, important, minor], file, line?, description }],
    assessment }`
- **Stage 1 — implement (per item):**
  `agent(implementPrompt, { label: 'implement:<taskId>', phase: 'Implement',
  agentType: 'implementer', schema: IMPLEMENT_RESULT_SCHEMA,
  ...(item.gate ? { gate: item.gate } : {}) })`. A non-zero gate exit fails the agent;
  the call returns `null` and the item's envelope entry becomes
  `{ status: 'gate-failed' }` — the controller runs the existing controller-side fix
  loop with the declared gate (the child's report file is the recovery record; its
  commits are on the branch). No gate declared → no gate.
- **Short-circuit:** stage 2 skips anything other than `done`/`done_with_concerns`
  (`{ skipped: true, reason: status }`) — `needs_context`/`blocked` come back
  un-reviewed for controller Q&A/re-dispatch.
- **Stage 2 — review (per done item):** the review child builds the scoped package
  itself: `bash: <reviewPackage> <taskBeadId> <base> $(git rev-parse HEAD) -- <files...>`
  (the child resolves HEAD at review time; the file-scoping is the interleaving
  protection), reads it plus the task bead and
  report file, returns `REVIEW_SCHEMA` (`agentType: 'task-reviewer'`). A null review
  → `{ status: 'review-failed' }` → controller re-runs that review on the plain path
  once.
- **Implementer prompt discipline:** work on the shared branch; `git add <own files>`
  + one commit at the end; retry once after ~2s on `index.lock` races; never
  merge/rebase/push.
- **Envelope out:** `{ wave: [{ taskBeadId, status, spec?, skipped?, reason? }],
  degraded? }` — `degraded` set when any item is other than `done`/`done_with_concerns`
  (concerns flow through the normal branches, reviewed not degraded; matches SKILL.md step 4).
  Children are read-only on beads (only `beads_show` in prompts).

### 4. Envelope processing (controller)

- `done` + compliant + no critical/important → ledger `Task <N>: complete (...)` →
  `beads_close`.
- `done_with_concerns` → concerns ledgered; reviewed normally.
- Non-compliant / issues present → issues become the open findings → **controller-side
  fix loop unchanged** (declared `Gate:` → `fix-loop.js`; else the prose path;
  rounds 1–5 + breaker as today; these are plain-Agent dispatches, so per-task cost
  events return for fix rounds — expected).
- `needs_context` → answer via `beads_comment`, re-dispatch on the next wave (stays
  claimed).
- `gate-failed` / `review-failed` → fix loop / plain re-review respectively.
- Wave-level `degraded` → ledger notes per task; nothing silently dropped.
- Ledger: per-task lines when the envelope lands (same volume as the plain loop's
  bookkeeping, batched).

### 5. Concurrency & fidelity

- Engine cap `min(16, cpus−2)` queues larger waves naturally; no controller
  throttling. A wave never exceeds the unclaimed ready-task count at snapshot time.
- Beads freeze mid-run (children read-only, no live channel); the live mid-run eye is
  `/agents → Workflows`; beads catch up in the batched envelope pass.

### 6. Error handling & graceful degradation

| Failure | Handling |
|---|---|
| `SubagentWorkflow` absent / disabled / stand-down | Wave never dispatches — sequential loop unchanged |
| Wave skipped by user / run errors | Tasks stay claimed → back to `open`; ledger note; commits already made are on the branch |
| Implement child `null` (crash / gate failure) | `gate-failed`/`failed` entry → controller fix loop with the declared gate |
| Implement status `needs_context` / `blocked` | Skipped past review; controller resolves, re-dispatches next wave |
| Review child `null` | `review-failed` → one plain-path re-review; never silently clean |
| `args` malformed / JSON-string | Normalize / degrade to empty wave; never a fatal throw |
| `index.lock` race | Implementer retry-once; no lost work |
| Wave > engine cap | Queues naturally |

### 7. Testing

`wave-parallel.test.mjs` structural assertions (mirrors sibling tests):

1. `meta` pure literal: `name: 'sdd-wave-parallel'`, phases Implement + Review
2. `pipeline(` over `ARGS.wave`; stage 1 labelled `implement:` per task; stage 2 labelled `review:`
3. `IMPLEMENT_RESULT_SCHEMA` status enum + `gate` applied only via the `item.gate` conditional
4. Short-circuit: review stage guards non-done statuses
5. `REVIEW_SCHEMA` shape (`specCompliant`, `issues[].severity` enum, `cannotVerify`)
6. Envelope: per-task entries by `taskBeadId`; degraded when any item is other than done/done_with_concerns (done_with_concerns flows through the normal branches)
7. Review stage passes `base`, `head`, `--`, `item.files` to `reviewPackage` (the file-scoping protection is asserted)
8. Args normalization branch; no sandbox-forbidden globals

Plus, delivered: an automated `review-package` scoping check (added in the fix
round, after review) — the test actually executes review-package against the two
spec commits in history via `spawnSync` + bash and asserts the diff stays
file-scoped (exactly one `^diff --git` line) and that `--` with no paths fails
loudly; vm-compile parse gates in all three structural test files (final-review,
fix-loop, wave-parallel) that compile each script under the runtime's async vm
wrapper. The SKILL.md insertion was verified by a manual read/grep during Task 4
(no automated self-read check — the structural tests do not grep SKILL.md).
Smoke-test: live wave behavior is the formula's own `smoke-test-approved` step.

## Out of scope

- Per-child worktree isolation (rejected working model) and the merge tax of
  overlapping parallel tasks (rejected — file-colliding tasks serialize via the
  scheduler).
- Gated fix loops (`fix-loop.js`) — shipped in l8x9.5; reused here, not re-designed.
- l8x9.7+ (named agents/@handle recovery, fail-closed dispatch, nested delegation,
  toolDescriptionMode) — later beads.
