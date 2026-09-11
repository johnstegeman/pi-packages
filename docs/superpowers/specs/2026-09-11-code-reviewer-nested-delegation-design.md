# Extend nested delegation to the code reviewer (l8x9.11)

Molecule: `pi-packages-mol-mtz8` · Task: `pi-packages-l8x9.11` (epic `pi-packages-l8x9`)

Date: 2026-09-11 · Status: approved design (`review.verdict=done` on `pi-packages-mol-7p35`)

## Problem

l8x9.9 turned on ownership-scoped nested delegation (`allowed_subagents:
Explore`) for the `task-reviewer` template only, so a reviewer can settle a
bounded, named question with one read-only nested `Explore` lookup and fold the
answer into its verdict instead of bouncing `⚠️ Cannot verify` back to the
controller (see
`docs/superpowers/specs/2026-09-11-narrow-nested-delegation-design.md`).
l8x9.9 deliberately kept `code-reviewer`, the scoped re-review path, and the
SubagentWorkflow surface off — the `code-reviewer` follow-up is this bead.

The `code-reviewer` role has the same bounce problem:

- The **final whole-branch review** (`skills/subagent-driven-development/scripts/final-review.js`)
  fans out parallel dimension finders; each hits verification questions it
  cannot answer from the diff alone and either guesses or emits weak/unverified
  findings into the JSONL.
- The **scoped re-review** (`skills/subagent-driven-development/re-review-prompt.md`,
  used inside `fix-loop.js` / `wave-parallel.js` pipelines) verdicts each
  finding from the fix diff; verifying "was the amended symbol actually used
  here / is this caller in scope" often needs a bounded tree lookup.

The bead's open question — resolved below with evidence — is whether
`allowed_subagents` composes with SubagentWorkflow-spawned children
(depth/`nestedRuntime` plumbing) and what that means for scope.

## Verification finding (resolves the bead's open question)

**Question:** does `allowed_subagents` compose with SubagentWorkflow-spawned
children?

**Finding (code trace):**

1. `nestedRuntime` is constructed in exactly **one** place in the codebase:
   `packages/pi-subagents/src/agent-manager.ts:800`, inside pi-subagents' own
   dispatch path (its `Agent`-tool wrapper), which records `parentAgentId` +
   `depth` itself.
2. The nested-tool injection gate (`agent-runner.ts:855`) is
   `allowedSubagents && nestedRuntime && !isolated`. Without a `nestedRuntime`
   from the dispatcher, `allowed_subagents` in frontmatter is **inert** — no
   nested `Agent` / `get_subagent_result` / `steer_subagent` tools appear.
3. Workflow children are spawned by pi's workflow engine via the script's
   `agent()` API — `final-review.js:153` (`agentType: 'code-reviewer'` finders)
   and `fix-loop.js:125` (`agentType: 'code-reviewer'` re-review) — bypassing
   pi-subagents' `Agent` wrapper. The `agent()` option surface is fixed
   (label/phase/schema/model/effort/isolation/agentType/gate/resume): there is
   **no way to pass a `nestedRuntime` or depth through it**.
4. `packages/pi-subagents/` is an upstream-tracked subtree (repo policy: do not
   hand-edit); modifying it to plumb `nestedRuntime` into workflow children is
   off the table.

