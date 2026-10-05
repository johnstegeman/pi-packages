# Workflow children must not mutate beads: a canonical guardrail in every prompt

Molecule: `pi-packages-mol-rvjb` · Bead: `pi-packages-2ik53` (P2, bug) · Single PR

Date: 2026-10-05 · Status: approved design (`review.verdict=done` on `pi-packages-mol-5k55`)

All line numbers are as of `7d4a6c6`.

## Problem

During the SDD run for molecule `pi-packages-mol-ye30` (spike `pi-packages-t6wc`), the gated fix
path closed a bead it did not own:

```
SubagentWorkflow({ scriptPath: '<skill>/scripts/fix-loop.js', args: { taskBeadId: 'pi-packages-mol-ye30.4', ... } })
→ "Bead `pi-packages-mol-ye30.4` closed"   # the controller had claimed it in_progress and had not closed it
```

The workflow completed correctly (`passed: true`, both findings ADDRESSED, gate green, commit
`7c3da6f`), so nothing else flagged it. Two invariants broke at once:

1. **`subagent-driven-development` states the controller alone owns bead state** —
   `reference/dispatch-implementer.md:9`: *"Never hand bead management to the implementer. Task
   tracking (creating, updating, closing this task's bead) is the controller's job alone, and the
   task closes only after its review passes. The implementer prompt template carries this
   guardrail — do not override it."* `reference/subagent-workflows.md:25` repeats it for workflows:
   *"Workflow scripts and their children are read-only on beads and the ledger — they never
   create/update/close beads."*
2. **The ledger stops being the record of truth.** The controller's `progress.md` and the bead's own
   close become two independent records that can disagree; a resumed session reading the ledger and
   one reading beads see different states.

## Evidence — what the code does today

**The guardrail exists in exactly one prompt.** `implementer-prompt.md:48` is the only place a child
is told not to write beads. Every prompt a *workflow script* authors itself lacks it:

| Script | Prompt builders | Guardrail |
|---|---|---|
| `scripts/fix-loop.js` | `fixPrompt` (:50), resume (:82), `verify` (:89), `reReviewPrompt` (:107) | none |
| `scripts/wave-parallel.js` | `implementPrompt` (:81), `reviewPrompt` (:96) | none |
| `scripts/final-review.js` | `requirement()` (:137), `refutation()` (:167), `writerPrompt` (:288) | none |

`final-review.js:9` carries a *source comment* claiming "Read-only on beads: finders only beads_show
the gate bead" — the claim is in the code's head, not in the child's prompt. The prose-path
templates are unguarded too: `re-review-prompt.md` and `task-reviewer-prompt.md`. That matters more
than it looks, because `re-review-prompt.md` is the **fallback for the exact scenario that broke**
(when `fix-loop.js` cannot run, or its gate command is broken), so the fallback reproduces the bug.

**Why the fix child could reach `beads_close` at all.** `agent-templates/implementer.md:3` declares
`tools: read, write, edit, bash`, which looks like a closed surface. It is not:
`packages/codemode-bootstrap` activates `codemode` for every session, and `beads_*` are registered
with code-mode exposure — so the child inherits a beads-write path. Worse, the fix-loop prompts
*hand* the child that path:

> `'Task bead (the exact task text), from a codemode script: return await tools.beads_show({ id: … }). The beads_* tools have code-mode exposure, so they are not in your declared tool list — reach them through `codemode`.'`

They teach the child how to reach the beads tools and never say which of them are forbidden. The
implementer template does it right — it carries the read instruction *and* the prohibition.

**A constraint that shapes the whole design.** Workflow scripts run in a sandbox exposing only
`args`, `agent`, `parallel`, `pipeline`, `phase`, `log` (`scripts/run-workflow.mjs:21-39`) — **no tool
access**. A script cannot read or set a bead's status, so the bead's AC #2 ("a regression test pins
it: a fix round leaves the task bead's status exactly as the controller set it") **cannot be
satisfied as written**. See *Acceptance criteria* for the restatement.

**The agent template body is a system prompt.** `packages/pi-subagents/src/custom-agents.ts:128` —
`systemPrompt: body.trim()`. A guardrail line in a template body therefore covers *every* dispatch of
that type, whatever prompt the caller passes. Caveats: templates are copy-in only (README:67 — never
overwritten by an update, and `~/.pi/agent/agents/` currently holds stale copies dated Oct 2), and
`general-purpose` (used by `final-review.js`'s writer child) is pi's built-in, with no template to
edit — so the prompt layer is the only cover for it and templates can never be the whole fix.

## Decision

### 1. The canonical text

`CORE` — byte-identical in all locations, wrapped in `**…**` when rendered:

> Do NOT create, update, or close any beads issues (beads_* tools / bd commands) — task tracking belongs to the orchestrator

`TAIL_IMPL` — `, who closes this task's bead only after the review passes. Report DONE; the controller handles the bead.`

`TAIL_REVIEW` — `. Your beads access is READ-ONLY — reading the task/gate bead is fine; never write. Report your verdict; the controller records it.`

`CORE + TAIL_IMPL` reproduces `implementer-prompt.md:48` exactly — verified byte-for-byte, modulo
that template's four-space code-block indentation — so the file needs no edit and becomes the
reference copy the tests pin against. `CORE + TAIL_REVIEW` is the new
reviewer variant — "Report DONE" would be wrong for a re-reviewer, a finder, or a verifier, which is
why the text is a canonical core plus an audience tail rather than one verbatim block.

### 2. Inventory — 17 locations, 16 edits

| # | File | Location | Variant |
|---|---|---|---|
| 1 | `skills/subagent-driven-development/scripts/fix-loop.js` | `fixPrompt` (:50) | IMPL |
| 2 | " | resume prompt (:83) | IMPL |
| 3 | " | verify prompt (:90) | IMPL |
| 4 | " | `reReviewPrompt` (:107) | REVIEW |
| 5 | `skills/subagent-driven-development/scripts/wave-parallel.js` | `implementPrompt` (:81) | IMPL |
| 6 | " | `reviewPrompt` (:96) | REVIEW |
| 7 | `skills/subagent-driven-development/scripts/final-review.js` | `requirement()` finders (:137) | REVIEW |
| 8 | " | `refutation()` verifiers (:167) | REVIEW |
| 9 | " | `writerPrompt` (:288) | REVIEW |
| 10 | `skills/subagent-driven-development/implementer-prompt.md` | `:48` | IMPL — already correct, **no edit** |
| 11 | `skills/subagent-driven-development/re-review-prompt.md` | dispatch template | REVIEW |
| 12 | `skills/subagent-driven-development/task-reviewer-prompt.md` | dispatch template | REVIEW |
| 13 | `agent-templates/implementer.md` | appended `## Beads` section (end of file) | IMPL |
| 14 | `agent-templates/worker.md` | appended `## Beads` section (end of file) | IMPL |
| 15 | `agent-templates/task-reviewer.md` | appended `## Beads` section (end of file) | REVIEW |
| 16 | `agent-templates/code-reviewer.md` | appended `## Beads` section (end of file) | REVIEW |
| 17 | `agent-templates/verifier.md` | appended `## Beads` section (end of file) | REVIEW |

The uniform appended section is deliberate — one placement rule for every template, rather than five different anchors — because an agent template's body is the child's system prompt.

**Placement rule (scripts):** the guardrail goes immediately after the lines that tell the child how
to *read* the task/gate bead through `codemode`. The prompt is what hands the child its `codemode`
route; the read permission and the write prohibition must land in the same breath.

**The resume and verify prompts are included** even though they are terse by design ("…still
failing. Fix the cause, and stop."). The extra line buys a uniform test rule — *every prompt a
script emits contains `CORE`*, with no per-prompt exemptions to reason about. The resume is the same
child with the guardrail already in context, so this is belt-and-braces, not load-bearing.

`agent-templates/explore.md` is excluded: a read-only research agent, and no prompt routes it to
beads.

### 3. Why the agent templates too

The child that breached the invariant was `agentType: 'implementer'` — it ran under
`agent-templates/implementer.md`, whose body *is* its system prompt. The prompt layer is the
complete, immediately-effective fix; the template layer is the structural backstop for the one child
type that demonstrably breached, and it costs one sentence in five files. It cannot be the whole fix
(`general-purpose` has no template), which is why both layers are in scope.

### 4. Tests

**Behavioural prompt capture** — in each script's own test file. All three already stub `agent` and
can record `{prompt, label}` (`fix-loop.test.mjs:156`, `wave-parallel.test.mjs:191`,
`final-review.test.mjs:205`):

- **Rule 1 — every emitted prompt contains `CORE`.** Assert on the *recorded prompts*, not on the
  script source. `fix-loop.test.mjs` already drives both paths (passed round → `fix` + `re-review`;
  gate-failed → `fix` + resume + `verify`), so the terse resume/verify prompts are covered for free.
- **Rule 2 — the right variant per audience.** By label: `fix`/`implement:*` → `TAIL_IMPL`;
  `re-review`/`review:*`/`find:*`/`verify:*`/`writer` → `TAIL_REVIEW`. This makes the audience-tail
  decision tested rather than decorative.

This is what a source grep cannot do: the verify prompt exists only on the retry path, so a grep of
`fix-loop.js` stays green even if the guardrail is dropped from the one prompt a broken round
actually reaches.

**Source sweep + exhaustiveness** — in `test/skills-contract.test.mjs`, which already walks the
skills tree and is the existing structural contract for the prompt set:

1. **Canonical copy pin** — `implementer-prompt.md` contains exactly `CORE + TAIL_IMPL`.
2. **Per-file variant assertions** for the 17 locations above.
3. **Exhaustiveness** — mechanical conventions, each failing on a new match not in the list:
   - every `*-prompt.md` under `skills/subagent-driven-development/` must contain `CORE`;
   - every `skills/subagent-driven-development/scripts/*.js` containing `agent(` must contain `CORE`
     (any script that emits a prompt);
   - every `agent-templates/*.md` except `explore.md` must contain `CORE`.

   `reference/*.md` is deliberately outside the sweep: controller-facing docs that quote dispatch
   examples, not prompts a child receives.

### 5. Reconciliation — the detection half

The guardrail is **advisory**. A child that ignores its prompt can still close the bead; nothing in
the sandbox prevents it. So the controller gets one rule, in three doc edits:

- **`reference/fix-loop.md`** — after the gated-path paragraph: a fix round never closes the bead;
  before closing it at the end of a round, re-read it (`beads_show`). If it is already closed, that
  is a controller-owns-beads breach — ledger `Task <N>: DEVIATION — bead closed by a child
  (<closed_at>, <close_reason>); reconciled`, then rule on it (re-open, or record why the close
  stands).
- **`reference/subagent-workflows.md:25`** — reword "Controller-owned state" from asserting the
  invariant as fact ("they never create/update/close beads") to stating the truth: children are
  read-only *by instruction* — every workflow-authored prompt and every agent template carries the
  guardrail — the guardrail is advisory, and the controller's pre-close re-read is the detection
  mechanism. This is the paragraph that was wrong in the first place: it promised a property nothing
  enforced.
- **`reference/dispatch-implementer.md:9`** — extend "the implementer prompt template carries this
  guardrail" to name the agent templates too.

### 6. Distribution

Neither layer is live until two re-installs happen, and both are part of acceptance:

1. **Agent templates are copy-in**: `cp agent-templates/*.md ~/.pi/agent/agents/`. README:67 already
   documents that templates are never overwritten by an update, so this is existing practice.
2. **The skills come from pi's managed clone** (`~/.pi/agent/git/github.com/johnstegeman/pi-packages`,
   currently at `38043ae` — behind this workspace's `7d4a6c6`). The prompt-layer fix is live in a real
   SDD run only after that clone is updated.

## Rejected alternatives

- **Hard block: a dedicated agent type with `disallowed_tools: codemode`.** `SubagentWorkflow`'s
  `agent()` accepts `label, phase, schema, model, effort, isolation, agentType, gate, resume` — no
  per-call tool scope; the only lever is an agent type whose `disallowed_tools` becomes pi's
  `excludeTools` (`packages/pi-subagents/src/agent-runner.ts:255`). Blocking `codemode` also removes
  the child's `beads_show` read access that every one of these prompts depends on, requires a new
  agent template, and forces the task/gate text to be inlined as script args. It contradicts the
  "children read beads read-only" model the skill deliberately chose.
- **A per-round bead-status probe agent.** Costs one agent per round/wave and can only *report* a
  deviation the script is powerless to act on. The controller's pre-close re-read is free and equally
  informative.
- **A pi-beads-side guard refusing writes from subagent sessions.** Not expressible today — pi-beads
  cannot distinguish a controller from a child without a session marker pi does not provide. It is
  the only *preventive* mechanism that would exist, but it is a pi-beads/pi-core change, not this
  bead.
- **Presence-only regex test** (assert a loose `/do not .*beads/i` in each prompt source). Reproduces
  the original failure at the test level: a weakened copy ("avoid closing beads") would pass. The bug
  exists *because* the invariant was stated three times in prose and enforced nowhere.
- **A generated single source** (one file + a generator writing the literal into each prompt). Its
  generator is a worse liability than five duplicated lines, and workflow scripts cannot `import` at
  runtime, so generation would have to happen at author time anyway.

## Acceptance criteria

1. Every prompt the three workflow scripts emit contains `CORE`, with the audience-correct tail,
   asserted behaviourally on the captured prompts under a full-path run (including the
   retry path's resume and verify prompts).
2. The prose-path templates (`re-review-prompt.md`, `task-reviewer-prompt.md`) carry `CORE` +
   `TAIL_REVIEW`; `implementer-prompt.md:48` is unchanged and pinned as the reference copy.
3. The five agent templates carry the guardrail; `skills-contract.test.mjs` fails if a new
   `*-prompt.md`, a new script containing `agent(`, or a new non-explore agent template lacks
   `CORE`.
4. `reference/fix-loop.md`, `reference/subagent-workflows.md` and `reference/dispatch-implementer.md`
   state the controller's pre-close re-read and stop asserting the invariant as an enforced fact.
5. `npm test` in `packages/pi-superpowers-plus` passes, and the repo gate
   (`node scripts/ci/package-gate.mjs pi-superpowers-plus`) passes.

**Restated from the bead's AC #2.** The original — *"a regression test pins it: a fix round leaves
the task bead's status exactly as the controller set it"* — is not testable: workflow scripts run
without tool access and cannot observe a bead. It is satisfied by AC #1 (the child is now told) plus
AC #4 (a disobedient child is detected), and the spec states the limitation plainly rather than
encoding a test name that overclaims. The bead's own AC text is left unedited so the record stays
honest; a comment on `pi-packages-2ik53` points here.

## Verification

- `cd packages/pi-superpowers-plus && npm test` — runs all three script suites plus
  `skills-contract`.
- `node scripts/ci/package-gate.mjs pi-superpowers-plus` from the repo root.
- Both re-installs from *Decision §6*, after which a real gated fix round is the end-to-end check
  (the controller re-reads the bead and ledgers no `DEVIATION`).

## Out of scope

- Any change to `pi-beads` or `pi-subagents` (see *Rejected alternatives*).
- `dispatching-parallel-agents` and `requesting-code-review/code-reviewer.md`: the only other skills
  that dispatch children, and neither mentions beads anywhere. The sweep stays SDD-scoped — no
  repo-wide enforcement.
- Making the guardrail preventive rather than advisory.
