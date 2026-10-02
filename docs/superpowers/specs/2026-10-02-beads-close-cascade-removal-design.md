# Remove the `beads_close` parent-step cascade

Molecule: `pi-packages-mol-jcsx` · Bead: `pi-packages-oq1f8` (P2, bug) · Single PR, branch `fix/oq1f8`

Date: 2026-10-02 · Status: approved design (`review.verdict=done` on `pi-packages-mol-8wdi`)

## Problem

Closing the last task bead under the `implement` step closes the `implement` step itself, ending the
implementation phase and unblocking `verify` while the final whole-branch review is still
outstanding. Observed 2026-10-02 during the SDD run for molecule `pi-packages-mol-jcwz`:

```
beads_close({ ids: "pi-packages-mol-l7k8.3" })   # the last task under implement step pi-packages-mol-l7k8
→ "closed pi-packages-mol-l7k8.3, pi-packages-mol-l7k8"
```

`beads_mol_current` then reported `verify` as ready before the final review had run; the controller
had to `beads_reopen` the implement step to keep the molecule honest. This reproduces on every SDD
run that closes its last task bead.

Both execution skills specify the opposite: the **controller** closes the implement step, and only
after the work is verified — `subagent-driven-development/SKILL.md` ("After All Tasks Complete /
Final Review") and `executing-plans/SKILL.md:69-71`. The cascade pre-empts both. Closing the task
beads is not the same event as the implementation phase completing.

## What the cascade does today (evidence)

`packages/pi-beads/src/index.ts`:

- `parentStepToClose()` (`:1489-1504`) returns the parent's id when no open task-child remains — the
  parent must be a `parent-child` dep, `issue_type === "task"`, and not closed (`:1492-1495`); the
  just-closed child is excluded.
- `beads_close.execute` (`:1565-1589`) runs it after every successful close and walks up one level
  per iteration, closing each parent in turn.

It is generic code with exactly one consumer. In the only formula in this repo
(`packages/pi-superpowers-plus/formulas/superpowers-workflow.formula.toml`):

- root→step edges are `parent-child`, but the root is `issue_type: "molecule"` and is filtered out
  at `:1494`;
- gate links and step→step links (`verify` is blocked by `implement`) are `blocks`, never
  considered;
- `verify` / `finish` are *siblings* of `implement`, so the walk cannot reach them;
- only `beads_create_list` creates task children under a step, and its only documented call site is
  `writing-plans/reference/creating-task-beads.md:19` → `parent: "<implement-step-id>"`.

So the cascade fires at most once per molecule, always on `implement`, and the recursion above it is
dead (its parent is the molecule root). Every molecule the listing returned — 25, out of a capped
500-row `bd list --all` — is `superpowers-workflow` with that same shape. Nothing in any skill
mentions the cascade.

The behavior is deliberate, not an oversight: it was introduced by
`2026-09-03-superpowers-workflow-internals-fixes-design.md` §A2 specifically so that the implement
step would auto-close. This design **reverses that decision**.

## Decision

**Delete the cascade outright.** Rejected alternatives:

- *Exempt `step:implement` via its label* — one extra clause, retroactive for already-poured
  molecules, but keeps ~50 lines and 5 tests alive for a behavior with no remaining consumer, and
  hardcodes a step name. The label is also not unique to the step: its task children inherit it
  (e.g. `pi-packages-mol-l7k8.2` carries `step:implement`).
- *Keep the walk behind a `cascade: true` parameter, default off* — dead surface that still has to be
  schema'd, documented, and tested, and nothing passes it.

## Design

### 1. Contract

`beads_close({ ids, reason?, continue?, suggestNext?, claimNext?, noAuto? })` writes to exactly the
ids it is given, grouped by owning repo. No parent, step, or any other bead is closed or even looked
up. Unchanged: per-repo independence on failure, failure accumulation into `warning:`, the
`continue` / `suggestNext` / `noAuto` argv, client-side `claimNext` (with its `no claimable next
issue` / `bd ready failed` / `could not claim` outcomes), and one `beads:changed` per repo.

Return shape is unchanged: `closed <ids>` + optional `; claimed next: <ids>` + optional
`\nwarning: <failure>`. With the walk gone, `closedIds` can only contain ids the caller passed —
exactly the property the bug violated.

The tool **description** gains a clause: *"Closes exactly the ids you pass — no parent or step is
closed automatically."* The description is what the controller model reads when deciding whether to
close `implement` itself; without it, a model half-remembering the old cascade could leave
`implement` open and stall the molecule.

### 2. Code (`packages/pi-beads/src/index.ts`)

1. Delete `parentStepToClose()` and its doc comment, `:1483-1505`, leaving the single blank line
   after `beads_update`'s closing `});` before `registerTool({ name: TOOL.close, …`.
2. Delete the cascade walk, `:1565-1589`, so the per-repo body becomes:

   ```ts
           changed = true;
           closedIds.push(...rids);
           if (claimNext) {
   ```

3. That is the whole source change. `beads_close` no longer invokes `bd dep list` at all (it stays
   in use by `beads_deps` and `beads_gate_resolve`); the two deleted lines were the only `cascade`
   mentions left in `src/`.

### 3. Tests (`packages/pi-beads/test/pi-beads.test.mjs`)

- **New — the bug-shaped regression** (replaces `:1354`). Keep the existing `proj-t9` → `proj-imp2`
  fixture pair (`:304-315`), which already models "the only child closes the parent", and add
  `"labels":["step:implement"]` to the `proj-imp2` row of the `proj-t9 --direction down` block
  (`:305`). Rewrite the test as *"single-repo: closing the last task under a `step:implement`
  parent leaves the parent open"*: `beads_close({ids:
  "proj-t9"})` returns exactly `closed proj-t9`, never invokes `close proj-imp2`, and never invokes
  `dep list` for the child. This is the original repro carrying the label the real molecule has.
  The fixture rows stay even though nothing reads them now: they record the repro's shape.
- **Rewritten — `:1344` becomes the general invariant.** *"beads_close closes exactly the named ids
  and never touches a parent"*: exactly one `close` invocation, its id list exactly `["proj-t1"]`,
  plus `assertNoInvocation(["dep","list","proj-t1","--direction","down","--json"])`. This is the
  assertion that catches a re-added walk whatever mechanism it is re-added with.
- **Deleted:** `:1371` (surfaces a failed parent close), `:1380` (already-closed parent is success),
  `:1650` (umbrella cascade failure — its surviving half is already asserted by `:1659`). With them
  go the fixtures that existed only for those paths: the `dep list` rows for `proj-tc` / `proj-tcc` /
  `umb-tc` (`:316-330`); the `close)` case arms for `proj-bad-parent` / `proj-closed-parent` /
  `umb-bad-parent` (`:369-380`), which made the parent close fail — the removed walk's failure
  path; and the top-level `show)` case's `*closed-parent*` / `*bad-parent*` arms (`:401-406`), whose
  only caller was the removed walk's failure probe. The `mol show` case's `*closed-parent*` /
  `*bad-parent*` arms (`:224-229`) are pre-existing and intentionally untouched — unrelated to this
  change.
- **Rewritten minus cascade:** `:1567` (drop `findInvocation(["close","proj-imp2"])` at `:1582`,
  rename to "…maps continue/next flags and claims client-side") and `:1639` (drop `:1647`, rename to
  "…batches one `beads:changed` per repo when claimNext claims"). Its
  `assert.equal(…, 1, "one emit per repo")` stands untouched: `afterWrite` is already once per repo
  (`src/index.ts:1608`).
- **Pruned:** the `proj-t1` / `proj-t2` / `proj-imp` `dep list` fixtures (`:287-303`), dead once
  nothing calls `dep list` from `close`. `proj-t1` / `proj-t2` stay in the `ready` / `mol current`
  fixtures, which is where the `beads_mol_ready` tests (`:1563`, `:1862`, `:1912`) read them.

### 4. Docs

- `packages/pi-beads/README.md:168-177` — retitle to *"Gate resolve and close semantics"*; replace
  the cascade sentence with: `beads_close` closes exactly the ids you pass and never cascades, so
  closing the last task bead under a step leaves that step open — the `implement` step is closed
  explicitly by the controller (`subagent-driven-development` / `executing-plans`).
- Bead `pi-packages-oq1f8` acceptance criteria: drop #4 (the cascade still closes a non-`implement`
  parent — obsolete), restate #1/#2 as "closes only the task id", keep #3 (explicitly closing
  `implement` still unblocks `verify`).
- No `package.json` version bump — the recent `fix(pi-beads)` commits do not bump it.

## Testing

- `npm test` in `packages/pi-beads` (the suite is the `bd`-stub subprocess double).
- Then the root `npm test` gate (`scripts/ci/package-gate.mjs --all`); lint through the package's
  installed biome, never `npx biome` (AGENTS.md).
- The bug-shaped test must fail against the pre-change source and pass after — that is the
  regression proof.

## Bounds / non-goals

- `beads_gate_resolve` is untouched: closing a gate's gated step is a gate contract, not a cascade.
- Nothing in `pi-superpowers-plus` changes. Both skills already close `implement` explicitly, and
  `beads-molecule-widget.mjs:272` keys the `finishing` phase off step status via `beads:changed`,
  not off who closed it.
- No tool-name, parameter, or return-shape change beyond the description clause; no new tool surface.
- No backfill: already-poured molecules need nothing.

## Risks

- **A controller that never closes `implement` now stalls the molecule** instead of silently
  advancing. That is the point of the bead; the new description clause plus both skills cover the
  instruction side.
- **The `parent cascade: <id> not closed` failure surface disappears** with the feature it reported
  on (M3 in `2026-09-11-pi-beads-write-path-correctness-design.md` §4). Accepted: there is no
  cascade left to fail.

## Supersedes

- `2026-09-03-superpowers-workflow-internals-fixes-design.md` §A2 (introduced the cascade).
- `2026-09-11-pi-beads-write-path-correctness-design.md` §4 / M3 (surfaced its parent-close
  failures).
