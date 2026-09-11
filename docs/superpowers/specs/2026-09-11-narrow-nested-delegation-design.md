# Narrow nested delegation for the task reviewer

Molecule: `pi-packages-mol-cclr` · Task: `pi-packages-l8x9.9` (epic `pi-packages-l8x9`)

Date: 2026-09-11 · Status: approved design (`review.verdict=done` on `pi-packages-mol-23r2`)

## Problem

The SDD task reviewer is dispatched with a diff package and told not to crawl the
broader codebase: inspect code outside the diff only to evaluate a concrete,
named risk, one focused check per risk. When a requirement cannot be verified
from the diff alone, the prompt's current instruction is to report it as a
`⚠️ Cannot verify` item *and hand the question back to the controller*.

That hand-back is the "bounce". The controller must then break out of
coordination, run a lookup, and either answer the reviewer (an extra round trip)
or adjudicate an unverified verdict. pi-subagents supplies a better path:
`allowed_subagents` gives a custom agent its own ownership-scoped nested
`Agent` / `get_subagent_result` / `steer_subagent` tools, depth-capped from the
main session (default 2), with results folded back and token spend rolled into
the parent's totals. A reviewer could settle a bounded question itself with one
read-only lookup instead of bouncing it.

This design turns that capability on **narrowly**: the `task-reviewer` template
only, allowlisted to `Explore` only, with the existing "one focused check per
named risk" discipline extended to cover nested lookups. It is deliberately
scoped off the `code-reviewer` / re-review / workflow surface — see
`pi-packages-l8x9.11`.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Which reviewer roles get nesting | `task-reviewer` only. `code-reviewer` and the re-review path are a follow-up (`pi-packages-l8x9.11`). |
| Q2 | Allowlist contents | `Explore` only. `general-purpose` was considered and rejected: it carries all tools, so allowlisting it would hand a "read-only" reviewer write-capable delegation. |
| Q3 | Prompt contract | Instruct, bounded: one nested `Explore` child per named question that a bounded lookup can settle; fold the answer into the verdict; report `⚠️` only for genuinely unresolvable questions or when nesting is unavailable. |
| Q4 | Acceptance | Structural guard assertions + one manual smoke test. No scripted e2e. |
| Q5 | Visibility | The reviewer names each nested lookup (question + `Explore`) in its report, so the controller can ledger it. |

## Behavior contract

**Capability.** `agent-templates/task-reviewer.md` gains
`allowed_subagents: Explore` in frontmatter. Nothing else in frontmatter
changes: the nested tools are auto-injected by pi-subagents for this
non-isolated agent when its depth is below `maxSubagentDepth` (default 2), so
they must not be listed in `tools:` and the controller's dispatch call is
unchanged — `task-reviewer` is still dispatched exactly as it is today.

**When the reviewer delegates.** A question the reviewer cannot verify from the
diff alone, and that is answerable by a bounded read-only lookup, is resolved by
dispatching **one nested `Explore` child for that named question**. The answer
is folded into the verdict — a would-be `⚠️ Cannot verify` becomes a backed
`✅`/`❌` with evidence. Genuinely unresolvable questions still become `⚠️`.

**Bounds** (existing SDD discipline, extended to nesting):

- One child per named risk/question. No open-ended crawling, no fan-out; this
  preserves the prompt's existing "one focused check per named risk" rule.
- Scoped to the question about this task's diff. The reviewer still does not
  crawl the broader codebase.
- The reviewer never mutates the working tree, and its nested children are
  stopped when it finishes (pi-subagents guarantees the latter).
- No re-nesting: `Explore` carries no `allowed_subagents`, and the reviewer
  already sits at depth 2.

**Reporting.** Each nested lookup gets one line in the report's "checks you ran"
area — the question plus the fact that an `Explore` child answered it — so the
controller can record it in the ledger and the reviewer's verdict stays
auditable.

**Fallback (graceful, additive).** If no nested `Agent` tool is available —
a pi-subagents build that predates nested delegation, `maxSubagentDepth ≤ 1`,
a stale copied template, or `Explore` disabled — the reviewer reports `⚠️`
exactly as today. Nothing on the controller path changes.

## File changes

