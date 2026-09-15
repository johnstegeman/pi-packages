## Workflows (SubagentWorkflow)

SubagentWorkflow (pi-subagents >=0.19, pi >=0.84) runs deterministic scripts that coordinate many subagents in the background — `agent()`, `parallel()`, `pipeline()`, `gate`, `resume` (see the pi-subagents README / docs/workflows.md). It is for batches, not single tasks: use `Agent` for one delegated task or a handful you can name up front.

**When a workflow is right.** Prefer `SubagentWorkflow` for SDD's batch shapes:

- **Final whole-branch review** — fan review dimensions (or files/findings) out and verify each independently before believing the aggregate.
- **Verification fan-out** — any "check all N things" pass over a runtime-discovered list.
- **Wave-parallel implementation** — per-task batches dispatched from the beads ready frontier (only with a file-conflict gate; per the wave-parallel work).

The preference is judgement-based: a small plan's final review is one reviewer, a two-item fan-out is two named calls — plain Agent dispatch wins whenever the batch is small enough to name up front. A workflow costs a subprocess per agent plus ~5k tokens/turn of tool-spec context; use one only when the parallelism pays for both. Per-task implementation stays on Agent dispatch when per-task cost attribution is wanted; wave batches (see Wave-parallel implementation below) may run on the workflow with per-batch cost, chosen deliberately per plan.

**The fallback rule.** If `SubagentWorkflow` is present (pi-subagents >=0.19, pi >=0.84, `workflowsEnabled` not off, no stand-down), use it for the shapes above. If it is absent, the existing Agent-dispatch loop is unchanged — dispatch sequentially; never emulate workflows with parallel Agent calls.

**The context budget.** The tool spec costs ~5k tokens of system prompt every turn while `workflowsEnabled` is on (source: `packages/pi-subagents/src/workflow/tool-description.ts`), used or not. Spend deliberately: when the plan has no batch phase in sight, consider pinning `"workflowsEnabled": false` in `subagents.json` (or `/agents → Settings → Workflows`) and re-enabling when a batch is planned. Guidance only — never toggle a host's settings from a skill.

**Stand-down semantics.** The tool stands down automatically when another extension already provides a `Workflow`/`SubagentWorkflow` tool (exact-name match, checked at session start). Stand-down is equivalent to absence; the fallback applies unchanged.

**Controller-owned state.** Workflow scripts and their children are read-only on beads and the ledger — they never create/update/close beads. Results funnel back through the controller, which alone records them in the SDD ledger; the ledger stays the record of truth (workflow resume journals are session-scoped; nothing a workflow produced persists cross-session except what the controller wrote).

**Wave-parallel implementation.** For plans with several ready, INDEPENDENT tasks, batch them as waves on the workflow (one `SubagentWorkflow` run per wave; see `scripts/wave-parallel.js`). Per wave:

1. Read the ready frontier (`beads_mol_ready`), filter to unclaimed tasks, and read each task bead's `Files:` section (plus the optional `**Gate:**` line — see writing-plans). A wave contains only tasks with PAIRWISE-DISJOINT file sets: compute the file-overlap groups; tasks that share any file are withheld and picked up by the next frontier. Never include colliding tasks in one wave. Tasks with no Files section (e.g. doc-only) are not wave-eligible — they stay on the sequential path (a wave review must be file-scoped).
2. Claim every wave task bead (`beads_update({ id, claim: true })`), and record the ledger cursor `Wave <W>: dispatched — <task ids> on <base>`.
3. Run `SubagentWorkflow({ scriptPath: "<skill>/scripts/wave-parallel.js", args: { wave: [{ taskBeadId, gate?, files: [...] }], base, reportDir, gateBeadId, reviewPackage } })` where `base` is the current HEAD, `reportDir` the plan workspace, `gateBeadId` the plan-approval gate bead, `reviewPackage` the absolute path to this skill's `scripts/review-package`.
4. Process the returned envelope per task: `done` + `spec.specCompliant` + no critical/important → ledger `Task <N>: complete (...)`, close the bead. `done_with_concerns` → ledger the concerns; the review proceeds and the task flows through the same complete/fix-loop branches as `done`. `specCompliant: false` or issues present → the issues become the open findings; run the EXISTING controller-side fix loop (declared `Gate:` → `fix-loop.js`; else the prose path; rounds 1–5 + breaker as normal — these are plain-Agent dispatches, so per-task cost events return here). `needs_context`/`blocked` → answer via `beads_comment`, re-dispatch on the next wave (the task bead stays claimed). `gate-failed`/`failed` → fix loop with the declared gate (or prose path). `review-failed` → re-run that review once on the plain path. Wave-level `degraded` → ledger note per task; nothing silently dropped. If the `wave-parallel.js` run itself errors (a thrown script, e.g. bad args), fall back to sequential per-task dispatch for that wave's tasks — never silently drop them.
5. Re-read the ready frontier and repeat until the implement step's tasks are closed; then the normal final whole-branch review runs once over the whole branch (it diffs merge-base..HEAD as usual — waves are invisible to it).

Choose waves over sequential dispatch deliberately: waves waive per-task cost attribution (workflow children emit no lifecycle events) and freeze task beads mid-run (children are read-only on beads; the live mid-run eye is `/agents → Workflows`). The engine caps concurrency at `min(16, cpus−2)` — larger waves queue naturally. If `SubagentWorkflow` is absent, the sequential loop is unchanged — never emulate a wave with parallel `Agent` calls.
