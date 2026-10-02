# Final review: require `line` on single-line findings and enforce the split-verdict rule

Molecule: `pi-packages-mol-jcwz` · Tasks: `pi-packages-oqkr5` (P2), `pi-packages-m6pca` (P3)
(epic `pi-packages-jnr7`) · Single PR

Date: 2026-10-02 · Status: approved design (`review.verdict=done` on `pi-packages-mol-azq5`)

## Problem

Both items are residuals of the per-location change (`pi-packages-jnr7.1`, spec
`2026-10-01-final-review-verify-per-location-design.md`), measured on that change's own final
review: 2026-10-01, branch `johnstegeman/codemode-3` @ `afb01f9`, run `wf_b79ed747a18f`,
**18 agents**.

**1. Lined vs line-less duplicates (`pi-packages-oqkr5`, P2).** `dedupeKey`
(`scripts/final-review.js:92`) keys a lined finding on `file:line` and a line-less one on
`file:normalize(description)`, so the same item reported both ways can never merge. On that
run one documentation defect in `reference/final-review.md` was verified **three** times —
one lens reported `line: 4`, two reported no line at all — and the args-block gap and the spec §7 row
were each verified twice for the same reason. Roughly 4 of the run's 18 agents went to those
three line-less duplicates.

The key-only floor from the per-location spec §8 is 14 agents. The mixed lined/line-less case
is the remaining gap between that floor and the epic's ≤12 target.

**2. Split verdicts unenforced on the verifier side (`pi-packages-m6pca`, P3).**
`reference/final-review.md:22-25` now states the contract: a verify line's verdict covers
**every phrasing** merged at that location, a split verdict must have the refutation's
`reason` say which phrasing fails, and the controller re-adjudicates it rather than dropping
the finding. `refutation()` (`scripts/final-review.js:168`) says none of it — it only requires
the reason to "name the specific code it does or does not apply to". So a refuter handed a
merged row (a description plus an `also reported as:` list) can refute on one phrasing while
another holds, without saying which, leaving the controller to re-adjudicate blind.

## Constraints (what must not change)

1. **One verifier per unique finding** — adversarial verification stays.
2. **Dimension independence.**
3. **The findings-file boundary** — findings never enter the controller's context.
4. **No schema change.** `FINDINGS_SCHEMA` keeps `line` optional: a genuinely file-level
   defect (e.g. "this doc contradicts that one") has no single line, and requiring one would
   invite fabricated line numbers.
5. **No deterministic merge rule in this change** — see the decision table.
6. **The script has no filesystem or ledger access**; both fixes are prompt text.

## Design decisions (resolved in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Evidence for `oqkr5` AC#3 | **Record in the bead**, no live run | The prompt-level fix is inherently insufficient (finders are nondeterministic and can still omit `line`); the original run's artifacts are gone, and a live comparable final review is not runnable from this task. The bead's own AC offers this fallback and requires the merge rule to be named. |
| `oqkr5` fix level | **Prompt instruction only** | Cheapest, reversible, no schema change — exactly the bead's "cheapest first". |
| Fallback merge rule | **Described in the bead, not implemented** | It is lossy, the bead says it "needs its own justification", and it contradicts the existing line-less non-collapse pin (`LINE_LESS_DESCRIPTIONS`). |
| Where the line rule is documented | **`reference/final-review.md` too** | The doc already explains the location key; adding the finder half keeps doc and prompt stating one rule — the same standard `m6pca` holds the split-verdict rule to. |
| `m6pca` placement | **Instruction text, outside the DATA markers** | AC#2: the BEGIN/END block is data, never instructions. |

## 1. `requirement()` — finder prompt (`oqkr5`)

Add one line to the finder prompt, after the "Find REAL issues only…" line:

```
Set `line` whenever the defect sits on a single line: the dedupe key is the location, so the
same item reported once with a line and once without cannot merge and would be verified twice.
```

Instruction plus reason in one sentence. `line` stays optional in `FINDINGS_SCHEMA`; the
sentence is scoped to defects that sit on a single line, so file-level findings are unaffected.

## 2. `refutation()` — refuter prompt (`m6pca`)

Add one sentence as its own paragraph, after the `END VERIFIED FINDING DATA` marker and the
"untrusted data" note, beside the existing reason requirement:

