# SDD Subagent Dispatch Hardening — Design Spec

**Date:** 2026-09-14
**Source:** bead `pi-packages-3iej.6` — "SDD subagent dispatch hardening: reviewer
pinning, read-only verifiers, fail-loud args" (findings M5, M6, M7, M9).
**Constraint:** `packages/pi-subagents` is an upstream subtree. This spec changes only
our own scripts, agent templates, prompt templates, config examples, and tests — never
the subtree.

## Motivation

The SDD (subagent-driven-development) flow dispatches reviewers and verifiers through two
different paths: the plain `Agent` tool (controller-side, direct dispatch) and
`SubagentWorkflow` scripts (`final-review.js`, `fix-loop.js`, `wave-parallel.js`). Four
gaps were found in that dispatch layer:

- **M5 — silent args degradation.** All three workflow scripts normalize their `args`
  with `try { … JSON.parse … } catch { parsedArgs = null }` and then fall back to `{}`.
  A malformed or missing payload runs the workflow against `undefined` inputs
  (`final-review.js` reviews a `undefined..undefined` range; `wave-parallel.js` no-ops
  with an empty wave) instead of failing. This is the same failure class recorded in
  `pi-packages-1fjq` ("finders self-served the diff").
- **M6 — unpinned reviewers.** `agent-templates/task-reviewer.md` and `code-reviewer.md`
  carry only `description`/`tools`/`allowed_subagents`. No `thinking`, no finite
  `max_turns`; a reviewer can run unbounded. `config-examples/*.json` do not set
  `scopeModels`, so a runtime `Agent({ model })` choice can silently spawn off-allowlist.
- **M7 — write-capable verifiers.** `final-review.js` spawns refuters as
  `agentType: 'general-purpose'` (write/edit capable) over model-produced finding text,
  while the shipped reviewers are deliberately read-only.
- **M9 — inert `allowed_subagents`.** `task-reviewer.md` and `code-reviewer.md`
  advertise a nested `Explore` child, but nested delegation is built only on the direct
  `Agent` path (`pi-subagents/src/agent-manager.ts:800`); it is unavailable on every
  `SubagentWorkflow` path, so the claim is misleading exactly where `code-reviewer` is
  most often used.

## Goals

1. Workflow scripts fail loud on malformed or missing `args` (M5).
2. Reviewer/verifier templates pin `thinking` and a finite `max_turns`; config examples
   enable `scopeModels` (M6).
3. Verification runs read-only (M7).
4. The nested-delegation claim is documented as direct-dispatch-only (M9).
5. `cd packages/pi-superpowers-plus && npm test` is green.

## Non-goals

- No change to the `packages/pi-subagents` subtree. The two durable fixes that would live
  there are tracked by a separate upstream-control bead (see "Upstream tracking").
- No schema-based structured output on the sequential task-review path (bead's optional
  item) and no re-routing of the sequential review through a workflow. Deferred.
- No hard sandbox for "read-only" agents — read-only remains a tool-surface +
  instruction boundary, not a security boundary (`bash` can always write).

## Design

### M5 — Fail-loud `args`

Each of the three workflow scripts runs in a `vm` sandbox with no imports and no
filesystem, so the guard is **inlined independently** in each (identical shape):

```js
function failArgs(message) {
  throw new Error('<script-name>: ' + message)
}
let parsed = args
if (typeof args === 'string') {
  try { parsed = JSON.parse(args) }
  catch (e) { failArgs('args was a JSON string but did not parse: ' + e.message) }
}
if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
  failArgs('args must be an object; got ' +
    (parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed))
}
const ARGS = parsed
```

Per-script required fields (missing/blank → throw), except `fix-loop`:

| Script | Required fields | Bad-args behavior |
|---|---|---|
| `final-review.js` | string `base`, `head`, `packagePath`, `gateBeadId` (`description` defaults `''`; `dimensions`/`findingsFile` optional) | throw |
| `wave-parallel.js` | `base`, `reportDir`, `gateBeadId`, `reviewPackage`, and a **non-empty array** `wave` whose entries each carry `taskBeadId` | throw |
| `fix-loop.js` | `taskBeadId`, `reportFilePath`, `findings`, `gate`, `fixBase`, `head`, `gateBeadId`, `reviewPackage` | malformed string → **throw**; missing fields → existing structured `{ passed: false, reason: 'bad-args', … }` envelope |

Rationale for the asymmetry: the controller already branches on `fix-loop`'s `bad-args`
envelope as a normal adjudication path, whereas a malformed payload is a caller bug in
all three. `final-review`'s throw lands on SKILL.md's documented "run error → fall back
to the single-reviewer path"; SKILL.md gains one analogous line for `wave-parallel`
(run error → fall back to sequential per-task dispatch).

### M6 — Reviewer pinning + config

Frontmatter additions (existing keys unchanged, `model:` deliberately unpinned):

| Template | `thinking` | `max_turns` |
|---|---|---|
| `agent-templates/task-reviewer.md` | `medium` | `40` |
| `agent-templates/code-reviewer.md` | `medium` | `60` |
| `agent-templates/verifier.md` (new) | `medium` | `25` |

`max_turns` values are derived from real subagent session logs: task-reviewer p99 38,
code-reviewer p90 36 / p99 75, refuter p99 20 / max 41. Each bound sits between the p90
and the extreme tail, so it clips only rare outliers; pi enforces the cap gracefully (a
"wrap up now" steer at the limit plus grace turns).

