# Fail-Closed Agent Dispatch: `fallbackSubagent: "none"` + `strictAgentFiles` — Design Spec

**Date:** 2026-09-11
**Source:** Harden the superpowers setup docs/config for the copy-in agent types
(`implementer`, `task-reviewer`, `code-reviewer`): recommend `fallbackSubagent: "none"`
so a typo'd `subagent_type` fails closed with an error instead of silently running
`general-purpose` (unconstrained tools), and document `strictAgentFiles` (fail startup on
a broken agent file instead of skipping). Verify the three SDD agent template names are
wrapped by this and note the tradeoff (fail-loud vs lenient) in README.

## Motivation

Subagent dispatch is provided by [`@tintinweb/pi-subagents`](../../../../pi-subagents/),
which already implements both settings natively:

- **`fallbackSubagent`** (default `general-purpose`, permissive): the agent used when a
  caller-supplied `subagent_type` doesn't resolve to exactly one enabled agent — unknown,
  disabled, or ambiguous because two agents differ only by case. The value `"none"` (or
  the boolean `false`, which would otherwise be dropped as the wrong type) makes dispatch
  **fail closed**: the call is refused with an error listing the available types, and
  nothing spawns.
- **`strictAgentFiles`** (default `false`): when on, an unreadable or unparseable agent
  file aborts extension load at startup and names the file, instead of being skipped with
  a warning — so a checked-in `.pi/agents/` can't silently fall through to a same-named
  agent from another location.

Today these knobs exist in pi-subagents (README + CHANGELOG + wiring tests), but the
superpowers package never surfaces them: its Install section says *"No other
configuration required."* right after telling users to copy the agent templates. The
default permissive behavior is a real hazard for this package's agent set:

- A typo'd dispatch name (e.g. `implementor`) silently runs `general-purpose` — an
  unconstrained-tools agent — instead of failing. For the read-only reviewers
  (`code-reviewer` / `task-reviewer` restricted to `read, bash, find, grep, ls`), this is
  a silent tool-policy escalation before the caller learns anything, worst for background
  and scheduled calls.
- With `disableDefaultAgents` and no own `general-purpose`, an unresolvable type still
  resolves to a built-in config carrying *all* tools — the README calls this out as the
  reason to set `none`.

## Goals

1. Users who follow the superpowers Install docs end up with fail-closed dispatch: a
   typo'd or unknown `subagent_type` errors instead of silently substituting a
   general-purpose agent.
2. `strictAgentFiles` is documented and recommended, so a broken template copy can't
   silently fall through to a same-named agent elsewhere.
3. A structural guard proves the three SDD agent names (`implementer`, `task-reviewer`,
   `code-reviewer`) and the fourth template (`worker`) are each backed by a shipped
   template — so the fail-closed claim can't drift as the skills evolve.
4. The README states the tradeoff (fail-loud vs lenient) explicitly.

## Approach

### 1. Shipped example configs — `config-examples/`

Two new files in the package, mirroring the Install doc's existing pick-one template copy
(global `~/.pi/agent/agents/` vs project-local `.pi/agents/`):

- **`config-examples/subagents.global.json`** — for `~/.pi/agent/subagents.json`
  (machine-wide defaults)
- **`config-examples/subagents.project.json`** — for `<cwd>/.pi/subagents.json`
  (per-project overrides)

Both carry the same content (the settings are location-independent):

```json
{
  "fallbackSubagent": "none",
  "strictAgentFiles": true
}
```

- `fallbackSubagent: "none"` → strict fail-closed dispatch: any type that doesn't resolve
  to exactly one enabled agent is refused with an error listing the available types.
  `general-purpose` remains dispatchable when called by its own name.
- `strictAgentFiles: true` → an unreadable/unparseable agent file aborts extension load at
  startup, naming the file. Startup only: mid-session reloads (one per `Agent` call) keep
  warning, since a bad edit shouldn't kill the session on an unrelated spawn.

Add `config-examples/` to `package.json` `files` so the npm package ships them. When
editing these files by hand, remember JSON has no comments; explanations live in README.

### 2. README changes

1. **Install section** — replace "No other configuration required." with a
   "Recommended: fail-closed dispatch" block: after copying the templates, copy the
   matching example config to `~/.pi/agent/subagents.json` (global) or
   `.pi/subagents.json` (project) — same pick-one structure as the template copy block
   above it — with one-line explanations of the two settings.
2. **Tradeoff note (fail-loud vs lenient)** — new paragraph in the Agent Templates /
   Subagent Dispatch area: with `fallbackSubagent: "none"`, the SDD agents dispatch by
   exact name only — a typo or an un-copied template makes the call fail loudly with the
   available-type list instead of silently substituting an all-tools agent. That's the
   point for the read-only reviewers; the cost is that any custom agent must be copied
   before dispatch works, and a missing template is a hard error rather than a fallback.
3. Point at `/agents → Settings → Fallback agent` and `Strict agent files` as the UI
   alternative (both settable there as well).

### 3. Structural guard — `scripts/agent-dispatch-guard.test.mjs`

Follows the `named-agents.test.mjs` pattern (plain node script, `assert`, exit 1 on
failure, wired into `npm test`):

1. **Membership guard** — scan `skills/**` (md + js) for `subagent_type: "X"` /
   `agentType: 'X'` literals, collect distinct names, exclude built-ins
   (`general-purpose`, `Explore`, `Plan`), and assert every remaining name has a matching
   `agent-templates/<name>.md`. This pins the four shipped templates against the skill
   dispatch sites (`implementer`, `task-reviewer`, `code-reviewer`, `worker`) so the
   fail-closed claim can't drift.
2. **Config guard** — assert both `config-examples/*.json` parse and carry exactly
   `fallbackSubagent: "none"` + `strictAgentFiles: true`, and that the two files are
   byte-identical (they differ only by install location).

## Tradeoffs

- **Fail-loud vs lenient.** Strict mode converts silent substitution into hard errors.
  Fail-loud is the safe default for this package: the reviewers must not gain tools on a
  typo. The cost is operational friction — any newly added custom agent must be copied
  (or the global config extended) before dispatch works. The package's own `worker` and
  the three SDD agents are all covered by shipped templates, so out of the box nothing is
  refused.
- **Two example files to keep in sync.** Contents are identical today and expected to stay
  identical (both settings are location-independent); the byte-identical assertion in the
  guard makes divergence a test failure rather than a silent doc drift.
- **Documentation only, no code in pi-subagents.** The knobs already exist upstream with
  their own wiring tests; this package only surfaces and guards them.

## Out of Scope

- Changing pi-subagents behavior (upstream-tracked subtree — no hand-edits).
- `disableDefaultAgents` recommendations (orthogonal setting, not required for
  fail-closed dispatch once `fallbackSubagent: "none"` is set).
- Verifying resolution at runtime in this package's tests (pi-subagents runtime isn't a
  dependency here; wiring is covered upstream).
