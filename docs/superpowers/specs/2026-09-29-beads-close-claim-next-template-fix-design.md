# Design: close the `beads_close --claim-next` template-claim surface

Date: 2026-09-29
Status: approved (design review), pending implementation
Tracking: `pi-packages-vkw2` (bug), molecule `pi-packages-mol-8w3m`
Follows: PR #65 (merged) — `beads_ready` + `/beads` board template filtering

## Problem

`beads_ready` and the `/beads` board no longer list template protos (PR #65), but
`beads_close({ claimNext: true })` still forwards bd's server-side `--claim-next`
(`packages/pi-beads/src/index.ts:1314`). `bd close --help` defines it as
"Automatically claim the next highest priority available issue" — selected from the
same ready set that leaks `is_template: true` rows — so closing with `claimNext`
can claim a `superpowers-workflow.*` template step. It is the last template-claim
surface in our tools.

`pi-packages` (pmm-iris DB) still shows the leak in raw `bd ready`:

```
$ bd ready --json   # template rows present:
['superpowers-workflow.explore']
```

## Why the fix is client-side

Verified previously (and re-confirmed): the `template` label sits on the molecule
ROOT only, so the step rows carry no labels and `bd ready --exclude-label template`
/ `--exclude-type molecule` do **not** filter them. The per-row `is_template: true`
marker is the only reliable signal, so bd cannot do the exclusion for us. The
selection therefore moves into the extension, reusing the `stripTemplates` helper
added by PR #65.

## Scope

One change in `packages/pi-beads`:

- `src/index.ts` — `beads_close` drops the `--claim-next` passthrough and claims
  the next issue client-side, per closed repo.
- `test/pi-beads.test.mjs` — update the existing `beads_close` flag test and add a
  template-skip regression.
- `README.md`, `skills/beads/SKILL.md` — correct the `beads_close` `claimNext` wording.
- The tool's `claimNext` parameter description.

**Out of scope:** `beads_ready` (already filtered), `beads_update --claim` (explicit
id), the accepted claim-path TOCTOU trade-off, raw `bd close --claim-next` run
outside our tools, and `pi-packages-h0ym` (already closed by PR #65).

## Design

### 1. Behaviour

`beads_close({ ids, claimNext: true })` still closes the ids and claims the next
highest-priority ready issue, but the next issue is chosen client-side over
template-filtered rows. Selection is per closed repo, matching bd's current per-repo
semantics. Everything else is unchanged: the per-repo loop, parent-step cascade,
`continue` / `suggestNext` / `noAuto`, cross-repo batching, and the result shape.

The accepted trade-off (identical to `beads_ready`'s): the close and the claim are no
longer one atomic bd operation; `bd update <id> --claim` remains atomic for the
individual issue.

### 2. Code seam (`src/index.ts`)

Remove the passthrough:

```ts
if (params?.claimNext === true || params?.claimNext === "true") args.push("--claim-next"); // DELETE
```

Add one closure helper beside `stripTemplates`. It must distinguish the three
outcomes — a claimed id, nothing non-template ready, and a claim-write failure —
so a failed write is reported, not silently read as "nothing to claim":

```ts
// bd's own --claim-next selects from the same ready set that leaks template
// protos, and no bd flag can exclude them (the `template` label is on the
// molecule root only). Select client-side instead, over filtered rows.
async function claimNextReady(dir: string): Promise<{ id?: string; error?: string }> {
  const rr = await bd(["ready", "--json", "--include-ephemeral"], dir);
  if (!rr.ok) return { error: `bd ready failed: ${rr.err}` };
  const parsed = jparse(stripTemplates(rr.out));
  const arr = Array.isArray(parsed) ? parsed : parsed?.issues;
  const head = Array.isArray(arr) ? arr[0] : null;
  const id = head?.id ? String(head.id) : null;
  if (!id) return {};                     // nothing non-template ready
  const c = await bd(["update", id, "--claim"], dir);
  if (!c.ok) return { error: `claimed next ${id} but repo claim failed: ${c.err}` };
  await afterWrite(dir);
  return { id };
}
```

In the per-repo loop, after that repo's closes and parent-cascade succeed, when
`claimNext` was requested call `claimNextReady(dir)`: add a returned `id` to the
claimed-next list, or fold a returned `error` into the tool's accumulated `failure`.
The ready query runs in the repo's own `dir`, so the head's owning repo is `dir`
and the claim is written exactly where bd would have written it.

### 3. Output

Append the outcome to the existing result text:

- success: `closed <ids>; claimed next: <id>`
- nothing non-template ready: `closed <ids>; no claimable next issue`
- a claim-write failure is accumulated into `failure` and surfaced by the existing
  `warning:` line, alongside the closed ids.

### 4. Docs

- `README.md:136` (`beads_close` row): state that `claimNext` claims the next ready
  issue **client-side, template protos excluded** (no longer `bd close --claim-next`).
- `skills/beads/SKILL.md:55` (`beads_close` row): same correction to the `claimNext`
  clause.
- The `beads_close` `claimNext` parameter `description` updated to match.

### 5. Tests (`test/pi-beads.test.mjs`)

- Update `single-repo: beads_close maps continue/next flags and still cascades`: the
  close argv becomes `["close","proj-t9","-r","done","--continue","--suggest-next","--no-auto"]`
  (no `--claim-next`), followed by a `ready --json --include-ephemeral` call and an
  `update <id> --claim`.
- New regression: with the fixture's template-head ready payload, `claimNext` claims
  `proj-1a2` and **never** `superpowers-workflow.explore`; with the template-only
  fixture (`FAKE_BD_READY_EMPTY`), it claims nothing and reports
  `no claimable next issue`.

## Verification / definition of done

1. `cd packages/pi-beads && npm test` green (updated + new tests).
2. In a repo with a cooked proto, `beads_close({ claimNext: true })` never claims a
   template step; when only template rows are ready it claims nothing.
3. Cascade / `continue` / `suggestNext` / `noAuto` behaviour unchanged (existing
   tests stay green).
4. Root `npm test` (all package gates) green before finishing.

## Branch

Continue on `johnstegeman/protofix`. The branch tip (`6602ffc`) is an ancestor of
`main`'s merge commit (`28ae933`), so the plan's first step merges `origin/main`
(fast-forward) before adding new commits; the follow-on PR then shows only the new
work.

## Rejected alternatives

- **Keep bd's atomic `--claim-next`** — no server-side exclusion exists; that is the bug.
- **One aggregate claim after all repos close** — simpler, but changes semantics from
  "next in the repo you just closed" to "next anywhere".
- **Drop the `claimNext` parameter entirely** — least code, but removes a documented
  capability and its bd parity, and churns the tool surface, docs, and tests.
