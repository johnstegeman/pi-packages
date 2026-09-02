# Beads as the Structural Persistence Layer — Design Spec

**Date:** 2026-09-02
**Source:** Replace superpowers-plus's markdown-file-only spec/plan persistence with beads
(via its formula/molecule system) as the structural backbone of the brainstorm → design →
plan → implement → verify → finish workflow, while keeping spec prose in a diffable
markdown file. Supersedes the bookkeeping-only role beads plays today
(`2026-08-26-beads-migration-design.md`, `2026-08-27-beads-wip-visibility-design.md`),
where wisps/issues only shadowed status that markdown files fully owned.

## Motivation

Today, beads tracks *that* work is happening (one wisp per phase, one persistent issue per
plan task) while markdown files in `docs/superpowers/specs/` and `docs/superpowers/plans/`
remain the actual content and structure — the spec prose, the plan's task list, per-step
instructions. This is a shadow layer: nothing in beads models the epic → phase → task → step
hierarchy for real, dependencies between phases are enforced only by prose "HARD-GATE"
instructions an agent could in principle skip, and a plan's execution state lives in
checkbox characters inside a file that isn't guaranteed to be synced anywhere until
committed.

beads' formula/molecule system (`bd cook`, `bd mol pour`, `bd ready --mol`, `[steps.gate]`)
is purpose-built for exactly this shape: a template that instantiates into a real,
git-synced dependency graph, with human-approval gates as first-class graph nodes instead
of instructions. Moving the workflow's *structure* into beads — while keeping spec *prose*
in a file, for reasons covered in Decision 3 — gets us:

