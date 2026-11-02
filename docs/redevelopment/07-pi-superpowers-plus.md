# 07 — pi-superpowers-plus: feature inventory

Source: `packages/pi-superpowers-plus/` (v0.10.0) — vendored Superpowers skills
plus pi-specific extensions. No compiled code: markdown skills, agent templates,
plain `.mjs` extensions, one TOML formula, node test scripts. Provenance chain:
`obra/superpowers` (upstream) → `coctostan/pi-superpowers` (pi port) → this
package (vendored; standalone repo deprecated). Brainstorming rebuilt on upstream
**v7.0.0**. Upstream's 13th skill `writing-skills` replaced by `using-superpowers`.

## 1. Packaging & the structural backbone

1. `pi` manifest: `extensions: ["./extensions"]` (directory — pi loads every
   default-export module) and `skills: ["./skills"]`. `files` includes
   agent-templates/, config-examples/, skills/, extensions/, formulas/ and
   excludes `**/*.test.mjs` from the tarball. Gate: `check` = `biome check .`;
   `test` = biome **plus 19 node test scripts** (so lint runs twice via the
   monorepo gate — harmless).
2. **Skill frontmatter contract**: `name` + `description`; **11 of 13 skills are
   `disable-model-invocation: true`** (hidden from the system prompt; load only
   via `/skill:<name>` or phase commands). Only `using-superpowers` and
   `systematic-debugging` are model-visible. ~52 tokens of descriptions vs
   upstream's ~450.
3. **Skill layout convention**: lean SKILL.md decision-tree + on-demand
   `reference/` files opened via read-gate lines
   (`> **Read now:** [reference/x.md](…) — description`). Enforced structurally
   by `test/skills-contract.test.mjs` (all references linked, all links resolve,
   no `set_phase` in reference material).
4. **The workflow formula** (`formulas/superpowers-workflow.formula.toml`,
   version 3, var `topic`): 12 steps — `explore → conversation → playback →
   [human gate] design-approved → write-spec → spec-review → [human gate]
   spec-approved → implement → wrap-up → verify → [human gate]
   smoke-test-approved → finish`. `bd mol pour` stamps `step:<key>` labels
   (gates get `step:gate-<id>`); skills resolve steps at runtime via
   `beads_list({ label: "step:<key>", mol: "<root-id>" })`. Plan tasks are
   **beads** (no markdown plan file); the spec document remains a markdown file
   in `docs/superpowers/specs/`.

## 2. The 13 skills (one line + key mechanics each)

1. **brainstorming** (hidden, `/brainstorming` `/brainstorm`) — the entry point;
   full detail in §3.
2. **using-superpowers** (visible) — "invoke relevant skills before acting";
   announce; todo per checklist item; red-flags/rationalizations tables; skill
   priority (process first); user instructions > skills > defaults. **Session
   Start beads cleanup**: `bd mol wisp gc --dry-run --age 24h`; keep resumable
   wisps (note or longer `--age`); delete the rest; never touch persistent
   issues; confirm the formula is available. Working-directory rule (always the
   user's cwd). References `pi-tools.md` (tool mapping, codemode exposure,
   repo-routing rules, undeclared-argument caveat).
3. **writing-plans** (hidden, `/plan`) — plan output IS task beads via ONE
   `beads_create_list({ parent: <implement-step-id>, gate: {…}, tasks: […] })`
   call (tasks-array order = plan order → ids `parent.1..N`). Task template:
   Files / Interfaces / Acceptance Criteria (passed as `acceptance` so bd lint
   is clean) / Steps 1–5 (failing test → run-to-fail → implement → run-to-pass
   → commit) / optional re-runnable `Gate:` command. Gate bead description =
   **Global Constraints** (version floors, naming rules, one line each with
   exact values) + **Review Focus** (five uncovered input classes). Self-review
   checklist (spec coverage, gaps vs transcripts, type consistency,
   proportion, lifecycle-duplicate check). `RESULT.gate` = gate task bead
   (**never** `beads_gate_resolve` it); `RESULT.human-gate` = the only id the
   verdict resolver resolves.