Both `config-examples/subagents.global.json` and `subagents.project.json` become:

```json
{ "fallbackSubagent": "none", "strictAgentFiles": true, "toolDescriptionMode": "compact", "scopeModels": true }
```

They must stay byte-identical. `scopeModels: true` makes an out-of-scope runtime
`Agent({ model })` choice a hard error for reviewers/verifiers.

### M7 — Read-only verifier

New `agent-templates/verifier.md`:

```markdown
---
description: "Adversarial verifier: read-only refutation of a single finding (read-only)"
tools: read, bash, find, grep, ls
thinking: medium
max_turns: 25
---

You are an adversarial verifier. You are given ONE finding from a review and
must try to refute it. Default to refuted when the evidence is ambiguous.

## Boundaries
- Read code, run git commands, read the review package: yes
- Edit, create, or delete any files: NO
- If a finding is testable, reproduce it before accepting it; a claim you
  could not reproduce is `isReal: false` unless the code plainly shows it.

## Method
- Locate the exact file:line in the diff and read the surrounding context.
- Ask what would have to be true for the reviewer's claim to be false, then
  check that. Do not accept the finding because it sounds plausible.
- If you cannot read the artifact the finding refers to, return
  `isReal: false` with a reason naming what was missing.

The caller supplies a schema; return exactly that object.
```

`final-review.js` changes the refuter dispatch (`:204`) from
`agentType: 'general-purpose'` to `agentType: 'verifier'` (keeps
`schema: VERDICT_SCHEMA`, label, phase). The JSONL writer child (`:251`) **stays
`general-purpose`** — it must write the findings file.

### M9 — Conditional nested-lookup caveat

`allowed_subagents: Explore` is kept in both reviewer frontmatters (real on direct
dispatch). The prose that promises a nested `Explore` child is conditionalized in all
four places — `agent-templates/task-reviewer.md`, `agent-templates/code-reviewer.md`,
`skills/subagent-driven-development/task-reviewer-prompt.md`,
`skills/subagent-driven-development/re-review-prompt.md` — with the substance:

> **Direct dispatch only.** When this agent is dispatched directly with the `Agent`
> tool, you may dispatch **one nested `Explore` child per named question** you cannot
> answer from the diff alone … **Under `SubagentWorkflow`, the nested `Agent` tool is
> not available** — the workflow path exposes no nested delegation. Do not attempt to
> delegate there; report the item as `⚠️ Cannot verify` instead.

The existing capability sentence, the one-child bound, and each file's existing fallback
wording stay. Only the shared condition sentence `Under `SubagentWorkflow` the nested
`Agent` tool is not available` is added identically across all four files (caveat wording
parity); the surrounding fallback phrasing intentionally differs per file.
fallback stay; only the availability condition is added, identically across all four
files.

## Testing

Behavioral tests use the existing `run-workflow.mjs` vm harness (a top-level `throw`
surfaces as a rejected promise):

- `final-review.test.mjs` — malformed-string args reject with `/final-review.*did not
  parse/`; `args: {}` rejects naming `base`; one case per required field. Existing
  happy-path cases already pass all required fields.
- `wave-parallel.test.mjs` — missing/non-array/empty `wave` rejects naming `wave`.
- `fix-loop.test.mjs` — malformed string rejects; `args: {}` still resolves to the
  structured `bad-args` envelope; expand coverage to each required field.
- `agent-dispatch-guard.test.mjs` — config `deepEqual` gains `scopeModels: true`;
  `verifier` added to the covered-templates list; refuter dispatch asserted
  `agentType: 'verifier'` (and no `general-purpose` on the verify path); each of the
  four nested-lookup files must match both the `Explore` capability and a
  `SubagentWorkflow`-unavailable caveat; new assertions that the three templates declare
  `thinking: medium` and a finite positive `max_turns`.

No new test file, so `package.json`'s `test` script is unchanged.

## Files changed

Runtime: `skills/subagent-driven-development/scripts/{final-review,fix-loop,wave-parallel}.js`
Templates: `agent-templates/{task-reviewer,code-reviewer,verifier}.md`
Prompts: `skills/subagent-driven-development/{task-reviewer-prompt,re-review-prompt}.md`
Docs: `skills/subagent-driven-development/SKILL.md` (wave-parallel run-error fallback)
Config: `config-examples/{subagents.global,subagents.project}.json`
Tests: `skills/subagent-driven-development/scripts/{final-review,fix-loop,wave-parallel}.test.mjs`, `scripts/agent-dispatch-guard.test.mjs`

## Upstream tracking

One `pi-packages` chore bead records the two durable fixes that live in the subtree, with
file:line evidence and a note that the subtree cannot be changed from here:

1. Workflow args boundary should reject non-object `args` (the `typeof args === 'string'`
   delivery path should be impossible) — the server-side half of M5.
2. `allowed_subagents` should be effective on the `SubagentWorkflow` path, or the field
   should be documented as direct-dispatch-only in the runtime's own docs — the
   server-side half of M9.

## Acceptance

```
cd packages/pi-superpowers-plus && npm test
```

Scripts fail loud on bad args; reviewer templates pinned; read-only verifier dispatched;
nested-lookup claim conditional; suite green.
