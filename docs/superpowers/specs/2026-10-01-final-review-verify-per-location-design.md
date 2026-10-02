# Final review: verify per location, not per phrasing

Molecule: `pi-packages-mol-q5hl` · Task: `pi-packages-jnr7.1` (epic `pi-packages-jnr7`)

Date: 2026-10-01 · Status: approved design (`review.verdict=done` on `pi-packages-mol-w9kp`)

## Problem

The `sdd-final-review` workflow spent **1,767,655 tokens, 723 tool uses, 33 agents and
58.5 minutes** on the `ci-gate-hardening` diff (6 commits, 8 files, ~366 lines, most of it
spec prose). Measured on run `wf_623c1a4859b3`.

Agent count decomposes exactly: **5 dimension finders + 27 verifiers + 1 writer**. Of the 27
findings, **21 (78%)** were the six ledgered minors re-reported by different dimensions —
each of the six appeared ~4 times, once per lens that re-triaged it, and every re-statement
then got its own verifier. 2 findings were genuinely new; 4 were dimension summary lines
mistaken for findings. **~21 of 33 agents (64%) re-triaged items that already carried
rulings.**

**Root cause is caller discipline, not the script.** `requirement(d)` embeds
`ARGS.description` into every finder prompt as "What was implemented"
(`final-review.js:122`), and the controller passed the six deferred minors there "for
triage". Five finders read that as their assignment and each worked all six. The dedupe key
`file:line:normalize(description)` (`:90-93`) could not collapse them, because each
dimension phrased the item differently.

Secondary: `performance` returned **zero** findings on a diff that adds a CI job, docs and a
four-line guard, yet cost a finder — and `args.dimensions` (`:81`) exists and was not passed.

## Constraints (what must not change)

1. **Adversarial verification per unique finding.** It refuted 4 findings on that run,
   including one the controller had flagged itself, with evidence the controller had not
   checked. Highest-value output of the run.
2. **Dimension independence.** Three task reviews missed the stale design-spec section; the
   `correctness` lens caught it.
3. **The findings-file boundary.** The 1.77M tokens never entered the controller's context.
   The fan-out isolates context; it does not overload it. The cost is tokens and wall-clock.
4. **The script has no filesystem or ledger access.** It cannot read `progress.md`, and
   ledger minor lines (`Task <N>: minor (deferred): <one-liner>`, `fix-loop.md:9`) carry no
   file/line.

## Design decisions (resolved in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Evidence for the acceptance criteria | **Canned-fixture behavior test** through the existing `run-workflow.mjs` vm harness | The `pi-packages-mol-qoqe` run artifacts are gone from disk, so the exact 27 findings are unreproducible; finders are nondeterministic; a live re-run costs the very agents this task exists to save. The fixture proves the *mechanism*; the live confirmation is the epic's "next comparable final review" |
| Dedupe key | **Location** — `file:line`; a finding with no `line` keeps `file:normalize(description)` | Verification is per location. Line-less findings must not fold per file: that is the lossy direction |
| Losing descriptions | **Kept** in `alsoDescribed: [...]` on the merged row | Coarsening the key must not silently drop a real, distinct finding — the one failure mode this change introduces |
| `dimensions` on merge | **Union**, not append | With a coarser key, one lens reporting two phrasings at one location is ordinary; `['correctness','correctness']` is noise |
| Script-side fix #4 (skip verification for an item with a standing ruling) | **Dropped, deliberately** | Once the key is a location, the 21 restatements cost ~6 refuters, so the marginal saving is small; the bead's own AC forbids changing "one verifier per unique finding"; and the script would have to assert `isReal: true` on evidence it never checked — the exact thing verification exists to prevent. The duplication's source is the caller-side rule, which is fix #1 |
| Deferred-minors triage | **Controller-side, prescribed** (a single dedicated triage pass only as the fallback for a long list) | Offering two equal routes is what let "for triage" reach `description` |
| `SKILL.md:335` trigger | Amended — deferred minors are no longer a reason to take the workflow path | As written it read as "route minors *into* the workflow", the opposite of the new rule |
| The 2026-09-10 design spec | **Errata section**, not a silent rewrite | Its §4/§5 state the old key and 1:1 verify mapping. Leaving a stale present-tense claim in a doc this diff touches would reproduce the exact defect class the `correctness` lens caught on 2026-10-01 |

## 1. The key and the merge — `scripts/final-review.js`

```js
const SEVERITY_RANK = { minor: 1, important: 2, critical: 3 }
const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()
// Verification is per LOCATION, not per phrasing: the same item re-reported by
// several lenses — each phrasing it differently — must verify once. Severity is
// excluded too, so a file+line flagged at two severities still merges and the
// higher-severity phrasing wins. A finding with no line keeps the description in
// its key: folding every line-less finding in a file into one row drops signal.
const dedupeKey = (f) => (f.line ? f.file + ':' + f.line : f.file + ':' + normalize(f.description))

// The merged row keeps the highest-severity phrasing as `description` and every
// other distinct phrasing in `alsoDescribed` (normalized-compared, so identical
// phrasings never duplicate). Coarsening the key must not lose a description.
function mergeInto(prev, f) {
  const fWins = SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]
  const hi = fWins ? f : prev
  const lo = fWins ? prev : f
  return {
    ...hi,
    dimensions: prev.dimensions.includes(f.dimension)
      ? prev.dimensions
      : prev.dimensions.concat([f.dimension]),
    alsoDescribed: (prev.alsoDescribed ?? []).concat(
      normalize(lo.description) === normalize(hi.description) ? [] : [lo.description],
    ),
  }
}
```

