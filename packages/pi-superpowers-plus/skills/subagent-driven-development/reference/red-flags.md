## When a Subagent Fails

**You are the orchestrator. You do NOT write code. You dispatch subagents that write code.**

If an implementer subagent fails, errors out, or produces incomplete work:

1. **Attempt 1:** Dispatch a NEW fix subagent with specific instructions about what went wrong and what needs to change. Include the error output and the original task text.
2. **Attempt 2:** If the fix subagent also fails, dispatch one more with a different approach or simplified scope.
3. **After 2 failed attempts: STOP.** Report the failure to the user and ask how to proceed. The task likely needs redesign.

**NEVER:**
- Write code yourself to "help" or "finish up" — you are the orchestrator, not an implementer
- Try to fix the subagent's work inline — this pollutes your context and defeats the fresh-subagent model
- Silently skip the failed task and move on
- Reduce quality gates (skip reviews) because a task is "almost done"

## Red Flags

**Never:**
- Start implementation on main/master branch without explicit user consent
- Skip the task review (spec + quality)
- Proceed with unfixed issues that are neither fixed nor parked-with-ruling
- Dispatch multiple implementation subagents in parallel (conflicts) — the sanctioned exception is a scheduled wave of DISJOINT-file tasks via `scripts/wave-parallel.js`; never free-form parallel `Agent` dispatch
- Make a subagent read more than its own task bead (hand it the whole plan / molecule tree)
- Skip scene-setting context (subagent needs to understand where task fits)
- Ignore subagent questions (answer before letting them proceed)
- Accept "close enough" on spec compliance
- Skip review loops (reviewer found issues = implementer fixes = re-review)
- Let implementer self-review replace the task review (both are needed)
- Move to the next task while the review has open Critical/Important issues
- Pre-judge findings for a reviewer ("do not flag", "at most Minor")
- Silently discard a finding — every adjudication is a ledger entry
- Fix findings yourself in the controller session
- Re-dispatch a completed task from memory because the controller lost its report — query the finished implementer by its canonical handle (Setup · Second recovery path: @handle) or trust the ledger first
- Emulate workflows with parallel `Agent` dispatch when `SubagentWorkflow` is absent (the fallback is the sequential loop, not fake parallelism)