1. **`packages/pi-superpowers-plus/agent-templates/task-reviewer.md`** — the
   persistent capability contract. Add `allowed_subagents: Explore` to
   frontmatter and a short `## Bounded Lookups` section to the body: the
   reviewer may spawn one `Explore` child per named question it cannot answer
   from the diff, folds the answer into the verdict, never mutates the tree, and
   reports `⚠️` when no nested `Agent` tool is available.
2. **`packages/pi-superpowers-plus/skills/subagent-driven-development/task-reviewer-prompt.md`**
   — the SDD workflow bounds. Extend the "Do not crawl the broader codebase"
   paragraph with the nested-lookup path (dispatch one `Explore` child when the
   `Agent` tool is available, rather than bouncing the question), and extend the
   `⚠️ Cannot verify` output bullet to name what was attempted plus the
   per-lookup report line. `Tests` and severity-calibration guidance are
   unchanged.
3. **`packages/pi-superpowers-plus/README.md`** — in the agent-templates
   section, note that `task-reviewer` opts into narrow nested delegation
   (`Explore` only), with the `maxSubagentDepth ≥ 2` requirement, the copy-in
   caveat (re-copy after upgrade), and the soft read-only caveat.
4. **`packages/pi-superpowers-plus/scripts/agent-dispatch-guard.test.mjs`** —
   structural guard: `task-reviewer.md` declares `allowed_subagents: Explore`;
   `implementer.md` and `worker.md` declare no `allowed_subagents`;
   `task-reviewer-prompt.md` references the nested-lookup path so the two halves
   of the split cannot drift apart.
5. **`packages/pi-superpowers-plus/CHANGELOG.md`** — one `Added` bullet under
   `[Unreleased]`.

**Explicitly untouched:** all of `packages/pi-subagents/` (upstream subtree,
read-only), `agent-templates/code-reviewer.md`, the re-review prompt,
`implementer.md` body, the workflow scripts, and `config-examples/` (pi-subagents'
default `maxSubagentDepth` of 2 already supports nesting).

## Verification

- **Automated:** `cd packages/pi-superpowers-plus && npm test` runs `biome check`
  plus the extended `agent-dispatch-guard` (pure Node + `assert`, no new
  harness).
- **Manual smoke test (Q4 acceptance):** run one real SDD task review that
  surfaces a genuine `⚠️`; confirm in `/agents` that the `task-reviewer` spawned
  a nested `Explore` child, that the lookup is named in the returned report, and
  that the `⚠️` was folded into a backed verdict.
- **Graceful-degradation check:** with `maxSubagentDepth: 1`, the same review
  must behave exactly as today (report `⚠️`), satisfying the epic's
  degrade-gracefully constraint.

## Out of scope

- `code-reviewer` and the re-review path nesting — `pi-packages-l8x9.11`.
- Any change to `packages/pi-subagents/`, `config-examples/`, or workflow
  scripts.
- No new controller-side dispatch parameters and no new ledger plumbing. The
  controller *may* ledger a nested-lookup line, but that is existing behavior.

## Residual risks (recorded, accepted)

- **Soft read-only boundary.** `Explore` ships `read, bash, grep, find, ls`; its
  system prompt forbids mutation but `bash` is not hard-sandboxed. Accepted under
  Q2-A and called out in the README.
- **Wave composition.** `wave-parallel.js` also dispatches `task-reviewer`
  children (depth 1→2), so nesting is expected to compose there too (same
  depth-1→2 condition, not separately verified here). Wave cost is aggregate
  by design, so per-lookup attribution is not claimed in waves.
- **Cost shape.** Nested token spend folds into the `task-reviewer`'s lifecycle
  event, so per-task cost attribution is preserved but the reviewer's per-task
  number includes its lookups. Expected, and worth a CHANGELOG/README note.

## References

- `packages/pi-subagents/README.md` — "Nested subagents" (allowlist semantics,
  depth cap, ownership scoping, token roll-up).
- `packages/pi-subagents/src/nested-tools.ts`,
  `packages/pi-subagents/src/agent-runner.ts` — injection condition
  (`allowedSubagents` + `nestedRuntime` + non-isolated).
- `packages/pi-superpowers-plus/skills/subagent-driven-development/task-reviewer-prompt.md`
  — current `⚠️` / "do not crawl" guidance.