4. **executing-plans** (hidden, `/execute` choice 2) — separate-session batch
   execution: load/review (task beads + constraints from the gate bead), claim →
   work → verify (record `→ (no output)` when passing commands print nothing) →
   close → re-run `beads_mol_ready`; default batch 3; stop conditions;
   wrap-up disposition; then verify/finish.
5. **subagent-driven-development (SDD)** (hidden, `/execute` choice 1, recommended)
   — the largest skill; §4.
6. **test-driven-development** (hidden) — **three-scenario model** (new feature →
   full TDD; modifying tested code → tests green before+after, add only if
   uncovered; trivial → judgment) — the package's signature local change.
   Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST (code-before-test
   is deleted, not adapted). Verify-RED and Verify-GREEN as distinct gates.
   Companion `writing-good-tests.md`: "Name the break" + "Exercise the real
   thing" principles with gate-function pseudocode.
7. **systematic-debugging** (visible) — Iron Law: NO FIXES WITHOUT ROOT CAUSE
   FIRST; four ordered phases (root-cause investigation → pattern analysis →
   single-variable hypothesis testing → implement via TDD); <3 failed attempts
   → back to phase 1, ≥3 → STOP and question architecture. Supporting files:
   root-cause-tracing, defense-in-depth, condition-based-waiting (+ example),
   `find-polluter.sh` (test-pollution bisection).
8. **verification-before-completion** (hidden, `/verify`) — Iron Law: NO
   COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE; claims table
   (requires vs not-sufficient); molecule integration: claim `verify`, close it
   when all passes, the `smoke-test-approved` gate is resolved by a **human**.
9. **requesting-code-review** (hidden, `/review`) — whole-branch review via
   `code-reviewer` template; BASE = `git merge-base origin/main HEAD` (never
   HEAD~1); pre-generated review package optional.
10. **receiving-code-review** (hidden) — READ→UNDERSTAND→VERIFY→EVALUATE→
    RESPOND→IMPLEMENT; no performative agreement; clarify ALL unclear items
    before implementing any; source-specific trust handling; YAGNI check;
    GitHub replies via the comment-replies API.
11. **dispatching-parallel-agents** (hidden) — one agent per independent domain;
    when-to-use dot graph; parallel dispatch in one response; integration
    (read summaries, check conflicts, run full suite).
12. **using-git-worktrees** (hidden) — detect existing isolation
    (`GIT_DIR` vs `GIT_COMMON`), submodule guard, consent flow, native tools
    preferred with git-worktree fallback, directory selection
    (`.worktrees` > `worktrees`), must be gitignored, sandbox fallback = work
    in place. *(VCS-coupled — rewrite for the chosen VCS, see 02.)*
13. **finishing-a-development-branch** (hidden, `/finish`) — verify tests;
    detect environment; confirm base; present options **exactly** (merge /
    push+PR / keep; discard only on the literal word `discard`); merge-path
    verifies tests on the merged result; PR path runs local CI checks first;
    `set_phase({ phase: "" })` to clear; worktree cleanup only for
    merge/confirmed-discard, only for our own worktrees.

## 3. brainstorming — the workflow the new repo's inventory docs feed into

**Input triage** ("First: What Do You Actually Know?"): (a) self-contained
request → fast-route candidate; (b) **a document is named — a bead, a spec, an
issue, a file → read it FIRST as the `explore` step, without asking** (this is
how external markdown feature docs enter the flow, before the first message);
(c) something non-trivial missing → start the conversation. Every "Ground to
cover" line must be attributed: told / document-says / your call.

