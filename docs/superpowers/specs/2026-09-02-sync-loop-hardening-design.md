# Design: Sync-loop hardening — bot-branch edit preservation + CI validation lane

Date: 2026-09-02 · Follow-up to [`2026-09-02-pi-subagents-sync-design.md`](./2026-09-02-pi-subagents-sync-design.md) (merged via PR #17) · Source bead: `pi-packages-ugi`

## Goal

Harden the pi-subagents nightly sync loop in two ways, following up on the deferred
whole-branch review of the initial fold-in:

1. **Bot-branch edit preservation** — a human's un-merged commit on
   `bot/update-pi-subagents` (e.g. a dep-mirror fix added to the sync PR) must never be
   silently discarded by the next nightly run.
2. **CI validation lane** — PRs to `main` and pushes to `main` carry a red/green signal
   covering manifest validity, registration/path resolution, and a subtree
   install+typecheck smoke, plus an automated dep-mirror gate.

## Context

- `packages/pi-subagents/` is a squashed git subtree of `tintinweb/pi-subagents` (branch
  `master`), upstream-tracked (do not hand-edit).
- The merged `.github/workflows/sync-pi-subagents.yml` **rebuilds** the bot branch from
  `main` each run (checkout main → `git subtree pull` → `--force-with-lease` push), opens
  or refreshes a review PR. A non-`main` commit on the branch (a human dep-mirror fix) is
  thus silently dropped by the next run.
- The PR body currently asks a human to mirror new runtime deps into root
  `package.json` — the exact commit that gets clobbered. There is no CI to make that
  pass/fail.
- The subtree ships `npm run typecheck` (`tsc --noEmit`), `npm run lint` (biome) and
  `npm test` (vitest), with a tracked `package-lock.json`.
- `main` is effectively static: it moves only to accept sync PRs and occasional other
  merges.

## Decision

### 1. Branch preservation: merge-onto-branch (mechanism A, approved)

Persistent single branch `bot/update-pi-subagents`. Each run merges the new subtree
onto the branch's current tip instead of rebuilding from `main`, so human fix-ups
survive; any conflict or non-fast-forward push fails the run loudly.

Reworked per-run flow in `sync-pi-subagents.yml`:

1. Checkout `main` with `fetch-depth: 0`; configure bot identity; add upstream remote
   and `git fetch subagents master`. Unchanged from current runtime.
2. Tolerantly fetch the existing branch:
   `git fetch origin 'refs/heads/bot/update-pi-subagents:refs/remotes/origin/bot/update-pi-subagents' || true`.
3. Establish the branch:
   - If the ref exists → `git switch -c bot/update-pi-subagents refs/remotes/origin/bot/update-pi-subagents`
     (branch starts at its current tip, human commits included).
   - Else → `git switch -c bot/update-pi-subagents` off `main` (first run / post-merge).
4. Capture baseline `BEFORE=$(git rev-parse HEAD)`.
5. `git subtree pull --prefix packages/pi-subagents subagents master --squash` — merges
   upstream onto the tip.
6. No-op detection: if `HEAD == BEFORE`, print "No upstream changes" and exit silently.
   (No longer compared against `origin/main` — the branch legitimately carries
   non-main commits.)
7. Push only if changed: `git push origin bot/update-pi-subagents` — a plain, non-force
   fast-forward. Because the branch is never rebuilt and `main` is static, pushes are
   always additive; if the remote moved between fetch and push the push is rejected and
   the run fails loudly.
8. Open/refresh PR only when changed (existing `gh` logic, upstream SHA in the body).

Concurrency guard and `workflow_dispatch` trigger remain. **No `--force` anywhere.**

Why not the alternatives (recorded trade-offs):
- *Dated per-run branches* (`bot/update-pi-subagents-YYYYMMDD`): zero clobber risk by
  construction but proliferates branches/PRs and splits review across competing open
  PRs, contradicting the chosen "one sync PR carries the fix through review" flow.
- *Rebuild-from-main + divergence guard*: smallest diff, refuses to clobber, but does not
  preserve the fix across runs — the loop stalls (fails every night) until the human
  merges, rather than becoming non-destructive.
- *Merging latest `main` into the branch each run*: rejected because `main` is
  effectively static; nothing to track.

### 2. CI validation lane (approved)

New `.github/workflows/ci.yml`, on `pull_request` (branches: `main`) and `push`
(branches: `main`). Three parallel jobs; a fourth is optional.

- **Job `manifest`** — validates the root `package.json`: parses as JSON, and every path
  in `pi.extensions` / `pi.themes` / `pi.skills` resolves to an existing file or
  directory in the checkout.
- **Job `deps-mirror`** — runs the checked-in `scripts/ci/check-deps-mirror.mjs` (repo
  root, outside the subtree — not upstream-tracked), which:
  - reads `packages/pi-subagents/package.json` `dependencies` and root `package.json`
    `dependencies`;
  - asserts every subtree dep is present in root deps (hard gate — this is the PR-body
    checklist made automatic);
  - asserts the root version range is compatible with the subtree's range via
    `semver.intersects`; the job installs `semver@7` into a throwaway temp prefix
    (`npm install --no-save semver@7 --prefix <tmp>`, then
    `NODE_PATH=<tmp>/node_modules node scripts/ci/check-deps-mirror.mjs`) for a
    deterministic, dependency-free-at-runtime check (~2s).
  - Extra root deps (langfuse/otel) are allowed and ignored.
- **Job `subtree-smoke`** — `actions/setup-node@v4` (Node 20, npm cache keyed on
  `packages/pi-subagents/package-lock.json`) → `npm ci` → `npm run typecheck`. This is
  the install+tsc smoke. Upstream's `lint`/`build`/`vitest` intentionally omitted to
  keep runtime fast (we only need the vendored copy to compile).
- **Job `workflow-lint` (optional)** — `actionlint` on `.github/workflows/*.yml`
  (single static binary), so a broken bot workflow YAML can't slip through silently.
  Cheap; default is to include.

Since `main` is effectively static and sync PRs target `main`, running CI on all PRs +
pushes to `main` gives the sync path its signal without scoping gymnastics.

## Files

- Modify: `.github/workflows/sync-pi-subagents.yml` — merge-onto-branch rework.
- Create: `.github/workflows/ci.yml` — validation lane.
- Create: `scripts/ci/check-deps-mirror.mjs` — shared dep-mirror check.
- Modify: `README.md`, `AGENTS.md` — short notes documenting the persistent sync branch
  and the CI lane.

## Error handling

All failure modes fail the run loudly; nothing silent:
- **Subtree-pull conflict** (human fix-up vs. upstream): step fails → manual
  `git subtree pull` resolution or re-`add`.
- **Remote moved between fetch and push**: plain push rejected (non-FF) → run fails,
  retry next night or via `workflow_dispatch`.
- **PR creation failure**: run fails; retry via `workflow_dispatch`.
- **CI**: any red job blocks the PR merge; a sync that misses a dep mirror or fails to
  compile cannot look green.

## Testing / verification

- `actionlint` on both workflow files before committing.
- **Local simulation of the branch mechanics** (the one part where the git dance can go
  wrong): in a throwaway clone, build a fake upstream + a `bot/update-pi-subagents` with
  a human commit on top of a prior sync, run the new scripted sequence, assert
  (a) the human commit survives the next sync merge, (b) the push is a fast-forward,
  (c) the no-op path pushes nothing.
- After merge: one `workflow_dispatch` to confirm the live loop; the CI lane proves
  itself on the follow-up PR.

## Scope

- **In:** the branch rework, the CI lane, the deps-mirror script, docs.
- **Out:** moving `main`; auto-merge (stays PR-only); switching subtree → submodule;
  syncing other upstream packages; running upstream's full `lint`/`test`/`vitest` in CI.

## Risks

- A human dep-fix that will never merge keeps failing the nightly run until resolved —
  intended loud behavior, not silent data loss.
- `git subtree pull` onto a tip with divergent human edits can conflict; manual
  resolution is the designed (rare) escape hatch.
- CI `npm ci` runtime is tens of seconds per run — accepted by the user.
