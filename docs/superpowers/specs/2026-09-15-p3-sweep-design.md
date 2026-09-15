# P3 sweep design — far1 + huim + cxaw + d610 + README context-size

Date: 2026-09-15
Molecule: `pi-packages-mol-spip` (topic: "P3 sweep: far1 + huim + cxaw + d610")
Issues: `pi-packages-far1`, `pi-packages-huim`, `pi-packages-cxaw`, `pi-packages-d610`
Follow-up filed this run: `pi-packages-axam` (skill-size review)

## Problem

Four local P3s plus a stale README section, burned down in one cycle:

- **`far1`** — two fail-safe gaps in `beads-molecule-widget-controller.mjs`'s
  `refreshWorkspace` multi-worktree handling.
- **`huim`** — the molecule-widget adapter's event wiring is untested; two pi-beads
  test-hygiene items; one stale controller comment.
- **`cxaw`** — a langfuse ledger minor.
- **`d610`** — six recovered SDD/skill-text minors.
- **README** — the `pi-superpowers-plus` context-size table is badly stale and its
  surrounding narrative no longer holds.

Exploration found most of `cxaw`/`d610` are **already satisfied** in the current code.
The sweep policy is therefore **verify-and-close with recorded evidence** for anything
already done, and implement only what is genuinely outstanding.

## Decisions

- **Verify-and-close:** items already satisfied are confirmed against the code, closed
  with the evidence recorded in this spec; no manufactured code/tests.
- **`far1` fail-safe:** when the `ws:*` guard probe cannot confirm (exec threw, or
  non-zero), **keep the prior frame** — never fall through to the unscoped global adopt.
- **README:** recompute honestly, reframe around on-demand loading (default-context
  callout + per-skill table), and point at the follow-up size review (`axam`).

## Item 1 — `far1`: `refreshWorkspace` guard hardening

File: `packages/pi-superpowers-plus/extensions/beads-molecule-widget-controller.mjs`

**Fix 1** (multi-worktree guard, in the `found.length === 0` branch). Today the
condition `anyWs && anyWs.code === 0 && parseMoleculeRoots(...).length > 0` is false
when the probe *throws* (→ `anyWs` null) or returns non-zero, so control falls through
to the unscoped global `bd mol current` adopt — the exact cross-worktree leak the guard
exists to prevent. Replace with an explicit early return:

```js
const anyWs = await safeExec(["list", "--type", "molecule", "--label-pattern", "ws:*", "--json"], gen);
if (gen !== refreshGen) return;
if (!anyWs || anyWs.code !== 0) return; // can't confirm; keep prior frame, never adopt unscoped global
if (parseMoleculeRoots(anyWs.stdout).length > 0) {
  clearFrame();
  return;
}
```

This mirrors the existing `if (!listR) return; // exec threw; safeExec warned, keep the
prior frame` rule a few lines above.

**Fix 2** (per-root loop). Today `sawError = true` is set for *any* `r.code !== 0`,
including a clean not-found, so a multi-root workspace whose roots all return clean
not-found retains a stale frame. Move it inside the non-clean branch:

```js
if (r.code !== 0) {
  if (!isCleanNotFound(r)) {
    warn(
      "[pi-superpowers-plus] molecule workspace root query error:",
      root.id,
      r.code,
      sanitizeLogText(`${r.stdout ?? ""}\n${r.stderr ?? ""}`),
    );
    sawError = true;
  }
  continue;
}
```

An all-clean-not-found workspace then falls through to `clearFrame()`.

Accepted risk (no action): `workspaceKey` truncates SHA-256 to 12 hex (48 bits) with no
runtime collision check — negligible.

**Tests** (`test/beads-molecule-widget-controller.test.mjs`):
- 0 `ws:` roots + `ws:*` probe exits non-zero → the global `bd mol current` is **not**
  invoked and the prior frame is retained.
- Multiple `ws:` roots all returning clean not-found → frame cleared.

## Item 2 — `huim`: adapter wiring test + test hygiene

**(a) New `test/beads-molecule-widget-adapter.test.mjs`** (added to the `package.json`
`test` chain). Node 26 strips types, and the adapter's only pi import is
`import type { ExtensionAPI }` (erased), so the test can `await import("../extensions/beads-molecule-widget.ts")`.
Construct a fake `pi` that captures `on(ev, fn)` handlers, `events.on(name, cb)`
subscribers (returning real `off` fns), and an `exec` stub; then assert:
- `events.on` is called for both `beads:changed` and `superpowers:phase`;
- dispatching `superpowers:phase` with `{ phase: "development" }` triggers a refresh
  (`exec` observes a `bd` call), while `{ phase: "" }` does not;
- invoking the `session_shutdown` handler calls **both** unsubscribe functions.

**(b) pi-beads test hygiene** (`packages/pi-beads/test/pi-beads.test.mjs`):
- wrap the `transient startup failure` test body (`~:736`) in `try/finally` so
  `FAKE_BD_TRANSIENT_MARKER` / `FAKE_BD_MODE` are always cleaned up;
- rename `"no workspace: startup probes info once, sets no status, emits nothing"`
  to reflect that it simulates an **unusable DB**.

**(c) Stale comment** (`beads-molecule-widget-controller.mjs:241-242`): the comment
claims turns call `setCwd({ refresh: false })`, but the adapter now refreshes on every
`agent_start`. Correct the wording to match the per-turn refresh.

## Item 3 — README context-economy reframe + `d610` T3

File: `packages/pi-superpowers-plus/README.md` (context-size section, ~:124).

