# Workflow Tracker Design

**Date:** 2026-02-10
**Status:** Approved

## Problem

The 12 workflow skills in pi-superpowers-plus are powerful but disconnected. Users manually invoke each phase (brainstorm → plan → execute → verify → review → finish) and can easily skip steps or forget code review. There's no visibility into where you are in the overall flow.

## Solution

An informational workflow tracker that:
1. Shows current phase in a TUI widget
2. Prompts the user with next-step options at natural transition points
3. Offers fresh session handoff with artifact reference

## Phases

```
brainstorm → plan → execute → verify → review → finish
```

The tracker is **informational only** — no enforcement, no blocking. Phases can be skipped explicitly. Skipped phases show as `–` in the widget, completed as `✓`.

## Phase Detection

The tracker watches tool calls and skill invocations to infer the current phase. No manual tagging needed.

| Phase | Detected by |
|-------|------------|
| **brainstorm** | `/skill:brainstorming` used, or agent writes to `docs/plans/*-design.md` |
| **plan** | `/skill:writing-plans` used, or agent writes to `docs/plans/*-implementation.md` |
| **execute** | `/skill:executing-plans` or `/skill:subagent-driven-development` used, or `plan_tracker` initialized |
| **verify** | `/skill:verification-before-completion` used |
| **review** | `/skill:requesting-code-review` used, or subagent dispatched with review task |
| **finish** | `/skill:finishing-a-development-branch` used, or `git merge`/PR creation detected |

Phase transitions are forward-only but skippable. If you jump to `execute` without brainstorming, brainstorm and plan are marked as skipped.

## Transition Prompts

At natural boundaries (design doc committed, all plan tasks complete, verification passes, review completes), the agent uses the `question` tool to offer next steps:

```
──────────────────────────────────────────
 Design committed. What next?

> 1. Write the plan
  2. Fresh session → write the plan
  3. Skip
  4. Discuss
──────────────────────────────────────────
```

The 4-option pattern is consistent across all transitions:
1. **Next step** — proceed in current session
2. **Fresh session → next step** — start clean session with artifact reference
3. **Skip** — move on without this phase
4. **Discuss** — talk about it before deciding

The agent prompts **once per transition**. If the user skips, it doesn't nag.

## Transition Triggers

| Boundary | Prompt offers |
|----------|--------------|
| Design doc committed | Plan (or fresh → plan) |
| Plan complete (all plan_tracker tasks done) | Execute (or fresh → execute) |
| All plan tasks executed | Verify (or fresh → verify) |
| Verification passes | Review (or fresh → review) |
| Review completes | Finish (or fresh → finish) |

## Session Handoff

The "fresh session" option automates the manual workflow of copying an artifact path to a new session:

1. Starts a new session via `/workflow-next` command (uses `ctx.newSession()`)
2. Sends an opening message referencing the artifact file path and suggesting the next skill
3. New session starts clean — fresh context, no prior conversation

**Artifact reference, not content injection.** The new session gets a path like `docs/plans/2026-02-10-auth-design.md`. The agent reads it when needed. This keeps context clean, avoids staleness, and lets the agent read selectively.

Example kickoff message:
```
Continue from design: docs/plans/2026-02-10-auth-design.md
Use /skill:writing-plans to create the implementation plan.
```

### `/workflow-next` Command

```
/workflow-next <phase> [artifact-path]
```

Registered as an extension command. Starts a new session and sends the kickoff message.

## TUI Widget

Added to the existing workflow monitor widget line:

```
✓brainstorm → [plan] → execute → verify → review → finish  |  TDD: RED
```

- Current phase: highlighted (accent color)
- Completed phases: `✓` prefix (success color)
- Skipped phases: `–` prefix (dim)
- Future phases: dimmed text
- Hidden when no workflow is active (idle state)

## Question Tool

The `question` tool (from pi's examples) is bundled into the package. It renders a multi-choice prompt in the TUI and returns the user's selection to the agent. The agent uses it at transition points.

## Edge Cases

**No artifact found at transition.** Prompt still fires. Fresh session message notes no artifact was found and suggests reviewing the previous conversation.

**Multiple artifacts.** Handoff references the most recent relevant artifact for the next phase.

**User starts mid-flow.** Tracker picks up from wherever you are. Earlier phases marked as skipped. No setup ceremony.

**Session restarts.** State stored in tool result `details` (like plan_tracker). Reconstructed from session branch on `session_start`/`session_switch`/`session_fork`/`session_tree`.

**Compaction.** Workflow phase is lightweight metadata. Survives compaction because the last `workflow_transition` tool result in the branch has the full state.

## Implementation

### New Files

- `extensions/workflow-monitor/workflow-tracker.ts` — phase state machine, detection logic, artifact tracking
- `extensions/workflow-monitor/workflow-transitions.ts` — transition prompt content (which options for which phase)

### Modified Files

- `extensions/workflow-monitor.ts` — wire tracker to event hooks, register `/workflow-next` command, register `question` tool
- `extensions/workflow-monitor/workflow-handler.ts` — expose tracker state for widget rendering

### Event Hooks

Hooks into events already observed by the workflow monitor:

- `input` — detect `/skill:*` invocations before expansion
- `tool_call` — detect file writes to `docs/plans/`, `plan_tracker` init, git commands
- `tool_result` — detect plan completion, verification pass, review completion
- `agent_end` — fire transition prompt (natural pause, agent just finished)

### State Shape

```typescript
interface WorkflowTrackerState {
  phases: Record<Phase, "pending" | "active" | "complete" | "skipped">;
  currentPhase: Phase | null;
  artifacts: Record<Phase, string | null>;  // file paths
  prompted: Record<Phase, boolean>;         // already prompted for this transition
}
```

## Architecture

```
workflow-monitor.ts (entry point)
├── workflow-handler.ts (existing — TDD + debug + verification + tracker)
├── workflow-tracker.ts (NEW — phase state machine)
├── workflow-transitions.ts (NEW — transition prompt content)
├── tdd-monitor.ts (existing)
├── debug-monitor.ts (existing)
├── verification-monitor.ts (existing)
├── heuristics.ts (existing)
├── test-runner.ts (existing)
├── warnings.ts (existing)
├── investigation.ts (existing)
└── reference-tool.ts (existing)
```