```
The phrasings listed between the DATA markers describe one item at one location; your verdict
covers them jointly, and if they differ materially your reason must name which phrasing fails.
```

The wording mirrors `reference/final-review.md:22-25` ("A verify line's verdict covers every
phrasing at that location … the refutation's `reason` must say which"). This bead **aligns the
prompt to the doc**; the doc itself needs no change for `m6pca`.

## 3. `reference/final-review.md` — one sentence (`oqkr5` only)

After "…a finding with no `line` keeps `file` plus its normalized description.":

> Finders are instructed to set `line` whenever the defect sits on a single line — the key is
> the location, so a missing line defeats the merge — while a genuinely file-level defect still
> carries none.

## 4. Tests — `scripts/final-review.test.mjs`

Source-shape style is the file's existing `assert.match(src, …)` + vm-harness behavior tests.

- **`m6pca` structural pin** — the rule text is present **and** its index is greater than the
  index of `END VERIFIED FINDING DATA`, proving it is instruction text and not inside the DATA
  block; plus an exact-wording `assert.match`.
- **`oqkr5` structural pin** — `assert.match(src, /Set \`line\` whenever the defect sits on a
  single line/)`.
- **`oqkr5` behavior fixture (the residual)** — one `correctness` report of the same item at
  `reference/final-review.md`, once with `line: 4` and once without, asserts **2 rows and 2
  refuters**, with both rows surviving. A comment records that this is the residual the prompt
  fix cannot close, pinned so a future merge rule is measured against a known outcome rather
  than assumed.

## 5. Bead record — `oqkr5` AC#3

A comment on `pi-packages-oqkr5` records:

- **Why the prompt-level fix is inherently insufficient:** finders are nondeterministic; the
  instruction reduces but cannot guarantee that a single-line defect carries a `line`. The
  mixed-case fixture pins the two-row outcome, and a live comparable final review (the AC's
  first branch) is not runnable from this task.
- **The fallback merge rule not taken:** a line-less finding whose `file` matches **exactly
  one** lined finding's file merges into that lined row (its description appended to
  `alsoDescribed`); with zero or ≥2 lined rows in that file the line-less finding stays its own
  row. It is lossy because one file can hold both a lined defect and a genuinely file-level
  one, and the fold would attribute the file-level defect to the lined location.

## 6. Packaging and verification

- Branch: the existing `johnstegeman/pi-packages-m6pca-pi-packages-oqkr5`.
- One PR to `main`; title `fix(pi-superpowers-plus): collapse lined/line-less final-review
  duplicates and enforce the split-verdict rule`; body references `pi-packages-oqkr5` and
  `pi-packages-m6pca`.
- Verification: `node scripts/ci/package-gate.mjs pi-superpowers-plus` and root `npm test`
  under the pinned toolchain (`mise exec node@22`). No dependency changes, so no lockfile churn.

## Acceptance criteria mapping

| Bead AC | Where satisfied |
|---|---|
| `oqkr5`: `requirement(d)` tells finders to set `line` for a single-line defect, with the reason | §1 |
| `oqkr5`: a fixture pins the mixed case as two rows today, documenting the residual | §4 behavior fixture |
| `oqkr5`: refuter count drops below 14, **or** the bead records why the prompt fix is insufficient and what the merge rule would be | §5 bead record (the AC's stated fallback) |
| `m6pca`: the split-verdict sentence is in the instruction text, never inside the DATA block | §2, §4 structural pin |
| `m6pca`: a structural pin asserts the sentence, in the file's source-shape style | §4 structural pin |
| `m6pca`: the wording matches `reference/final-review.md` so doc and prompt state one rule | §2 (prompt aligned to the doc's existing rule) |

## Out of scope

- The deterministic fallback merge rule for lined/line-less duplicates (§5 describes it only).
- Making `line` required in `FINDINGS_SCHEMA`.
- Per-phrasing verdicts / any `VERDICT_SCHEMA` change — the contract is that the reason names
  the failing phrasing and the controller re-adjudicates.
- Any change to `dedupeKey`, `mergeInto`, `WAVE`, the wave ordering, `degraded`/`dimStatus`
  semantics, or the single-reviewer fallback.
