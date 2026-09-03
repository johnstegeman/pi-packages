# Design: Step-key labels at pour time (R1 from pi-packages-pin)

**Date:** 2026-09-03
**Status:** Approved (brainstorming, molecule pi-packages-mol-o6j, discovered-from pi-packages-826)
**Owner:** pi-beads + pi-superpowers-plus

## Context

Refinement **R1** from `pi-packages-pin` (bead `pi-packages-826`): the
`superpowers-workflow` formula steps carry stable **semantic `id` keys**
(`explore`, `clarify`, `approaches`, `design`, `write-spec`, `spec-review`,
`implement`, `verify`, `finish`, plus the approval steps and the generated gate
keys `gate-design-approved`/`gate-spec-approved`/`gate-smoke-test-approved` — see
`packages/pi-superpowers-plus/formulas/superpowers-workflow.formula.toml`), but
`bd mol current`/`bd mol show --json` surface only **opaque runtime ids**
(`pi-packages-mol-<hex>`) and titles. Skills reference the semantic keys in prose
and must title-match to recover the runtime ids.

**Upstream-only conclusion:** changing `bd`'s mol output means touching the `bd`
CLI (abix5 fork), which lives outside this repo's editable surface. Out of scope
here.

**Accepted alternative (this design):** at **pour time**, stamp each step and gate
bead with a **`step:<key>` label** (in-tree, in `pi-beads`), and scope every lookup
to its molecule with **native `bd list --parent` / `bd ready --mol` flags**. Skills
then resolve any step/gate deterministically by
`beads_list({ label: "step:<key>", mol: "<root-id>" })` — no title-matching, no
upstream change.

## Goals & constraints

- Any formula step or gate resolves to its runtime id by semantic key,
  **deterministically** — including when two independent superpowers sessions /
  molecules exist in the same repo (the beads DB is shared/canonical across
  worktrees) and both carry the same `step:<key>` label.
- **No user-facing changes:** no new tools (pi-beads tool count stays 17), no `bd`
  CLI changes, no changes to `beads_mol_current`/`beads_mol_ready` output. Labels
  and the `mol` params are invisible plumbing.
- *"The safety of a label":* invisible when healthy, **fails loudly** when it
  cannot be guaranteed.

## Part 1 — Pour-time labeling (`beads_mol_pour`, pi-beads)

Pipeline added after a successful pour in `packages/pi-beads/src/index.ts`
`beads_mol_pour.execute`:

1. `bd mol pour <proto> [--var k=v]` → root id (existing behavior, output unchanged).
2. `bd mol pour <proto> --dry-run` (same `--var`s) → parse `- <title> (from
   <proto>.<key>)` lines into an ordered `(title, key)` list; skip the root line; a
   `gate-*` key is recorded against the **preceding** step key (bd generates these
   at dry-run, e.g. `gate-design-approved`).
3. `bd mol show <root> --json` → issues (`id`, `title`, `issue_type`) + the
   `blocks` dependency edges.
4. Match each keyed step by **exact title** → runtime id. For each **gate** bead,
   follow its `blocks` edge to the keyed step it gates ("User approves design" ←
   one gate, etc.) and assign that step's dry-run gate key. (Empirically verified
   on a live pour: all 15 keys map to unique ids, zero missing.)
5. `bd update <id> --add-label step:<key>` for every step **and** gate. Labels are
   plain short `step:<key>`; the molecule **root bead is not labeled**.

**Hard-fail safety:** if any keyed step/gate is unmapped, or a title matches more
than one issue, the pour **returns an error** (no root id, no partial labels — the
map is validated in full before any `bd update` is issued).

**Formula-agnostic:** dry-run prints `(from <proto>.<key>)` for any proto's steps,
so the mechanism is generic (tested against `superpowers-workflow`).

## Part 2 — Molecule-scoped lookup via native flags (`beads_list` / `beads_ready`)

- **`beads_list`** gains optional **`mol`** (a root id): maps to
  `bd list --all --parent <root> --include-gates` (+ any `--label`/`--labelAny`/status).
  `--parent` is a native server-side filter returning the molecule's immediate
  children (steps **and** gates — gates are hidden by default, hence
  `--include-gates`); `--all` includes closed steps/gates. No client-side
  `mol show` + filter loop.
