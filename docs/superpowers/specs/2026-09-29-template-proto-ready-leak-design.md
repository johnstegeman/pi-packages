# Design: stop template protos leaking into ready work; retire `bd cook --persist`

Date: 2026-09-29
Status: approved (design review), pending implementation
Tracking: `pi-packages-h0ym` (bug), molecule `pi-packages-mol-hg7b`

## Problem

`bd` models a reusable workflow template as a **proto**: a `molecule`-type root
carrying the `template` label, with one child bead per step, all `is_template:
true` and all `status: open`. Protos are not work items. `bd list` hides them by
default, but `bd ready` does not — and neither does the `beads_ready` tool that
wraps it, nor the `/beads` board.

Reproduced against `pmm-iris` (bd 1.3.0):

```
$ bd ready                    → ○ superpowers-workflow.explore P2 Explore project context: {{topic}}
$ bd list                     → (nothing; templates hidden by default)
$ bd list --include-templates → the full 16-step template tree
```

Only the chain head leaks (`superpowers-workflow.explore`); the other steps are
masked by their `needs:` dependencies. The unresolved `{{topic}}` is the tell
that it is a template, not work. Impact: a template appears as actionable work in
every triage view, and `beads_ready({claim:true})` could claim a template step.

The persisted proto is created by the brainstorming skill's Step 0, which
instructs `bd cook superpowers-workflow … --persist`. `bd cook --help` calls
`--persist` **legacy** ("pour and wisp commands accept formula names directly and
cook inline"), so removing it stops the leak being recreated.

## Evidence gathered during design

- `bd ready --exclude-label template` **does not** filter the step (still 1
  match): the `template` label is on the root only; the step is an ordinary
  `task` with no labels. `--exclude-type molecule` likewise does not help (the
  step's type is `task`). The forwarded plan's "B1 = add `--exclude-label
  template`" is therefore **disproven** and rejected.
- The `--json` ready rows do carry usable signals, present only on template rows:

  ```
  {'id': 'superpowers-workflow.explore', 'is_template': True, 'parent': 'superpowers-workflow', ...}
  ```

  A non-template row omits `is_template` entirely.
- `beads_mol_pour({ proto: "superpowers-workflow" })` poured all 16 steps with
  **no** prior `bd cook --persist`, confirming pour-by-formula-name works and
  that dropping `--persist` is safe.
- Prior investigation (`pi-packages-h0ym`) established that proto/template beads
  are **read-only** in bd: `bd update` is refused on the step, its siblings, and
  the root. So the interim mitigation "defer the leaking step" is **impossible**,
  not merely hacky, and is dropped from scope.
- The residual gap in raw `bd ready` (outside our tools) is a bd-side
  inconsistency (`bd list` hides templates, `bd ready` has no equivalent filter).
  It will be **noted in the commit message**, with no follow-up bead.

## Scope

One change, two packages:

- `packages/pi-beads` — filter template rows out of the ready paths (B1'–B5).
- `packages/pi-superpowers-plus` — retire the persisted-proto path in the
  brainstorming skill and the using-superpowers tool reference (S1–S2), and
  annotate the historical docs that document `--persist` (S3).

**Out of scope:** deleting the persisted proto in any repo's DB; changing
`beads_mol_ready`; any bd upstream change (recorded as a note only).

## Design

### 1. Seam

Add one small helper next to `fmtRows`/`jparse` in `packages/pi-beads/src/index.ts`:

```ts
const stripTemplates = (json: string): string => {
  const o = jparse(json);
  const arr = Array.isArray(o) ? o : o?.issues;
  if (!Array.isArray(arr)) return json;           // unparseable → leave as-is
  return JSON.stringify(arr.filter((r) => r?.is_template !== true));
};
```

`fmtRows` and `jparse` are left untouched — they are shared with `list`/`stale`,
which already receive template-filtered data and must not double-filter.

### 2. `beads_ready` — non-claim path (`src/index.ts` ~749)

Current: `return textResult(fmtRows(r.out));`
New: `return textResult(fmtRows(stripTemplates(r.out)));`

`is_template` is already in the payload, so there is **no** extra `bd` call; the
`-n` limit is applied by `bd`, and the existing optional `--label` /
`--label-any` filters are unchanged. No `--exclude-label template` flag is added
(proven no-op). In a repo whose only "ready" row was the template, the tool now
reports `(none)`.

### 3. `beads_ready` — claim path (pick-then-update)

The server-side `bd ready --claim` is removed for the claim path, because it
claims server-side and could atomically grab the template step regardless of our
filtering. New flow:

1. Fetch `ready --json` (no `--claim`), parse, drop `is_template` rows, take head.
2. If the filtered set is empty → return the empty listing; no mutation, no
   `beads:changed`.
3. Otherwise claim the chosen id explicitly:
   - single-repo: `bd update <id> --claim` in the repo dir;
   - umbrella: reuse the existing owning-repo re-assert (`dirForPrefix`),
     which already runs `update <id> --claim` in the owner.
4. Emit `beads:changed` after a successful claim (via the existing `afterWrite`
   path), matching today's umbrella behaviour, then format the output from the
   chosen row.

Trade-off (accepted): the claim is no longer atomic **across processes** at the
`bd ready --claim` level; `bd update <id> --claim` is still atomic for the
individual issue. The README/SKILL wording changes from "atomically claims the
first match (`bd ready --claim`)" to "claims the first **non-template** match",
and `--claim` is no longer part of the `beads_ready` argv.

### 4. `/beads` board (`src/index.ts` ~1906)

Same wrap: `fmtRows(stripTemplates(ready.out))`. Nothing else changes.

### 5. `beads_mol_ready` (~1748) — deliberately unchanged

`beads_mol_ready` is scoped to one molecule's steps via `bd ready --mol`; when
asked about a template it must still return that template's steps. The existing
comment documenting the deliberate difference stays.

### 6. S1 — brainstorming skill

`packages/pi-superpowers-plus/skills/brainstorming/SKILL.md`:

- Line 25: delete `bd cook superpowers-workflow --var topic="<topic>" --persist`;
  keep the single `beads_mol_pour({ proto: "superpowers-workflow", vars:
  "topic=<topic>" })`.
- Fresh-topic prose: "cook and pour" → "pour the workflow formula".
- Step-0 completion sentence: replace the "calling `bd cook` / `beads_mol_pour`
  alone is not enough" phrasing with "`beads_mol_pour` **and**
  `beads_mol_current` have both run and the widget is visible".
- Step-0 recap line: keep as a pointer to the gate; no `cook`.
- `reference/anti-patterns.md` ~line 18: verify no `cook` reference remains; edit
  only if one does.

### 7. S2 — using-superpowers tool reference

`skills/using-superpowers/references/pi-tools.md`:

- "(`bd cook`/`bd mol pour`)" → "(`bd mol pour`)".
- "bare `bd` is reserved for formula prep (`bd cook`)" → reserved for raw/read
  `bd` where no tool exists; pour-by-formula-name is the path.

### 8. S3 — annotate prior docs (do not rewrite history)

`--persist` also appears in:

- `docs/superpowers/plans/2026-09-02-beads-as-persistence-layer.md:175`
- `docs/superpowers/specs/2026-09-03-event-driven-beads-widget-design.md:136`

Add a one-line note to each that `--persist` is superseded (pour-by-formula-name;
the persisted proto was the source of the `bd ready` leak), leaving the original
text intact. `…internals-fixes-design.md` does not mention `--persist` — no edit.

### 9. Docs (B4)

- `packages/pi-beads/README.md` `beads_ready` row: state template protos are
  excluded; note `claim` claims the first non-template match.
- `packages/pi-beads/skills/beads/SKILL.md` `beads_ready` row: same.
- Read-tool name enumerations need no change.

### 10. Tests (B5)

- `packages/pi-beads/test/pi-beads.test.mjs` (hermetic `bd` double via
  `helpers/fake-bd.mjs`): add a canned `ready --json` payload containing one
  `is_template:true` row plus real rows; assert it is absent from `beads_ready`
  output, and that `claim:true` claims the first **real** row and issues
  `update <id> --claim` — never the template id. Mirror the board path.
- `packages/pi-beads/test/tool-surface.test.mjs`: extend the doc-drift guard so
  the `beads_ready` rows in README.md and SKILL.md both mention the template
  exclusion.
  assert the README/SKILL wording mentions the template exclusion if useful.

## Verification / definition of done

1. In a repo with a cooked proto, `beads_ready` and `/beads` omit any
   `superpowers-workflow.*` step; `bd list --include-templates` still shows the
   template; `beads_mol_ready` on a template still returns its steps.
2. `beads_mol_pour({ proto: "superpowers-workflow", vars: "topic=<x>" })` works
   end-to-end and yields `open`, correctly-chained steps (evidence: pour output +
   `bd mol current <root>`).
3. The brainstorming skill's Step 0 no longer writes a proto to the DB and still
   works from a clean state.
4. `node scripts/ci/package-gate.mjs pi-beads` and `… pi-superpowers-plus` are
   green (run under `mise exec node@22` per AGENTS.md).
5. The commit notes the residual raw-`bd ready` gap as a bd-side inconsistency /
   client workaround.

## Going live

`pi-beads` is declared `main: ./src/index.ts` with **no build step**, and skills
are read at runtime. The fix therefore takes effect once `pi` reloads the package
from the git checkout (reload / update the installed packages); no publish is
required.

## Rejected alternatives

- **bd-native `--exclude-label template`** — disproven; the label does not reach
  the steps.
- **Resolve each row's molecule root and test its label** — dominated by the
  `is_template` field already present in the payload.
- **Defer the leaking step** (`bd update … --status deferred`) — impossible;
  template beads are read-only in bd.
- **Burn the persisted proto** — out of scope: the delete is Dolt-synced, and
  pour's resolution order between a same-named proto and the formula is
  unverified.
