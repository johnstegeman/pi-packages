# `selectGate` composition — design

- **Date:** 2026-09-25
- **Issue:** `pi-packages-4vmn` (bug, P2) — "package-gate.mjs: selectGate still drops a lint-only `check` when the package also declares a separate typecheck"
- **Origin:** final whole-branch review of `pi-packages-xh2n` (PR #63, merged as `5083f89`); the same class had already been fixed twice inside this one function
- **Molecule:** `pi-packages-mol-po9c` (superpowers-workflow)
- **Branch:** `fix/package-gate-select-composition`, cut fresh from `main` (`5083f89`)

## Problem

`selectGate` decides which scripts a package's CI gate runs. It works by regex-matching script
*text* to infer whether one declared script embeds another, and that inference has now silently
dropped a declared script **three times in this one function**:

1. `check` covers `test` but not `typecheck` → returned `typecheck && test`, dropping the rest of
   `check`. Fixed in PR #63 (`92d6019`).
2. `check` does **not** cover `test`, and a `typecheck` exists → returns
   `npm run typecheck && npm test`, **dropping `check`**.
3. `check` does **not** cover `test`, and no `typecheck` exists → returns `npm test`, **dropping
   `check`** as well.

The bead names case 2; case 3 is the same defect, is arguably the likelier shape (a lint-only
`check` plus a plain test script), and is not mentioned there.

Current rule (`scripts/ci/package-gate.mjs:46-57`):

```js
export function selectGate(scripts) {
  if (!isGated(scripts)) return null;
  const { check, typecheck } = scripts;
  if (check && covers(check, 'test')) {
    if (!typecheck || covers(check, 'typecheck')) return 'npm run check';
    return 'npm run typecheck && npm run check';
  }
  if (typecheck) return 'npm run typecheck && npm test';   // <- drops check
  return 'npm test';                                       // <- drops check
}
```

### Why no current package exposes it

The seven real shapes are all safe, but only by luck or by construction:

- `hashline-edit`, `statusline`, `pi-subagents` — `check` covers `test`, so `check` *is* the gate.
- `bifrost`, `langfuse`, `pi-beads` — declare no `check` at all.
- **`pi-superpowers-plus` is safe by accident**: its `check` is `biome check .` (lint only, does not
  cover `test`), so it falls to `return 'npm test'` and its `check` is never run — but its `test`
  script *also* begins with `biome check .`, so the lint happens anyway. Delete that duplication
  from its `test` and the gate would silently stop linting.

### The module header is currently false

`package-gate.mjs:40-45` claims:

```
// The strongest gate a package offers: ...
//   dropped: a selected gate always composes, never replaces, a declared script.
```

That is the bug, written down as a guarantee. Anything built on that sentence is built on a
falsehood, which is why the fix carries header and documentation corrections rather than only a
code change.

### The root cause is inference

The rule cannot know whether `test` embeds `check`; it guesses from shell text. That guess is why
this class has recurred. This design **closes the drops** but does **not** remove the inference —
see "Residual limitation".

## Goals / non-goals

**Goals**

- No combination of declared `check` / `typecheck` / `test` produces a gate that omits a declared
  script.
- The guarantee is **provable by test**, not by inspection: the rule's input space is small enough
  to enumerate exhaustively.
- The seven real packages keep their current selections except where the bug requires a change, and
  that one change is intended and visible.
- The module header, `AGENTS.md`, and the prior spec stop asserting a guarantee that is not true.

**Non-goals**

- **Removing the text inference** (e.g. explicit per-package gate declaration). Declined for now;
  documented as a residual limitation instead.
- **Touching any package's scripts or tests.** The duplicate lint that results from the fix is
  accepted rather than optimised away (see Decisions).
- **`pi-packages-1yzu`** — the unguarded `JSON.parse` in `discoverGated`. Separate bead,
  deliberately not bundled.
- Changing the runner, the CLI, the quarantine machinery, or the CI workflow.

## Decisions (from brainstorming)

1. **Branch:** a fresh branch from `main`, not another PR from the merged `pi-packages-33j5`.
2. **Guarantee: at-least-once.** Every declared check-bearing script appears in the selected gate at
   least once. Running one twice is acceptable and deliberate. The alternative — "exactly once where
   detectable" — means keeping the inference that caused the recurrence, so it was rejected.
3. **Accept the duplicate lint; change no package scripts.** With at-least-once,
   `pi-superpowers-plus`'s gate becomes `npm run check && npm test` and lint runs twice (~40 ms
   inside a ~15 s job). The alternative — deleting the now-redundant `biome check .` from that
   package's `test` script — would remove lint from its own `npm test`, trading real behaviour for a
   micro-optimisation.
