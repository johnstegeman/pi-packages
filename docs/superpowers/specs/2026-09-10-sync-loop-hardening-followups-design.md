# Design: Sync-loop hardening follow-ups — sim failure-path coverage, fresh-branch fix, actionlint pin

Date: 2026-09-10 · Source backlog: bead `pi-packages-8cd` (post-review follow-ups + root causes folded in from `pi-packages-cdzy`) · Molecule: `pi-packages-mol-s224` · Branch: `feat/sync-loop-hardening-followups`

## Goal

Harden the pi-subagents nightly sync loop against the failure family observed on 2026-09-04/05 and close the two root causes identified in the `cdzy` post-mortem, to the **A+C scope agreed with the user** (tier-B minors stay on the `8cd` backlog, see Scope).

1. **A1 — Sim failure-path coverage**: `scripts/sim/simulate-sync.sh` currently proves only the happy path (a/b/c). Add scenarios proving the loud-failure paths: the subtree-pull conflict (`sync-subtree.sh:35` → exit 1) and the deleted-branch fresh-branch else-path (`sync-subtree.sh:30`).
2. **A2 — Actionlint pin**: `.github/workflows/ci.yml` pipes an unpinned `rhysd/actionlint@main` installer to bash under `sudo` each run.
3. **C1 — Fresh-branch path never establishes the persistent branch**: the `changed=false` early-exit (`sync-subtree.sh:43-48`) precedes the push (`:52`). A freshly-created branch is therefore never pushed until there is upstream drift, so every subsequent run repeats the tolerated fetch failure — exactly what 09-04 and 09-05 hit.
4. **C2 — The review-PR step is blocked by repo security**: on 09-05 the sync itself worked (merge + push of `e955e29`), but PR creation failed with `GitHub Actions is not permitted to create or approve pull requests (createPullRequest)`. `GITHUB_TOKEN` cannot create PRs in this repo — a repo-settings fix (user action), plus a greppable error message so a recurrence names the fix.
5. **C3 — 09-04 subtree-pull flake** (`fatal: working tree has modifications. Cannot add.` on a clean checkout; identical inputs merged fine on 09-05): not reproducible in hindsight; its failure family is covered by the A1 conflict scenario.

## Context

- `packages/pi-subagents/` is a squashed git subtree of `tintinweb/pi-subagents` (`master`), upstream-tracked (do not hand-edit).
- The merged sync loop (`.github/workflows/sync-pi-subagents.yml` + `scripts/sync/sync-subtree.sh`) follows the merge-onto-branch contract from [`2026-09-02-sync-loop-hardening-design.md`](./2026-09-02-sync-loop-hardening-design.md): persistent `bot/update-pi-subagents`, merges upstream onto the current tip (preserving human commits), plain fast-forward pushes, **no `--force` anywhere**, review PR opened on change.
- Observed timeline: 09-02 manual runs (old workflow variant) green; 09-03 first night of the new variant (`changed=false`, no drift); 09-04 **FAILED** — bot branch missing on origin → fresh path → `git subtree pull` `working tree has modifications`; 09-05 **FAILED** — branch still missing → fresh path → merge succeeded (upstream had moved to `e955e29`), branch pushed, but the PR step died on the permission error; 09-06…09-10 five "green" runs that were vacuous `changed=false` no-ops (the update sits on the branch, not `main`).
- `main` was left stale at the original `4f572ea` subtree until the update was delivered manually as PR #33 on 2026-09-10 (3 files, +28/−1, all four CI gates green). No review PR has ever been opened from the bot branch (`gh pr list --head bot/update-pi-subagents` empty).
- The sim (`scripts/sim/simulate-sync.sh`) is currently local-only verification; it is not wired into CI.

## Decision

### 1. `scripts/sync/sync-subtree.sh` — establish a fresh branch on origin (C1)

- Track `FRESH=1` when step 3 takes the else-branch (`git switch -c "$BOT_BRANCH"` with no remote ref).
- Push rule becomes: **push when `changed=true`, or when the branch was created fresh.** A no-op fresh run pushes the (empty) branch so it materializes on origin; an existing-branch no-op still pushes nothing.
- Plain `git push "$ORIGIN" "$BOT_BRANCH"` only — publishing a branch that does not exist remotely is additive by construction; **no `--force` anywhere** (unchanged).
- Output contract unchanged: `changed=true|false` and `upstream_sha=` lines; exit codes unchanged (0 no-op / changed, non-zero on subtree-pull failure or rejected push).

### 2. `scripts/sim/simulate-sync.sh` — scenarios S2 and S3 (A1, C1-proof, C3-family)

Existing happy path (a: human commit survives, b: fast-forward push, c: no-op pushes nothing) is kept intact. Two added scenarios:

