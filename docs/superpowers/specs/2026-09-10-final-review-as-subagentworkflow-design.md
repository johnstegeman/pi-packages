# Final whole-branch review as a SubagentWorkflow

Molecule: `pi-packages-mol-a1vs` · Task: `pi-packages-l8x9.4` (epic `pi-packages-l8x9`)

Date: 2026-09-10 · Status: approved design (`review.verdict=done` on `pi-packages-mol-m49w`)

## Problem

SDD's Final Review step dispatches a single `code-reviewer` agent against the
whole-branch review package. Reviews gain nothing from parallel dimension
reviewers, adversarial verification of findings, or schema-validated output —
all available from `SubagentWorkflow` (pi-subagents ≥0.19 / pi ≥0.84), whose
adoption contract l8x9.3 just landed in this same SKILL.md (`## Workflows
(SubagentWorkflow)`, listing final whole-branch review as a workflow phase).
This bead implements exactly that phase, with the judgement gate and fallback
the contract prescribes.

Constraints that shape this design (from the epic's plan-approval gates):

1. Per-task cost attribution stays on Agent-tool spawns; the final review is an
   **aggregate** phase, so a workflow is permitted (l8x9.3's named phases).
2. Degrade gracefully: `SubagentWorkflow` absent → the current single
   `code-reviewer` dispatch is unchanged.
3. Beads/ledger state stays controller-owned: workflow scripts and children are
   read-only on beads (the finders may only `beads_show` the gate bead for
   Global Constraints).
4. The SDD ledger stays the record of truth: the workflow's resume journal is
   session-scoped; only the workflow's **return value** (plus the controller's
   ledger entries) persists.
5. Never parallel-implement; the review workflow is read-only fan-out, and the
   controller remains the sole fix/adjudication path (ONE fix dispatch + one
   scoped re-review + breaker rules preserved verbatim).
6. Workflows cost ~5k tokens/turn of tool-spec context while `workflowsEnabled`;
   judgement-gated use per the contract.

## Design decisions (resolved in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Trigger | **Judgement-gated** (consistent with l8x9.3): workflow default when tool present AND the branch is large/broad (multi-file, many commits, security-sensitive, deferred minors to triage); single `code-reviewer` dispatch for small plans and for absent tool | The ~5k/turn context + per-agent subprocess costs must pay for themselves |
| Dimensions | **Fixed full set**: correctness, security, performance, plan/spec alignment, maintainability | Mirrors the current `code-reviewer.md` What-to-Check scope 1:1 — no regression vs the single reviewer |
| Verify strength | **One refuter per finding** with refute-biased framing; reason surfaced for controller adjudication | Bounded cost; matches the documented review-changes pattern |
| Script location | **Ship `scripts/final-review.js` in the SDD skill**, invoked via `SubagentWorkflow({ scriptPath, args })` | Deterministic, versioned with the skill, edited once; `scriptPath` wins over inline/saved-name |
| Orchestration shape | **Find barrier → deterministic dedupe → parallel verify** | Cross-dimension dedupe genuinely needs all findings together (security+correctness often flag the same line); barrier cost = slowest finder, which any approach pays |

## Design

### 1. New file: `scripts/final-review.js` (in the SDD skill directory)

A deterministic SubagentWorkflow script: `export const meta = { name, description, phases }`
pure literal + an async body (bare top-level `return` the runtime wraps — the
file is NOT valid standalone JavaScript). Self-contained; no fs/bash in the
script itself — its agents do all reading. No `Date.now()` / `Math.random()` /
`eval` / `new Date` anywhere in the source (the sandbox throws on them).

### 2. Invocation contract

Controller invokes during Final Review (workflow path):

```
SubagentWorkflow({
  scriptPath: "<skill-dir>/scripts/final-review.js",
  args: {
    packagePath: "<abs path to review-<base7>..<head7>.diff>",  // generated via scripts/review-package (unchanged)
    base: "<sha>", head: "<sha>",
    description: "<what was implemented — one paragraph>",       // from the After-All-Tasks summary
    gateBeadId: "<plan-approval gate bead id>",                  // Global Constraints source
    dimensions: ["correctness","security","performance","plan","maintainability"],
  },
})
```

### 3. Stage 1 — Find (parallel, 5 dimension finders)

- `parallel(dimensions.map(d => () => agent(promptFor(d), { agentType: "code-reviewer", label: \`find:\${d}\`, phase: "Find", schema: FINDINGS_SCHEMA })))`
- Each prompt composes the existing `code-reviewer.md` persona with: the
  package path ("read it once — it is your view of the change; do not re-run
  git"), base/head, the one-paragraph description, the gate bead id ("read the
  Global Constraints — they are the attention lens"), and that dimension's
  single What-to-Check focus.
- `FINDINGS_SCHEMA` (JSON Schema, object root):
  `{ findings: [{ file: string, line?: integer, severity: "critical"|"important"|"minor", description: string }] }`
  (required: `file`, `severity`, `description`).
- `.filter(Boolean)`: a failed/skipped dimension contributes nothing.

### 4. Stage 2 — Dedupe (deterministic plain JS)

- Key = `file:line?:severity:normalizedDescription` (description lowercased,
  whitespace-collapsed); when `line` absent, `file:severity:normalizedDescription`.
- Collision: keep the higher-severity entry, merge dimension tags
  (`dimensions: [...]`). Pure string ops.

### 5. Stage 3 — Verify (parallel, one refuter per surviving finding)

- `parallel(findings.map(f => () => agent(refutePrompt(f), { agentType: "general-purpose", label: \`verify:\${f.file}\`, phase: "Verify", schema: VERDICT_SCHEMA })))`
- Refuter prompt: "Try to REFUTE this finding (file, severity, description) —
  the reason must be specific to the diff. Default to refuted unless the
  finding clearly holds; you may read the review package at `<packagePath>`."
- `VERDICT_SCHEMA = { isReal: boolean, reason: string }`.
- Refuter `null` (skipped mid-run) → finding **kept** as
  `verification: { isReal: true, reason: "unverified (refuter skipped)" }`.

### 6. Return envelope (the JSON boundary the controller consumes)

```
{ base, head, dimensions: [...], findings: [
  { file, line?, severity, dimensions: [...], description,
    verification: { isReal, reason } } ] }
```

### 7. Controller flow (SKILL.md Final Review, dual path)

1. User confirms → `set_phase("final review")` → generate the review package.
2. **Workflow path** (tool present + broad branch): invoke with `args`, wait
   for the completion notification, consume the return envelope.
3. **Adjudicate exactly as today**: ONE fix dispatch + one scoped re-review →
   residuals via breaker rules → ledger entry for every parked finding. The
   workflow replaced only the find/verify step.
4. **Fallback path** (absent tool, or small plan): single `code-reviewer`
   dispatch, unchanged.
5. Existing adjudication/finishing paragraphs of SKILL.md stay intact — the
   change is additive around them. The `## Workflows` section needs no edit.

### 8. Error handling

- All dimension finders fail → return `{ findings: [], degraded: "all dimension
  finders failed" }` → controller falls back to the single-reviewer path (never
  a silent clean pass).
- Zero findings → clean path: no fix dispatch, straight to finishing.
- Runtime script exception → run reports failure; controller falls back.
- Agent failures never throw the script (`parallel` folds them to `null`).

## Testing

1. **Structural regression test** (CI-able): new
   `packages/pi-superpowers-plus/skills/subagent-driven-development/scripts/final-review.test.mjs`
   (beside the script it guards, matching the package's test-sits-next-to-code
   convention like `extensions/*.test.mjs`), wired into the
   package's `npm test` (after the existing two extension tests). node:assert
   over the script *source*: `export const meta` pure-literal present; both
   schemas' required keys present; both `parallel(` calls, the dedupe function,
   `.filter(Boolean)`, and the return-envelope keys present; **forbidden-globals
   guard** (`Date.now(`, `Math.random(`, `eval(`, `new Date` absent).
2. **Self-smoke (manual QA, smoke gate)**: run the workflow for real against its
   own branch's review package — real agents, real schemas, real pipeline.
3. **Guard**: existing `npm test` (biome + two extension test files) stays green.

## Out of scope

- Gated fix loop (l8x9.5) and wave-parallel implementation (l8x9.6) — this bead
  is the final-review phase only.
- Dimension configurability beyond `args` passthrough (defaults are the fixed
  full set; `args.dimensions` can already override per run).
- Per-finding majority-of-3 verification (decision: one refuter per finding).
