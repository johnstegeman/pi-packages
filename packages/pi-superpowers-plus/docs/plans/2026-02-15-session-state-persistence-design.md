# Session State Persistence — Design Spec

**Date:** 2026-02-15
**Milestone:** v0.3.0
**Status:** Ready for implementation

## Problem

Three monitors use in-memory-only state that resets on session restore, fork, and tree navigation:

| Component | Lost state | User impact |
|-----------|-----------|-------------|
| **TddMonitor** | `phase`, `testFilesWritten`, `sourceFilesWritten`, `redVerificationPending` | TDD cycle resets to idle on `/resume` or `/fork` — loses RED/GREEN tracking mid-session |
| **DebugMonitor** | `active`, `investigated`, `fixAttempts` | Debug mode resets — loses "fix without investigation" tracking |
| **VerificationMonitor** | `verified`, `verificationWaived` | Verification status resets — could re-gate a commit that was already verified |

Additionally, WorkflowTracker uses its own `appendEntry` type (`WORKFLOW_TRACKER_ENTRY_TYPE`) while plan-tracker uses tool result `details`. The monitors and tracker should share a single combined snapshot entry.

There is also a skill detection gap: when the LLM reads a skill file via the `read` tool (rather than the user typing `/skill:name`), the workflow tracker does not detect the phase change.

## Scope

**In scope:**
- Persist TDD, Debug, and Verification monitor state via `appendEntry`
- Reconstruct all three on session events from branch history
- Unify with WorkflowTracker into a single combined snapshot entry type
- Detect skill file reads via the `read` tool as phase transitions
- Extract `SKILL_TO_PHASE` as a shared constant

**Out of scope:**
- No changes to plan-tracker (already correct — stores in tool result `details`)
- No new user commands (Future: `/superpowers`)
- No changes to monitor detection logic or violation rules

## Design

### 1. Combined state snapshot

Single entry type `superpowers_state` replaces `WORKFLOW_TRACKER_ENTRY_TYPE`:

```typescript
interface SuperpowersStateSnapshot {
  workflow: {
    phase: Phase;
    phaseHistory: PhaseHistoryEntry[];
  };
  tdd: {
    phase: TddPhase;
    testFilesWritten: string[];  // serialized from Set
    sourceFilesWritten: string[];  // serialized from Set
    redVerificationPending: boolean;
  };
  debug: {
    active: boolean;
    investigated: boolean;
    fixAttempts: number;
  };
  verification: {
    verified: boolean;
    verificationWaived: boolean;
  };
}
```

### 2. Monitor API changes

Each monitor gets `getState()` and `setState()`:

**TddMonitor** (`tdd-monitor.ts`):
- `getState()` → returns snapshot (Sets serialized to arrays)
- `setState(s)` → restores fields (arrays converted back to Sets)

**DebugMonitor** (`debug-monitor.ts`):
- `getState()` → returns `{ active, investigated, fixAttempts }`
- `setState(s)` → restores all three

**VerificationMonitor** (`verification-monitor.ts`):
- `getState()` → returns `{ verified, verificationWaived }`
- `setState(s)` → restores both

**WorkflowTracker** (`workflow-tracker.ts`):
- Existing `getWorkflowState()` renamed/aliased to `getState()` for consistency
- Existing `reconstructFromBranch()` replaced by `setState(s)` accepting snapshot directly

**WorkflowHandler** (`workflow-handler.ts`):
- Add `getFullState(): SuperpowersStateSnapshot` — aggregates all four monitors
- Add `setFullState(s: SuperpowersStateSnapshot)` — distributes to all four
- Remove `resetState()` (replaced by `setFullState` or reconstruction)

### 3. Persistence wiring

New helper in `workflow-monitor.ts`:

```typescript
function persistState(pi: ExtensionAPI, handler: WorkflowHandler) {
  pi.appendEntry("superpowers_state", handler.getFullState());
}
```

Called after every state mutation. Replaces existing `pi.appendEntry(WORKFLOW_TRACKER_ENTRY_TYPE, ...)` calls. Additional call sites:
- TDD phase transitions (`tdd.onTestResult`, `tdd.onSourceFileWritten`)
- Debug mode changes (`debug.onFailure`, `debug.onInvestigation`, `debug.onCommit`)
- Verification changes (`verification.onVerify`, `verification.onWaive`, `verification.onCommit`)

### 4. Reconstruction wiring

Replaces `handler.resetState()` in all four session event handlers (`session_start`, `session_switch`, `session_fork`, `session_tree`):