`dedupe()` keeps its shape: a first sighting seeds `{ ...f, dimensions: [f.dimension] }`
(with no `alsoDescribed` key), every later sighting goes through `mergeInto`.

Note the existing merge at `:102-106` dropped the losing entry's description on a
severity-wins replacement; `mergeInto` is where that loss is closed.

## 2. Emission — refutation prompt, verify lines, envelopes

`alsoDescribed` is emitted **only when non-empty**, so the single-phrasing case stays
byte-identical to today and the documented join key is unaffected.

- **Refutation prompt** — the extra phrasings are listed **inside** the existing
  `BEGIN`/`END VERIFIED FINDING DATA` boundary. They are reviewer-authored text and obey
  the same untrusted-data rule as `description`:

  ```
  description: <hi.description>
  also reported as:
  - <extra 1>
  - <extra 2>
  ```

- **Verify line** — `...(f.alsoDescribed?.length ? { alsoDescribed: f.alsoDescribed } : {})`
  alongside `file`, `line`, `severity`, `description`, `verdict`.
- **Inline findings envelope** — the same spread on each finding, next to `dimensions`.

## 3. Deliberately unchanged

- `find` lines stay **raw per dimension** — the on-disk audit trail still shows all 21
  original reports. Coarsening happens only in the verification/report path.
- `WAVE = 6`, its sequential waves, and the ordered 1:1 `deduped[i] → verdicts[i]` mapping.
- `dimStatus`, `degraded`, `persisted`, `refuted`, and both envelope key sets. `count` now
  means merged rows.
- `FINDINGS_SCHEMA`, `VERDICT_SCHEMA`, `FOCUS`, `DEFAULT_DIMENSIONS`, and the
  membership-guard fallback. No new args.
- The single-reviewer fallback path and the fix loop.

## 4. Caller-side rule 1 — `reference/final-review.md`

> **Two caller-side rules (measured: getting them wrong cost 33 agents).**
>
> **1. Never put the deferred-minors list in `description`.** `description` is embedded
> verbatim in *every* finder prompt as "What was implemented" — it is context, not an
> assignment. On the 2026-10-01 `ci-gate-hardening` run six deferred minors were passed
> there "for triage"; all five finders read it as their job and worked all six, re-reporting
> them 21 times, each re-statement earning its own verifier — 21 of 33 agents. **Triage the
> minors in the controller** (you hold the ledger *and* the rulings); if the list is long
> enough to warrant a dispatch, give it ONE dedicated triage pass — never the finder
> fan-out. If finders must see it, it goes in the review package or a separate file, never
> `description`.
>
> **2. Pass `dimensions`, scaled to the diff.** The default is all five. `performance`
> returned zero findings on a diff that added a CI job, docs and a four-line guard, yet
> still cost a finder. Use `['correctness', 'plan', 'maintainability']` for most changes;
> add `security` when the change touches an enforcement path. Drop a lens when the diff
> cannot exercise it.
>
> Both rules matter for the target: the key change alone lands a measured-shape run at 14
> agents; the documented dimension list is what reaches ≤ 12.

The same file's join sentence — "join verify lines to findings by
file/line/normalized-description — the same dedupe key the script uses" — becomes: join by
`file:line` (line-less: `file` + normalized description); a verify line may carry
`alsoDescribed`, the other phrasings of the same location, which the refuter judged as one
item.

## 5. `SKILL.md` and `reference/fix-loop.md`

`SKILL.md:335` loses the trigger that invited this:

```
- **Workflow path** (preferred when `SubagentWorkflow` is present and the branch is
  large or broad — multi-file, many commits, security-sensitive): invoke the skill's
  final-review workflow per `reference/final-review.md`. Deferred minors are never a
  reason to take this path — the controller triages them (rule 1 in that reference).
```

`reference/fix-loop.md:9-12` is the origin of the habit and is rewritten in place:

```
- Record Minor findings in the progress ledger as you go
  (`Task <N>: minor (deferred): <one-liner>`), then **triage that list yourself in the
  controller** — you hold the ledger and the rulings. The list is not an assignment for
  the final review's finders (see `reference/final-review.md`, rule 1). A roll-up nobody
  reads is a silent discard; you are the reader.
```

The ledger format itself is unchanged — no file/line is needed, because the script never
sees the ledger.

## 6. Spec errata — `docs/superpowers/specs/2026-09-10-final-review-as-subagentworkflow-design.md`

