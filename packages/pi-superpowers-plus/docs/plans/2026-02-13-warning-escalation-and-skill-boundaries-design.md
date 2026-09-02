# Warning Escalation & Skill Boundary Enforcement

**Date:** 2026-02-13  
**Status:** Design

## Problem

The workflow monitor injects warnings into tool results when the agent violates guardrails (TDD, branch safety, phase skipping). However, agents can and do ignore these warnings entirely — editing code repeatedly despite multiple ⚠️ messages. The skills themselves also lack explicit boundaries about what actions are in/out of scope for each phase.

Additionally, several existing enforcement mechanisms are broken or incomplete:
- `ui.select` prompts display `[object Object]` instead of readable choices
- The verify gate fires on `git commit` even during brainstorming (e.g., committing a design doc)
- No distinction between writing docs and writing code during thinking phases

---

## How Skills and Oversight Work Together

The enforcement model has two layers: **skills** guide the agent's behavior, and the **workflow monitor extension** catches violations when the agent ignores that guidance. They serve different purposes and reinforce each other.

### Layer 1: Skills (Agent Self-Governance)

Skills are markdown instructions loaded on-demand when the agent enters a workflow phase. They define what the agent *should* do — and critically, what it should *not* do. Each skill contains:

- **Purpose and process** — what the phase is for, step-by-step instructions
- **Boundaries** — what actions are in/out of scope for this phase
- **Warning respect** — instructions to stop if a workflow warning appears in tool output

Skills are the primary guardrail. A well-written skill prevents most violations before they happen, because the agent follows the instructions. The goal is that the extension rarely needs to intervene.

### Layer 2: Workflow Monitor Extension (Safety Net)

The extension runs continuously, observing every tool call and result. It does NOT rely on the agent reading or following skill instructions. It independently enforces rules by:

1. **Detecting violations** — inspecting file paths, tool names, git commands, and workflow phase state
2. **Injecting warnings** — appending ⚠️ messages to tool results so the agent sees them
3. **Escalating to hard blocks** — on repeated violations, preventing the action entirely and prompting the user

The extension is the backstop. It catches the cases where the agent ignores, misinterprets, or never loaded the relevant skill.

### How They Interact

```
Agent receives task
    │
    ▼
Skill loaded ──────────────────── Skill says: "Don't edit code in this phase"
    │
    ▼
Agent follows skill ─── ✅ ────── No violation. Extension stays silent.
    │
    ▼
Agent ignores skill ─── ⚠️ ────── Extension detects violation, injects warning.
    │                              Agent sees warning in tool result.
    │
    ▼
Agent heeds warning ─── ✅ ────── Agent self-corrects. Count stays at 1.
    │
    ▼
Agent ignores warning ── 🛑 ───── Extension hard-blocks the action.
                                   User prompted: allow or stop?
```

This creates defense in depth:
- **Most of the time**, the skill prevents the violation entirely (the agent never tries)
- **Occasionally**, the agent slips and the warning redirects it
- **Rarely**, the agent ignores everything and the hard block protects the user

The user always has final say. A hard block can be overridden — the system trusts the human, not the agent.

---

## Design

### 1. Phase-Aware File Write Enforcement

The extension must distinguish between legitimate file writes and violations based on the current workflow phase.

**During brainstorm and plan phases**, the only permitted file writes are to `docs/plans/`. Any other file write — source code, test files, config — is a process violation.

| Current Phase | File Path | Result |
|---------------|-----------|--------|
| brainstorm | `docs/plans/*.md` | ✅ Allowed |
| brainstorm | `extensions/foo.ts` | ❌ Process violation |
| brainstorm | `tests/foo.test.ts` | ❌ Process violation |
| plan | `docs/plans/*.md` | ✅ Allowed |
| plan | `src/bar.ts` | ❌ Process violation |
| execute+ | any | Governed by TDD/practice rules |

**Verify gate on `git commit`** only fires when the workflow has reached or passed the `execute` phase. Committing a design doc during brainstorming does not trigger the verify check.

### 2. Skill Boundaries — "Thinking" Phase Skills

Add a concise **Boundaries** section to skills where the agent should not be writing code:

**brainstorming, writing-plans:**

```
## Boundaries
- Read code and docs: yes
- Write to docs/plans/: yes
- Edit or create any other files: no
```

**verification-before-completion:**