```typescript
function reconstructState(ctx: ExtensionContext, handler: WorkflowHandler) {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === "superpowers_state") {
      handler.setFullState(entry.data);
      return;
    }
    // Migration fallback: old-format workflow-only entries
    if (entry.type === "custom" && entry.customType === WORKFLOW_TRACKER_ENTRY_TYPE) {
      handler.setFullState({
        workflow: entry.data,
        tdd: TDD_DEFAULTS,
        debug: DEBUG_DEFAULTS,
        verification: VERIFICATION_DEFAULTS,
      });
      return;
    }
  }
  handler.setFullState(FRESH_DEFAULTS);
}
```

### 5. Skill file read detection

Extract shared constant from `onInputText` inline mapping:

```typescript
export const SKILL_TO_PHASE: Record<string, Phase> = {
  brainstorming: "brainstorm",
  "writing-plans": "plan",
  "executing-plans": "execute",
  "subagent-driven-development": "execute",
  "verification-before-completion": "verify",
  "requesting-code-review": "review",
  "finishing-a-development-branch": "finish",
};
```

New method on WorkflowTracker:

```typescript
onSkillFileRead(path: string): boolean {
  // Match */skills/<name>/SKILL.md
  const match = path.match(/\/skills\/([^/]+)\/SKILL\.md$/);
  if (!match) return false;
  const phase = SKILL_TO_PHASE[match[1]];
  if (!phase) return false;
  return this.advanceTo(phase);
}
```

Refactor `onInputText` to use `SKILL_TO_PHASE` instead of its inline if-else chain.

Wire in `workflow-monitor.ts` inside the existing `tool_result` handler for `read`:

```typescript
if (event.toolName === "read") {
  const path = event.input?.path ?? "";
  handler.handleSkillFileRead(path);  // new
  handler.handleReadOrInvestigation("read", path);  // existing
}
```

### 6. Ephemeral state (no change)

These fields correctly reset on session events — no persistence needed:
- `sessionAllowed`, `strikes` — UI gating, per-session
- `branchNoticeShown`, `branchConfirmed` — one-time notices

## Files changed

| File | Change |
|------|--------|
| `extensions/workflow-monitor/tdd-monitor.ts` | Add `getState()` / `setState()` |
| `extensions/workflow-monitor/debug-monitor.ts` | Add `getState()` / `setState()` |
| `extensions/workflow-monitor/verification-monitor.ts` | Add `getState()` / `setState()` |
| `extensions/workflow-monitor/workflow-tracker.ts` | Extract `SKILL_TO_PHASE`, add `onSkillFileRead()`, refactor `onInputText`, rename `getWorkflowState` → `getState`, add `setState()` |
| `extensions/workflow-monitor/workflow-handler.ts` | Add `getFullState()` / `setFullState()`, add `handleSkillFileRead()`, remove `resetState()` |
| `extensions/workflow-monitor.ts` | Add `persistState()` / `reconstructState()`, wire persist calls at mutation sites, wire reconstruct calls in session events, wire skill file read detection in `tool_result` |

## Test plan

New test file: `tests/workflow-monitor/state-persistence.test.ts`

**Snapshot round-trip (unit):**
- Each monitor's `getState()` → `setState()` round-trips correctly (TDD Sets survive serialization as arrays)
- `handler.getFullState()` aggregates all four monitors
- `handler.setFullState()` distributes to all four monitors
- `setFullState` with partial/missing fields falls back to defaults (defensive)

**Persistence triggers (integration):**
- TDD phase transition calls `persistState`
- Debug mode activation calls `persistState`
- Verification waive/verify calls `persistState`
- Workflow phase advance calls `persistState`

**Reconstruction (integration):**
- Reconstruct from `superpowers_state` entry restores all monitor state
- Reconstruct from old `WORKFLOW_TRACKER_ENTRY_TYPE` entry restores workflow, defaults the rest
- No entries → fresh defaults
- Multiple entries → last one wins
- Reconstruction runs on all four session events (start/switch/fork/tree)

**Skill file read detection (unit):**
- `read` of `*/skills/brainstorming/SKILL.md` → advances to brainstorm phase
- `read` of `*/skills/writing-plans/SKILL.md` → advances to plan phase
- `read` of non-skill file → no phase change
- `SKILL_TO_PHASE` shared between `onInputText` and `onSkillFileRead`

**Existing tests:** No changes expected — monitor detection logic is unchanged.

## Migration

Old `WORKFLOW_TRACKER_ENTRY_TYPE` entries in saved sessions are handled by the reconstruction fallback. Workflow state reconstructs from old entries; monitor state defaults (same as today, no regression). New sessions produce `superpowers_state` entries only.