- **S2 — loud subtree-pull conflict**. After upstream advances once more touching a subtree file the human *renamed* on the bot branch (a `git mv` creates a delete/modify pair), run the real script and assert `RC != 0` and the `ERROR: git subtree pull failed … Manual resolution required` text on stderr. Deterministic: delete/modify is a guaranteed merge conflict.
- **S3 — deleted branch, no drift**. Delete the remote `bot/update-pi-subagents` ref, run with upstream unchanged, assert exit 0, `changed=false`, **and** `git ls-remote` shows the branch re-present on origin (C1 proven fixed); then run once more and assert the "*Using existing*" branch is taken, proving the tolerant-fetch failure stops recurring.

`pass()` message updated to enumerate all five assertions (a, b, c, S2, S3).

### 3. `.github/workflows/ci.yml` — sim job + pinned actionlint (A1-enforcement, A2)

- New `sim` job: `actions/checkout@v4` → `bash scripts/sim/simulate-sync.sh`. Scratch repos in `mktemp`, no network beyond the checkout, ~2s. Turns the new failure-path coverage into a permanent PR gate.
- `workflow-lint` job: replace the unpinned installer pipe with a checksum-verified download of a pinned release:
  - `https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_x86_64.tar.gz`
  - the matching `actionlint_1.7.12_checksums.txt` entry filtered to `linux_x86_64`, verified with `sha256sum -c` (job fails on mismatch), then extract + `sudo mv actionlint /usr/local/bin/`, then `actionlint .github/workflows/*.yml`.
  - Version is an explicit constant for hand bumps; no more `@main` drift.

### 4. `.github/workflows/sync-pi-subagents.yml` — greppable PR-permission failure (C2)

Capture `gh pr create/edit` output on failure; if it matches `not permitted to create or approve pull requests`, print an `::error::` naming the exact fix path (repo Settings → Actions → General → Workflow permissions → *Allow GitHub Actions to create and approve pull requests*), then exit non-zero. Post-flip this path won't trigger; pre-flip it is one grep away from the remedy.

### Ops pre-requisite (user action, before live verification)

Enable **Allow GitHub Actions to create and approve pull requests** in the repo settings. This is the only piece that cannot be committed to the repo.

## Files

- Modify: `scripts/sync/sync-subtree.sh` — FRESH flag; push fresh branches on no-op.
- Modify: `scripts/sim/simulate-sync.sh` — S2, S3, updated `pass()`.
- Modify: `.github/workflows/ci.yml` — `sim` job; pinned actionlint download.
- Modify: `.github/workflows/sync-pi-subagents.yml` — PR-step failure message.

## Error handling

- **Subtree-pull conflict** → non-zero exit + existing ERROR message (S2 asserts this stays loud).
- **Push rejected (non-FF because remote moved)** → `set -e` fails the run, nothing clobbered (unchanged).
- **Actionlint checksum mismatch** → `workflow-lint` job fails; no silent unpinned binary.
- **PR-permission block** → explicit `::error::` naming the settings path; the run fails correctly until the flip.

## Testing / verification

1. Local: `bash scripts/sim/simulate-sync.sh` → all five assertions PASS.
2. This branch's PR: new `sim` job green; `workflow-lint` (pinned v1.7.12) green; existing manifest / deps-mirror / subtree-smoke green.
3. Post-merge + settings flip: `workflow_dispatch` on the sync loop. With upstream still at the just-synced `e955e29` this is a `changed=false` no-op (PR step skipped) — it proves the loop no longer errors. The genuine "opens a review PR" proof arrives on the next upstream drift; the sim already covers branch mechanics, the flip covers permission.

## Scope

- **In:** the four file changes above + the ops pre-requisite.
- **Out — stays on the `8cd` backlog as tier B:** `semver.intersects` try/catch with an `INVALID RANGE` message (`scripts/ci/check-deps-mirror.mjs:32`), the exit-2 semver-unresolvable test case, `actions/cache` for the semver install, operator hint echoing the actual `NODE_PATH`, a documented root command to run sim + gate suite.
- **Unchanged (existing decisions):** no auto-merge (sync stays PR-only), no subtree→submodule switch, only `pi-subagents` is synced, upstream's full `lint`/`vitest` still not run in CI.

## Risks

- Fresh-branch push on no-op creates `bot/update-pi-subagents` even when it would have stayed absent — intended (this is C1's fix); no clobber risk since the branch does not exist and the push is plain.
- S2 relies on git delete/modify merge semantics for a deterministic conflict — stable behavior across git versions.
- The pinned actionlint version goes stale and must be bumped by hand — accepted; that is the point of pinning (the bump is a one-line constant).
- If the settings flip is skipped, the PR step keeps failing loudly (now with the explicit message) and drift accumulates on the branch — same posture as today, but greppable.