1. Real, enforced ordering and gating (the graph, not prose, decides what's next).
2. Cross-session/cross-machine resumability for free (beads syncs on every write; a
   mid-edit plan.md does not).
3. A native "what's next" query (`bd ready --mol`, `bd mol current`) replacing manual
   checkbox-parsing in `executing-plans`.
4. A purpose-built custom widget instead of the generic pi-beads issue board.

**Goals:**
1. Model brainstorm → design → plan → implement → verify → finish as a real beads
   molecule (epic + dependency-ordered children), not independent wisps.
2. Keep spec content in a markdown file (diffable, human-editable); use a bead purely for
   graph linkage (ordering, gating) into that file.
3. Move plan-task content (per-task instructions) into bead descriptions, replacing
   `docs/superpowers/plans/*.md` entirely.
4. Replace the generic pi-beads board with a custom widget rendering the active
   molecule's pipeline state.
5. Require beads (with `.beads/` initialized) as a hard prerequisite — no fallback path
   for projects without it.

## Decisions

### 1. Entry point: brainstorming pours the molecule, no new skill

Brainstorming remains the sole entry point for starting a topic. Its first step changes
from "create a wisp per checklist item" to: cook and pour the `superpowers-workflow`
formula (`bd cook superpowers-workflow --var topic="<topic>"` then `bd mol pour`),
producing a real epic immediately. The rest of brainstorming's checklist maps onto
claiming/working the formula's early steps (explore, clarify, approaches, design)
instead of ad hoc `beads_create({ ephemeral: true })` wisps.

**Existing-issue entry point** (`brainstorm beads-kp0`): brainstorming pours a **new**
epic from the formula (seeding its title/description from the existing issue's content
as a starting point) and links the two with a non-blocking dependency
(`bd dep add <new-epic> <existing-issue> --type discovered-from`, falling back to
`related` if `discovered-from`'s semantics don't fit). The originating issue is **never**
retyped, reparented, or otherwise mutated — it stays exactly what it was (a `feature`,
`bug`, whatever), and the link is purely for traceability. `bd show`/`bd dep tree` on
either side surfaces the connection.

Rejected: adopting the existing issue in place as the molecule root (retyping it to
`epic`, attaching formula steps as its direct children). Rejected because it mutates an
issue that wasn't created with molecule semantics in mind, and doesn't generalize cleanly
across origin types (feature vs. bug vs. plain task).

### 2. Formula shape

One TOML file, shipped at the package root as `formulas/superpowers-workflow.formula.toml`
(added to `package.json`'s `files` array so it's included in the published package —
`.beads/` is the git-ignored local database directory and cannot hold a shipped template).

**Distribution mechanism (revised from the original "extension writes it automatically"
plan):** rather than an extension writing the file on `session_start`, `using-superpowers`'s
Session Start checklist carries a prose step: check `bd formula list | grep
superpowers-workflow`, and if missing, copy the package's bundled
`formulas/superpowers-workflow.formula.toml` into the project's `.beads/formulas/`, never
overwriting a user-customized formula of the same name. This is an agent-executed step
re-run each session, not a one-time automatic filesystem write — a deliberate
simplification (avoids giving the extension its own `session_start` file-write side
effect) accepted during implementation. The tradeoff: correctness depends on the agent
following this step each session rather than a guaranteed one-time bootstrap.

```toml
formula = "superpowers-workflow"
description = "Brainstorm -> design -> plan -> implement -> verify -> finish"
version = 1
type = "workflow"

[vars.topic]
description = "The feature/topic being brainstormed"
required = true

[[steps]]
id = "explore"
title = "Explore project context: {{topic}}"
type = "task"

[[steps]]
id = "clarify"
title = "Ask clarifying questions"
type = "task"
needs = ["explore"]

[[steps]]
id = "approaches"
title = "Propose approaches"
type = "task"
needs = ["clarify"]

[[steps]]
id = "design"
title = "Present design sections"
type = "task"
needs = ["approaches"]

[[steps]]
id = "design-approved"
title = "User approves design"
type = "task"
needs = ["design"]

[steps.gate]
type = "human"

[[steps]]
id = "write-spec"
title = "Write spec to docs/superpowers/specs/"
type = "task"
needs = ["design-approved"]

[[steps]]
id = "spec-review"
title = "Spec self-review"
type = "task"
needs = ["write-spec"]

[[steps]]
id = "spec-approved"
title = "User reviews written spec"
type = "task"
needs = ["spec-review"]

[steps.gate]
type = "human"

[[steps]]
id = "implement"
title = "Implement {{topic}}"
type = "task"
needs = ["spec-approved"]

[[steps]]
id = "verify"
title = "Verify"
type = "task"
needs = ["implement"]

[[steps]]
id = "smoke-test-approved"
title = "Smoke test / manual QA sign-off"
type = "task"
needs = ["verify"]

[steps.gate]
type = "human"

[[steps]]
id = "finish"
title = "Finish development branch"
type = "task"
needs = ["smoke-test-approved"]
```

**Gate loop mechanics (informed by a comparable prior-art review, see Decision 8):**
each of the three human gates (`design-approved`, `spec-approved`, and the dynamically-
created `plan-approved`) is not a fire-and-forget approve/reject signal — the skill
explicitly supports a bounded revise-and-recheck loop:

1. **Verdict lives in bead metadata, not just open/closed status.** After presenting a
   design/spec/plan for review, the skill writes
   `bd update <step-id> --set-metadata review.verdict=iterate` (user requested changes)
   or `review.verdict=done` (approved) — status alone (`open`/`closed`) can't
   distinguish "not reviewed yet" from "reviewed, needs changes," and a future reader
   (a resumed session, the widget, a human inspecting `bd show`) needs that distinction
   without replaying the conversation.
2. **On `iterate`, the skill writes a revision summary before looping back** — a short,
   specific note (via `bd comment <step-id> "..."` or
   `--set-metadata review.revision_summary=...`) naming exactly which sections,
   assumptions, or open questions caused the loopback. The skill then re-enters the
   same conversational work (re-claim the step if it was left `in_progress`, or reopen
   it) rather than treating "revise" as an unstructured do-over.
3. **On resume (new session or after a gap), the skill reads prior content plus the
   latest verdict/summary before continuing** — `bd show <step-id>` for the design/spec
   content already written, plus the latest `review.revision_summary`, so earlier
   answered questions, approach trade-offs, and approved sections are revised in
   place, never silently discarded and restarted.
4. **Only `review.verdict=done` permits closing the gate** (`bd gate resolve
   <gate-id>` or `bd close <step-id>`, per whichever pattern applies) — `iterate`
   always means "loop back," never "proceed anyway."

This is a plain-`bd` pattern (no orchestration platform required) discovered by
reviewing a separate, more mature prior-art implementation of the same beads-as-
workflow idea (Decision 8) — it strengthens what was previously left as unstructured
prose ("if the user requests changes, make them and re-run the review loop") into a
durable, inspectable record of how many iterations happened and why.

**Why the freeform loops (explore/clarify/approaches/design) aren't modeled as their own
DAG nodes per turn:** brainstorming's "ask one question per turn, across as many turns as
it takes" is inherently unbounded and conversational. The formula captures the phase
*boundary* (one bead per checklist item, same granularity as today's wisps) — the
turn-by-turn question loop happens as work within the `clarify` bead, not as separate
steps per question.

**Why `implement` and `verify` are typed `task`, not `epic`:** validated live against a
throwaway beads instance — `bd` disallows `blocks`-type dependency edges crossing the
`epic` ⟷ non-epic type boundary in *either* direction:

```
$ bd dep add <task> <epic>
Error: tasks can only block other tasks, not epics
$ bd dep add <epic> <task>
Error: epics can only block other epics, not tasks
```

`waits-for` is the documented escape hatch for this exact case ("fan-in gate on a
molecule's dynamic children"), but it is not expressible via formula `needs` syntax —
`needs` always compiles to a plain `blocks` edge. Rather than post-pour-patching every
edge that touches `implement`/`verify` with manual `bd dep add --type waits-for` calls,
the simpler fix is to not type them `epic` at all. Confirmed live that a `task`-typed
issue with children is still correctly recognized as a molecule by `bd mol show` and
`bd ready --mol` — "molecule" is a usage pattern (epic-or-not, with children, worked via
`bd ready`), not a hard type requirement. This keeps every edge a plain `blocks` edge,
declarable directly in the formula.

**Why `implement`, not `plan`, is the epic-equivalent step:** the deliverable is the
implementation; the plan is a transient, interim artifact that exists to shape and gate
that work. Naming the container step for its actual output avoids a redundant "plan
epic" wrapping the same task beads a second time.

**Why `finish` has its own gate:** unlike the design/spec/plan approvals (all "does this
artifact look right," answerable by reading it), completing implementation may require
smoke testing or manual QA — an experiential check, not a document review. This gate
sits *before* `finish` starts, matching the other three gates' pattern of "approve, then
the next phase runs" — `finish` (branch cleanup, merge/PR options) only begins once
smoke-test sign-off exists, keeping `finish` itself a simple "act on the already-approved
outcome" step.

### 3. Spec content stays a file; the bead is graph linkage only

The `write-spec` bead's `description` holds a short summary and the file path (via
`bd update --spec-id <path>`, a field beads already provides for exactly this pattern);
the actual spec prose lives in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`,
edited directly across brainstorming's turns exactly as it is today (append a new
section as each gets approved).

Evaluated and rejected: storing spec prose in the bead's `description` field directly.
`bd show` renders markdown legibly enough (verified live — headings, lists, code blocks
all display correctly), which made this tempting. Rejected on three grounds, validated
against a live instance:

- **Diff quality.** `bd diff <ref1> <ref2>` does not include the `description`/`design`
  fields at all, even in `--json` mode — confirmed live, it only reports
  added/modified issue *ids*, not field-level content. `bd history --json` does give a
  full field snapshot per commit, so no content is *lost*, but there is no
  `git diff spec.md`-equivalent view without scripting a diff over two history
  snapshots yourself.
- **Edit ergonomics.** `bd update`/`bd edit` support full-field overwrite only for
  `description`/`design` — no `--append-description` exists (only `--append-notes`,
  a different field). Brainstorming builds a spec incrementally, section by section,
  across many turns; overwrite-only means re-sending the entire accumulated text on
  every section addition. This item was resolved as fixable (pi-beads is owned by the
  team and could add client-side append support), but the diff-quality and tooling
  points below stand independent of that fix.
- **Tooling and separation of concerns.** A spec is narrative content meant for a human
  to read, search, and review with their own editor/IDE/PR tooling; an issue field is
  workflow state. `bd show` rendering "well enough" doesn't make an issue tracker the
  right home for a multi-hundred-word design document, and coupling the spec's
  existence to beads' lifecycle (vs. a file that survives independent of the tracker)
  is an unnecessary new dependency.

**Consequence:** `appendDescription`/`appendDesign` support in `beads_update` — floated
during design as a fix for the edit-ergonomics point — is **not needed**. Specs are
edited as files (native append via normal file edits); plan-task descriptions
(Decision 4) are write-once, not incrementally built, so they don't need append either.

### 4. Plan tasks: dynamic children with instructions in bead descriptions

`docs/superpowers/plans/*.md` is retired entirely. Once brainstorming/writing-plans
knows the real task breakdown, each task becomes a child bead created directly under
`implement`:

```bash
bd create "Task N: <name>" --parent <implement-id> --type task
# full step-by-step instructions go in --description
bd dep add <task-N+1-id> <task-N-id>   # ordering, per the plan's own dependencies
```

No dynamic bonding (`bd mol bond --ref`) is needed for this — confirmed live that plain
`bd create --parent <existing-step-id>` against an already-poured molecule's step
immediately shows up correctly in `bd mol show`/`bd dep tree`/`bd ready --mol`. Dynamic
bonding matters for attaching a whole reusable *sub-formula*, which isn't this case (task
count and shape are project-specific, not a reusable template).

A dedicated `plan-approved` gate bead is also created as a child of `implement`, and
every real task bead depends on it (`bd dep add <task-N-id> <plan-approved-id>`) so
`bd ready --mol` correctly shows no real work until the human has approved the task
breakdown — mirroring today's "plan reviewed before execution starts" boundary, but as a
real graph gate.

**Self-review guard (from Decision 8's prior-art review):** before wiring tasks under
`implement`, `writing-plans`' self-review must confirm no generated task duplicates a
phase the formula already executes as its own step — a task titled "write the design
doc" or "get plan approved," for instance, belongs to `write-spec`/`plan-approved`,
not to `implement`. This mirrors a real bug class the prior-art review caught in its
own plan-review lane.

Plan-task descriptions are **write-once** at planning time (unlike specs, they are not
built incrementally section-by-section across turns), so the overwrite-only nature of
`bd update --description` is a non-issue: if a task's instructions need revising
mid-execution ("the plan was wrong, revise task 3"), that's a full-field rewrite via
`bd update --description`, the same one-shot pattern as authoring it the first time.

### 5. Execution reads the graph, not a file

`executing-plans`/`subagent-driven-development` replace "read plan.md, find the next
unchecked task" with the standard molecule execution loop already documented by beads:

```bash
bd ready --mol <implement-id>       # what's unblocked right now
bd update <task-id> --claim         # atomically claim + mark in_progress
# ... do the work ...
bd close <task-id> --reason "..."   # done; unblocks whatever needed this task
```

`bd mol current <implement-id>` gives a richer "where am I" view (per-step
done/current/ready/blocked/pending status, plus a computed `next_step`) — this becomes
the primary status query these skills use instead of scanning checkbox state, and is
also the widget's data source (Decision 6).

### 6. Custom widget replaces the generic pi-beads board

For superpowers sessions specifically, the generic multi-issue pi-beads board (existing
`widget-lines.mjs`, rendering a flat WIP+ready+done list across all repos) is replaced by
a widget scoped to the single active molecule, rendering it as an ordered pipeline rather
than a flat list.

**Data source:** `bd mol current --for <actor> --json`, returning
`{ molecule_id, molecule_title, current_step, next_step, steps: [...] }` in one call
(verified live; ~2s latency per call — meaningful enough to rule out fast timer-based
polling as a refresh strategy).

**Refresh triggers** (no timers, matching the existing widget's explicit "never poll `bd`
on a timer" rule, verified against `SPEC-ui.md`):
- `session_start` — one-shot, fire-and-forget, never blocks startup.
- `agent_start` — **unconditional every turn**, not just after tool calls. This mirrors
  the existing widget's per-turn closed-wisp re-read, which exists specifically because
  skills run bare `bd` commands the `beads_*` tool wrappers never see. Our formula-driven
  skills do the same (`bd cook`, `bd mol pour`, `bd dep add`, `bd create --parent` for
  dynamic task creation) — none of these are guaranteed to route through a tracked tool
  call, so the per-turn safety-net re-read is required, not optional.
- Any `beads_*` tool call that touches a molecule step triggers a detached
  (`void Promise.allSettled(...)`) refresh + repaint after it returns, so the extra
  subprocess latency never shows up as tool latency to the agent — same pattern as the
  existing `afterWrite()`.

**Failure handling:** if `bd mol current` fails or returns no active molecule, the widget
clears rather than showing stale or fabricated data — extending the existing rule
("never show `0 ready` instead of unknown — that's a lie") to this widget's progress
count and gate-status line.

**Rendering:** a new top-level layout function, reusing `widget-lines.mjs`'s existing
low-level primitives unchanged (`assemble`, `truncToWidth`, `displayWidth`, `formatAge`,
theme-safe painting) — those are general-purpose terminal-rendering infrastructure, not
tied to the flat-list data model they currently serve. The new function renders:

1. **Header:** a client-side phase label (derived by mapping formula step ids to
   human phases — `explore`/`clarify`/`approaches`/`design` → "Brainstorming",
   `write-spec`/`spec-review` → "Spec", `implement` and its dynamic task children →
   "Implementing", `verify`/`smoke-test-approved` → "Verifying", `finish` → "Finishing")
   + molecule title + a `done/total` progress count folded from `steps[].status`.
2. **Current step**, if any is `in_progress` — rendered distinctly if it's a gate
   (`⏸ Waiting on you: <title>`) versus a normal task (`◐ <title>` + elapsed time via
   the existing `formatAge`).
3. **Next step**, if nothing is currently claimed (`○ Next: <title>`).
4. **Collapsed pending/blocked count** (`+N pending`) rather than individual rows for
   everything not yet reachable.

This is a deliberate departure from the existing board's behavior of keeping full rows
for done items for a full turn: our object is a single ordered/gated pipeline where
*position* is the useful signal, not a scrolling history of completed items across
unrelated issues. A 15-20 step molecule would blow the existing 10-row budget quickly if
every done step kept its own row; the header count is sufficient signal here.

### 7. Hard beads dependency, no fallback

Per the existing beads-migration precedent (clean break, no abstraction layer), a project
without `.beads/` initialized cannot brainstorm or plan under this design — there is no
markdown-file fallback path. This is a stronger dependency than today's design (which
degrades gracefully to "no widget, but markdown still works"), and is an explicit,
accepted tradeoff of moving structure into beads.

### 8. Prior-art review: gascity-packs/superpowers

During design, a comparable implementation was reviewed for anything worth adopting:
[`gascity-packs/superpowers`](https://github.com/gastownhall/gascity-packs/tree/main/superpowers),
which maps upstream Superpowers onto **Gas City**, a separate, much larger
orchestration platform (own daemon, CLI, agent-session management, a richer
`graph.v2` formula contract with convoys/drains/role-routed agents). That platform
layer is not applicable here — a pi extension rides inside pi's own agent loop and has
no equivalent orchestration surface to target — but three beads-level patterns
(independent of Gas City's agent dispatch, expressible in plain `bd`) were adopted:

1. **Verdict-in-metadata and the revise/recheck loop** (Decision 2's "Gate loop
   mechanics" above) — their `[template.check]` steps poll a metadata field
   (`design_review.verdict = done|iterate`) via a retry loop instead of a single
   approve/reject gate, and their per-step prompts explicitly instruct writing a
   revision summary on `iterate` and reading prior content back in on resume.
2. **Plan self-review must reject lifecycle-duplicate tasks.** Their plan-review lane
   explicitly rejects any generated task that re-implements a phase the formula
   already executes (prepare/requirements/plan/decompose/review/finalize) —
   translated here as: `writing-plans`' self-review (Decision 4) must check that no
   dynamically-created task under `implement` duplicates a formula step the molecule
   already covers (e.g., a task literally titled "write the spec" or "get plan
   approved" belongs to `write-spec`/`plan-approved`, not to `implement`'s children).
3. **Confirmation that formula-driven, bead-backed workflow modeling is not an
   idiosyncratic choice** — a second, independently-built implementation converged on
   the same core primitive (TOML step templates compiled into beads with `needs`
   edges), and also kept per-step instructional content in markdown files referenced
   from the formula rather than inlined, matching this design's own file-vs-bead split
   (Decision 3).

Not adopted: Gas City's agent routing/convoy/drain machinery (`gc.run_target`
metadata, drain policies, session management) — out of scope for a pi extension;
and the two-stage per-task review split (spec-compliance then code-quality as
separate graph lanes) and parallel review-lane fan-out/fan-in, both of which are
reasonable patterns but deliberately left as skill-internal prose behavior in this
design (inside `verify`/`test-driven-development`) rather than promoted to graph
structure — revisit if task-level review ever needs to be independently resumable or
widget-visible.

## Scope

### New

- `.beads/formulas/superpowers-workflow.formula.toml` — written by the extension into a
  project's `.beads/formulas/` on first use if not already present.
- Custom widget module (new top-level layout function; reuses existing
  `widget-lines.mjs` primitives) rendering single-molecule pipeline state.

### Skill files rewritten

| File | Change |
|---|---|
| `skills/brainstorming/SKILL.md` | Checklist wisps → `bd cook`/`bd mol pour` at start; existing-issue entry mode (`discovered-from` link); checklist items map to formula steps `explore`/`clarify`/`approaches`/`design`/`design-approved`; spec content still written to a file, but `write-spec`/`spec-review`/`spec-approved` steps are real graph gates, not prose hard-gates |
| `skills/writing-plans/SKILL.md` | Retitled/rescoped: creates dynamic task children under `implement`, wires `plan-approved` gate and per-task `bd dep add` ordering, writes instructions into each task's `description` — no more `docs/superpowers/plans/*.md` output |
| `skills/executing-plans/SKILL.md` | "Read plan file" replaced by `bd ready --mol`/`bd mol current`; claim/close loop replaces manual status prose |
| `skills/subagent-driven-development/SKILL.md` | Same molecule-query replacement as executing-plans, for its batch-dispatch variant |
| `skills/test-driven-development/SKILL.md`, `skills/verification-before-completion/SKILL.md` | Map onto `verify`/`smoke-test-approved`/`finish` formula steps instead of self-owned wisps |

### Reference/prerequisite docs

- `skills/using-superpowers/references/pi-tools.md`, `README.md` — updated to describe
  the formula/molecule model as the persistence layer, hard `.beads/` prerequisite (no
  fallback), and the new custom widget replacing the generic pi-beads board.

### Out of scope

- Any change to `bd`/pi-beads' `description`/`design` field semantics
  (`appendDescription` was considered and dropped per Decision 3/4 — not needed).
- Formula support for per-question DAG nodes within `clarify` — the freeform Q&A loop
  stays conversational work inside one bead, not modeled in the graph (Decision 1).
- Multi-molecule-per-session handling beyond a "+N more" indicator if it ever occurs —
  not expected under normal use (one topic = one active molecule).

## Verification

- **Formula validity:** `bd formula list` shows `superpowers-workflow`; `bd cook
  superpowers-workflow --var topic="..." --dry-run` resolves all 12 steps with correct
  `needs` chains and three `[steps.gate]` blocks — manually verified against a live throwaway
  instance during design.
- **Pour + gate discipline:** `bd mol pour superpowers-workflow --var topic="..."` succeeds
  end-to-end (verified live: 16 issues created, no epic/task boundary errors). Walking the
  chain — closing `explore`, confirming `clarify` becomes ready, confirming everything past
  the unresolved `design-approved` gate stays blocked via `bd ready --explain` — was manually
  verified during design and should be re-verified as part of implementation.
- **Existing-issue linkage:** `brainstorm <existing-issue-id>` produces a new epic and a
  `discovered-from`/`related` edge to the original issue, which itself is untouched
  (same type, same fields) — verify via `bd show <original-id>` before/after.
- **Widget behavior:** manual smoke test — start a molecule, confirm the widget appears
  with the correct phase label and current step; claim a gate-blocked step and confirm it
  cannot be claimed until the gate resolves; close the molecule's last step and confirm
  the widget clears (no stale display).
- **No regression to the "never lie" rule:** disconnect/break `bd` mid-session and confirm
  the widget clears rather than showing a stale or fabricated progress count.
