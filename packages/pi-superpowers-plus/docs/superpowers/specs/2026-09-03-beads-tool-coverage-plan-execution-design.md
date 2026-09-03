# Complete beads tool coverage for plan execution

**Date:** 2026-09-03
**Status:** Approved (design)
**Source issues:**
- `pi-packages-6np` — `beads_ready` has no `--mol`/molecule-scoped frontier filter (`executing-plans` relies on raw `bd ready --mol`)
- `pi-packages-jac` — `subagent-driven-development`: no reusable Global Constraints artifact when plan output is beads (no plan.md)

This work closes the two remaining tails of the `pi-packages-i1i` "route all beads access through `beads_*` tools" effort. Both issues were logged as deferred minors from the event-driven beads widget review (`pi-packages-mol-0lj`). Both concern the **plan-execution** leg of the beads-as-persistence brain/plan/execute cycle.

---

## 1. Overview

Plan execution reads/bears two gaps that still force raw `bd` CLI usage (or lossy memory reconstruction) from the Superpowers skills:

1. **No mole molecule-scoped "ready frontier" read.** `executing-plans/SKILL.md` calls the raw `bd ready --mol <implement-step-id>` three times (L40, L47, L63) because no `beads_*` tool exposes a molecule-scoped ready query.
2. **No reusable Global Constraints artifact.** When a plan's output is beads (task beads under the `implement` step, not a plan.md), the plan's `## Global Constraints` section is folded inline into every task bead's description. `subagent-driven-development`'s task-reviewer dispatch reconstructs the constraint block from memory per task, risking drift.

Both are small, additive, and non-breaking. No existing tool or skill behavior changes; the changes add capability and point existing prose at the new canonical source.

---

## 2. Design decisions (approved)

| Decision | Choice | Rationale |
| --- | --- | --- |
| 6np API shape | New dedicated `beads_mol_ready` tool | Mirrors `bd ready --mol` one-to-one; consistent with the existing `beads_mol_pour/show/current` family; keeps `beads_ready`'s whole-umbrella contract untouched |
| jac artifact home | Plan-approval gate bead's **description** | `writing-plans` already creates this bead; SDD already touches it; zero extra beads, zero new tool capability |
| jac reviewer integration | Approach A: reviewer subagent reads the gate bead directly | Deterministic, no transcription/drift — kills the failure mode the issue describes |
| Task-bead inlining | **Keep** verbatim inline copies | Zero risk; the canonical bead is the reviewer/controller source, execution-time requirement text unchanged |

---

## 3. Part 1 — New `beads_mol_ready` tool

**File:** `packages/pi-beads/src/index.ts`

### 3.1 Tool registration

- Add `molReady: "beads_mol_ready"` to the `TOOL` map (beside `molPour`/`molShow`/`molCurrent`).
- `pi.registerTool` with:
  - `name: "beads_mol_ready"`
  - `label: "Beads molecule ready"`
  - `description`: "Show the ready frontier of one molecule's steps (`bd ready --mol <id>`): which steps/tasks are unblocked right now. Accepts a molecule id or a step id (e.g. an implement step with task children). Read-only; aggregate-aware; id prefix shows the owning project."
  - `parameters`: `id` (string, required: "Molecule or step id, e.g. the implement step id"), `limit` (number, optional: "Max steps shown (no default -> bd default)")

### 3.2 Execution

```
await ensureFresh();
const args = ["ready", "--mol", String(params.id), "--json"];
if (params?.limit) args.push("-n", String(params.limit));
const r = await bd(args, umbrella);
if (!r.ok) return textResult(`bd ready --mol failed: ${r.err}`);
return textResult(fmtMolReady(jparse(r.out)));
```

Routing: run against the **umbrella aggregate** (`umbrella`), identical to every other `beads_mol_*` read (`molShow`, `molCurrent`). No prefix-routing to the owning repo — reads flow through the aggregate, which already resolves cross-repo molecule ids.

### 3.3 Formatter — `fmtMolReady`

`bd ready --mol <id> --json` returns an object where `steps[]` already contains **only the ready steps** (each with `parallel_info.is_ready: true` and `issue.status: "open"`); `total_steps` is the full step count:
```
{ molecule_id, molecule_title, ready_steps, total_steps, steps: [ { parallel_info: { is_ready: true, step_id, ... }, issue: { id, priority, status, title, issue_type, ... } }, ... ] }
```

Output shape (compact, `fmtRows` style — map directly over the already-filtered `steps[]`):

```
molecule: <molecule_id> — <molecule_title> · <ready_steps>/<total_steps> ready
<ID> P<n> [status] <title>            # one line per step in steps[] ({issue.id} {issue.status} {issue.title})
```

