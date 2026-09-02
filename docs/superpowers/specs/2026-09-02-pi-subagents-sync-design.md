# Design: Fold in `tintinweb/pi-subagents` with automated sync

Date: 2026-09-02 · Branch: `johnstegeman/fold-in-subagents`

## Goal

Make [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) a first-class
part of this monorepo (it "lives here"), while keeping it in lockstep with upstream:

1. The package is folded into `packages/pi-subagents/` using **git subtree** — its files
   are committed directly into this repo's tree, so clones get everything with no init
   step and `pi install git:...pi-packages` works for it.
2. The package is **registered in the installable collection** (root `package.json`),
   and pi-subagents is removed from the user's global pi config to avoid a double load.
3. Upstream changes are picked up automatically: a **scheduled GitHub Action** detects
   changes to upstream `master` and opens a PR for review. **Never auto-merges.**

## Context

- `pi-packages` is a personal monorepo of pi extensions/themes, each self-contained under
  `packages/<name>/`, registered via the root `package.json` `pi` manifest, installable via
  `pi install git:github.com/johnstegeman/pi-packages`.
- Existing vendored packages (`pi-beads` fork of `abix5/pi-beads`, `pi-langfuse`) are plain
  copied directories with local modifications on top. `pi-subagents` differs: we want it to
  **track upstream**, so it should not be hand-edited in place (see Risks).
- Upstream details:
  - Default branch: `master`
  - Package: `@tintinweb/pi-subagents` (roughly v0.19+)
  - Self-contained pi extension with `src/`, `.pi/agents/`, `examples/`, `docs/`, `media/`.
  - Runtime deps: `croner`, `nanoid`, `@sinclair/typebox`, `typebox`
  - Peer deps: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
    `@earendil-works/pi-tui` (all `>=0.84.0`)
- This repo's default branch is `main`; work happens on `johnstegeman/fold-in-subagents`.

## Decision

### 1. Mechanism: git subtree (squashed)

```
git subtree add --prefix packages/pi-subagents \
  https://github.com/tintinweb/pi-subagents.git master --squash
```

- Files land under `packages/pi-subagents/` as regular committed content.
- `--squash` imports one commit per sync; upstream's full history is not retained here.
- Subsequent syncs: `git subtree pull --prefix packages/pi-subagents <upstream> master --squash`.
- A named remote alias (`git remote add subagents <url>` in the sync workflow) makes the
  pull stable.

**Subtree, not submodule**: submodule stores only a gitlink (pinned commit) and requires
`git submodule update --init` on clone — which would leave `packages/pi-subagents` empty in
plain clones and break `pi install` from GitHub. Subtree keeps content in-tree.

### 2. Registration (approved: option A — part of the collection)

- Root `package.json`:
  - Add `./packages/pi-subagents/src/index.ts` to `pi.extensions`.
  - Add `croner`, `nanoid`, `@sinclair/typebox`, `typebox` to `dependencies`
    (same pattern as the existing langfuse deps).
- User removes the standalone pi-subagents install from their global pi config so the
  extension loads once, from this package.

### 3. Auto-update: nightly GitHub Action

New file `.github/workflows/sync-pi-subagents.yml` (repo currently has no `.github`).

**Triggers**: `schedule` cron `0 4 * * *` (04:00 UTC) + `workflow_dispatch` (manual button).

**Permissions**: `contents: write`, `pull-requests: write`; uses `GITHUB_TOKEN` + `gh`.

**Steps** (on `ubuntu-latest`):
1. `actions/checkout@v4` with `fetch-depth: 0` (subtree needs full history), `ref: main`.
2. Configure git bot identity (`github-actions[bot]`).
3. `git remote add subagents https://github.com/tintinweb/pi-subagents.git`; `git fetch subagents master`.
4. Create branch `bot/update-pi-subagents` off `main`.
5. `git subtree pull --prefix packages/pi-subagents subagents master --squash`.
6. If HEAD moved (real upstream change): push branch, open PR (base `main`) citing the
   upstream commit range; `gh pr create` (skip if an open PR for that branch exists).
   If "Already up to date": exit silently, no PR, no push.

**Safety gate**: the PR is for human review — no auto-merge, no direct push to `main` from
the workflow. A conflicted pull is surfaced as a failed run (or failed PR creation) and
reviewed manually.

### 4. Docs

- `README.md`: add `pi-subagents` line to the packages list; note the nightly auto-sync.
- Optional `AGENTS.md` note documenting the subtree + sync workflow.

## Error handling

- **Subtree pull conflict** (only possible if something edited inside `packages/pi-subagents`
  or upstream rewrote history): workflow run fails loudly; fix manually (`git subtree pull`
  resolving conflicts, or re-`add` if unrecoverable). Because we never hand-edit the subtree,
  conflicts should never occur in practice.
- **Already up to date**: no-op, silent success.
- **GH token / PR creation failure**: workflow fails; run can be retried manually via
  `workflow_dispatch`.

## Testing / verification

- After the subtree add: `packages/pi-subagents/src/index.ts` exists; subtree dir consistent
  with upstream `master` tree (`git diff` against upstream compares clean).
- Root manifest valid: `node -e "JSON.parse(require('fs').readFileSync('package.json'))"` and
  the extension path resolves.
- The GitHub Action's subtree-pull/no-op path is exercised by manually running
  `workflow_dispatch` once after merge (it should report "already up to date" or open a PR).

## Out of scope

- Forking or locally customizing pi-subagents (upstream-tracked by design).
- Syncing other upstream packages (e.g. re-vendoring pi-beads/pi-langfuse) — same pattern
  can be repeated later if wanted.

## Risks

- **Hand-editing the subtree** breaks future pulls. Mitigation: documented convention; CI PRs
  make divergences obvious.
- **Dependency drift**: upstream may add/remove runtime deps; the root `dependencies` mirror
  must be updated when a sync PR lands (a step included in the PR body checklist).
- **Package size**: upstream ships `media/demo.mp4`; acceptable for a package repo, noted for
  awareness.
- **Double-load**: avoided by removing pi-subagents from the global pi config (approved).
