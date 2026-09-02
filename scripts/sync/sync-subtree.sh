#!/usr/bin/env bash
# scripts/sync/sync-subtree.sh
# Merge-onto-branch sync of an upstream subtree. Persistent branch, never force-pushes.
#
# Env inputs: UPSTREAM_REPO (required), UPSTREAM_REF, SUB_TREE_PREFIX, BOT_BRANCH, ORIGIN
# Output (stdout): changed=true|false, upstream_sha=<short sha>, progress lines.
# Exit: 0 success (changed or no-op); non-zero on subtree-pull failure / rejected push.
set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:?UPSTREAM_REPO required}"
UPSTREAM_REF="${UPSTREAM_REF:-master}"
SUB_TREE_PREFIX="${SUB_TREE_PREFIX:-packages/pi-subagents}"
BOT_BRANCH="${BOT_BRANCH:-bot/update-pi-subagents}"
ORIGIN="${ORIGIN:-origin}"

# 1. Upstream remote + fetch (idempotent in a fresh checkout)
git remote remove subagents >/dev/null 2>&1 || true
git remote add subagents "$UPSTREAM_REPO"
git fetch subagents "$UPSTREAM_REF"

# 2. Tolerantly fetch the persistent branch (may not exist yet)
git fetch "$ORIGIN" "refs/heads/$BOT_BRANCH:refs/remotes/$ORIGIN/$BOT_BRANCH" || true

# 3. Establish the branch: existing tip (preserves human commits) or fresh off HEAD
if git rev-parse --verify "refs/remotes/$ORIGIN/$BOT_BRANCH" >/dev/null 2>&1; then
  echo "++ Using existing $BOT_BRANCH (preserves non-main commits)"
  git switch -c "$BOT_BRANCH" "refs/remotes/$ORIGIN/$BOT_BRANCH"
else
  echo "++ Creating fresh $BOT_BRANCH"
  git switch -c "$BOT_BRANCH"
fi

# 4. Merge upstream onto the branch tip; a conflict fails loudly here
BEFORE="$(git rev-parse HEAD)"
if ! git subtree pull --prefix "$SUB_TREE_PREFIX" subagents "$UPSTREAM_REF" --squash; then
  echo "ERROR: git subtree pull failed against $UPSTREAM_REPO@$UPSTREAM_REF (conflict or upstream history issue). Manual resolution required." >&2
  exit 1
fi
AFTER="$(git rev-parse HEAD)"
UPSTREAM_SHA="$(git rev-parse --short "subagents/$UPSTREAM_REF")"

# 5. No-op detection: HEAD unchanged means nothing to sync (never compare vs origin/main)
if [ "$AFTER" = "$BEFORE" ]; then
  echo "changed=false"
  echo "upstream_sha=$UPSTREAM_SHA"
  echo "No upstream changes — nothing to sync."
  exit 0
fi

# 6. Fast-forward push. If the remote branch moved after our fetch, this is rejected
#    (non-FF) and set -e exits non-zero -> the run fails loudly, nothing is clobbered.
git push "$ORIGIN" "$BOT_BRANCH"

echo "changed=true"
echo "upstream_sha=$UPSTREAM_SHA"
