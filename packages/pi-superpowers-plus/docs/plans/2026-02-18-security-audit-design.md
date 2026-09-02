# v0.3.0 Hardening — Security, Subagent Lifecycle & Error Surfacing

**Date:** 2026-02-18
**Status:** Approved
**Scope:** Remaining v0.3.0 roadmap items — Security Audit, Subagent Hardening, Error Surfacing Review

---

## 1. Environment Variable Filtering

**Problem:** Subagent spawn passes `{ ...process.env }` to child processes, leaking all environment variables including secrets (API keys, database URLs, cloud credentials). Project-local agents from untrusted repos inherit everything in the parent shell.

**Fix:** Replace `{ ...process.env }` with a prefix-based allowlist plus an explicit set of known-safe variables.

**Allowlist prefixes:**
- `PI_` — pi-specific config
- `NODE_` — Node.js runtime
- `NPM_` — npm config
- `NVM_` — nvm config
- `LANG` — locale (matches `LANG` and `LANGUAGE`)
- `LC_` — locale categories
- `XDG_` — XDG base dirs

**Explicit vars:**
`PATH`, `HOME`, `SHELL`, `TERM`, `USER`, `LOGNAME`, `TMPDIR`, `EDITOR`, `VISUAL`, `SSH_AUTH_SOCK`, `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`

**Escape hatch:**
`PI_SUBAGENT_ENV_PASSTHROUGH` — comma-separated variable names to forward. Read from the parent `process.env` before filtering.

**Implementation:**
- New function `buildSubagentEnv()` in `extensions/subagent/env.ts`
- Iterates `Object.entries(process.env)`, keeps entries matching prefixes or explicit set
- Merges passthrough vars
- Adds `PI_TDD_GUARD_VIOLATIONS_FILE` per-invocation (already done, just uses the filtered env as base)

**Tests:**
- Includes PATH, HOME, PI_* vars
- Excludes AWS_SECRET_ACCESS_KEY, DATABASE_URL, etc.
- Passthrough override works
- Empty/missing passthrough var is a no-op

---

## 2. CWD Validation

**Problem:** If the LLM passes a nonexistent `cwd`, spawn throws a cryptic `ENOENT`.

**Fix:** Resolve and verify the directory exists before spawn. No path restrictions — subagents have the same permissions as pi and can `cd` anywhere via bash regardless.

```typescript
const resolved = path.resolve(cwd);
if (!fs.existsSync(resolved)) {
  throw new Error(`Subagent cwd does not exist: ${resolved}`);
}
```

**Tests:**
- Nonexistent cwd produces clear error message

---

## 3. Subagent Timeout & Kill

**Problem:** A stuck subagent runs forever with no way to stop it.

**Fix:** Configurable per-invocation timeout, default 10 minutes. When hit, the subagent process is killed and the invocation returns an error result.

- New config: `PI_SUBAGENT_TIMEOUT_MS` env var (default: `600000` / 10 min)
- Agent definitions can override via `timeout` field in agent YAML
- On timeout: `proc.kill('SIGTERM')`, wait 5s, then `SIGKILL` if still alive
- Return a clear error: `"Subagent timed out after 10 minutes"`

**Tests:**
- Timeout triggers kill after configured duration
- Agent-level override takes precedence over default
- Graceful SIGTERM → SIGKILL escalation

---

## 4. Cancellation Propagation

**Problem:** If the parent session is interrupted (user kills pi, ctrl+c), spawned subagents keep running as orphans.

**Fix:** Track active subagent processes and clean them up on extension teardown.

- Maintain a `Set<ChildProcess>` of active subagent processes
- On process exit/close, remove from the set
- Register a cleanup handler (extension `destroy` or `process.on('exit')`) that kills all active processes
- Use SIGTERM with the same 5s → SIGKILL escalation

**Tests:**
- Active processes tracked and removed on exit
- Cleanup kills remaining processes

---

## 5. Concurrent Subagent Cap

**Problem:** Unbounded parallel subagent spawns could exhaust API rate limits or model provider concurrency caps.

**Fix:** Simple semaphore — queue when the cap is hit, run when a slot opens.

- Default cap: `6` concurrent subagents
- Configurable via `PI_SUBAGENT_CONCURRENCY` env var
- When cap is hit, the invocation awaits a slot (no error, just waits)
- Log when queuing: `"Subagent queued — 6/6 slots in use"`

**Tests:**
- Respects configured cap
- Queued invocations run when slots free up
- Custom cap via env var

---

## 6. Error Surfacing — Silent Catch Blocks

**Problem:** Two catch blocks in `workflow-monitor.ts` silently swallow failures that change behavior.

**Catch 1 — State file read (line 74):**
State file read fails → falls through to session entries with no log. User doesn't know file-based persistence is broken.

**Fix:** Add `log.warn()` so it shows in the debug log:
```typescript
} catch (err) {
  log.warn(`Failed to read state file, falling back to session entries: ${err instanceof Error ? err.message : err}`);
}
```

**Catch 2 — State file write (line 152):**
State file write fails → silently drops persistence. User has no idea state won't survive restarts.

**Fix:** Add `log.warn()` + one-time `ctx.ui.notify()` so the user sees it:
```typescript
} catch (err) {
  log.warn(`Failed to persist state file: ${err instanceof Error ? err.message : err}`);
  // Notify once — repeated failures are common (e.g., read-only fs)
  if (!stateWriteWarned) {
    stateWriteWarned = true;
    ctx.ui.notify("⚠️ Workflow state file persistence failed — state may not survive restarts");
  }
}
```

**All other catch blocks (11 total):** Already log via `log.debug` or `log.warn`. No changes needed.

**Tests:**
- State read failure logs warning and falls back to session entries
- State write failure logs warning and notifies user once

---

## Summary

| Item | Lines of code (est.) | Files touched |
|------|---------------------|---------------|
| Env filtering | ~40 | `extensions/subagent/env.ts` (new), `extensions/subagent/index.ts` |
| CWD validation | ~5 | `extensions/subagent/index.ts` |
| Timeout & kill | ~40 | `extensions/subagent/index.ts` |
| Cancellation propagation | ~25 | `extensions/subagent/index.ts` |
| Concurrent cap | ~35 | `extensions/subagent/index.ts` |
| Silent catch fixes | ~10 | `extensions/workflow-monitor.ts` |
| Tests | ~120 | `tests/extension/subagent/`, `tests/extension/` |
| **Total** | **~275** | |