4. **Approach: collect-and-compose**, with an exhaustive property test over the rule's input space
   (chosen over patching the cascade again, and over a lookup table).

## Design

### 1. The rule

```js
// Select the gate that runs every check a package declares, at least once.
//
// Order is typecheck -> lint/check -> tests: cheapest and most fundamental first, so a
// type error fails before the suite runs. A declared script is never dropped; running one
// twice is acceptable and deliberate (see the invariant below).
export function selectGate(scripts) {
  if (!isGated(scripts)) return null;
  const { check, typecheck, test } = scripts;
  const checkRunsTests = Boolean(check) && covers(check, 'test');
  const steps = [];
  if (typecheck && !(check && covers(check, 'typecheck')) && !covers(test, 'typecheck')) {
    steps.push('npm run typecheck');
  }
  if (check && !checkRunsTests) steps.push('npm run check');
  steps.push(checkRunsTests ? 'npm run check' : 'npm test');
  return steps.join(' && ');
}
```

**The invariant**, which the property test asserts independently of the expected strings:

| declared | must appear in the selected gate |
|---|---|
| `test` | always (declaring it is what makes a package gated) |
| `check` | always, as `npm run check` |
| `typecheck` | **unless** `check` or `test` already invokes it |

The third row is the only transitive reasoning the rule permits, and it is satisfied only by script
text that *literally* invokes the typecheck script. Everything else is at-least-once by
construction.

### 2. The complete input space

Eleven cases: nine declared-script combinations, the ungated case, and one case for the
`test`-invokes-`typecheck` clause. The property test enumerates all of them.

| # | `check` | `typecheck` | selected gate |
|---|---|---|---|
| 1 | absent | absent | `npm test` |
| 2 | absent | present | `npm run typecheck && npm test` |
| 3 | covers test + typecheck | present | `npm run check` |
| 4 | covers test + typecheck | absent | `npm run check` |
| 5 | covers test, not typecheck | present | `npm run typecheck && npm run check` |
| 6 | covers test, not typecheck | absent | `npm run check` |
| 7 | covers typecheck, not test | present | `npm run check && npm test` |
| 8 | covers neither | present | `npm run typecheck && npm run check && npm test` |
| 9 | covers neither, or typecheck-only | absent | `npm run check && npm test` |
| 10 | *(no `test` script — ungated)* | — | `null` |
| 11 | absent | present, but invoked by `test` | `npm test` |

Combinations 7, 8 and 9 silently dropped `check` before this change; 5 was fixed in PR #63; 1–4, 6
and 10 are unchanged behaviour; and 11 is a new, strictly narrower result — the old rule ran
`npm run typecheck` even when `test` already invoked it, and the new rule does not.

### 3. Delta against the seven real packages

Exactly one selection changes:

| package | before | after |
|---|---|---|
| `pi-superpowers-plus` | `npm test` | **`npm run check && npm test`** |
| `hashline-edit`, `statusline`, `pi-subagents` | `npm run check` | unchanged |
| `langfuse` | `npm run typecheck && npm test` | unchanged |
| `bifrost`, `pi-beads` | `npm test` | unchanged |

That delta is both intended and the proof the fix works: `pi-superpowers-plus` is precisely the
package whose `check` does not cover `test`, i.e. the shape that used to lose its lint and is today
saved only by its `test` script repeating `biome check .`.

### 4. Tests

**New — an exhaustive property test in `scripts/ci/package-gate.test.mjs`.** A table of the eleven
cases above, where each case asserts **two independent things**:

1. **the exact selected string** — pins behaviour, so an intentional change is visible in the diff;
2. **the invariant** — for every declared script, that it appears in the output (with the documented
   transitive exception for `typecheck`). This is the assertion that would catch a twelfth
   combination nobody anticipated.

Plus one contract assertion across every non-null case: `gateSteps(selected)` yields argv arrays
whose first element is `npm`, so the rule and the runner cannot drift apart (the runner splits on
`' && '` and shells nothing).

**RED evidence is required.** The new test must be run against the *current* rule first, showing
cases 7, 8 and 9 failing. Without that, the test proves only that it passes, not that it detects the
bug.

**Two existing pins are updated, and the new cases add coverage that did not exist before:**

- The six packages other than `pi-superpowers-plus` keep their recorded gate, and the
  real-manifest test keeps reading the actual `packages/*/package.json` files — it is the drift
  guard, and it is the reason this delta cannot happen silently.
