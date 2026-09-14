# Docs truth-up & dead-code cleanup across the three packages — Design

Date: 2026-09-14
Issue: pi-packages-3iej.7 (findings H6, M21–M25, M30, plus cleanup lows)
Molecule: pi-packages-mol-qrub

## Problem

Several docs across the monorepo describe a state the code no longer has, and a
few dead artifacts remain. The root cause of the tool-table drift is that one
beads tool surface is described in three places (pi-beads README, the beads
`SKILL.md`, and `pi-tools.md`), so additions silently desync.

Verified state (2026-09-14 worktree):

- **H6** — `AGENTS.md:29` says "pi-beads has no automated tests"; `package.json`
  runs `test/pi-beads.test.mjs` and `test/cost-tracking.test.mjs`.
- **M21** — `pi-superpowers-plus/README.md:38` says the package "provides skills
  and agent templates only", but `pi.extensions` registers `./extensions`
  (phase-commands, set-phase, beads-molecule-widget, formula-seed). Its
  architecture tree omits `extensions/` and `formulas/`.
- **M22** — `ROADMAP.md:34` advertises "vitest + biome check"; no vitest exists
  and root CI never runs this package's tests.
- **M23** — `pi-tools.md:16` and `skills/beads/SKILL.md` omit tools that exist in
  `src/index.ts`'s 23-entry toolMap (`beads_reopen`, `beads_gate_*`,
  `beads_mol_*`, `beads_mol_ready`, `beads_promote`) and `SubagentWorkflow`.
- **M24** — pi-beads README says "twenty-three tools" but the table lists 22
  (missing `beads_mol_ready`).
- **M25** — pi-superpowers-plus README:158 says plan tasks are beads, but the
  `Agent` example at :232 passes `docs/superpowers/plans/retry-plan.md Task 3`.
- **M30** — six `.superpowers/sdd/*` files are git-tracked; root `.gitignore` has
  no `.superpowers/`.
- **Cleanup lows** — orphan `banner.jpg`; `truncToWidth`/`GATE_TO_REVIEW_STEP`
  exported but only self-used; stale "mirrors the widget test" comment
  (`pi-beads.test.mjs:367`); psp `files[]` ships dev tests while excluding one;
  40 legacy Feb-2026 files in `packages/pi-superpowers-plus/docs/plans/`;
  duplicate `docs/superpowers` roots; cost-tracking undocumented in pi-beads
  README; pi-beads Development section omits the cost suite; ROADMAP/CONTRIBUTING
  support links point at `coctostan/...`.

## Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Legacy docs | **B** — delete the 40-file Feb-2026 `docs/plans/`; move the package's `docs/superpowers/{plans,specs}` (12 plans + 18 specs) into the root `docs/superpowers/` (verified no basename collisions, so it is a straight move); keep `learnings.md`, `reviews/`, `upstream-sync-analysis.md`. |
| 2 | Tool tables | **B** — `pi-tools.md` and pi-beads README exhaustively enumerate the surface; `SKILL.md` keeps a curated, explicitly-marked non-exhaustive table that includes the workflow-critical tools. |
| 3 | Test packaging | **A** — move all psp `*.test.mjs` into a top-level `test/` excluded from `files[]`. |
| 4 | Cost-tracking docs | **A** — full section in pi-beads README + both suites in Development. |
| 5 | Truth-up scope | **B** — rewrite ROADMAP to current reality; leave CHANGELOG as an untouched historical record. |
| 6 | Canonical URLs | **A** — the monorepo (`github.com/johnstegeman/pi-packages`) is the support target; keep an "adapted from" attribution. |
| 7 | Execution approach | **1** — guarded truth-up: edits + one structural drift-guard test. |

## Section 1 — Documentation truth-up

### Root `AGENTS.md`
- Replace line 29 with the truth: `cd packages/pi-beads && npm test` runs
  `test/pi-beads.test.mjs` + `test/cost-tracking.test.mjs`.
- Adjust the `pi-superpowers-plus` wording if the test path moves to `test/`.

### `packages/pi-beads/README.md`
- Add the missing `beads_mol_ready` row so the table matches its "twenty-three
  tools" line and the 23-entry toolMap.
- New **Cost tracking** section: subscribes to subagent lifecycle events; records
  only for top-level agents; merges
  `cost.agents.<id>.{total,tokens.input,tokens.output,tokens.cacheRead,role,status}`
  plus derived `cost.total` / `cost.tokens.*` / `cost.agents.count`; noted as a
  second registered extension (`src/cost-tracking.ts`); link to
  `docs/superpowers/specs/2026-09-10-cost-tracking-on-task-beads-design.md`.