An **Errata (2026-10-01)** section records that §4's key
(`file:line?:normalizedDescription`) and §5's one-refuter-per-surviving-finding description
are superseded: the shipped key is the location, description leaves it, and a merged row
carries `alsoDescribed`. It states why (this spec, §1) rather than rewriting history.

## 7. Tests — `scripts/final-review.test.mjs`

**Structural pins** (the existing `dedupeKey` test is rewritten; it currently pins the old
key):

- the lined branch is `f.file + ':' + f.line` with no description; the line-less branch keeps
  `normalize(f.description)`;
- `mergeInto` exists and `prev.dimensions.push` is gone (union, not append);
- `alsoDescribed` is guarded by `?.length ? … : {}` in both the verify line and the inline
  envelope;
- the refutation prompt places the extra phrasings between the `BEGIN`/`END VERIFIED
  FINDING DATA` markers.

**Behavior fixture** through the vm harness — the measured shape: **21 reports over 6
distinct `file:line`s, each phrasing the item differently**, plus 2 genuinely new findings,
one reported *only* by `correctness` (the stale design-spec-section analogue) and one by
`maintainability` (the SHA-pinning nit), across the five canned finders.

| Assertion | Covers |
|---|---|
| `findings.length === 8` and `refuterCalls === 8` — the 21 collapse to 6, nothing else lost | AC#2 |
| merged minors carry the union of `dimensions` and `alsoDescribed` holding the other phrasings | §1 |
| the `correctness`-only finding survives with its canned verdict | AC#4 (dimension independence) |
| `dimensions: ['correctness','plan','maintainability']` → `finderCalls === 3`, and `finders + refuters + writer === 12` | AC#1 |
| the writer heredoc still carries **3 raw `find` lines** with all **15** raw reports of those three lenses (13 restatements + 2 genuine), and **8 `verify` lines** | AC#4 (boundary) |
| in a separate variant, 4 line-less summary lines stay 4 rows, not 1 | §1 (line-less key), §8 residual |

The existing behavior tests stay as-is and keep passing. The current populated-run fixture
(two lenses reporting an identical description at `src/a.js:10`) additionally pins that a
merge with no distinct phrasing emits **no** `alsoDescribed` key.

Verification: `node scripts/ci/package-gate.mjs pi-superpowers-plus`, plus root `npm test`.
No dependency changes, so no lockfile churn.

## 8. Cost arithmetic on the measured shape

| Configuration | Finders | Refuters | Writer | Findings | Total |
|---|---|---|---|---|---|
| Measured run, 2026-10-01 | 5 | 27 | 1 | 27 | **33** |
| Coarse key only (5 dimensions) | 5 | 8 | 1 | 8 | **14** |
| Coarse key + documented dimension list (3 dimensions) | 3 | 8 | 1 | 8 | **12** |

The key change alone lands at 14, not 12 — the ≤ 12 target needs the documented `dimensions`
discipline as well. Both numbers are asserted or stated; neither is assumed.

**Residual, recorded not hidden:** the 4 line-less summary lines mistaken for findings are
not absorbed by a coarser key (they become 4 rows → 16 agents). They are a finder-prompt
artifact caused by the same root cause, and rule 1 plus the `dimensions` rule are what
remove them. The fixture pins their non-collapse so the behavior is tested rather than
hoped for.
Confirmed on the change's own final review (2026-10-01, `afb01f9`): one documentation defect was
verified three times because one lens reported `line: 4` and two reported no line — a lined finding
and a line-less one cannot merge, and roughly 4 of that run's 18 agents went to the three line-less
duplicates.

## 9. Acceptance criteria mapping

| Bead AC | Where satisfied |
|---|---|
| Materially fewer agents and findings, stale design-spec-section finding still produced | §7 fixture (33 → 12 on the measured shape; the `correctness`-only finding survives); §8 arithmetic |
| The dedupe change demonstrably collapses the 21 re-trials into ≤ 6 findings | §7 fixture: 21 reports over 6 locations → 6 rows |
| `reference/final-review.md` documents both caller-side rules with the measured cost | §4, §5 |
| No change to one-verifier-per-unique-finding, dimension independence, or the findings-file boundary | §3; §7 assertions on refuter count, the `correctness`-only finding, and the raw `find` lines |

**Limit of the evidence, stated plainly:** this is mechanism-level evidence from a canned
fixture, not a live run. The run's artifacts are gone and the finders are nondeterministic,
so an exact reproduction of the 27 findings is impossible; the live confirmation is the
epic's next comparable SDD final review.

## Out of scope

- **Script-side fix #4** (skip adversarial verification for a restatement of an adjudicated
  item) — dropped, per the decision table.
- `DEFAULT_DIMENSIONS` shrinking to three, or any other script-side default change: the
  dimension list stays a caller decision.
- Any change to `FINDINGS_SCHEMA`, `VERDICT_SCHEMA`, `WAVE`, the wave ordering, the
  degraded/`dimStatus` semantics, or the single-reviewer fallback.
- The ledger format (no file/line field).
- The gated fix loop, `fix-loop.js`, and the re-review head (`pi-packages-jnr7.2`).
- The implementer-resume defect (`pi-packages-6f0p`).