- The **two** pins encoding the old result — the `SHAPES` entry for `pi-superpowers-plus`
  (`package-gate.test.mjs:32`) and its expectation in the real-manifest test (`:89`) — are **updated**
  to `npm run check && npm test`. They are the only two places asserting the old behaviour, and
  leaving either would fail. (They are updates, not replacements: cases 7–9 add coverage that simply
  did not exist before, which is why this class survived two previous rounds of tests.)
- The four standalone `selectGate` cases at `:47-66` (covers-test-not-typecheck; composing keeps
  steps; covers-test-no-typecheck; not-gated) stay valid unchanged.

**Untouched:** the process-level tests (`runGate`, `main`, quarantine, CLI) and every package's own
tests.

### 5. Documentation corrections

- **`package-gate.mjs:40-45`** — rewrite the header so it states the real invariant (at-least-once,
  duplication deliberate, the single transitive clause). The current text is a false guarantee.
- **`AGENTS.md:33-36`** — the strongest-gate paragraph describes the rule as "`check` when it covers
  both the tests and the typecheck, otherwise `typecheck && test`, otherwise `test`", which omits the
  uncovered-`check` composition. Rewrite to match the code and to say plainly that a script may run
  more than once.
- **`docs/superpowers/specs/2026-09-25-package-gate-enforcement-design.md`** — its "exact
  strongest-gate scripts" table and its decision 4 assert the guarantee that turned out to be
  untrue. Add a short **correction note** pointing at this spec rather than silently superseding it:
  the design record should show that the earlier claim was wrong and when it was corrected.

## Verification plan

Performed in the `verify` step with fresh evidence, not inherited from the implementation:

1. `node --test scripts/ci/package-gate.test.mjs` under node 22 — the full suite including the
   eleven-case property test.
2. The **RED** half: the new test run against the pre-fix rule, cases 7/8/9 failing.
3. `mise exec node@22 -- node scripts/ci/package-gate.mjs --all` — **7/7 PASS, exit 0**, with
   `pi-superpowers-plus` now on the composed gate; record the runtime delta (expected: tens of ms).
4. `--list` — exactly one package's gate differs from `main`, all six others unchanged.
5. CI green on the PR, including the `Package gate (pi-superpowers-plus)` leg.
6. `actionlint` still clean (the workflow is untouched).

## Acceptance criteria mapping

| AC (`pi-packages-4vmn`) | Satisfied by |
|---|---|
| No shape of `{check, typecheck, test}` produces a gate that omits a declared check script | the 11-case exhaustive property test, asserting the invariant per case |
| The seven real packages keep their current selections, asserted by the real-manifest test | §3 tables; exactly one intended change (`pi-superpowers-plus`), asserted from the real manifests |
| A unit test covers the lint-only-`check` + separate-`typecheck` shape and asserts the lint survives | case 8 (and case 7 for the typecheck-only variant, case 9 for the no-typecheck variant) |
| `node --test scripts/ci/package-gate.test.mjs` passes | verification 1 |

Additional criteria this design adds:

- the new test is shown **failing** against the pre-fix rule (RED), so it is proven to detect the bug;
- `gateSteps` produces `npm`-rooted argv for every selected gate (rule/executor contract);
- the module header, `AGENTS.md`, and the prior spec no longer assert the false guarantee.

## Residual limitation (documented, not solved)

The rule still decides coverage by matching script **text**. It cannot see through an indirect
invocation: if a package's `test` script invoked a helper that lints, `covers()` would not notice,
and the rule would run the lint a second time (harmless).

So the residual error mode flips from **omission to duplication**: a false negative in `covers()`
(not noticing an embedded script) now costs a repeated step rather than a skipped one. The single
remaining omission path is a false **positive** — a script that merely *mentions* `npm run typecheck`
or `npm test` without invoking it (the `(?![\w:-])` lookahead blocks the common variants such as
`npm run test:coverage`). That is narrow and pathological, and it is why at-least-once was chosen
over exactly-once: the rule can now essentially only over-run.

Removing the inference entirely (explicit per-package gate declaration) remains a possible future
change; it is explicitly out of scope here.

## Files touched

- `scripts/ci/package-gate.mjs` (the rule + its header)
- `scripts/ci/package-gate.test.mjs` (the property test; one existing pin moves)
- `AGENTS.md` (strongest-gate paragraph)
- `docs/superpowers/specs/2026-09-25-package-gate-select-composition-design.md` (this file)
- `docs/superpowers/specs/2026-09-25-package-gate-enforcement-design.md` (correction note)