Empty case (must be unambiguous — `executing-plans` Step 5 depends on it):

```
molecule: <molecule_id> — <molecule_title> · 0/<total_steps> ready
no ready steps (all blocked or completed)
```

Malformed/unparseable JSON falls back to `r.out.trim()` (same pattern as `fmtRows`).

### 3.4 Version

Minor version bump on `packages/pi-beads/package.json` (new capability shipped in the tool package).

---

## 4. Part 2 — Convert executing-plans to `beads_mol_ready`

**File:** `packages/pi-superpowers-plus/skills/executing-plans/SKILL.md`

Replace all three raw `bd ready --mol <implement-step-id>` invocations with the tool:

| Line | Current | New |
| --- | --- | --- |
| L40 | "working the ready frontier (`bd ready --mol <implement-step-id>` shows what's unblocked right now)" | "working the ready frontier (`beads_mol_ready({ id: "<implement-step-id>" })` shows what's unblocked right now)" |
| L47 | "re-run `bd ready --mol <implement-step-id>` to see the next batch" | "re-run `beads_mol_ready({ id: "<implement-step-id>" })` to see the next batch" |
| L63 | "confirm with `bd ready --mol <implement-step-id>` returning empty" | "confirm with `beads_mol_ready({ id: "<implement-step-id>" })` returning no ready steps" |

**Also:** `using-superpowers/references/pi-tools.md` — if it still lists `bd ready --mol` as a raw-`bd` call (it appears in a list of still-raw calls), update it: the fallback is no longer needed for the ready frontier, or drop it from the raw-`bd` examples outright.

**Not touched:** historical records — `docs/superpowers/specs/2026-09-02-beads-as-persistence-layer-design.md` and `docs/superpowers/plans/2026-09-02-beads-as-persistence-layer.md` document the original design and keep `bd ready --mol` as the described mechanism. They are records, not living skill instructions, and are left as-is.

---

## 5. Part 3 — Global Constraints on the plan-approval gate bead

### 5.1 `writing-plans` — populate the gate bead

**File:** `packages/pi-superpowers-plus/skills/writing-plans/SKILL.md`, section "Creating Tasks as Beads".

The existing gate creation

```
GATE_ID = beads_create({ title: "Plan reviewed / ready to execute", parent: "<implement-step-id>", type: "task" })
```

becomes

```
GATE_ID = beads_create({
  title: "Plan reviewed / ready to execute",
  parent: "<implement-step-id>",
  type: "task",
  description: "## Global Constraints\n<constraints block verbatim from the plan header>",
})
```

Add one sentence of prose next to the snippet: the gate bead's description is the **canonical Global Constraints artifact** for the plan — copy the plan's `## Global Constraints` section verbatim (exact values, exact formats, stated component relationships) — and it remains readable after the gate is resolved/closed.

This is purely additive: the bead was already created and gated; only its `description` is now populated. No dependency, status, or lifecycle change.

### 5.2 `subagent-driven-development/task-reviewer-prompt.md`

**File:** `packages/pi-superpowers-plus/skills/subagent-driven-development/task-reviewer-prompt.md`

Replace the inline `[GLOBAL_CONSTRAINTS]` block in the reviewer prompt body

```
Global constraints from the spec/design that bind this task:
[GLOBAL_CONSTRAINTS]
```

with an instruction to read the canonical source:

```
The canonical Global Constraints for this plan live in the plan-approval
gate bead's description (writing-plans populated it). Read it now:
beads_show({ id: "[GATE_ID]", full: true }).
Those constraints bind the task under review.
```

And replace the `[GLOBAL_CONSTRAINTS]` entry in the **Placeholders** list with:

```
- `[GATE_ID]` — REQUIRED: the plan-approval gate bead id; its description
  holds the plan's canonical Global Constraints (written by writing-plans).
  The reviewer reads it with beads_show and applies those constraints to the
  task under review.
```

### 5.3 `subagent-driven-development/SKILL.md`

Two spots currently point elsewhere for constraint sourcing:

1. **Setup** (L155-156): "note its context and Global Constraints from each task bead's description, and confirm the `plan-approved` gate is closed". Update to reference the gate bead as the canonical home:
   - Read the molecule once (`beads_mol_current`), note its context, and confirm the `plan-approved` gate is closed. The plan's canonical Global Constraints live in that gate bead's description (`beads_show({ id: "<plan-approved-gate-id>", full: true })`); it is the single source handed to reviewers.