**Conclusion:** workflow children never receive a `nestedRuntime`, so
`allowed_subagents` composes **only** with direct `Agent` dispatch
(controller-side, task-reviewer-style paths). This confirms l8x9.9's
"deliberately off the workflow surface" posture with evidence rather than
assumption. The template change is therefore safe: it is inert inside
`final-review.js` / `fix-loop.js` children and active on direct-dispatch
`code-reviewer` runs — exactly the fail-closed direction.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Scope (bead's open question) | Keep off the workflow surface (verified: no `nestedRuntime` path through `agent()`). Extend nesting to direct-dispatch `code-reviewer` paths only. |
| Q2 | Allowlist contents | `Explore` only, same as task-reviewer. `general-purpose` carries all tools; allowlisting it would hand a read-only reviewer write-capable delegation. |
| Q3 | Prompt contract | Bounded, same as task-reviewer: one nested `Explore` child per named question that a bounded lookup can settle; fold the answer into the verdict; report `⚠️` only for genuinely unresolvable questions or when nesting is unavailable. Re-reviewer lookups scoped to the findings/fix diff (never whole-branch re-review). |
| Q4 | Verification approach | Code-trace evidence (Section above) written to the spec + recorded on the bead. Structural guard assertions; no scripted e2e; no runtime probe (deferred to manual smoke test). |
| Q5 | Visibility | The reviewer names each nested lookup (question + `Explore`) in its report, so the controller can ledger it. |

## Behavior contract

**Capability.** `agent-templates/code-reviewer.md` gains
`allowed_subagents: Explore` in frontmatter and a `## Bounded Lookups` section
mirroring task-reviewer's contract. Nothing else in frontmatter changes: the
nested tools are auto-injected by pi-subagents for this non-isolated agent when
its depth is below `maxSubagentDepth` (default 2), so they must not be listed
in `tools:` and every dispatch call is unchanged — both
`Agent({ subagent_type: "code-reviewer" })` (controller direct dispatch) and
workflow `agentType: 'code-reviewer'` (where the template is inert, see
finding).

**When the reviewer delegates.** A question the reviewer cannot verify from the
diff alone, and that is answerable by a bounded read-only lookup, is resolved
by dispatching **one nested `Explore` child for that named question**. The
answer is folded into the verdict — a would-be unverified finding becomes a
backed `✅`/`❌` with evidence. Genuinely unresolvable questions still become
`⚠️` / unverified, exactly as today.

**Re-review scoping.** The re-reviewer's existing scope rule (findings + fix
diff only, no whole-branch re-review) is unchanged. Nested lookups are
permitted only for questions *about the findings or the fix diff* (e.g. is the
amended symbol actually used here). Never delegate open-ended crawling.

**Bounds** (same discipline as task-reviewer):

- One child per named risk/question. No open-ended crawling, no fan-out.
- Scoped to the question at hand; the reviewer still does not crawl the
  broader codebase.
- The reviewer never mutates the working tree, and its nested children are
  stopped when it finishes (pi-subagents guarantees the latter).
- No re-nesting: `Explore` carries no `allowed_subagents`.

**Reporting.** Each nested lookup gets one line in the report's checks area —
the question plus the fact that an `Explore` child answered it — so the
controller can record it in the ledger and the verdict stays auditable.

**Fallback (graceful, additive).** If no nested `Agent` tool is available — a
pi-subagents build that predates nested delegation, `maxSubagentDepth ≤ 1`, a
stale copied template, `Explore` disabled, **or a workflow child (no
`nestedRuntime`)** — the reviewer behaves exactly as today. Nothing on the
controller or workflow paths changes.

## File changes

1. **`packages/pi-superpowers-plus/agent-templates/code-reviewer.md`** — the
   persistent capability contract. Add `allowed_subagents: Explore` to
   frontmatter and a short `## Bounded Lookups` section: one `Explore` child
   per named question, fold the answer into the verdict, never mutate the
   tree, report `⚠️` when no nested `Agent` tool is available.
2. **`packages/pi-superpowers-plus/skills/subagent-driven-development/re-review-prompt.md`**
   — add the bounded nested-lookup paragraph after the `## Scope` section:
   one `Explore` child per named question about the findings/fix diff when the
   `Agent` tool is available; otherwise verdict from the diff alone (fallback
   unchanged).
3. **`packages/pi-superpowers-plus/scripts/agent-dispatch-guard.test.mjs`** —
   structural guard changes:
   - Move `code-reviewer.md` from the "must NOT declare" list to the "opts
     in" assertion; allowlist must be exactly `Explore` for both
     `task-reviewer.md` and `code-reviewer.md`. Rename the test to
     `task-reviewer and code-reviewer opt into narrow nested delegation; implementer/worker do not`.
   - New test: `re-review-prompt.md` references the nested `Explore` lookup
     path, so the template half and the prompt half cannot drift apart.