**Pour before you speak**: before reading any file, `beads_mol_pour({ proto:
"superpowers-workflow", vars: "topic=<topic>" })` + `beads_mol_current` +
`beads_mol_ready`. No exception. Pour refuses (existing workspace molecule) →
stop, bring the refusal verbatim to the human, carry-on vs clear-and-pour
fresh. Failed workspace check → pour proceeds with a loud warning. Brainstorming
an existing bead → new molecule + `beads_dep({ type: "discovered-from" })`
(fallback `related`), never mutating the original.

**Step semantics** (claim when begun, close when its real output exists; "when
you claim step N+1, close step N in the same turn"; never batch closes except
the fast route): `explore` (read what the request points at; runs before the
first message; never skipped) → `conversation` (one question per message, open
questions first, plain language; ground to cover = territory not script;
**enough is not a number** — coverage not count, a decision is load-bearing
when a wrong guess changes what gets built; offer recon; think wide privately;
spike = throwaway, keeping it is a new request) → `playback` (~200–300 word
chunks, guesses marked as guesses; **record size in the close reason**:
`size: project` / `size: small change`) → `design-approved` (human gate on the
full description in chat) → `write-spec` (project only; plain doc a builder
could plan from; four-point self-review; small change → close as skipped) →
`spec-review` (**builder check**: fresh blocking subagent with
`builder-check-prompt.md`, cast as a builder who cannot talk to the author,
reports only questions where a wrong guess would matter; sort into
answered-already / minor-yours / theirs) → `spec-approved` (human gate) →
`implement` (project: stays open for the whole phase, task beads created under
it; small change: worked directly).

**Gates**: approved → `beads_update({ setMetadata: "review.verdict=done" })`
then `beads_gate_resolve({ id: <gate-id> })`; changes requested →
`review.verdict=iterate` + specific revision summary comment + re-claim
playback, loop back, never resolve. Fast route: six-step ordered close
sequence. HARD-GATE #1: nothing gets built until the human approves the full
description (exceptions: the opt-out; an approved spike). After a project's
spec approval: print `/plan` for the human — terminal hand-off.

## 4. subagent-driven-development (SDD) — the execution engine

- **SubagentWorkflow batch shapes**: final whole-branch review (dimension
  fan-out), verification fan-out, wave-parallel implementation. Plain `Agent`
  for small batches. Fallback rule: SubagentWorkflow absent → sequential Agent
  loop, never emulate with parallel Agent calls. Stall watchdog: default 600 s
  run-wide; SDD implementer calls pass `stallTimeout: 3600`; `0` disables.
- **Controller-owned state**: workflow scripts and children are read-only on
  beads and the ledger **by instruction** (guardrail in every prompt/template —
  advisory, so the controller re-reads the bead before closing and ledgers a
  `DEVIATION` on mismatch).
- **Setup**: worktree (using-git-worktrees); ledger at
  `<repo-root>/.superpowers/sdd/<implement-step-id>/progress.md`
  (`scripts/sdd-workspace` creates it, self-ignoring) — conversation memory
  doesn't survive compaction; a ledger naming a different id is another plan's.
  Pre-flight conflict scan batched before execution.
- **Task loop**: dispatch implementer (record BASE `git rev-parse HEAD`; hand
  ONLY the task bead id — the bead description IS the requirements; claim at
  dispatch; canonical handle `task-<sanitized-id>-impl`; cost attribution via
  `bead:<task-id>` token in the Agent `description`; **one implementer at a
  time** except scheduled waves) → handle report (DONE / DONE_WITH_CONCERNS /
  NEEDS_CONTEXT / BLOCKED — never ignore an escalation, never blind-retry) →
  review (task-scoped, never skipped, both verdicts required; review package
  via `scripts/review-package <id> BASE HEAD`, never HEAD~1; reviewer reads in
  ~400-line slices past 600 lines; never pre-judge findings) → **fix loop**
  (triggers on spec ❌ / any Critical/Important / confirmed ⚠️; gated
  `fix-loop.js` path when a covering-test command exists — gate command
  shape-validated, no shell metacharacters; prose path rounds 1–3 resume the
  original implementer **by handle** (survives the ~10-min record sweep via
  `resumed from disk`), rounds 4–5 always fresh; **5-round cap with the
  adjudication breaker**: reviewer-wrong → park with ruling;
  real-but-not-load-bearing → park; real-and-load-bearing → STOP, BLOCKED,
  report to human; parking is not filing) → complete (ledger line with commit
  range; close the bead; never move on with open unparked Critical/Important).