```
## Boundaries
- Run verification commands: yes
- Read code and output: yes
- Edit source code: no
```

### 3. Skill Prerequisites — "Doing" Phase Skills

Add a **Prerequisites** note to implementation skills:

**test-driven-development, executing-plans, subagent-driven-development:**

```
## Prerequisites
- Active branch (not main) or user-confirmed intent to work on main
- Approved plan or clear task scope
```

### 4. Warning Respect — "Doing" Phase Skills Only

Add one line to skills where the agent is actively coding and may encounter warnings:

**test-driven-development, executing-plans, subagent-driven-development, systematic-debugging, verification-before-completion:**

```
If a tool result contains a ⚠️ workflow warning, stop immediately and address it before continuing.
```

This line is not needed on thinking-phase skills because their boundaries already prevent the actions that trigger warnings.

### 5. Extension Escalation — Two-Bucket Strike Counter

#### Violation Categories

**Process violations** — the agent skipped the workflow:
- Writing files outside `docs/plans/` during brainstorm or plan phase
- Writing to main branch without confirmation
- Jumping to implementation without a plan

**Practice violations** — the agent is coding incorrectly:
- TDD violation (production code before a failing test)
- Debug violation (guessing fixes without investigation)
- Verification violation (claiming success without evidence)

#### Escalation Behavior

**First violation in a bucket:** Soft warning injected into tool result (current behavior). The action still succeeds. Counter increments to 1.

**Second violation in same bucket:** Hard block. The action is prevented. A `ui.select` prompt is shown to the user:

> "The agent has repeatedly violated [process/practice] guardrails. Allow it to continue?"
> - Yes, continue
> - No, stop

If the user selects "Yes, continue," the counter resets and the agent proceeds. If "No, stop," the action stays blocked.

#### Counter Scope

- Counters are **per-session** (reset on new session)
- Each bucket (process, practice) is tracked independently
- User override resets that bucket's counter only

### 6. Fix ui.select Bug

All current `ui.select` calls pass `{ label, value }` objects instead of plain strings, causing `[object Object]` to render as choices. The pi API expects `ctx.ui.select("prompt", ["Option A", "Option B"])` and returns the selected string.

Fix all 7 call sites in `workflow-monitor.ts` to pass string arrays and map the returned label string back to the intended action value.

---

## Skills Affected

| Skill | Changes |
|-------|---------|
| brainstorming | Add Boundaries section |
| writing-plans | Add Boundaries section |
| verification-before-completion | Add Boundaries section + warning respect line |
| test-driven-development | Add Prerequisites + warning respect line |
| executing-plans | Add Prerequisites + warning respect line |
| subagent-driven-development | Add Prerequisites + warning respect line |
| systematic-debugging | Add warning respect line |
| dispatching-parallel-agents | No change (already well-guarded) |
| finishing-a-development-branch | No change (already has verification gates) |
| receiving-code-review | No change (already has "STOP" instruction) |
| requesting-code-review | No change |
| using-git-worktrees | No change |

## Documentation Updates

The oversight model is a core part of this project's value proposition and needs to be clearly documented for users.

### README.md

Update the README to reflect the two-layer enforcement model. The current "What You Get" section describes warnings and gates but doesn't explain the skill boundary system or the escalation behavior. Add:

- A brief explanation of how skills and the extension work together (the defense-in-depth concept)
- The escalation path: skill boundaries → soft warning → hard block → user override
- Phase-aware enforcement: thinking phases restrict file writes to `docs/plans/`

### docs/ (new)

Create user-facing documentation outside of `docs/plans/` to explain the oversight system in detail. Candidates:

- `docs/oversight-model.md` — full explanation of the two-layer system, violation categories, escalation behavior, and how the user interacts with hard blocks
- `docs/workflow-phases.md` — what each phase permits, what gates exist, how phases transition (currently only captured implicitly in code and scattered across plan files)

These docs should be written for someone installing the package and wanting to understand what it enforces and why — not implementation notes for contributors.

### Sequencing

Documentation updates should happen **after** implementation is complete, not during. The implementation may surface edge cases or design adjustments that would require rewriting docs. Write the docs once, against the final behavior.

## Out of Scope

- Shared skill includes (pi skills are self-contained; each gets its own copy of boundary text)
- Cross-session violation tracking (counters reset per session)
- Changes to the workflow phase model itself
