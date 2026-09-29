# Design: shared claim core + batched `beads_close` emit

Date: 2026-09-29
Status: approved (design review), pending implementation
Tracking: molecule `pi-packages-mol-wvdg`
Follows: PR #65 and PR #66 (both merged) — template-proto filtering for `beads_ready`, the `/beads` board, and `beads_close` claimNext

## Problem

Two cleanups parked with rulings during the PR #66 final review:

1. **Duplication.** The select-and-claim sequence exists twice:
   - `claimNextReady(dir)` (`packages/pi-beads/src/index.ts:451-465`) — added for `beads_close` claimNext;
   - the claim branch inside `beads_ready` (`:789-803`).

   Both parse a `stripTemplates` result, take the head, resolve the owning repo, run
   `bd update <id> --claim`, and emit. They had already drifted on the failure wording
   (`claimed <id> but repo claim failed` vs `selected next <id> but the claim write
   failed`) and on the `-n` bound.

2. **Emit noise.** `beads_close` calls `afterWrite(dir)` per mutation: after `bd close`,
   once per parent-cascade step, and again after the claimNext claim. In umbrella mode
   each call emits `beads:changed` and re-exports the repo JSONL.

3. A stale documentation detail: the merged spec
   `docs/superpowers/specs/2026-09-29-beads-close-claim-next-template-fix-design.md:4`
   cites `44cb5b9..60f5cb1`, which predates its own fix commit `de42f33`.

## Scope

One change in `packages/pi-beads` plus a one-line spec fix:

- `src/index.ts` — add a shared `claimHead(filtered)` helper; use it from `beads_ready`
  and `beads_close`; batch `beads_close`'s emit to once per repo.
- `test/pi-beads.test.mjs` — update the claim-failure match; add a batched-emit regression.
- `docs/superpowers/specs/2026-09-29-beads-close-claim-next-template-fix-design.md` — fix
  the status range.

**Out of scope:** `beads_mol_ready`, the `/beads` board, `beads_ready`'s filtering/args,
`beads_close`'s argv and result text, the accepted non-atomic claim trade-off.

## Design

### 1. Shared helper (beside `stripTemplates`)

```ts
// Select-and-claim core shared by `beads_ready` and `beads_close`'s claimNext.
// `filtered` is already-template-stripped `bd ready --json`. It does NOT emit —
// each caller decides when (beads_close batches one emit per repo).
async function claimHead(
  filtered: string,
): Promise<{ id?: string; dir?: string; error?: string }> {
  const parsed = jparse(filtered);
  const arr = Array.isArray(parsed) ? parsed : parsed?.issues;
  const head = Array.isArray(arr) ? arr[0] : null;
  const id = head?.id ? String(head.id) : null;
  if (!id) return {};
  const dir = dirForPrefix(id);
  if (!dir) return {}; // unresolvable owner → nothing claimed
  const c = await bd(["update", id, "--claim"], dir);
  if (!c.ok) return { error: `could not claim ${id}: ${c.err}` };
  return { id, dir };
}
```

`dirForPrefix(id)` resolves the owning repo in both callers: `beads_ready` runs against
the umbrella aggregate, and `beads_close`'s ready query runs inside the repo `dir`, whose
prefixes map back to that same `dir`.

This replaces `claimNextReady` and the claim block inside `beads_ready`.

### 2. `beads_ready` claim path

Fetch is unchanged (`scope`, `-n <limit>`, `label`/`labelAny`), then:

```ts
const filtered = stripTemplates(r.out);
if (!claim) return textResult(fmtRows(filtered));
const cn = await claimHead(filtered);
if (cn.error) return textResult(cn.error);
if (cn.id && cn.dir) await afterWrite(cn.dir);
return textResult(fmtRows(filtered));
```

Behaviour preserved: no resolvable head → listing, no claim, no emit; a failed claim →
error text.

### 3. `beads_close` — batched emit + shared claim

Inside the per-repo loop, declare `let changed = false;` and replace the `await
afterWrite(dir)` sites in that block (after `bd close`, and inside the cascade loop) with
`changed = true;`. The claimNext step becomes:

```ts
if (claimNext) {
  const rr = await bd(["ready", "--json", "--include-ephemeral", "-n", "50"], dir);
  if (!rr.ok) {
    const msg = `bd ready failed: ${rr.err}`;
    failure = failure ? `${failure}; ${msg}` : msg;
  } else {
    const cn = await claimHead(stripTemplates(rr.out));
    if (cn.id) { claimedNext.push(cn.id); changed = true; }
    if (cn.error) failure = failure ? `${failure}; ${cn.error}` : cn.error;
  }
}
```

At the end of that repo's iteration, after the cascade and the claimNext block:
`if (changed) await afterWrite(dir);`. A repo whose `bd close` failed `continue`s and
emits nothing (unchanged). The result text (`closed …; claimed next: …` /
`no claimable next issue` / `warning:`) is unchanged from PR #66.

### 4. Wording unification

The two divergent failure strings become the single `could not claim <id>: <err>`.

### 5. Tests (`test/pi-beads.test.mjs`)

- Update `beads_close claimNext surfaces a claim-write failure…` (`:1483`): match
  `/could not claim/` instead of `/claim write failed/`; keep the `no claimable next
  issue` negative assertion.
- Add a regression pinning the batched emit: a `beads_close({ claimNext: true })` that
  closes, cascades a parent, and claims emits exactly one `beads:changed`.
- Other existing tests are unchanged (they assert argv and text, not emit counts).

### 6. Docs

- Fix `docs/superpowers/specs/2026-09-29-beads-close-claim-next-template-fix-design.md:4`
  to `Status: implemented (commits 44cb5b9..de42f33, merged PR #66)`.
- No README/SKILL change (the user-facing claimNext wording is unaffected).

## Verification / definition of done

1. `cd packages/pi-beads && npm test` green.
2. `beads_ready({claim:true})` and `beads_close({claimNext:true})` still claim the first
   non-template issue and never a template step (existing regressions stay green).
3. `beads_close` emits exactly one `beads:changed` per repo containing any successful
   mutation (new regression).
4. Root `npm test` (all package gates) green before finishing.

## Branch

Continue on `johnstegeman/protofix` (PR #66 merged at `c7558e9`).

## Rejected alternatives

- **A single `selectAndClaim(scope, rargs, { emitDir })`** doing fetch + strip + claim +
  emit — fewer lines, but bakes two tools' bd argv/limits and error wording into one
  function and couples `beads_ready`'s filtering options to `beads_close`'s.
- **Factor only parse→head→update, leave emits as-is** — smallest diff, but does not
  remove the emit noise.
