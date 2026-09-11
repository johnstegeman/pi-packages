# toolDescriptionMode: compact for context costs — design (l8x9.10)

Date: 2026-09-11 · Status: approved design → spec · Bead: `pi-packages-l8x9.10`

## Problem

With scripted workflows enabled, every turn pays tool-spec context for two
large tool descriptions: pi-subagents' `SubagentWorkflow` tool and the `Agent`
tool's description. On flash/small-context models (e.g. the deepseek-flash
sessions this machine typically runs), ~6k tokens of tool-spec overhead per
turn is material relative to context. The `SubagentWorkflow` description is
fixed (pi-subagents-owned, deliberately ported from Claude Code's `Workflow`
wording); only the `Agent` tool description is adjustable via
`toolDescriptionMode` (`full` | `compact` | `custom`, pi-subagents 0.19,
#91).

## Measurement (hybrid: source estimates + live-session spot-check)

Token estimates use the standard chars/4 heuristic for English prose, stated
as estimates everywhere below. The strings measured are byte-identical to what
pi renders (the exact template literals); exact assembled-prompt token counts
are not logged by pi, so per-token figures are heuristic estimates.

| Item | Source | chars | est. tokens |
|---|---|---|---|
| `SubagentWorkflow` tool prose (`fullWorkflowToolDescription`) | `packages/pi-subagents/src/workflow/tool-description.ts` | 19,527 | ~4,900 |
| `Agent` tool prose, `full` (`fullAgentToolDescription`) | `packages/pi-subagents/src/index.ts` | 4,562 | ~1,140 |
| `Agent` tool prose, `compact` (`compactAgentToolDescription`) | `packages/pi-subagents/src/index.ts` | 985 | ~250 |

Notes:

- **~5k SubagentWorkflow claim confirmed** (19,527 chars ≈ 4.9k tokens of
  prose; the full tool spec with parameter schemas renders larger). This
  chunk is **not reducible** by `toolDescriptionMode` — it is the cost of
  having workflows enabled at all.
- **Full → compact ≈ 75% smaller confirmed** (1,140 → 250 tokens, ~78%);
  the saving against the full tool spec is the prose delta ≈ **~0.9k tokens
  per turn** (both modes share the identical parameter schema — pi-subagents
  never customizes the schema, only the prose).
- **Spot-check:** the live training session (this one) verifiably runs with
  both `SubagentWorkflow` and `Agent` registered — the session file carries
  the SubagentWorkflow source echo, and both tools appear in the assembled
  system prompt. The rendered strings are pinned byte-identical to the
  measured sources by upstream CI tests (see Verification). No exact
  assembled system-prompt dump exists on machine, so the spot-check
  validates registration + rendering path, not a per-prompt token census.

## Recommendation: `toolDescriptionMode: "compact"`

- Compact is preferred over `custom` because pi-subagents' CI contract test
  (`tool-description-mode.test.ts` → *"compact keeps every load-bearing
  contract — fails when a behavior change forgets compact"*) keeps the
  compact prose in lockstep with the full description whenever upstream
  changes a behavior. A hand-authored `custom` description would own that
  drift itself and must independently pass the same guardrail checklist.
- Superpowers does not need bespoke tool-description prose: its load-bearing
  guidance lives in the skill files, not the Agent tool text.
- **Escape hatch (documented, not applied):** users who want their own prose
  set `toolDescriptionMode: "custom"` and ship an `agent-tool-description.md`
  (`<cwd>/.pi/` project wins over `<agentDir>/`, `{{placeholders}}` keep the
  agent list live); a missing/empty file falls back to `"full"`.
- The ~0.9k-token saving (≈ 15% of the ~6k workflow-mode tool-spec
  overhead) is worth it on flash-class models and costs nothing on large
  ones; the fixed ~4.9k SubagentWorkflow chunk is stated explicitly so the
  reader knows what compact does — and does not — fix.

## Repo changes (`packages/pi-superpowers-plus/` only)

1. **README.md § Subagent Dispatch** — new short *Context costs* subsection:
   the table above, the compact recommendation, and the one-sentence custom
   escape hatch. No other prose changes.
2. **config-examples/subagents.global.json** and
   **config-examples/subagents.project.json** — add
   `"toolDescriptionMode": "compact"` alongside the existing
   `fallbackSubagent` / `strictAgentFiles` keys (matches how l8x9.8's
   config was shipped).
3. **CHANGELOG.md** — l8x9-style entry in the existing format.

## Applied change (machine, outside the repo)

Add `"toolDescriptionMode": "compact"` to the existing
`/Users/jstegeman/.pi/agent/subagents.json` (global defaults, hand-edited;
current content `fallbackSubagent: none` + `strictAgentFiles: true` is left
untouched). The mode is read once at tool registration, so it takes effect
on the **next pi session**.

## Guardrail verification

- Read `compactAgentToolDescription`: every load-bearing bullet from `full`
  has a compact counterpart — self-contained prompts (never-delegate
  understanding), parallel dispatch, background-by-default + don't-fabricate
  pending results, trust-but-verify before reporting done, `resume` /
  `steer_subagent`, worktree isolation guideline.
- Executable check: `cd packages/pi-subagents && npm test -- --run
  test/tool-description-mode.test.ts test/workflow-tool-description.test.ts`
  → **40 passed (2 files)**, including the keep-every-load-bearing-contract
  test and the workflow-description pins.

## Testing & validation

- pi-subagents suite above (guardrails + settings round-trip, which validates
  the exact value we write).
- JSON validity on both config-examples files and the applied global file.
- No new automated tests: this is a docs + config change; no skill code
  changes, per task scope. If guardrail verification had failed, stop and
  report before any next step (contingency; did not trigger).

## Out of scope

- Code changes to pi-superpowers-plus skills or extensions.
- Reducing the `SubagentWorkflow` tool description (fixed upstream).
- `custom` mode authoring.
