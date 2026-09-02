# pi-subagents Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold `tintinweb/pi-subagents` into this monorepo as a squash git subtree under `packages/pi-subagents/`, register it in the installable collection, and add a nightly GitHub Action that opens a review PR whenever upstream `master` changes.

**Architecture:** Upstream's files are committed directly into this repo's tree via `git subtree add --prefix packages/pi-subagents ... master --squash` so the package installs normally from this repo with no clone-time init step. The root `package.json` `pi.extensions` array points at the subtree's `src/index.ts`, with upstream's runtime deps mirrored into the root `dependencies`. A scheduled `sync-pi-subagents.yml` workflow reruns `git subtree pull` on a `bot/update-pi-subagents` branch and opens a PR (`gh`) only when something actually changed — it never auto-merges.

**Tech Stack:** git subtree (squashed), git + GitHub Actions (`actions/checkout@v4`, `gh`), JSON manifest editing, Markdown docs.

## Global Constraints

- Do **not** hand-edit any file under `packages/pi-subagents/` after Task 1 — the subtree is upstream-tracked; local edits break future `git subtree pull`s (unlike the manually-forked `pi-beads`).
- Always add/pull the subtree with `--squash` against upstream branch `master`. Upstream URL: `https://github.com/tintinweb/pi-subagents.git`.
- The sync workflow must only ever open a PR — never push directly to `main`, never auto-merge.
- Root `package.json` `pi.extensions` entry for the package is exactly `./packages/pi-subagents/src/index.ts` (matches upstream's own `pi.extensions`).
- Runtime deps to mirror verbatim from upstream: `@sinclair/typebox@^0.34.49`, `croner@^10.0.1`, `nanoid@^5.1.16`, `typebox@^1.3.7`.
- This repo's default branch is `main`; all work happens on branch `johnstegeman/fold-in-subagents` and commits land on that branch.

---

### Task 1: Fold in upstream via git subtree (squashed)

Pulls the full upstream `master` tree into `packages/pi-subagents/` as a squashed commit so the package's files live directly in this repo.

**Files:**
- Create (via subtree): `packages/pi-subagents/**` (upstream content — `src/`, `package.json`, `.pi/`, `docs/`, `examples/`, `media/`, `README.md`, etc.)

**Interfaces:**
- Consumes: nothing (pure import of an external repo).
- Produces: directory `packages/pi-subagents/` containing `package.json` and `src/index.ts` — used by Task 2 for registration and by Task 3's workflow prefix.

- [ ] **Step 1: Confirm a clean working tree before the import**

```bash
git status --porcelain
```

Expected: empty output. If the tree is dirty, stash or commit the changes first — an unclean tree makes the subtree merge messy.

- [ ] **Step 2: Confirm you are on the feature branch**

```bash
git rev-parse --abbrev-ref HEAD
```

Expected: `johnstegeman/fold-in-subagents`.

- [ ] **Step 3: Add the subtree (squashed)**

```bash
git subtree add --prefix packages/pi-subagents https://github.com/tintinweb/pi-subagents.git master --squash
```

This fetches upstream `master`, splices its tree under `packages/pi-subagents/`, and produces a single squashed merge (plus a `git-subtree-split:` bookkeeping commit). It runs without a commit prompt — subtree add commits automatically.

- [ ] **Step 4: Ensure the upstream lockfile is tracked in the subtree**

The root `.gitignore` ignores `package-lock.json`, which can hide the upstream lockfile that landed on disk. Force-add it if missing:

```bash
git ls-files packages/pi-subagents/package.json packages/pi-subagents/package-lock.json | grep -q 'package-lock.json' \
  || git add -f packages/pi-subagents/package-lock.json
```

Expected: no error; either the file was already tracked or it was just force-added.

- [ ] **Step 5: Verify the subtree is complete and consistent with upstream**

```bash
echo "tracked files under subtree:" && git ls-files packages/pi-subagents | wc -l
test -f packages/pi-subagents/src/index.ts && echo "src/index.ts present"
test -f packages/pi-subagents/package.json && echo "package.json present"
git status --short | grep -v '^A  packages/pi-subagents/' | grep -v '^?? packages/pi-subagents/' || true
```

Expected: the first line reports > 50 tracked files (upstream has ~60 `src/*.ts` plus docs/examples/media); the two `test` checks echo "present"; the last grep prints nothing outside the subtree. If stray `packages/pi-subagents/**` files are still untracked (shown as `??`), add them with `git add -A packages/pi-subagents`.

- [ ] **Step 6: Commit the fold-in**

```bash
git add -A packages/pi-subagents
git commit -m "chore: fold in tintinweb/pi-subagents as a squashed subtree (packages/pi-subagents)"
```

Expected: commit succeeds, `git status --porcelain` clean. Note: this commit is large (hundreds of files incl. `media/demo.mp4`) — that is expected.

---

### Task 2: Register the extension and mirror deps in root package.json

Makes pi-subagents part of the installable `pi-packages` collection and gives its imports their runtime dependencies.

**Files:**
- Modify: `package.json` (root) — `pi.extensions`, `dependencies`, `peerDependencies`

**Interfaces:**
- Consumes: `packages/pi-subagents/src/index.ts` (from Task 1).
- Produces: root manifest that loads the extension and resolves its deps; used by pi at install/run time. Task 4's README references the package as registered.

- [ ] **Step 1: Add the extension to `pi.extensions`**

Edit root `package.json` so the `"extensions"` array under `"pi"` gains one item. The array currently is:

```json
"extensions": [
  "./packages/bifrost/index.ts",
  "./packages/statusline/src/statusline.ts",
  "./packages/hashline-edit/src/index.ts",
  "./packages/langfuse/index.ts",
  "./packages/pi-beads/src/index.ts"
]
```

Append `"./packages/pi-subagents/src/index.ts"` as the new last element (keep existing entries untouched).

- [ ] **Step 2: Add the runtime dependencies**

In the root `"dependencies"` block, add exactly these four (keep all existing langfuse entries):

```json
"@sinclair/typebox": "^0.34.49",
"croner": "^10.0.1",
"nanoid": "^5.1.16",
"typebox": "^1.3.7"
```

Place them in alphabetical order alongside the existing `@langfuse/*`, `@opentelemetry/*`, and `langfuse`-style entries — the block is already sorted, so insert `@sinclair/typebox` after the `@opentelemetry` group and `croner`/`nanoid`/`typebox` among the lowercase entries.

- [ ] **Step 3: Add the `pi-tui` peer dependency**

`packages/pi-subagents` imports `@earendil-works/pi-tui` (its `peerDependencies` declare it `>=0.84.0`). Add it to the root `"peerDependencies"` block (currently `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`, both `"*"`):

```json
"@earendil-works/pi-tui": "*"
```

Keep the existing two peer entries as-is.

- [ ] **Step 4: Verify the manifest is valid JSON and the path resolves**

```bash
python3 -m json.tool package.json >/dev/null && echo "valid JSON"
grep -c '"\./packages/pi-subagents/src/index\.ts"' package.json
grep -cE '"@sinclair/typebox"|"croner"|"nanoid"|"typebox"' package.json
grep -c '"@earendil-works/pi-tui"' package.json
```

Expected: "valid JSON", then 1, then 4, then 1. (If `python3` is missing, also run `node -e "JSON.parse(require('fs').readFileSync('package.json'))"` and check for "valid".)

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat: register pi-subagents extension and mirror its deps in root manifest"
```

Expected: commit succeeds; `git status --porcelain` shows only `package.json` in the commit.

---

### Task 3: Add nightly sync GitHub Action

Scheduled workflow that pulls upstream `master` into the subtree and opens a review PR when something changed. Contained in one new file; creates the repo's first `.github/workflows/`.

**Files:**
- Create: `.github/workflows/sync-pi-subagents.yml`

**Interfaces:**
- Consumes: `packages/pi-subagents/` subtree prefix (from Task 1), `main` as the PR base (repo default branch).
- Produces: on upstream change, a branch `bot/update-pi-subagents` + an open PR titled "chore: sync pi-subagents from upstream" for human review.

- [ ] **Step 1: Create `.github/workflows/sync-pi-subagents.yml` with this exact content**

```yaml
name: Sync pi-subagents

on:
  schedule:
    - cron: '0 4 * * *'   # nightly 04:00 UTC
  workflow_dispatch: {}   # manual "Run workflow" button

permissions:
  contents: write
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout main with full history
        uses: actions/checkout@v4
        with:
          fetch-depth: 0        # git subtree needs the full history
          ref: main

      - name: Configure git bot identity
        run: |
          git config user.name 'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

      - name: Add upstream remote and fetch
        run: |
          git remote add subagents https://github.com/tintinweb/pi-subagents.git
          git fetch subagents master

      - name: Create sync branch
        run: git switch -c bot/update-pi-subagents

      - name: Pull subtree from upstream
        run: git subtree pull --prefix packages/pi-subagents subagents master --squash

      - name: Detect whether anything changed
        id: changes
        run: |
          if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
            echo "changed=false" >> "$GITHUB_OUTPUT"
            echo "No upstream changes — nothing to sync."
          else
            echo "changed=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Push sync branch
        if: steps.changes.outputs.changed == 'true'
        run: git push --force-with-lease origin bot/update-pi-subagents

      - name: Open pull request
        if: steps.changes.outputs.changed == 'true'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          EXISTING=$(gh pr list --head bot/update-pi-subagents --state open --json number -q '.[0].number')
          if [ -z "$EXISTING" ]; then
            gh pr create --base main --head bot/update-pi-subagents \
              --title "chore: sync pi-subagents from upstream" \
              --body "Automated \`git subtree pull\` of tintinweb/pi-subagents@master.

          If this PR adds or removes runtime dependencies, mirror them into root
          package.json \`dependencies\` (croner, nanoid, @sinclair/typebox, typebox)."
          else
            echo "PR #$EXISTING already open for bot/update-pi-subagents — branch updated in place."
          fi
```

Notes:
- The "Detect" step is the no-op safety: when upstream is unchanged, `git subtree pull` commits nothing, `HEAD` still equals `origin/main`, so the branch is never pushed and no PR is created.
- `--force-with-lease` safely refreshes an already-existing `bot/update-pi-subagents` branch (e.g. an older unmerged PR) instead of erroring on a non-fast-forward push.
- The final step skips creating a duplicate PR when one is already open for that branch — the force-push above has already refreshed it.

- [ ] **Step 2: Verify the workflow parses as YAML**

```bash
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/sync-pi-subagents.yml'); puts 'valid YAML'" || \
python3 -c "import sys, yaml; yaml.safe_load(open('.github/workflows/sync-pi-subagents.yml')); print('valid YAML')"
```

Expected: prints "valid YAML". (macOS ships `ruby` with YAML; fall back to `python3 -c` if `ruby` is unavailable. If neither is present, skip the check and rely on the careful copy + GitHub's own validation on push.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/sync-pi-subagents.yml
git commit -m "ci: nightly sync of pi-subagents subtree with review-PR safety gate"
```

Expected: commit succeeds; only the new workflow file is staged.

---

### Task 4: Update docs

Reflects the new package and its sync mechanism in the repo's surface documentation.

**Files:**
- Modify: `README.md` (package list + sync note)
- Modify: `AGENTS.md` (short repo-convention note)

**Interfaces:**
- Consumes: the registered package (Task 2) and the workflow (Task 3).
- Produces: documentation that names the package and warns against hand-editing the subtree.

- [ ] **Step 1: Add pi-subagents to the README package list**

In `README.md`, the package list is a fenced block headed `packages/`. Add this line after the `pi-beads/` entry:

```text
pi-subagents/  – vendored fork via squashed git subtree of tintinweb/pi-subagents (auto-synced nightly via PR)
```

Then update the tree glyphs so the block stays well-formed: change the existing `└──` in front of `pi-beads/` to `├──`, and give the newly added `pi-subagents/` line `└──` (the tree must have exactly one `└──`, on its final line).

- [ ] **Step 2: Add a sync note to the README**

Below the package list (after the fenced block), add a short section:

```markdown
## Upstream-tracked subtree: pi-subagents

`packages/pi-subagents/` is a squashed [git subtree](https://git-scm.com/book/en/v2/Git-Tools-Subtree-Merging)
of `tintinweb/pi-subagents` (branch `master`). It is **upstream-tracked — do not hand-edit
files inside it**; local edits will conflict with the next sync.

A nightly GitHub Action (`.github/workflows/sync-pi-subagents.yml`, 04:00 UTC + manual
`workflow_dispatch`) runs `git subtree pull` on a `bot/update-pi-subagents` branch and opens a
review PR when upstream changes. Merge it to accept the update. No changes are ever pushed to
`main` or auto-merged.
```

- [ ] **Step 3: Add a convention note to AGENTS.md**

In the "Repo layout" section of `AGENTS.md`, after the `pi-beads/` bullet, add:

```markdown
└── pi-subagents/  – Squashed git subtree of tintinweb/pi-subagents; upstream-tracked (do not hand-edit); synced nightly via .github/workflows/sync-pi-subagents.yml (opens a review PR). Manual sync: `git subtree pull --prefix packages/pi-subagents <url> master --squash`.
```

Then update the tree glyphs in that layout block: change the existing `└──` in front of `pi-beads/` to `├──`, and the added pi-subagents bullet keeps `└──` as the new final line of the block.

- [ ] **Step 4: Verify the doc edits**

```bash
grep -n "pi-subagents" README.md
grep -n "pi-subagents" AGENTS.md
```

Expected: each file shows the newly added line(s). Glance at the package-list block in `README.md` — it must still render as a well-formed tree (exactly one `└──`).

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document pi-subagents subtree and the nightly sync workflow"
```

Expected: commit succeeds; `git status --porcelain` clean.

---

### Task 5: End-to-end verification

Confirms the whole change set is coherent before handing off — a read-only sanity pass, no new code.

**Files:**
- (none modified in this task)

**Interfaces:**
- Consumes: all prior tasks' outputs.
- Produces: a verified, ready-to-push branch.

- [ ] **Step 1: Confirm everything is committed and the tree is clean**

```bash
git status --porcelain
git log --oneline -6
```

Expected: empty `git status` output; the last 6 commits are the design-doc commit plus the four task commits from this plan (fold-in, register/manifest, workflow, docs).

- [ ] **Step 2: Confirm the subtree exists and matches upstream master**

```bash
git ls-files packages/pi-subagents | wc -l
test -f packages/pi-subagents/src/index.ts && echo "entry file OK"
git log --oneline -1 --grep="subtree"
```

Expected: > 50 tracked files; "entry file OK"; the fold-in commit appears in the log.

- [ ] **Step 3: Confirm the manifest loads the extension and deps are mirrored**

```bash
python3 -m json.tool package.json >/dev/null && echo "manifest valid"
grep -c '"\./packages/pi-subagents/src/index\.ts"' package.json
node -e "const p=require('./package.json'); ['croner','nanoid','@sinclair/typebox','typebox'].forEach(d=>{if(!p.dependencies?.[d]){console.error('missing '+d);process.exit(1)}}); console.log('runtime deps present')"
```

Expected: "manifest valid", `1`, "runtime deps present".

- [ ] **Step 4: Confirm the workflow file is present and YAML-valid**

```bash
test -f .github/workflows/sync-pi-subagents.yml && echo "workflow present"
grep -q "never auto-merge\|pull-requests: write" .github/workflows/sync-pi-subagents.yml && echo "PR gate present"
```

Expected: "workflow present" and "PR gate present".

- [ ] **Step 5: Summarize for the user**

Report, in the final message: the 4 commits on `johnstegeman/fold-in-subagents`, the count of subtree files, the workflow's trigger schedule, and the two manual follow-ups that live outside this repo:
1. Remove the standalone pi-subagents install from the global pi config (so the extension loads once, from this package).
2. After merging to `main`, run the workflow via `workflow_dispatch` once to confirm the no-op path ("No upstream changes") before relying on the nightly run.

---

## Verification

- [ ] All five tasks committed; `git status --porcelain` clean on `johnstegeman/fold-in-subagents`.
- [ ] `packages/pi-subagents/src/index.ts` present; > 50 tracked subtree files.
- [ ] Root `package.json` valid JSON; extension path registered once; 4 runtime deps + `pi-tui` peer dep present.
- [ ] `.github/workflows/sync-pi-subagents.yml` YAML-valid; contains the `changed` detection, `--force-with-lease` push, and `gh pr create` guard so `main` is never written directly.
- [ ] README + AGENTS.md document the package and the do-not-hand-edit subtree rule.

## Notes

- The folder-in is a vendoring task (pure import of an external repo), so there is no unit-test code here; each step's "test" is the verification command shown for it. The mechanical guarantee this plan relies on is `git subtree pull` reporting "Already up to date." when upstream is unchanged — that is what makes the nightly no-op free.
- Manual follow-up (outside this repo, per the approved spec): remove the standalone pi-subagents source from the user's global pi config so the extension is not double-loaded once registered here.
- Out of scope: forking/customizing pi-subagents locally (upstream-tracked by design), and converting the existing manually-vendored pi-beads/pi-langfuse packages to subtrees (a repeatable future job, not part of this plan).