4. **`packages/pi-superpowers-plus/README.md`** — update the agent-templates
   table row for `code-reviewer` (may spawn one nested `Explore` lookup per
   named question), re-title the nested-lookups paragraph to cover both
   templates, and document the workflow caveat fail-closed: workflow-spawned
   children carry no `nestedRuntime`, so the template is inert there; direct
   `Agent` dispatches get the nested tools. Keep the cost-shape and
   `maxSubagentDepth ≥ 2` notes, updated to mention both templates.
5. **`packages/pi-superpowers-plus/CHANGELOG.md`** — one `Added` bullet under
   `[Unreleased]` after the l8x9.9 nested-delegation bullet, including the
   verified workflow caveat.

**Explicitly untouched:** all of `packages/pi-subagents/` (upstream subtree,
read-only), `config-examples/`, `task-reviewer.md`, `implementer.md`,
`worker.md`, the workflow scripts (`final-review.js`, `fix-loop.js`,
`wave-parallel.js`), and controller dispatch calls.

## Verification

- **Automated:** `cd packages/pi-superpowers-plus && npm test` runs `biome
  check` plus the extended `agent-dispatch-guard` (pure Node + `assert`, no
  new harness).
- **Graceful-degradation check:** with `maxSubagentDepth: 1` (or a stale
  copied template, or a workflow child), the same review must behave exactly
  as today (report `⚠️` / unverified) — satisfying the epic's
  degrade-gracefully constraint.
- **No runtime probe in implementation.** The workflow-composition question is
  answered by code trace (Section above). A live probe (dispatch a
  `code-reviewer` child and check for a nested `Agent` tool) is deferred to
  the manual smoke test, per l8x9.9's structural-guard + smoke-test
  acceptance pattern.

## Out of scope

- Composing nested delegation into SubagentWorkflow children — impossible
  without upstream `pi-subagents` changes (verified, Section above); revisit
  only if upstream exposes `nestedRuntime` to the `agent()` API.
- Any change to `packages/pi-subagents/`, `config-examples/`, or workflow
  scripts.
- No new controller-side dispatch parameters and no new ledger plumbing.

## Residual risks (recorded, accepted)

- **Soft read-only boundary.** `Explore` ships `read, bash, grep, find, ls`;
  its system prompt forbids mutation but `bash` is not hard-sandboxed.
  Accepted under Q2 (same as l8x9.9) and called out in the README.
- **Inert-in-workflow may surprise.** A user reading `code-reviewer.md` may
  expect finders inside `final-review.js` to nest; they do not (no
  `nestedRuntime`). Documented fail-closed in README + CHANGELOG.
- **Cost shape.** Nested token spend folds into the `code-reviewer`'s
  lifecycle event, so per-review cost attribution is preserved but the
  reviewer's number includes its lookups. Expected; noted in README/CHANGELOG.

## References

- `packages/pi-subagents/README.md` — "Nested subagents" (allowlist
  semantics, depth cap, ownership scoping, token roll-up).
- `packages/pi-subagents/src/nested-tools.ts`,
  `packages/pi-subagents/src/agent-runner.ts` — injection condition
  (`allowedSubagents` + `nestedRuntime` + non-isolated).
- `packages/pi-subagents/src/agent-manager.ts:800` — the single
  `nestedRuntime` construction site.
- `packages/pi-superpowers-plus/skills/subagent-driven-development/scripts/final-review.js:153`,
  `fix-loop.js:125` — workflow `agent()` dispatch of `code-reviewer`.
- `docs/superpowers/specs/2026-09-11-narrow-nested-delegation-design.md` —
  l8x9.9 predecessor.
- `packages/pi-superpowers-plus/agent-templates/task-reviewer.md` — the
  template contract this design mirrors.
