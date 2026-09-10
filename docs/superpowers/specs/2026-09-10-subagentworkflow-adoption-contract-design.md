# SubagentWorkflow adoption contract + graceful fallback in the SDD skill

Molecule: `pi-packages-mol-2wlj` · Task: `pi-packages-l8x9.3` (epic `pi-packages-l8x9`)

Date: 2026-09-10 · Status: approved design (`review.verdict=done` on `pi-packages-mol-js6r`)

## Problem

`packages/pi-superpowers-plus/skills/subagent-driven-development/SKILL.md` never
mentions `SubagentWorkflow` — the deterministic multi-agent orchestration tool
from pi-subagents ≥0.19 (pi ≥0.84). The epic's later workflow beads (final
review as a workflow, gated fix loops, wave-parallel implementation) need a
shared, authoritative adoption contract to build on: when SDD should use a
workflow vs plain `Agent` dispatch, what happens when the tool is absent, what
it costs, and what stays controller-owned. Today that contract does not exist.

Constraints that shape this design (from the epic's plan-approval gate
`pi-packages-l8x9.1`):

1. Per-task cost attribution REQUIRES per-task implementation on Agent-tool
   spawns: SubagentWorkflow children emit no lifecycle events, hence no
   per-child `usage.cost.total`. Workflows are for aggregate phases (final
   review, verification fan-out, wave-parallel batches).
2. Degrade gracefully: hosts on pi-subagents <0.19 / pi <0.84 keep the existing
   Agent-dispatch loop unchanged (superpowers-plus peerDependencies are `*`).
3. Beads/ledger state stays controller-owned; workflow scripts and their
   children are read-only on beads.
4. The SDD ledger stays the record of truth — workflow results are not
   persisted cross-session (resume journal is session-scoped).
5. Never parallel-implement on a shared branch without a file-conflict check
   — wave-parallel batches (named in the contract) carry that gate.
6. Workflows add ~5k tokens of system-prompt context whenever
   `workflowsEnabled`; spend deliberately.

## Design decisions (resolved in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| `workflowsEnabled` spend posture | Document the ~5k/turn cost + toggle guidance (pin `"workflowsEnabled": false` in `subagents.json` or `/agents → Settings → Workflows` when no batch phase is planned), **non-normative** — the skill never toggles host settings | Matches "spend deliberately" without fighting hosts that want workflows on for other reasons |
| Batch-phase rule | **Preference with judgement**: prefer the workflow for the named SDD phases/shapes, but small batches (one-reviewer final review, 2-item fan-out) stay on plain Agent dispatch | Workflows cost a subprocess per agent + 5k/turn context; must pay for themselves |
| Phase naming | **Both**: name the SDD phases (final whole-branch review, verification fan-out, wave-parallel implementation) AND give the shape heuristics each maps to | Concrete anchors for later beads + timeless heuristic |
| Organization in SKILL.md | **Standalone section** `## Workflows (SubagentWorkflow)` after "When to Use", plus a Red Flags line and a Final-Review hook | One authoritative anchor later workflow beads reference; rules not silently forgotten |

## Design

### 1. Placement

A new top-level section `## Workflows (SubagentWorkflow)` in
`packages/pi-superpowers-plus/skills/subagent-driven-development/SKILL.md`,
inserted after the "When to Use" section (before "The Process"). Five
sub-blocks (see §2 for full text). Two minimal woven-in pointer edits:

- **Red Flags** — add one line: "Emulate workflows with parallel `Agent`
  dispatch when `SubagentWorkflow` is absent (the fallback is the sequential
  loop, not fake parallelism)".
