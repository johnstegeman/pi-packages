# Deferred-minor backlog: drain the pile, and the findings it was carrying

Molecule: `pi-packages-mol-vnpho` · Date: 2026-10-09 · Status: approved design
(`review.verdict=done` on `pi-packages-mol-is2c1`)

Backlog bead: `pi-packages-6t1xv` (closes at the end of this cycle)

All line numbers are as of `7fe85aa`.

## Problem

`pi-packages-6t1xv` is the single kickoff point for the accumulated deferred-minor /
follow-up beads — items filed at the end of a superpowers cycle instead of being fixed
in-session. It exists because, until the `wrap-up` step landed (`pi-packages-mol-2omf0`,
2026-10-09), "fix now" was not on the menu: `reference/final-review.md` told the controller to
*triage* the parked list but never said what triage *does*, and the only durable exit was a
bead. The pile is the residue of that shape, not of any one bad finding.

So draining it needs a **rule per row**, not a new mechanism — the mechanism shipped with the
wrap-up policy. What the pile actually contains, read from the beads themselves (the shapes
overlap — `graey` and `f7ber` are both pre-work and small fixes — so these counts are not a
partition of 12):

| shape | rows | count |
|---|---|---|
| already done, never closed | `t6wc` (spike delivered in PR #78) | 1 |
| trigger-gated, trigger never fired | `xp8b` | 1 |
| pre-work for a config that is not adopted | `1v349`, `graey`, `f7ber`, `peefw` | 4 |
| small in-repo fixes | `7vzw`, `graey`, `f7ber` | 3 |
| open decisions with no code deliverable | `sw30`, `qbr6` | 2 |
| genuine design passes | `2cly`, `6f0p` (under epic `jnr7`) | 2 |

The four codemode rows are the largest single block, and they are all downstream of one fact
the pile does not state: **`codemode.mode` is unset in `~/.pi/agent/settings.json`**, so every
session runs stage A (`on`). Stage B was evaluated on 2026-10-05 (`go-with-mitigations`,
PR #78), never adopted, and no bead tracks adopting it. Pre-work for an unadopted config is
the definition of a pile that cannot drain.

## Goal

Every row of `pi-packages-6t1xv` is **closed** (fixed, or won't-fix with a recorded reason) or
**re-filed with a design-pass scope**. No row is left as an unowned follow-up. The in-repo
fixes land with tests, and the two claims that were only *argued* rather than *verified* are
verified on the runtime we actually run: that `Agent`'s budget omission is now marked
(§3.3), and whether the `rules`-block leak still exists (§3.3).
verified on the runtime we actually run.

## Decisions (from brainstorming)

1. **Full drain.** Not a decision-only pass, not a workstream split: the fixable rows are fixed
   in this session, and only the two genuine design passes are re-filed.
2. **Stage B stays unadopted.** `codemode.mode: "only"` is not adopted by this cycle, and this
   cycle does not adopt it. Consequence: the four codemode rows are pre-work for a mode we do
   not run.
3. **Nothing is filed upstream.** Human ruling, 2026-10-09: *"anything that's upstream — file
   as won't-fix, because it's nearly impossible to get things in pi upstream."* An upstream
   dependency is therefore a **closing reason**, never a work item.
4. **Fix now is the default for in-repo rows** — the policy this pile is the last artifact of
   (`skills/subagent-driven-development/reference/disposition.md`).
5. **`1v349` closes as moot.** This reverses an instruction given earlier in the same
   brainstorming ("re-scope it to the 1.1.0 runtime"), taken once stage B was ruled unadopted:
   the row exists only to firm up a pre-adoption verdict for a mode we do not run.
6. **`peefw` gets one verification before it closes** (two sessions on pi 1.1.0), because "is
   this still true?" is cheap and a wrong closing reason is not.
7. **`sw30` = candidate 2** — keep the pass-through and document it as the contract for
   extension authors. Candidates 1 (make pi reject undeclared keys) and 3 (document strict
   sampling in pi's extension docs) are upstream, so decision 3 closes them. **No live probe**:
   the function pi calls is the authority and it is readable in the binary we run.
8. **`qbr6` = Option B** (close as not-wanted), with a closing reason that names the missing
   consumer, as the bead's own success criteria require.
9. **`xp8b` closes**: the trigger never fired, and the artifact has no bead-claim path for two
   runs to contend over.
10. **`2cly` and `6f0p` are the only design passes.** Re-filed as fresh beads, originals closed
    with reasons naming their successors, `jnr7` stays open as the umbrella with the `6f0p`
    successor reparented under it.
11. **`graey`'s mitigation is implemented here, not carried.** The spike's verdict named two
    options for risk (a) — "namespace it, or take it upstream". Verified against the 1.1.0
    binary, the in-repo one is available: `getNamespace: (name) =>
    this._toolDefinitions.get(name)?.definition.namespace` (`73760557`), and pi's own docs
    sanction an extension-declared namespace (`docs/extensions.md:162`). Upstream was the
    fallback, not the dependency.
12. **Execution is Approach 2**: one branch, the two package fixes in parallel (disjoint file
    sets), the controller writes the records alongside, then one gate run.

## Dispositions

Every row, its outcome, and the record that exists afterwards:

| # | bead | outcome | record |
|---|---|---|---|
| 1 | `t6wc` spike | **close** | reason cites PR #78 and the spec's `Stage B evaluation` section as the delivered artifact |
| 2 | `1v349` gates 1–2 re-run | **close as moot** | reason: B is unadopted, so there is nothing to pre-verify; the re-run is a devDep bump to a published `1.1.0`, not an upstream wait; revisit only if B is adopted |
| 3 | `peefw` rules leak | **verify on 1.1.0, then close** | two-session diff as a bead comment; closes "fixed upstream in 1.1.0" or "won't-fix — upstream pi behaviour" |
| 4 | `f7ber` spec wording | **fix in-session** | four edits to `docs/superpowers/specs/2026-09-30-codemode-adoption-design.md` (§3.2) |
| 5 | `graey` Agent omission | **fix in-session, verified** | `namespace` on `agentTool` + updated test + `docs/pi-subagents-local-patch.md` entry + the `only`-session check |
| 6 | `7vzw` guard coverage | **fix in-session** | schema-safe rejection in `packages/pi-beads/src/index.ts` + tests |
| 7 | `sw30` args contract | **decide (candidate 2), record, close** | `docs/pi-extension-args-contract.md` |
| 8 | `qbr6` skill preloading | **close as not-wanted** | reason names the missing consumer |
| 9 | `xp8b` merge-slot | **close as won't-fix** | reason records the trigger and the absent bead-claim path |
| 10 | `2cly` `cost.main.*` | **close + re-file** | successor bead, design-pass scope, `discovered-from` → `2cly` |
| 11 | `6f0p` implementer resume | **close + re-file** | successor bead, design-pass scope, reparented under `jnr7` |
| 12 | `jnr7` epic | **stays open** | umbrella; its two delivered children stay closed, the successor hangs under it |
| — | `6t1xv` this pile | **close at the end** | reason: every row closed or re-filed; no unowned follow-up remains |

## Design

### 1. Fix A — `pi-beads`, `7vzw`

`beads_memories` mutates (`bd remember` / `bd forget`) and emits `beads:changed`, but it is not
in `WRITE_TOOLS`, so a codemode script calling `tools.beads_memories({ action: "remember",
content: "x", keys: "k" })` gets a success response while `keys` is dropped. It was excluded
for one reason: it declares an `outputSchema`, and the guard's rejection is a plain
`textResult` carrying no `structuredContent` — which violates the invariant the package
enforces for schema-declaring tools (`jsonResult`, `packages/pi-beads/src/index.ts:812`).
`beads_ready` was added to the set anyway in `beaa862` because leaving a mutating path
unguarded is the worse failure; its rejection path carries text only.

**Three edits to `packages/pi-beads/src/index.ts`:**

1. **Make the rejection schema-aware** in `guardUnknownKeys` (`:781-801`). Today:

   ```ts
   if (unknown.length > 0)
     return textResult(
       `${def.name}: unknown argument(s): ${unknown.join(", ")} (accepted: ${declared.join(", ")})`,
     );
   ```

   becomes:

   ```ts
   if (unknown.length > 0) {
     const msg = `${def.name}: unknown argument(s): ${unknown.join(", ")} (accepted: ${declared.join(", ")})`;
     // A tool that declares an `outputSchema` must carry `structuredContent` on every
     // return path (see `jsonResult`). Every pi-beads output schema spreads
     // `ERROR_PROP`, so `{ error }` is valid for all of them.
     return def.outputSchema === undefined ? textResult(msg) : textResult(msg, { error: msg });
   }
   ```

   `{ error: msg }` is schema-valid against every entry in `READ_SCHEMAS` (`beads_memories` →
   `{error?, memories?}` at `:843`, `beads_ready` → `{error?, issues?}`), and it is the same
   shape `beads_memories` already returns for `bd memories failed: …` (`:1724`). `jsonResult`
   itself is not reused here because it throws on a missing `structuredContent` and this branch
   must return a result, not throw.

2. **Add `TOOL.memories` to `WRITE_TOOLS`** (`:162-178`).

3. **Rewrite the two comments that document the exclusion**, since they are the stale
   rationale for the gap this fix closes:
   - the block at `:150-161` ("`beads_memories` is the one mutating tool deliberately left
     out: it declares an `outputSchema`, which the guard's plain `textResult` rejection would
     violate; bead `pi-packages-7vzw` tracks a schema-respecting rejection for it");
   - the `beads_ready` note at `:163-164` ("its rejection path carries text only — the same
     `7vzw` gap, accepted here so the mutation is guarded").

**Tests, `packages/pi-beads/test/pi-beads.test.mjs`:**

1. `beads_memories` rejects the bead's own repro
   (`{ action: "remember", content: "x", keys: "k" }`) → text matches
   `/beads_memories: unknown argument\(s\): keys/`, **zero** `bd` invocations, **zero**
   `beads:changed` emits (the existing `beads_ready` test at `:1093` is the pattern).
2. The rejection carries `structuredContent` equal to `{ error: <same message> }` — asserted
   for `beads_memories` **and** `beads_ready`, which share the shape and which currently
   returns text only.
3. **Membership coverage.** The test parses the `WRITE_TOOLS = new Set<string>([…])` block out
   of `src/index.ts` (the `test/tool-surface.test.mjs` precedent reads source text for exactly
   this kind of structural guard), resolves each `TOOL.<key>` through the `TOOL` map in the
   same file, and asserts every resolved name rejects an undeclared argument with zero `bd`
   calls. A separate hand-maintained inventory in the test asserts set-equality, so adding a
   tool to `WRITE_TOOLS` without covering it — or covering one that is not in the set — is red.

   **Residual gap, stated in the test's comment:** a *new* mutating tool that is registered but
   never added to `WRITE_TOOLS` stays invisible, because nothing in the source can be asked
   "do you mutate?" statically. The test pins today's inventory and its coverage; it cannot
   infer mutability.

### 2. Fix B — `pi-subagents`, `graey`

Under `codemode.mode: "only"` at the default `inlineBudget: 3000`, `Agent` is dropped from the
codemode description **silently**: it has no namespace, the non-namespaced group has no
heading, and incompleteness is reported per namespace, so nothing in the listing says anything
is missing. That is residual risk (a), and it is why the stage-B verdict is
`go-with-mitigations` rather than `go`.

**Two edits to `packages/pi-subagents/src/index.ts`:**

1. **`agentTool` (`:1604-1607`) gains `namespace: SUBAGENTS_NAMESPACE`**, carrying the file's
   existing `// LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md` marker.
2. **Reword the namespace's own comment (`:87-90`)**, which currently reads "`Agent` stays
   direct" as the reason for the omission. `Agent` stays *direct* (unchanged); it joins the
   namespace so that a budget omission is marked instead of silent.

**Why this is the whole fix, mechanically.** `prepareCodemodeLoadout` builds its `namespaces`
map from the *listed* set (`73944666`+), and `createCodemodeDescription` renders
`## ${namespace.name}${listing}`, where `listing` is `""` only when every entry fits. At
`inlineBudget: 3000` `Agent`'s section costs 1154 against 946 remaining, so it is refused and
the `subagents` heading gains ` (some tools not listed)` — 2 of 3 shown, the marker path rather
than the silent one. Under mode `on` the change is invisible: `listed` is
`callable.filter((tool) => !isDirect(tool))`, so a direct tool's namespace never reaches the
description. Two side effects worth recording as gains: `describeNamespace("subagents")` and
`searchTools({ namespace: "subagents" })` now return `Agent`, which are *active* discovery
routes rather than the passive cue risk (b) says cannot be relied on.

**`packages/pi-subagents/test/tool-exposure.test.ts`** encodes the old decision and must
change:
- the namespace loop (`:51-55`) gains `Agent`;
- `"leaves Agent direct"` (`:56-63`) asserts `exposure` still `undefined` **and** `namespace`
  now equal to `NAMESPACE`, renamed to say what it now guarantees.

**`docs/pi-subagents-local-patch.md`** gains a new divergence entry (the next number in that
list) naming the namespace addition, its reason, and the test that pins it.

**Not touched:** the codemode spec's verdict word or its `Follow-ups` table. `f7ber`'s
acceptance criteria forbid any verdict/gate/number change; the implementation record lives on
the bead and in the local-patch doc. The one permitted addition inside risk (a) is the
one-line "mitigation landed" note in §3.2.

### 3. Records

#### 3.1 `sw30` — the extension-arguments contract

A new short root doc, **`docs/pi-extension-args-contract.md`**. The contract is for extension
authors in this repo, not for pi's docs, so candidate 3 (upstream docs) is closed by decision 3
and this is the in-repo home. It carries:

- **The contract.** `execute` may receive undeclared top-level keys. The schema is what the
  model is *asked* to respect; pi does not enforce it. A tool that cannot apply a key must
  reject it by name — which is exactly what the `pi-beads` guard does
  (`packages/pi-beads/src/index.ts:781`).
- **The verified mechanism, re-read on 1.1.0** (the bead's note is 0.99.2):
  `validateToolArguments` (`67915977`) returns `args` unchanged after validation; 1.1.0 adds a
  JSON-schema coercion pass (`coerceWithJsonSchema`, `67912771`) that rewrites **declared**
  keys only — `applySchemaObjectCoercion` (`67911007`) never deletes an undeclared one. So
  `execute` can receive a *coerced* value for a declared key and an untouched value for an
  undeclared one. That coercion pass is new since the bead was written and is the part most
  likely to surprise an author.
- **`additionalProperties: false`, stated explicitly:** *not* enforced by pi. It is forwarded
  to strict-capable providers only; on a non-strict provider the keyword is inert, and on a
  strict one a model that emits an extra key anyway trips `validator2.Check(args)` and pi
  throws `Validation failed for tool …`. A loud side effect, not a guarantee.
- **Cross-reference, not duplication.** The wrong-diagnosis errata already live at
  `docs/superpowers/specs/2026-10-01-pi-beads-packaging-and-update-surface-design.md:266`; the
  new doc links there instead of restating it, which satisfies the bead's "the existing probe's
  conclusion is corrected wherever it was quoted".
- **One pointer line** from the pi-beads guard comment at
  `packages/pi-beads/src/index.ts:779-780`, since the guard is the enforcement this
  contract describes.

#### 3.2 `f7ber` — the codemode spec edits

Four edits to `docs/superpowers/specs/2026-09-30-codemode-adoption-design.md`, plus one
permitted line:

1. **The false absolute, which appears twice.** Residual risk (b) at `:1000` ("currently the
   only *passive* cue that `Agent` exists") **and** the `Why not go` paragraph at `:1009`
   ("whose only *passive* cue is the accidental leak in (b)"). `f7ber`'s acceptance criterion
   names only (b); leaving `:1009` would contradict the corrected text two paragraphs later.
   Both take the implementer's wording: *"the only passive cue to `Agent`'s **dispatch
   guidance** (its bare name also survives in `get_subagent_result`'s listed description)"*.
2. **The Gate 4 heading** (`:769`) — `#### Gate 4 — codemode-absent (settings
   \`-builtin:codemode\`) / \`--no-extensions\` degradation` names a mechanism the gate did not
   use. It becomes: ``#### Gate 4 — codemode-absent (`-ne`, no `builtin:codemode`) /
   `--no-extensions` degradation``.
3. **The counterfactual clause at `:1002-1003`** — *"pi could stop leaking it in any release, at
   which point (a) becomes a genuinely silent tool"*. Once Fix B lands this is false for a
   third reason: the `subagents` marker now signals the omission, so removing the leak no
   longer produces silence. It is corrected to say what is actually true — that the leak is not
   ours to rely on, and that (a)'s mitigation is the namespace marker rather than the leak. The
   replacement must not assert silence in any form ("genuinely silent", "nothing signals"):
   the marker is exactly what makes that claim false.
4. **The "flag" slip at `:1056-1057`** — "the `-builtin:codemode` flag" where the
   disambiguation was just applied. It becomes "the `-builtin:codemode` claim".

   **Also permitted, and required by edit 3:** one line inside risk (a) recording that its
   mitigation landed (commit + date). The verdict word `go-with-mitigations` is **not** touched
   — its remaining condition is risk (b), which is upstream.
   landed (commit + date). The verdict word `go-with-mitigations` is **not** touched — its
   remaining condition is risk (b), which is upstream.

   **Not changed:** the `**Deliverable:**` / `**Test artifacts:**` adjacency (f7ber lists it as
   non-blocking; the authorization clause in the same sentence resolves it).

#### 3.3 Verification — one session pair, two findings

After Fix B lands, one harness serves both `graey` and `peefw`, reusing the spike's method
(§1/§2 of the codemode spec): a throwaway `PI_CODING_AGENT_DIR` with `.pi/settings.json` set to
`codemode.mode: "on"` vs `"only"`, an identical `-e` set (the patched `pi-subagents`,
`codemode-bootstrap`, `bifrost`, `hashline-edit`, `pi-beads`, `pi-superpowers-plus`, plus
`builtin:codemode`), `-nc`, `-p`, on **pi 1.1.0**, sessions persisted under a scratch dir.

- **`peefw`** — hash `sections.rules` in both sessions. Identical ⇒ the leak survives 1.1.0 ⇒
  close "won't-fix, upstream pi behaviour" (decision 3). Different, with the hidden tool names
  gone ⇒ close "fixed upstream in 1.1.0". Either way the two hashes go in the bead comment.
- **`graey`** — read the `only` session's `codemode` description: the `## subagents` heading
  must carry ` (some tools not listed)` and list exactly `steer_subagent` +
  `get_subagent_result`, with `Agent` absent. That is the bead's own acceptance test ("verify
  from a real mode-`only` session at `inlineBudget: 3000`"), so `graey` closes *fixed and
  verified* rather than fixed-and-hoped.

Parsers stay scratch, as the spike's `parse-tools.mjs` did; the durable record is the bead
comment plus the numbers already in the spec.

### 4. Closes and re-files

- **Successor to `2cly`** (P2, `discovered-from` → `2cly`): *"`cost.main.*` controller/main-loop
  cost attribution — design pass"*. Carries the promise's provenance (the cost-tracking design's
  Out-of-scope line), the feasibility finding (`message_end` exposes per-assistant-message
  usage), the two halves (`beads_cost_focus <beadId>` + a `message_end` handler accumulating
  `event.message.usage.cost.total`), and the note that subagent attribution already shipped with
  a smoke assertion (`pi-packages-mol-p9nd.8`).
- **Successor to `6f0p`** (P2, `discovered-from` → `6f0p`, **reparented under `jnr7`**): *"SDD
  fix loop: implementer resume across the eviction window — design pass"*. Carries the repro
  (251 s / 566 s task reviews outlasting the ~10-min window; `Agent not found` on both the name
  and the type alias; `get_subagent_result` never surfacing a durable id) and both halves — the
  pi-subagents tool-side half and the fix-loop's rounds 1–3.
- **Originals close with reasons naming their successors**, so the link is legible from either
  end.
- Then the rest of the disposition table, and finally `pi-packages-6t1xv` closes.

### 5. Rollout

One branch — `johnstegeman/pi-packages-6t1xv`, which this worktree is already on — one PR, and
commits per workstream: fix A, fix B, the records. The two package fixes touch disjoint files
(`packages/pi-beads/**` vs `packages/pi-subagents/**` plus `docs/pi-subagents-local-patch.md`),
so the parallel streams land without a merge step.

Verification is the root gate under the pin: `mise exec node@22 -- npm test` (the gate's own
suite plus `package-gate --all`), which covers `pi-beads` and `pi-subagents` including their
manifest and dep-mirror checks. No dependency moves, so no `npm ci` is expected — if one does,
the lockfile is updated and committed with it.

## Out of scope

- **Adopting stage B** (`codemode.mode: "only"`). This cycle fixes a mitigation for it and
  verifies that mitigation; it does not flip the setting, and it does not create the adoption
  bead. If stage B is ever adopted, the spec's mitigation list plus §3.3's method are the
  checklist.
- **Anything upstream.** No pi issue, no pi PR, no SDK bump. Decision 3.
- **The two successors' actual implementation** — each needs its own brainstorm, spec and plan.
- **The epic `jnr7`'s own theme.** It stays open with the `6f0p` successor under it.
- **Any change to a verdict word, gate result or measured number** in the codemode spec
  (§3.2's four edits are wording, plus the permitted mitigation note).
- **`pi-packages-i8o5` and `pi-packages-d2r6`**, which the pile explicitly excludes as
  active/planned work rather than deferred minors.

## Risks

| Risk | Handling |
|---|---|
| The membership test cannot infer mutability, so a future mutating tool could still be left out of `WRITE_TOOLS` | Stated as the test's own residual gap; the test pins today's inventory, its coverage, and the source-parsed set-equality, which is strictly more than the bead asked for |
| Adding a namespace to `Agent` changes something under mode `on` | Verified against the bundle: `prepareCodemodeLoadout` builds namespaces from the *listed* set, which under `on` excludes every `direct` tool; the two new discovery surfaces (`describeNamespace`, `searchTools`) are additive |
| The two verification sessions differ for unrelated reasons | The spike already hit this: the `cwd` section differs (50 → 52 chars) when the two sessions run from differently-named dirs. The comparison is on `sections.rules` only, and the session pair runs from the **same** dir to keep even that identical |
| The `f7ber` edits touch a spec whose verdict we are not re-litigating | The four edits are wording; the permitted fifth adds an implementation note inside risk (a). No verdict word, gate result or number changes, which is `f7ber`'s own acceptance criterion 3 |
| A "small" fix turns out to need a design pass | The policy already has that door: it becomes a defer ruling made mid-flight, with the successor bead filed the same way as `2cly`/`6f0p` |

## Files

```
docs/pi-extension-args-contract.md                            (new — §3.1)
docs/superpowers/specs/2026-09-30-codemode-adoption-design.md (§3.2: :769, :1000, :1002-1003, :1009, :1056-1057, risk (a) note)
docs/superpowers/specs/2026-10-09-deferred-minor-backlog-triage-design.md  (this spec)
docs/pi-subagents-local-patch.md                              (new divergence entry — §2)
packages/pi-beads/src/index.ts                                (§1: :150-164, :162-178, :781-801)
packages/pi-beads/test/pi-beads.test.mjs                      (§1 tests)
packages/pi-subagents/src/index.ts                            (§2: :87-90, :1604-1607)
packages/pi-subagents/test/tool-exposure.test.ts              (§2: :51-63)
```