2. **Review the task** (L250-259): "The global-constraints block you hand the reviewer ... Copy the binding requirements verbatim from the plan's Global Constraints section or the spec". Replace with: the global-constraints block comes from the plan-approval gate bead's description — read it once via `beads_show` and pass the gate bead id to the reviewer dispatch, which carries the read instruction itself.

**Unchanged:** implementer dispatch (`implementer-prompt.md`) and the Setup conflict-scan prose ("tasks that contradict each other or the plan's Global Constraints") — task beads still inline the constraints verbatim, and the conflict scan still reads the plan, not the bead.

---

## 6. Part 4 — Verification

**pi-beads (`packages/pi-beads`)** — extends the existing `node:assert` harness `test/pi-beads.test.mjs` (no framework; a fixture `bd` on PATH shadows the real binary, logs every argv, and serves canned topology/molecule JSON). TDD:
1. Failing tests added first: tool-registration count 16→17 (add `beads_mol_ready` to the sorted list); the read-tools `never emit beads:changed` table gains `beads_mol_ready` (argv `["ready", "--mol", <id>, "--json"]`); new digest tests for header + ready frontier and for the empty `no ready steps (all blocked or completed)` case; `limit` plumbing (`-n <N>`); the fixture stub gains a `ready --mol` case serving canned JSON (keyed on the molecule id containing `empty` for the 0-ready case).
2. Run `npm test` → fail (tool not registered).
3. Implement `beads_mol_ready` + `fmtMolReady` in `src/index.ts`.
4. `npm test` → all pass.
5. Manual smoke against the real database (in an interactive pi session, not the fixture): `beads_mol_ready({ id: "<live-molecule-root>" })` on a molecule with ready work → header `N/M ready` + frontier; on a fully-blocked molecule (e.g. `pi-packages-mol-0lj`) → `0/N ready` + `no ready steps (all blocked or completed)`; on an `implement`-step id with task children → the ready *task* frontier; confirm output is lean (no raw `bd` JSON dump).

**pi-superpowers-plus (`packages/pi-superpowers-plus`)** — grep checks:
- `grep -rn "bd ready --mol" skills/` → zero matches (only historical `docs/superpowers/specs|plans/*` may retain the string).
- `grep -rn "GLOBAL_CONSTRAINTS" skills/subagent-driven-development/` → only the rewritten Placeholders entry + reviewer-body instruction; no inline "copy from memory" wording remains.
- Markdown consistency: the changed `SKILL.md`/template files parse cleanly (the repo's CI/doc-parity gate on PRs to main will catch malformed markdown).

**Cross-check:** no other living skill references `bd ready --mol` or reconstructs Global Constraints from memory; `writing-plans`'s Self-Review already mirrors the plan into task beads and now also populates the gate bead description.

---

## 7. Boundaries / Out of scope

- **Historical docs** (`2026-09-02-beads-as-persistence-layer*.md`) untouched — they are records.
- **No behavior change** to `beads_ready`, `beads_mol_show`, `beads_mol_current`, `beads_gate_resolve`, or the beads-molecule-widget extension.
- **No new task bead** ("Global Constraints") and **no dependency edge changes**.
- **Task beads keep inlining** constraints verbatim (explicit user decision) — the gate bead is the *canonical*, not the *only*, copy.
- **Test-suite work IS in scope** in pi-beads: the existing `test/pi-beads.test.mjs` harness is extended with `beads_mol_ready` coverage (fixture + argv + digest) per §6. No new framework or runner is added.

---

## 8. Packaging / delivery

- One branch / one PR per the repo's CI gate (manifest + typecheck + doc-parity).
- `packages/pi-beads` — minor version bump, new tool `beads_mol_ready`.
- `packages/pi-superpowers-plus` — skill doc + template prose changes, no version-sensitive surface.

---

## 9. Implementation shape (for the plan)

Two tasks under one `implement` step:

1. **Task 1 — `beads_mol_ready` tool.** TDD in `packages/pi-beads`: extend `test/pi-beads.test.mjs` (fixture `ready --mol` canned JSON, registration count, read-argv table, digest tests), then implement the tool + `fmtMolReady` + `TOOL` map entry in `src/index.ts`; minor version bump 0.2.2 → 0.3.0. Verification: `npm test` + manual smoke per §6.
2. **Task 2 — skill prose conversions.** `executing-plans/SKILL.md` (3 calls), `using-superpowers/references/pi-tools.md` (stale raw-`bd` mention), `writing-plans/SKILL.md` (gate bead description), `subagent-driven-development/SKILL.md` (2 spots), `subagent-driven-development/task-reviewer-prompt.md` (`[GATE_ID]` + read instruction). Verification: grep checks per §6.
