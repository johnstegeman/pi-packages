# Code Review Results — Warning Escalation & Skill Boundary Enforcement

- Plan: `docs/plans/2026-02-13-warning-escalation-and-skill-boundaries-implementation.md`
- Branch: `feature/warning-escalation-guardrails`
- Base (reviewed against): `c29b94189e599f8dd722eacb62c63d97ce5f43ee`
- Head: `9d81e3cc9135f66f44f2aa0efcc494189d2786ed`

## Strengths
- `ui.select` prompts now use string labels (fixes `[object Object]`) across skip-confirmation, completion gate, and boundary prompts.
- Defense-in-depth approach is clear: skill docs set expectations; workflow-monitor enforces at runtime.
- Strong test coverage for new guardrails and escalation.
- Documentation added: `docs/oversight-model.md`, `docs/workflow-phases.md`, linked from README.
- Edge case handled: `./docs/plans/...` treated as plan write during thinking phases.

## Issues Found

### Critical
- None.

### Important
1. **Repeated `getWorkflowState()` calls in the same tool handler**
   - File: `extensions/workflow-monitor.ts`
   - Notes: the `tool_call` handler queries workflow state multiple times per invocation; recommended to fetch once and reuse for clarity and to avoid confusion about state changing mid-handler.
   - Status: **Not addressed**.

2. **Absolute paths can cause false positives for `docs/plans/` allowlist**
   - File: `extensions/workflow-monitor.ts`
   - Notes: current normalization only strips a leading `./`. A path like `/.../docs/plans/x.md` would not match `docs/plans/` and would be flagged during brainstorm/plan.
   - Status: **Not addressed**.

3. **Practice escalation skipped during thinking phases (interaction between buckets)**
   - File: `extensions/workflow-monitor.ts`
   - Notes: practice escalation is gated off in brainstorm/plan. This is likely intentional because process violations already block code writes, but the behavior is non-obvious and should be documented with an inline comment.
   - Status: **Not addressed**.

### Minor
1. **`normalizedPath` passed into `handleFileWritten()`**
   - File: `extensions/workflow-monitor.ts`
   - Notes: thinking-phase write normalization changes the value passed to `handleFileWritten()`.
   - Status: **Not addressed**.

2. **Strike counter increments in non-interactive mode**
   - File: `extensions/workflow-monitor.ts`
   - Notes: escalation increments strikes even when `ctx.hasUI` is false (no prompt/override possible).
   - Status: **Not addressed**.

## Actions Taken From This Review
- Fixed the strict path allowlist edge case by normalizing `./docs/plans/...` → `docs/plans/...` and added a regression test.
- Removed an unnecessary `as any` cast in the boundary prompt `ui.select` call.

## Verification
- `npm test` (Vitest) passes: **24 files, 239 tests**.