**(1) Default-context callout (new).** State the loading model factually, without
overselling: 13 skills ship; 11 are hidden (`disable-model-invocation: true`) and load
only via `/skill:`. The system prompt carries only `using-superpowers` +
`systematic-debugging`: **~207 chars (~52 tokens)** of descriptions, versus upstream's
**13 visible / ~1,813 chars (~450 tokens)**. The value is a bounded, predictable default
context — the absolute saving here is small.

**(2) Intro paragraph (honest).** Drop the stale "67.5KB → 66.5KB / some shrank" story.
State that per-skill `SKILL.md` files have grown to roughly **2× the upstream baseline**,
that on-demand loading keeps this out of the *default* context, and that the growth is
tracked for review in **`pi-packages-axam`** (split reference material into
`reference/*.md`).

**(3) Per-skill table (recomputed).** `pi-superpowers-plus` column regenerated from
`wc -c` over `skills/*/SKILL.md`; `Change` recomputed; upstream column kept (verified
byte-exact against a fresh `coctostan/pi-superpowers` clone); add `using-superpowers`
(upstream `—`) and `writing-skills` (upstream 21.5 / plus `—`) rows to reconcile the
differing sets.

| Skill | upstream | plus | change |
|---|--:|--:|--:|
| brainstorming | 2.5 | 17.4 | +596% |
| dispatching-parallel-agents | 6.2 | 6.5 | +5% |
| executing-plans | 2.7 | 5.3 | +96% |
| finishing-a-development-branch | 4.3 | 7.8 | +81% |
| receiving-code-review | 6.2 | 5.8 | −6% |
| requesting-code-review | 2.9 | 3.5 | +21% |
| subagent-driven-development | 10.2 | 44.8 | +339% |
| systematic-debugging | 9.8 | 6.9 | −30% |
| test-driven-development | 9.8 | 9.0 | −8% |
| using-git-worktrees | 5.5 | 7.2 | +31% |
| using-superpowers | — | 5.0 | — |
| verification-before-completion | 4.1 | 5.0 | +22% |
| writing-plans | 3.3 | 14.6 | +342% |
| writing-skills | 21.5 | — | — |

**(4) Totals.** Shared 12 skills: **67.5 KB → ≈133.8 KB**. Full 13 each side: upstream
≈89.0 KB, plus ≈138.8 KB.

**(5) Follow-up pointer.** One line naming `pi-packages-axam` as the plan to bring
`SKILL.md` sizes back down.

**(6) `d610` T3.** `skills/requesting-code-review/SKILL.md:37` — replace "never the
parent-commit base (the `~1` shorthand)" with explicit "never `HEAD~1`". (Keeps the
`skills-contract` "never HEAD~1" guard satisfied; the guard only allows the literal in a
"never" line.)

## Item 4 — verify-and-close evidence (no code)

Recorded here so closure is auditable:

- **`cxaw`** — `grep -rn fetchTrace packages/langfuse` → no hits;
  `packages/langfuse/src/langfuse.ts:144` already calls
  `client.api.trace.get(traceId)`. The minor was explicitly conditional
  ("if SDK compatibility requires it") → satisfied. No new test (an absence-grep
  assertion is not worth adding).
- **`d610` T1** — `test/skills-contract.test.mjs:46` regex is
  `/set_phase\(\{\s*phase:\s*["']([^"']*)["']\s*\}\)/g` → quote-agnostic. Satisfied.
- **`d610` T2** — `test/skills-contract.test.mjs:73` also uses `["']` for the
  `beads_gate_resolve` id literal. Variable pass-through is inherently outside a static
  literal regex (not a defect). Satisfied.
- **`d610` T4** — `skills/subagent-driven-development/task-reviewer-prompt.md:3` uses a
  proper relative link `../../agent-templates/task-reviewer.md`; `agent-templates/code-reviewer.md`
  has no bare path. Satisfied.
- **`d610` T5** — `skills/subagent-driven-development/SKILL.md:466-467` already documents
  the `beads_mol_ready` readiness check and `<verify-step-id>`/`<finish-step-id>`
  resolution via `beads_list`. Satisfied.
- **`d610` T6** — `SKILL.md:202-207` no longer duplicates "already". Satisfied.
- **`d610` T3** — fixed in Item 3.

## Testing

- `cd packages/pi-superpowers-plus && npm test` green — includes `biome check .`, the new
  adapter wiring test, the `far1` controller tests, `skills-contract`, and
  `agent-templates`.
- `cd packages/pi-beads && npm test` green — includes the renamed test and the
  `transient` `try/finally` cleanup.
- README numbers reproducible: `for d in skills/*/; do wc -c < "$d/SKILL.md"; done`.
- `langfuse` is not modified (verify-only), so its suite is not required for this sweep.

## Acceptance Criteria

- `far1`: probe failure retains the prior frame and never adopts the unscoped global
  candidate; an all-clean-not-found multi-root workspace clears; controller tests pass.
- `huim`: adapter wiring test (both listeners, empty-phase filter, both unsubscribes)
  passes; `transient` test uses `try/finally`; "no workspace" test renamed; stale comment
  corrected.
- `cxaw`: verified satisfied; bead closed with the recorded evidence.
- `d610`: T3 fixed; T1/T2/T4/T5/T6 verified satisfied; bead closed with the recorded
  evidence.
- README: default-context callout + recomputed per-skill table (all 13 skills represented)
  + accurate totals + `axam` pointer; no false "shrank" claim.
- `pi-superpowers-plus` and `pi-beads` suites green.

## Non-goals / declined

- No behavior change to the widget beyond the two `far1` fail-safe corrections.
- No new test for `cxaw` (conditional minor, already satisfied).
- The skill-size reduction itself is **not** in scope here — it is filed as
  `pi-packages-axam` by explicit user request.
- `x33o` (upstream `pi-subagents`) is untouched: it is a subtree carry item, not
  actioned in this repo.
