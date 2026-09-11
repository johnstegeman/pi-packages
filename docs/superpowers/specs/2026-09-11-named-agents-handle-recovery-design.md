# Named agents + @handle recovery path in SDD

Molecule: `pi-packages-mol-73p0` · Task: `pi-packages-l8x9.7` (epic `pi-packages-l8x9`)

Date: 2026-09-11 · Status: approved design (`review.verdict=done` on `pi-packages-mol-mbhv`)

## Problem

SDD's single most expensive observed failure is a controller that lost its place and
re-dispatched entire completed task sequences. The ledger (`<workspace>/progress.md`)
is the recovery map, but it is only as good as what the controller wrote down, and it
is the *only* path: nothing ties a running or finished implementer to a recoverable
identity. Implementer dispatches today carry no `name:`; the agent id returned by
`Agent(...)` is recorded for fix-loop resumes but is a random opaque handle that is
useless after compaction if the controller did not write it down.

pi-subagents ≥0.19 supplies the missing second path: named agents (`Agent(name:)`),
sessions persisted by default (`rememberAgents`), tombstones that keep a handle
resolving after the in-memory record is evicted, reopen-from-disk, and `@handle`
mentions — "name works wherever ids do" (`steer_subagent` / `get_subagent_result`).
Because the handle is *deterministically derived from the task bead id*, a compacted
controller can reconstruct it from beads state it still holds, and query a finished
implementer's outcome without re-dispatch.

## Constraints (from plan-approval gate `pi-packages-l8x9.1`, as amended by this design)

1. **Per-task cost attribution** — unaffected: implementer dispatches stay plain
   `Agent` calls (the workflow-child carve-out does not apply); `name:` adds no
   lifecycle-event change, so `bead:<task-id>` cost tokens keep working.
2. **Degrade gracefully** — a host without pi-subagents ≥0.19 / pi ≥0.84 (or with
   `rememberAgents` off) has no naming or `@handle` surface: the ledger remains the
   sole recovery path. Documented caveat, matching the existing fallback pattern.
3. **Beads/ledger state stays controller-owned** — naming is a controller-side
   dispatch parameter; it grants implementers no new powers.
4. **The SDD ledger stays the record of truth** — the `@handle` path supplements
   within-session recovery; the ledger remains authoritative cross-session, and its
   dispatch lines now additionally index the handle.
5. **No new runtime context cost** — `name:` is a free parameter; the mechanical
   additions are prose, prompt-template text, and one structural test.

## Resolved decisions (brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Naming scope | **Implementers only** (`task-<id>-impl`) | Reviewers/re-reviewers/final reviewer are stateless one-shots over a diff file — losing one costs a re-dispatch, not context. Implementers are the only resumed agents (fix rounds 1–3) and hold the context worth recovering. |
| Verification bar | **Static guard + live in-session eval + manual smoke step** | `npm test` cannot spawn live agents; the static guard pins the documented contract, the live eval proves the mechanism in-session, and the existing smoke-test milestone hosts the human-verifiable step. |
| Ledger treatment | **Handle index**: `agent:` + `handle:` on dispatch and fix-round lines | Recovery becomes ledger → handle → query with zero transform rules to re-derive after compaction. |
| Handle derivation | **Prose convention documented once**; helper script (approach B) rejected | Transform (`task-` + dots→dashes + `-impl`) is trivial; a helper would be ceremony. |
| Template sync | **Byte-identical dispatch snippet** in SKILL.md + implementer-prompt.md, guarded by a structural test | The two are hand-maintained in parallel today; drift there is exactly what breaks the recovery contract. |
| Recovery scope | **`@handle` path is within-session** (compaction/eviction); the ledger is cross-session | pi-subagents keeps the 100 most recent handles and forgets all of them on `/new` and session switch; the docs state this boundary explicitly. |

## Canonical handle scheme

One rule, documented in SKILL.md:

```
task-<task-bead-id with every "." replaced by "-">-impl
```

Examples:

- Task bead `pi-packages-l8x9.2` → `task-pi-packages-l8x9-2-impl`
- Molecule task bead `pi-packages-mol-1nd7.3` → `task-pi-packages-mol-1nd7-3-impl`

Agent names allow only letters, digits, `_`, and `-`. Bead ids are lowercase
alphanumerics plus dashes and exactly one structural dot (project/plan prefix, then a
sequence number); id segments never contain dots themselves, so dots→dashes is
injective over the real id space and always produces a legal name.

## Dispatch & prompt-template changes

- **SKILL.md, Task Loop §1 (Dispatch the implementer)**: the dispatch bullet gains a
  `name:` line — the implementer dispatch becomes
  `Agent({ subagent_type: "implementer", name: "task-<sanitized-task-id>-impl",
  description: "Implement task bead:<TASK_ID>", ... })`.
- **implementer-prompt.md**: the dispatch snippet at the top of the template shows the
  same call including the name line. The snippet is **byte-identical** to the one in
  SKILL.md (the sync guard below asserts this).
- The agent id returned by `Agent(...)` is still recorded for fix-loop resumes
  (rounds 1–3); the canonical handle is recorded *alongside* it in the ledger.

## Ledger changes

- Dispatch line gains the handle:

  ```
  Task 1: dispatched (BASE 2b263e2, agent: <id>, handle: task-pi-packages-mol-csnx-1-impl)
  ```

- Fix-round ledger lines append the same `handle:` so a compacted controller
  mid-loop can query the finished implementer's outcome by name without re-dispatch.
- The handle is *derived at write time* from the task id the controller already
  holds — the ledger line is a record, not an independent authority.

## The @handle recovery path — new SKILL.md Setup subsection