- **Wave-parallel** (`scripts/wave-parallel.js`): ready frontier → filter
  unclaimed → require `Files:` sections → **pairwise-disjoint file sets per
  wave** → claim all → workflow script with `{wave, base, reportDir,
  gateBeadId, reviewPackage}`; fail-closed item-shape guard before ANY
  dispatch; shared-branch rules (commit exactly your own files, retry once on
  index.lock — **VCS-coupled, see 02**); engine caps concurrency at
  `min(16, cpus−2)`; per-task envelope processing incl. `degraded`.
- **Final review** (`scripts/final-review.js`): phases Find/Verify; five FOCUS
  lenses (correctness/security/performance/plan/maintainability, caller scales
  to the diff); parallel `code-reviewer` finders; **adversarial `verifier`
  refuters** in waves of 6 ("default to refuted unless the finding clearly
  holds"); location-based dedupe; `findingsFile` JSONL audit via one
  writer child; `count===0 && degraded:null` = clean. Two caller rules: never
  put the parked-findings list in `description`; pass `dimensions` scaled to
  the diff.
- **After all tasks**: ask "Ready for final review and finishing?", WAIT.
  Then: close implement → wrap-up (disposition every parked finding as one
  batched question: fix / drop-with-reason / defer) → delete the plan workspace
  **after** wrap-up → verify → finish.
- **Prompt templates**: `implementer-prompt.md` (questions before starting;
  TDD if task says; report contract <15 lines with covering-test command and
  RED/GREEN evidence), `task-reviewer-prompt.md` (two-part verdict, calibration,
  plan-mandated defects ARE findings labeled plan-mandated, no pre-judging),
  `re-review-prompt.md` (per-finding ADDRESSED/NOT ADDRESSED with file:line;
  "Attempted" is not addressed; one nested Explore child per bounded question).
- **Red-flags never-list**: controller never writes code; 2 failed fix
  attempts → stop; no main-branch work, skipped reviews, parallel implementers
  (outside waves), whole-plan handoffs, silent discards, re-dispatching
  completed tasks from memory, fake parallelism.

## 5. Extensions (`extensions/` directory)

1. **set-phase** — tool `set_phase({ phase })`, emits
   `pi.events.emit("superpowers:phase", { phase })`; canonical phases only:
   `brainstorming`, `development`, `""` (clear). Lifecycle clears phase on both
   `session_start` and `session_shutdown` (no session inherits a prior phase).
   **Direct tool call, never inside a codemode script** (54 `ReferenceError`
   occurrences fixed by this). Consumers today: molecule widget (refresh
   trigger), langfuse (phase tags), bifrost (`x-superpowers-phase` header) —
   the latter two are dropped packages (**[decide] Q5**).
2. **phase-commands** — `pi.on("input")` transform mapping `/brainstorming`,
   `/brainstorm`, `/plan`, `/verify`, `/review`, `/finish` → `/skill:<name>`
   (arguments preserved); `/execute` sets the editor to a two-option choice
   (SDD recommended vs executing-plans) unless headless (`!ctx.hasUI` → let the
   phrase reach the model). Pure text rewriting, no state.
3. **beads-molecule-widget** — the TUI progress widget (id `beads-mol`,
   `placement: "aboveEditor"`). Pure renderer + injected controller + TS
   adapter, all tested separately:
   - Renders: header `Superpowers: <topic> · <PhaseLabel> · <done>/<total>`
     (topic parsed from the `conversation` step's title, legacy fallbacks);
     three phase views (brainstorm list / implementing tree with task-bead
     children, `├──`/`└──`, + wrap-up sibling / finishing list); status markers
     ○ ◐ ● ✓ ❄; active row pinned; **"⏸ Waiting on you: <title> <id>"** only on
     a genuine wait (current step is a human gate, or the first open step is a
     gated review step with nothing in progress); deepest-open fallback lead;
     15-line cap with `+N more…`; full-width display-width-aware truncation
     (CJK/emoji width 2); all-done → single `✓ … finished` line.
   - Data: `bd list --type molecule --label ws:<workspaceKey>` (multi-worktree
     disambiguation; golden vectors shared with pi-beads) + `bd mol current
     --json` per root; `pickWorkspaceMolecule` (active > idle > finished;
     `preferId` is a floor not a filter); multi-worktree guard (never adopt an
     unscoped global when another worktree owns the cycle); additive mode keeps
     a locked frame absent from the probe.
   - Refresh triggers: `beads:changed` (leading-edge + 10 s trailing coalescer),
     `superpowers:phase` (non-empty only), `agent_start` per-turn backstop
     (out-of-band raw-`bd` mutations), `setCwd` — **never a timer, never a
     query at pi startup**. Failure: only clean not-found signals clear the
     frame; transient failures keep the last good frame; the widget never lies.
   - **Contention gate** (embedded-Dolt exclusive lock): one 150 ms retry, then
     exponential cooldown 2.5 s → 10 s during which bd calls return
     "contended" (keep last good frame); one forced probe per user turn.
     `dolt-lock-retry.mjs` = deliberate hand-kept copy of pi-beads'
     `lock-retry.ts` (packages must not import each other).
   - Timeout: `PI_BEADS_MOLECULE_TIMEOUT_MS` > `BEADS_DOLT_READY_TIMEOUT`-derived
     + 20 s margin, floored at 30 s.
   - *(This widget is the Q12 candidate for a Rex floating-pane renderer —
     see 00 §1b.)*
4. **formula-seed** — auto-seeds the bundled formula into
   `~/.beads/formulas/superpowers-workflow.formula.toml` as a **symlink into
   the installed package**; never throws; actions: linked / relinked (dangling)
   / already-linked / skipped-user-file (a real user file — never touch) /
   skipped-foreign / skipped-unwritable / skipped-error. Also detects a stale
   repo-local copy at search-path #2 **shadowing** the seed (byte-compare,
   root via `git rev-parse --git-common-dir` — VCS-coupled) and warns.
5. **subagent-models** — per-agent-type model injection from global
   `~/.pi/agent/subagent-models.json` + project `.pi/subagent-models.json`
   (project wins per key; types: implementer, task-reviewer, code-reviewer,
   verifier, worker, explore); `tool_call` handler injects `input.model` only
   when the call carries none (per-call and frontmatter pins win); malformed
   files → `{}` silently.

## 6. Agent templates & config examples (copy-in only)

`agent-templates/` (copied to `.pi/agents/` or `~/.pi/agent/agents/`; filename =
type name): `implementer.md` (TDD, IMPL guardrail), `worker.md`, `code-reviewer.md`
(read-only tools + `allowed_subagents: Explore`, `thinking: medium`,
`max_turns: 60`; bounded-lookup policy; Strengths/Issues/Recommendations/
Assessment output), `task-reviewer.md` (`max_turns: 40`), `verifier.md`
(adversarial refuter, `max_turns: 25`, default-to-refuted), `explore.md`
(overrides the built-in `Explore` by exact name, read-only, no model pin).
Config examples: fail-closed dispatch settings
(`fallbackSubagent: "none"`, `strictAgentFiles: true`,
`toolDescriptionMode: "compact"`, `scopeModels: true`).

**Guardrail strings** (byte-pinned by test): IMPL = "Do NOT create, update, or
close any beads issues … who closes this task's bead only after the review
passes. Report DONE; the controller handles the bead." REVIEW = same core +
"Your beads access is READ-ONLY …". Present verbatim in all prompts, scripts,
and templates; `explore.md` exempt.

## 7. Test coverage (19 scripts)

dolt-lock-retry; molecule-contention-gate; molecule-widget pure renderer
(2,174 lines); widget controller (lifecycle, workspace probe, multi-worktree
guard); widget adapter wiring; **widget-formula coupling** (pins the widget's
views/keys/topic-prefix against the shipped formula); workflow-formula
structure contract; phase-commands; set-phase; subagent-models; formula-seed +
shadow warning; **agent-dispatch-guard** (every `subagent_type` literal in
skills resolves to a shipped template or known built-in; reviewer templates pin
`allowed_subagents: Explore`/`thinking`/`max_turns`; refuters are `verifier`
never `general-purpose`); agent-templates; **skills-contract** (phase
vocabulary; guardrails byte-exact; pour-first/can-refuse/fast-route pins; no
HEAD~1; no `<plan-approved-gate-id>` conflation; reference/link integrity);
SDD script tests via `run-workflow.mjs` (a `node:vm` harness with injectable
agent/parallel/pipeline so CI tests workflow scripts without a live session).

## 8. Upstream divergences (what's locally ours)

Hidden skills + phase commands (~52 vs ~450 tokens); three-scenario TDD model;
subagent dispatch + 6 agent templates (upstream has none); **beads as the
persistence layer** (molecule/gates/wisps; plan output IS task beads);
reference/ split with read-gates; restored inline red-flags/checklists;
upstream visual-companion dropped; extension machinery with no upstream
equivalent (phase-commands, set-phase, molecule widget, formula-seed,
subagent-models, the formula); explicit "A local addition" markers in skill
text (coverage-not-count; design-for-isolation).

## 9. New-repo considerations

1. **Q12 applies here**: the molecule widget's renderer/controller/parsers are
   cleanly separated (pure `.mjs` logic, injected deps) — a floating-pane
   renderer could reuse `moleculeWidgetLines` + the parsing/picking logic and
   replace only the adapter's TUI wiring. The refresh-trigger design
   (`beads:changed` + phase events + per-turn backstop, never a timer) should
   carry over to any pane-based renderer; a pane renderer is a separate
   *process* and **cannot subscribe to `pi.events`** (verified against the pi
   1.5.0 docs — the bus is in-process, and RPC mode carries only session
   events + extension-UI records), so the event-driven design is a **bridge
   extension**: subscribe in the parent and forward over a unix socket or an
   atomic state file the renderer `fs.watch`es — which also keeps the bd
   query and its contention gate in the parent, leaving the pane a pure
   renderer (the polling-`bd mol current` alternative pays ~2 s/tick and
   needs the contention gate ported into the renderer). See 00 §1b / Q12.
2. `set_phase` consumers langfuse/bifrost are dropped (Q5) — the event remains
   useful for the widget and potentially pane labels.
3. The formula + `step:<key>` labels are the coupling contract between skills,
   widget, and tests — port the `widget-formula-coupling` and
   `workflow-formula` tests first; they will catch drift.
4. Skill prose is the main VCS-coupling surface (~50 git commands; see 02) —
   Q9 decides rewrite-vs-agnostic.
5. The SDD scripts' git coupling (`review-package` base..head ranges,
   wave-parallel shared-working-copy commits) needs the jj decision (02 §2).
6. `dolt-lock-retry.mjs` duplication with pi-beads (Q4).
7. The 19-script suite (especially skills-contract and agent-dispatch-guard)
   is the model for keeping doctrine executable — port the *approach* even if
   the assertions change.
