---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---

> **Related skills:** Write a failing test for the bug with `/skill:test-driven-development`. Verify the fix with `/skill:verification-before-completion`.

# Systematic Debugging

## Overview

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## When to Use

Use for ANY technical issue: test failures, bugs, unexpected behavior, performance problems, build failures, integration issues.

**Use this ESPECIALLY when:**
- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You've already tried multiple fixes
- Previous fix didn't work
- You don't fully understand the issue

**Don't skip when:**
- Issue seems simple (simple bugs have root causes too)
- You're in a hurry (rushing guarantees rework)

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

> **Read now:** [reference/red-flags.md](reference/red-flags.md) — the STOP list. Read before forming any fix.

**BEFORE attempting ANY fix:**

1. **Read Error Messages Carefully** — Don't skip past errors or warnings. Read stack traces completely. Note line numbers, file paths, error codes.

2. **Reproduce Consistently** — Can you trigger it reliably? What are the exact steps? If not reproducible → gather more data, don't guess.

3. **Check Recent Changes** — Git diff, recent commits, new dependencies, config changes, environmental differences.

4. **Gather Evidence in Multi-Component Systems** — For each component boundary: log what enters, what exits, verify config propagation. Run once to see WHERE it breaks, then investigate that component. See [reference/evidence-gathering.md](reference/evidence-gathering.md) for a worked multi-layer example.

5. **Trace Data Flow** — Where does the bad value originate? What called this with the bad value? Keep tracing up until you find the source. Fix at source, not at symptom. See `root-cause-tracing.md` for the complete technique.

### Phase 2: Pattern Analysis

1. **Find Working Examples** — Locate similar working code in same codebase.
2. **Compare Against References** — Read reference implementation COMPLETELY. Don't skim.
3. **Identify Differences** — List every difference, however small. Don't assume "that can't matter."
4. **Understand Dependencies** — What components, settings, config, environment does this need?

### Phase 3: Hypothesis and Testing

1. **Form Single Hypothesis** — State clearly: "I think X is the root cause because Y." Be specific, not vague.
2. **Test Minimally** — Make the SMALLEST possible change. One variable at a time. Don't fix multiple things at once.
3. **Verify Before Continuing** — Did it work? Yes → Phase 4. No → Form NEW hypothesis. DON'T add more fixes on top.

### Phase 4: Implementation

1. **Create Failing Test Case** — Use `/skill:test-driven-development` for writing proper failing tests. MUST have before fixing.

2. **Implement Single Fix** — ONE change at a time. No "while I'm here" improvements. No bundled refactoring.

3. **Verify Fix** — Test passes? No other tests broken? Issue actually resolved? Use `/skill:verification-before-completion` before claiming success.

4. **If Fix Doesn't Work:**
   - If < 3 attempts: Return to Phase 1, re-analyze with new information
   - **If ≥ 3 attempts: STOP (see below)**

> **Read now:** [reference/architecture-question.md](reference/architecture-question.md) — what 3+ failed fixes mean. Read before a 4th fix attempt.

## When Process Reveals "No Root Cause"

If investigation reveals issue is truly environmental, timing-dependent, or external:
1. Document what you investigated
2. Implement appropriate handling (retry, timeout, error message)
3. Add monitoring/logging for future investigation

**But:** 95% of "no root cause" cases are incomplete investigation.

## Supporting Techniques

These techniques are part of systematic debugging and available in this directory:

- **`root-cause-tracing.md`** — Trace bugs backward through call stack to find original trigger
- **`defense-in-depth.md`** — Add validation at multiple layers after finding root cause
- **`condition-based-waiting.md`** — Replace arbitrary timeouts with condition polling

## Reference material

- [reference/rationalizations.md](reference/rationalizations.md) — why investigation-first matters and the common excuses that lead to guessing.
- [reference/red-flags.md](reference/red-flags.md) — the STOP list: thoughts that mean stop and return to Phase 1.
- [reference/architecture-question.md](reference/architecture-question.md) — when 3+ fixes fail: why that signals a wrong architecture.
- [reference/evidence-gathering.md](reference/evidence-gathering.md) — worked multi-layer evidence-gathering example.