A new subsection in **Setup**, beside the "The ledger is your recovery map" bullet:
*Second recovery path: @handle*.

**What it is.** An implementer is addressable by its canonical handle for its whole
lifecycle — *message* it while running (`@mention` at the prompt / `steer_subagent`
by name), *resume* it once finished, *reopen* its session from disk long after the
in-memory record is evicted. Controller-side, the handle works wherever ids do:
`get_subagent_result({ agent_id: "<handle>" })` pulls a finished implementer's
outcome with no id memorized. Humans address it at the prompt as `@task-…-impl`.

**Mechanics (one to two lines each):**

- *Sessions persist by default* — `rememberAgents` defaults on; a finished
  implementer's session lives on disk under `<os-tmpdir>/pi-subagents-<uid>/…`.
- *Tombstones* — when the in-memory record is evicted (~10 min after finishing), a
  tombstone keeps the handle resolving; a later query reopens the conversation from
  disk, and the name stays reserved (a same-typed newcomer becomes `-2` rather than
  shadowing it).
- *Definition is re-resolved* — a reopened continuation runs under the *current*
  `implementer` frontmatter, not the first run's; if the type was deleted or
  disabled the resume is refused; if the session file has been deleted the mention
  says so and frees the handle (a fresh start instead of a silent redirect).

**The honest boundary.** Handles are session-scoped: the 100 most recent are kept,
*all forgotten on `/new` and session switch*. So the `@handle` path is the recovery
route for **compaction / lost context within the live session** — the controller
still knows the task bead id (beads survive), re-derives `task-…-impl`, and queries.
Across sessions the ledger remains the recovery map, exactly as today.

**`run_in_background` on resume.** A *foreground* resume reopens an existing session
and never hits the spawn path or the concurrency pool; a *background* resume takes a
background slot and queues with other background agents. SDD's fix-loop resumes
(rounds 1–3, plain `Agent({ subagent_type: "implementer", resume: <id>, ... })`) run
in the background by default — the controller should not block on them: dispatch,
and the completion notification carries the result. A finished agent can only be
resumed once its run has finished; `steer_subagent` is the mid-run channel.

**Absent-extension caveat.** One line, matching the skill's existing fallback
pattern: naming and `@handle` require pi-subagents ≥0.19 with `rememberAgents`
enabled; if the extension is absent, the ledger remains the sole recovery path and
the naming bullet is moot.

## Verification

**Static guard — new `scripts/named-agents.test.mjs`**, added to the explicit test
list in `package.json` (as with `final-review.test.mjs`, `fix-loop.test.mjs`,
`wave-parallel.test.mjs`). Assertions, mirroring the sibling tests' style
(`node:assert`, parse-gated by `npm test`):

1. SKILL.md carries the transform rule and a dispatch snippet containing
   `name: "task-` (the naming convention cannot silently regress).
2. implementer-prompt.md's dispatch snippet carries the same `name:` line as
   SKILL.md's — the test asserts byte-equality of that single `name: "task-` line
   (the rest of the snippet still reads identically in the docs, but only the
   name line is load-bearing for the handle; whole-snippet byte-equality would go
   brittle on formatting churn) — the C-sync guard, so controller-derived and
   template-shown handles never disagree.
3. The recovery subsection's load-bearing boundaries are present: the session-scoped
   sentence (forgotten on `/new`), the `run_in_background`-on-resume nuance, and the
   absent-extension caveat.

**Live in-session eval (during implementation).** The first real task dispatched
under the new convention:

1. The `Agent` call with `name:` succeeds (no shape/legality error).
2. After the implementer finishes, `get_subagent_result({ agent_id: "<canonical
   handle>" })` returns the implementer's final result with the agent out of the
   active fleet — handle-by-name resolution on a finished agent, proven.
3. The ledger dispatch line carries both `agent:` and `handle:`.

The eviction→tombstone→reopen transition is pi-subagents' documented behavior; the
smoke milestone may watch it given a ~10-minute window, otherwise it is accepted as
documented upstream behavior.

**Smoke-test milestone (manual QA, a checkable step in the plan).** After a task
finishes, the user types `@task-…-impl` at the prompt and confirms the mention
resolves the finished implementer (completion/query), and acknowledges the
session-scoped boundary where printed.

## Files changed

- `packages/pi-superpowers-plus/skills/subagent-driven-development/SKILL.md` —
  dispatch bullet (+`name:`), Setup § recovery subsection, fix-loop resume line
  (+`handle:`), one Red Flags line (never re-dispatch a completed task from memory —
  query the finished implementer's canonical handle or trust the ledger first).
- `packages/pi-superpowers-plus/skills/subagent-driven-development/implementer-prompt.md`
  — dispatch snippet (+`name:`).
- `packages/pi-superpowers-plus/skills/subagent-driven-development/scripts/named-agents.test.mjs`
  — new.
- `packages/pi-superpowers-plus/package.json` — test list gains the new file.
- `packages/pi-superpowers-plus/CHANGELOG.md` — Unreleased → Added.

No changes: `fix-loop.js`, `wave-parallel.js`, `final-review.js`, any agent-frontmatter
files (that is the .8/.9 lane), or the review scripts.

## Out of scope

- Naming reviewers / re-reviewers / the final whole-branch reviewer (deliberately
  anonymous; Q1-A).
- `.8` fail-closed dispatch (`fallbackSubagent: 'none'`, `strictAgentFiles`),
  `.9` `allowed_subagents`, `.10` `toolDescriptionMode` — sibling tasks with their
  own lanes.
- Any runtime behavior change to the workflow scripts or the fix-loop mechanism.
