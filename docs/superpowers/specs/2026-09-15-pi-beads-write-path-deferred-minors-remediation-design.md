# pi-beads write-path: deferred minors remediation — Design

**Status:** Approved (brainstorming complete; awaiting `/plan`)
**Source bead:** `pi-packages-3iej.9` (deferred minors from `pi-packages-3iej.1`)
**Workflow molecule:** `pi-packages-mol-c4fj`
**Date:** 2026-09-15

## Problem

Implementing `pi-packages-3iej.1` (pi-beads write-path correctness) shipped clean,
but the final whole-branch review (`wf_995e5eb8e8bb`) parked a set of non-blocking
minors, plus more surfaced per task. They were grouped into `pi-packages-3iej.9`
so the remediation epic's reconciliation could triage. This spec covers that
triage outcome.

The items fall into three buckets:

- **A. Code correctness / robustness** — routing precedence can let the umbrella
  claim a member repo's prefix (umbrella overwrite); the single-id / empty-LCP
  prefix fallbacks can mint a wrong prefix or fail silently; `rc.err` is
  interpolated unguarded; `beads_reopen` still uses the pre-fix plain failure
  assignment (cross-repo overwrite class); `beads_mol_pour`'s umbrella-aggregate
  error lost the create/pour distinction; the bulk dep-failure return omits the
  minted ids.
- **B. Test hardening** — the dep-direction test is circular; the cost-overlap
  test proves serialization but not "both writes land"; `conc_guard` + env
  plumbing are copy-pasted across two suites; `mkdtempSync` for the dep temp dir
  sits outside its `try`; no direct test for the `beadQueues` prune.
- **C. Real-world verification** — live bd 1.2.2 dashed-umbrella behavior is
  unverified.

## Scope

**In scope:** all A and B items above, delivered as one branch/run.

**Non-goals:**

- Live-bd 1.2.2 dashed-umbrella verification (bucket C). It is captured as the
  manual smoke checklist at the end of this document — not an automated promise
  this test harness cannot keep. No new bead is created for it.
- Extracting `src/topology.ts`. The resolution helpers close over module-level
  mutable routing state (`prefixToDir`, `umbrella`, `defaultRepoDir`, `isUmbrella`),
  so extraction means threading a state object through every call site — a
  disproportionate refactor for a deferred-minors task.
- Any unrelated refactor. Only changes that serve the enumerated items.

## Decisions (from brainstorming)

1. Scope is A + B; C becomes a documented manual checklist.
2. Member-prefix routing wins over the umbrella, collision-safe; when a member's
   native prefix equals the umbrella's (i.e. `bd where` resolved upward), prefer
   the member's own sampled prefix.
3. Test fidelity: targeted stubs plus a direction oracle — no stateful fake DB.
4. Ambiguous single-id / LCP prefix fallback is conservative and explicit:
   `prefixFromId` only derives a prefix when the trailing segment looks like a
   real minted suffix, otherwise `""`; a genuine no-shared-prefix LCP does not
   masquerade as a valid prefix.
5. Structural approach: surgical in-place fixes plus a shared test helper module
   (Approach A); no topology extraction.

## Design

### 1. Routing & prefix derivation (`packages/pi-beads/src/index.ts`)

**New pure helper** `derivePrefixFromIds(ids: string[]): string`, centralizing the
prefix-derivation rule so `samplePrefixOf` reads as intent:

- Normalize each id through `stripIdSuffix`.
- With **≥2 ids**: compute `lcp = longestCommonPrefix(normalized)`.
  - `cut = lcp.lastIndexOf("-")`; if `cut > 0`, return `lcp.slice(0, cut)` —
    recovers a dashed native prefix (e.g. `pi-packages`), not just the first
    hyphen-delimited token.
  - Else if `lcp` is non-empty (dashless prefix such as `crmback`), return `lcp`.
  - Else (`lcp === ""`) fall through to `prefixFromId(ids[0])`.
- With **exactly 1 id**: return `prefixFromId(ids[0])`.

**`prefixFromId(id)` becomes conservative.** After `stripIdSuffix`, split only
when the trailing segment after the last hyphen looks like a minted id suffix
(`/^[0-9a-z]{1,6}$/i`). Otherwise return `""`. This is what stops a molecule-root
id like `pi-packages-mol-c4fj` (stripped to `pi-packages`) from yielding a bogus
`pi` prefix. A plain issue id (`crmback-1a2` → `crmback`) still resolves.

**`resolveTopology` becomes member-first, collision-safe:**

1. Resolve the umbrella root as today (env override, then upward walk for a
   `.beads` whose config lists additional repos).