- **Final Review** — one sentence noting the whole-branch review *can* fan out
  as a workflow when the branch is large, per the Workflows section (the
  scripted form is l8x9.4's bead).

### 2. Contract text (verbatim draft)

> **When a workflow is right.** Prefer `SubagentWorkflow` for SDD's batch shapes:
>
> - **Final whole-branch review** — fan review dimensions (or files/findings) out and verify each independently before believing the aggregate.
> - **Verification fan-out** — any "check all N things" pass over a runtime-discovered list.
> - **Wave-parallel implementation** — per-task batches dispatched from the beads ready frontier (only with a file-conflict gate; per the wave-parallel work).
>
> The preference is judgement-based: a small plan's final review is one reviewer, a two-item fan-out is two named calls — plain Agent dispatch wins whenever the batch is small enough to name up front. A workflow costs a subprocess per agent plus ~5k tokens/turn of tool-spec context; use one only when the parallelism pays for both. Per-task implementation stays on Agent dispatch — workflow children emit no per-child cost events, so per-task cost attribution requires it.
>
> **The fallback rule.** If `SubagentWorkflow` is present (pi-subagents ≥0.19, pi ≥0.84, `workflowsEnabled` not off, no stand-down), use it for the shapes above. If it is absent, the existing Agent-dispatch loop is unchanged — dispatch sequentially; never emulate workflows with parallel Agent calls.
>
> **The context budget.** The tool spec costs ≈5k tokens of system prompt every turn while `workflowsEnabled` is on (source: `packages/pi-subagents/src/workflow/tool-description.ts`), used or not. Spend deliberately: when the plan has no batch phase in sight, consider pinning `"workflowsEnabled": false` in `subagents.json` (or `/agents → Settings → Workflows`) and re-enabling when a batch is planned. Guidance only — never toggle a host's settings from a skill.
>
> **Stand-down semantics.** The tool stands down automatically when another extension already provides a `Workflow`/`SubagentWorkflow` tool (exact-name match). Stand-down is equivalent to absence; the fallback applies unchanged.
>
> **Controller-owned state.** Workflow scripts and their children are read-only on beads and the ledger — they never create/update/close beads. Results funnel back through the controller, which alone records them in the SDD ledger; the ledger stays the record of truth (workflow resume journals are session-scoped; nothing a workflow produced persists cross-session except what the controller wrote).

### 3. Claim traceability (verify at implementation)

| Claim | Source to cross-check |
|---|---|
| Tool presence requires pi-subagents ≥0.19 / pi ≥0.84 | `packages/pi-subagents/README.md` (§Requires pi 0.84.0 or newer) |
| ~5k tokens/turn tool-spec context | `packages/pi-subagents/src/workflow/tool-description.ts` (19,527 chars ≈ 4.9k tokens ≈ + parameter schema) — cited in the section text |
| `workflowsEnabled` off → tool never registered, no tool-spec cost | README §Persistent Settings |
| Toggle routes: `subagents.json` / `/agents → Settings → Workflows` | README §Persistent Settings |
| Stand-down = exact-name match on `Workflow`/`SubagentWorkflow`, checked at `session_start` | README §Persistent Settings |
| Workflow children emit no per-child usage events | README §Events (top-level agents only) |
| Verbatim shape guidance ("number depends on runtime discovery / stages / independent verification") | `packages/pi-subagents/src/index.ts` promptGuidelines (line ~2414) |

## Testing / verification

- **Structural greps** (implementer): `## Workflows (SubagentWorkflow)` present after "When to Use"; five sub-block headings present; Red Flags line added; Final-Review hook present; diff touches no other SKILL.md content.
- **Claim cross-check**: every row in the traceability table verified against the cited subtree source.
- **Guard**: `cd packages/pi-superpowers-plus && npm test` stays green (biome check + `extensions/beads-molecule-widget.test.mjs` + `extensions/phase-commands.test.mjs`).
- No unit tests apply (prose-only deliverable); manual QA = read the section in context.

## Out of scope

- The scripted final-review workflow (l8x9.4), gated fix loop (l8x9.5),
  wave-parallel implementation (l8x9.6) — this contract names their phases,
  they implement the scripts.
- Toggling host `subagents.json` settings — guidance only.
- Changes to `workflowsEnabled` defaults in pi-subagents.