- Development section: state that `npm test` runs both suites (currently claims
  only `pi-beads.test.mjs`).

### `packages/pi-superpowers-plus/README.md`
- Line 38: accurate wording — ships skills, agent templates, **and its own
  extensions**; only the beads/subagent tool bundles come from companion
  packages.
- Architecture tree: add `extensions/`, `formulas/`, and the new top-level
  `test/`; correct the Development claim that "no compiled code ships … it is
  skills and agent templates."
- Line 232 example: replace the `docs/superpowers/plans/retry-plan.md Task 3`
  prompt with a bead-id reference, consistent with "plan tasks are beads."
- Support: point Issues/Contributing at the monorepo; drop the non-existent
  `johnstegeman/pi-superpowers-plus` Discussions URL.

### `packages/pi-superpowers-plus/ROADMAP.md`
- Rewrite to current reality (monorepo-vendored skills + extensions; current
  `npm test` = biome + node suites; no vitest, no `src/`, no "253 FakePi unit
  tests"). Remove stale standalone sections; fix `coctostan/...` links.
- `CHANGELOG.md` is left untouched as a historical record.

### `packages/pi-superpowers-plus/CONTRIBUTING.md`
- Fix the `coctostan/...` Discussions/Issues links to the monorepo.

### `packages/pi-beads/skills/beads/SKILL.md`
- Add workflow-critical tools (`beads_reopen`, `beads_gate_create`,
  `beads_gate_resolve`, `beads_mol_pour/show/current/ready`, `beads_promote`) to
  the read/write tables.
- Add an explicit "high-frequency subset — full reference in pi-beads README"
  marker.

### `packages/pi-superpowers-plus/skills/using-superpowers/references/pi-tools.md`
- Enumerate all 23 beads tools; add `SubagentWorkflow` to the subagents row.

### `packages/pi-superpowers-plus/package.json`
- `author` → current maintainer (monorepo owner).

## Section 2 — Dead-code/file removal, packaging, drift guard

### `.superpowers` untracking (M30)
- `git rm -r --cached .superpowers`; add `.superpowers/` to root `.gitignore`.
- Reword the `skills/subagent-driven-development/scripts/sdd-workspace` header
  comment: the self-ignoring `.gitignore` is defense-in-depth; the root ignore is
  authoritative. No behavior change.

### Dead files
- Delete `packages/pi-superpowers-plus/banner.jpg` (only `banner-plus.jpg`
  referenced).
- Delete the 40-file `packages/pi-superpowers-plus/docs/plans/` tree and the
  emptied `docs/superpowers/` after the move. No basename collisions exist between
  the root and package `docs/superpowers` trees, so the move is a straight move
  with no overwrite rule needed.

### Dead code
- Drop `export` from `truncToWidth` and `GATE_TO_REVIEW_STEP` in
  `extensions/beads-molecule-widget.mjs` (verified no external/test consumer).
- Reword the stale `pi-beads.test.mjs:367` comment referencing "the widget test".

### Test restructure (Decision 3)
- Move all 11 psp `*.test.mjs` (5 `extensions/`, 2 `scripts/`, 4
  `skills/subagent-driven-development/scripts/`) into top-level `test/`; update
  the `test` script paths. `files[]` omits `test/`, so nothing dev-only
  publishes. `skills-contract.test.mjs` resolves its root relative to the package
  root, so only its own path changes.

### Drift guard (Approach 1)
- New `packages/pi-beads/test/tool-surface.test.mjs`, added to pi-beads'
  `npm test`: parse the 23 names from `src/index.ts`'s toolMap and assert
  (a) the pi-beads README enumerates all 23, (b) `pi-tools.md` enumerates all 23
  and lists `SubagentWorkflow`, (c) `SKILL.md` contains the workflow-critical
  subset. Reports missing names on failure.
- Home is pi-beads (owns the toolMap and its README); it reads the two psp docs
  by relative path, which is acceptable monorepo-internal coupling since the
  packages ship as one install.

## Verification

- `npm test` for pi-beads and pi-superpowers-plus.
- `git status` shows no `.superpowers`; `git ls-files .superpowers` is empty.
- Grep-audit for retired claims: `vitest`, `coctostan`, `no automated tests`,
  `skills and agent templates only`, `retry-plan.md`.
- Two commits: (1) docs truth-up, (2) dead-code/file removal + drift guard.

## Acceptance criteria

- No doc claim contradicted by code (the enumerated findings resolved).
- `git status` clean of `.superpowers`; dead files removed.
- The drift guard fails if a registered tool is absent from the enumerated docs.

## Out of scope

- Rewriting `CHANGELOG.md` (historical record).
- Any behavior change to extensions or tools — this is docs, dead-code, packaging,
  and one new test.