2. **Pass 1 — members.** For each member dir:
   - `np = nativePrefixOf(dir)`.
   - If `np` is non-empty **and differs from the umbrella's native prefix**,
     claim `np`.
   - Otherwise claim `samplePrefixOf(dir)` (the member's own DB), which covers the
     upward-resolution case.
3. **Pass 2 — umbrella.** Claim the umbrella's native prefix only if no member
   already claimed it.
4. First claim wins: never overwrite a prefix that already maps to a different
   dir.
5. `basenameToDir` population is unchanged.

Single-repo mode (`else` branch) keeps its current shape; only the derivation
helper changes underneath it.

### 2. Error / return-path fixes (`packages/pi-beads/src/index.ts`)

- **`rc.err` guard.** Add `errText(r) => (r.err ?? "").trim() || "unknown error"`
  and use it at every `${r.err}` / `${rc.err}` interpolation site — the
  cascade-parent failure path, `beads_deps` tree, `beads_undep`, and the bulk-dep
  failure. No literal `undefined` reaches a message.
- **`beads_reopen`.** Mirror the `beads_close` pattern: accumulate failures
  (`failure = failure ? `${failure}; ${msg}` : msg`) instead of the plain
  `failure =` overwrite followed by `break`, so one repo's failure no longer
  hides another's.
- **`beads_mol_pour` wording.** Parameterize the shared create-target error with
  the operation verb, so an umbrella-aggregate pour reads "cannot pour…" while a
  create reads "cannot create…". The create/pour distinction is restored.
- **Bulk dep-failure return.** Include the minted ids (`gate`, `human-gate`,
  tasks) in the `deps: bulk wiring failed: …` message, matching the report shape
  of the partial-task path. `afterWrite` already runs on this path; unchanged.

### 3. Test hardening (`packages/pi-beads/test/`)

- **Shared helper module** `test/helpers/fake-bd.mjs`: export the `conc_guard`
  shell-function text and a `concEnv(dir, marker)` helper for the `FAKE_BD_CONC*`
  plumbing. Both `pi-beads.test.mjs` and `cost-tracking.test.mjs` import it; the
  verbatim copy-paste is removed.
- **Direction oracle.** A pure `expectedEdges(plan)` helper derives the edge set
  from the `beads_create_list` **inputs** (gate + tasks) using bd's documented
  `from = dependent / to = blocker` rule, validated against a hand-written golden
  edge set; the test then compares it to the actual edges. The test no longer
  treats the echoed `DEPS` JSONL as its own direction model.
- **Stateful `show` for the cost test.** The fixture records the last `update`
  metadata per bead and returns it from `show`, so the test asserts *both* writes
  land (no lost RMW), not merely that the two bd ops never overlap.
- **`beadQueues` prune test.** Expose a minimal, test-only `__beadQueueSize()`
  export in `src/cost-tracking.ts` and assert the map shrinks to zero once the
  and assert the map shrinks to zero once the queued promise settles.
- **`mkdtempSync` inside the `try`** for the dep temp dir, so a temp-dir-creation
  failure still runs `afterWrite` and cleanup.
- **New fixture:** a member repo whose `bd where` returns the umbrella's dashed
  prefix, proving member-first + sample-fallback routing.

### 4. Verification

Coverage is via the existing fake-`bd` fixture. `cd packages/pi-beads && npm test`
runs the tool suite, the cost-tracking suite, and the tool-surface drift guard.

New/changed tests:

- `prefixFromId`: plain id, molecule-root id, dashless id, non-suffix tail → `""`.
- Empty-LCP fallback and genuine no-shared-prefix behavior.
- Member/umbrella prefix collision → member's sampled prefix wins; umbrella
  prefix stays mapped to the umbrella.
- `beads_reopen` cross-repo failure accumulation.
- Bulk dep-failure message includes the minted ids.
- `beads_mol_pour` umbrella-aggregate wording.
- Direction oracle (independent edge model).
- Cost no-lost-write.
- `beadQueues` prune.
- Dep temp-dir cleanup on `mkdtempSync` failure.

## Manual smoke checklist (bucket C — live bd 1.2.2)

Run against a real hydrated umbrella with a dashed native prefix (e.g.
`pi-packages`):

- [ ] Umbrella `bd where` reports the dashed native prefix; a member repo's
      `bd where` resolves to its own prefix.
- [ ] Creating an issue for a member repo routes to that member; the umbrella's
      prefix mapping is not overwritten.
- [ ] A member whose `bd where` resolves upward does not steal the umbrella's
      prefix.
- [ ] `beads_create_list` writes the bulk-dep edges with `from = dependent`,
      `to = blocker`, and `bd` accepts them.

This checklist is also added to the pi-beads README's Limitations section, next to
the existing "bd output format is not a stable contract; verified against 1.2.2"
caveat.
already lives.

## Acceptance criteria

- Every bucket A item is fixed with a covering test; every bucket B item has its
  hardening in place.
- `cd packages/pi-beads && npm test` is green.
- No behavior change outside the enumerated items; the tool surface is unchanged
  (drift guard passes).
- Bucket C is captured as the manual smoke checklist above; no app/extension
  behavior depends on it.
- Design and spec committed; implementation handed off via `/plan`.
