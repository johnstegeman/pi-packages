# Convert remaining mutation-heavy skills from raw `bd` to `beads_*` tools

Date: 2026-09-03
Status: Approved
Tracks: pi-packages-15n
Molecule: pi-packages-mol-qd7
Branch: `fix/superpowers-beads-cleanup`

## Context

From the final whole-branch review of the event-driven beads widget effort
(pi-packages-mol-0eh), only `brainstorming`/`writing-plans`/`executing-plans` were
converted to `beads_*` tool calls (Task 3, commit `7765762`). Four primary execution
skills still shell out to the raw `bd` CLI:

- `subagent-driven-development/SKILL.md`
- `verification-before-completion/SKILL.md`
- `test-driven-development/SKILL.md`
- `requesting-code-review/SKILL.md`

**Why it matters:** the event-driven widget refreshes on `beads:changed` events.
`beads_*` tools emit that event; the raw `bd` CLI does not. So the widget goes stale
precisely during the busiest mutation periods (per-task claims/closes while a subagent
batch runs), catching up only at the next `agent_start`.

## Scope

Convert the **11 raw `bd` references** in the four skills above to the equivalent
`beads_*` tool calls, using the same mapping table as Task 3. Two small consistency
nits are included (below). No tooling, CI, or test changes — this is a docs-only
conversion, verified by a one-off grep.

Confirmed facts driving the design:

- None of the four files uses `bd ready --mol` — those calls live in
  `executing-plans/SKILL.md`, which is already converted and is the separate scope of
  pi-packages-6np. **pi-packages-6np does not gate this work.**
- Dispatched implementer subagents (pi-subagents default agents) resolve `tools` to
  "all available tools", so extension-registered `beads_*` tools **are** available
  inside dispatch-prompt templates. Converting in-template reads is functional, not
  just cosmetic.

## Mapping

| Raw `bd` | `beads_*` equivalent |
|---|---|
| `bd mol current X --json` | `beads_mol_current({ id: "X" })` |
| `bd mol show X` | `beads_mol_show({ id: "X" })` |
| `bd show X` (status check) | `beads_show({ id: "X" })` (compact) |
| `bd show X` (requirements) | `beads_show({ id: "X", full: true })` |
| `bd close X --reason "Y"` | `beads_close({ ids: "X", reason: "Y" })` |
| `bd update X --claim` | `beads_update({ id: "X", claim: true })` |
| `bd update X --status blocked` | `beads_update({ id: "X", status: "blocked" })` |
| `bd gate resolve X` | `beads_gate_resolve({ id: "X" })` |
| `bd comment X "Y"` | `beads_comment({ id: "X", text: "Y" })` |

Style rule: replace each `` `bd …` `` token **in place**, preserving each file's
existing plain-text prose voice (these files use inline parenthetical references, not
the fenced code-block style used in `writing-plans`).

## Edits

### `subagent-driven-development/SKILL.md` — 5 conversions + 1 nit

- L155 `bd mol current <implement-step-id> --json` → `beads_mol_current({ id: "<implement-step-id>" })`
- L157 `bd show <plan-approved-gate-id>` → `beads_show({ id: "<plan-approved-gate-id>" })` (compact — status check only)
- L186 `bd mol show <implement-step-id>` → `beads_mol_show({ id: "<implement-step-id>" })`
- L189 `bd show <task-id>` → `beads_show({ id: "<task-id>", full: true })` (dispatch template; task description IS the requirements)
- L367 `bd close <task-id> --reason "<summary>"` → `beads_close({ ids: "<task-id>", reason: "<summary>" })`
- **Nit L225:** realign the existing half-converted `beads_update({ id: "<id>", status: "blocked", appendNotes: "<blocker>" })` to the standardized pattern → `beads_update({ id: "<id>", status: "blocked" })` + `beads_comment({ id: "<id>", text: "<blocker>" })`.

### `verification-before-completion/SKILL.md` — 3 conversions

- L22 `bd update <verify-step-id> --claim` → `beads_update({ id: "<verify-step-id>", claim: true })`
- L135 `bd close <verify-step-id> --reason "verification passed"` → `beads_close({ ids: "<verify-step-id>", reason: "verification passed" })`; `bd gate resolve <smoke-test-approved-gate-id>` → `beads_gate_resolve({ id: "<smoke-test-approved-gate-id>" })`; `bd update <finish-step-id> --claim` → `beads_update({ id: "<finish-step-id>", claim: true })`
- L139 `bd update <verify-step-id> --status blocked` → `beads_update({ id: "<verify-step-id>", status: "blocked" })`; `bd comment` → `beads_comment({ id: "<verify-step-id>", text: "<why>" })`

### `test-driven-development/SKILL.md` — 2 conversions

- L18 `bd update <task-id> --claim` → `beads_update({ id: "<task-id>", claim: true })`
- L260–261 `bd update <task-id> --status blocked` + `bd comment` → `beads_update({ id: "<task-id>", status: "blocked" })` + `beads_comment({ id: "<task-id>", text: "<why>" })`

### `requesting-code-review/SKILL.md` — 1 conversion + 1 nit

- L65 `bd show` → `beads_show({ id: "<task-id>", full: true })`
- **Nit L65:** the example carries a dead-session id `pi-packages-mol-ogh.2`. Replace with a neutral placeholder so it reads `the task bead <task-id> (read via beads_show({ id: "<task-id>", full: true }))`.

## Verification

- Grep the four files for raw CLI usage (`` `bd `` + verb tokens, `bd <verb>`) → **0 hits**.
- Confirm every converted `beads_show` for requirement reads carries `full: true`; the gate status check stays compact.
- Proofread each edit site for prose continuity.

## Acceptance

1. Zero raw `bd` references remain in the four files.
2. All 11 sites map to the equivalent `beads_*` call per the table above.
3. Full-description reads (`subagent-driven-development` L189, `requesting-code-review` L65) use `full: true`.
4. The two nits applied; prose voice preserved throughout.
5. Single docs commit on `fix/superpowers-beads-cleanup`, e.g.
   `docs(skills): convert remaining bd CLI calls to beads_* tools`.