- **`beads_ready` `mol` param: adjudicated out** — `bd ready --mol <root>`
  returns a digest (aggregate counts), not rows, so a label filter has nothing
  to key on; `beads_mol_ready` remains the compact digest, unchanged.
- **Concurrency:** two molecules in the same repo may both carry `step:<key>`;
  the `mol` param pins the lookup to one molecule's children.
- Impl nit: `bd list --parent <root>` alone returns `{"issues":[...],"meta":…}`
  while combined with `--label` returns a bare array — `fmtRows` normalizes both
  shapes (defensive `JSON.parse`).

*Note: `--metadata-field` / `--spec` on `bd list` were evaluated and rejected —
`--spec <root>` returns 0 (spec_id is not paired with the molecule root on poured
beads), and `--metadata-field` would require an extra pour-wide metadata write.*

## Part 3 — Skills wiring (consumer side)

Switch canonical step/gate addressing from "read `beads_mol_current` + match
titles" to a one-hop label lookup:

```
beads_list({ label: "step:<key>", mol: "<root-id>" })   # → runtime id
```

**Files** (all `packages/pi-superpowers-plus`):
- `skills/brainstorming/SKILL.md` (step/gate ids, currently via `beads_mol_current` / `next_step`)
- `skills/writing-plans/SKILL.md` (implement step id handed to execution)
- `skills/executing-plans/SKILL.md` (implement-step id for `beads_mol_ready`)
- `skills/subagent-driven-development/SKILL.md` + `implementer-prompt.md` + `task-reviewer-prompt.md` + `scripts/sdd-workspace` (implement step id threading)
- `skills/using-superpowers/references/pi-tools.md` (mention the label lookup)

**Carve-outs:**
- **No `plan-approved` label.** The formula has no plan-approval step; `writing-plans`
  creates that gate dynamically and returns its id as `GATE_ID` (the canonical
  Global Constraints spot). It stays unlabeled and is addressed by its returned id,
  unchanged.
- **Gate keys vs approval-step keys are distinct** (`gate-design-approved` vs
  `design-approved`) — no label collisions.
- **`beads_mol_current` / `beads_mol_ready` outputs are untouched** — labels are a
  parallel lookup path, not a change to those tools.

## Success criteria

1. `beads_mol_pour` stamps exactly one `step:<key>` per step + gate (15 for
   superpowers-workflow), none on the root.
2. Hard-fail: missing/ambiguous title → pour errors out with no partial labels.
3. `beads_list({ label: "step:<key>", mol: <root> })` returns exactly that
   molecule's bead even when another molecule in the same repo shares the label.
4. A fixture **two molecules in the same repo** sharing `step:implement` proves
   isolation (Part 3 test).
5. An agent can drive brainstorm → plan → implement resolving every formula
   step/gate by label, never reading a step title.
6. pi-beads tool count stays 17; `packages/pi-beads/package.json` bumps
   `0.3.0 → 0.4.0`.

## Out of scope

- Backfilling already-poured molecules (only pours through `beads_mol_pour` going
  forward are labeled; backfill could be a separate later item).
- Changing the `bd` CLI (upstream abix5) — the original R1 ask.
- Any change to `beads_mol_*` outputs or new user-facing beads surface.

## Verification

From `packages/pi-beads` (TDD via the existing fixture-`bd` harness):

- New stub cases: `mol pour` (real + `--dry-run`), `mol show --json`,
  `update --add-label`, `list --parent/--include-gates`, `ready --mol`.
- Tests: 15 labels land (one per key, none on root); `--var` fidelity between real
  and dry-run pours; hard-fail for missing step and for ambiguous title; two-molecule
  same-repo isolation via `mol`-scoped `beads_list`; `mol` param plumbing for
  `beads_list` (only `beads_list` gained the param — `beads_ready` did not).
- Skills grep: no remaining `beads_mol_current`-based step-id *addressing* (the
  `next_step`/gate-find prose moves to `beads_list({label, mol})`).
