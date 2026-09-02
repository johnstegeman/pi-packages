#!/usr/bin/env bash
# scripts/sim/simulate-sync.sh
# Faithful simulation of the merge-onto-branch sync against scratch repos built with real
# `git subtree add/pull`, verifying scripts/sync/sync-subtree.sh preserves:
#   (a) a human commit on bot/update-pi-subagents survives the next sync
#   (b) the sync push is a fast-forward (no --force anywhere)
#   (c) a no-op run (upstream unchanged) pushes nothing
# Exit 0 on PASS; non-zero with a "FAIL: ..." message otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # repo root
SCRIPT="$ROOT/scripts/sync/sync-subtree.sh"
[ -x "$SCRIPT" ] || chmod +x "$SCRIPT"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "SIM PASS: (a) human commit preserved, (b) fast-forward push, (c) no-op pushes nothing"; exit 0; }

BASE="$(mktemp -d /tmp/sim-sync.XXXXXX)"
trap 'rm -rf "$BASE"' EXIT
UPSTREAM="$BASE/upstream.git"; ORIGIN="$BASE/origin.git"

git() { command git -c user.email=sim@example.com -c user.name=Sim "$@"; }

# --- upstream repo -----------------------------------------------------------
git init -q --bare "$UPSTREAM"
git init -q "$BASE/upstream-src"
pushd "$BASE/upstream-src" >/dev/null
  git init -q
  echo '{"name":"upstream-sub","dependencies":{"croner":"^10.0.1"}}' > package.json
  mkdir -p src; echo 'export {}' > src/index.ts
  git add -A; git commit -qm "r0: upstream base"
  git branch -M master
  git remote add origin "$UPSTREAM"; git push -q origin master
popd >/dev/null

# --- origin (bare remote for our main repo) ----------------------------------
git init -q --bare "$ORIGIN"
git init -q "$BASE/main-src"
pushd "$BASE/main-src" >/dev/null
  echo '{"name":"pi-packages"}' > package.json
  git add -A; git commit -qm "r0: main base"
  git branch -M main
  git subtree add --prefix packages/pi-subagents "$UPSTREAM" master --squash -m "chore: fold in upstream"
  git remote add origin "$ORIGIN"; git push -q origin main
popd >/dev/null

# --- human leaves a dep-mirror commit un-merged on the bot branch -------------
git clone -q --branch main "$ORIGIN" "$BASE/human"
pushd "$BASE/human" >/dev/null
  git switch -q -c bot/update-pi-subagents
  git subtree pull -q --prefix packages/pi-subagents "$UPSTREAM" master --squash || true  # no-op sync
  sed -i '' 's/"pi-packages"/"pi-packages","fix_by_human":true/' package.json
  git add package.json; git commit -qm "fix: human dep-mirror on sync branch"
  PRE_TIP="$(git rev-parse HEAD)"
  git push -q origin bot/update-pi-subagents
  echo "PRE_TIP=$PRE_TIP" > "$BASE/pre_tip.env"
popd >/dev/null

# --- upstream advances --------------------------------------------------------
pushd "$BASE/upstream-src" >/dev/null
  echo 'export const two = 2;' > src/extra.ts
  git add -A; git commit -qm "r2: upstream feature"
  git push -q origin master
  UP2="$(git rev-parse --short master)"
  echo "$UP2" > "$BASE/up2.env"
popd >/dev/null

# --- nightly run 1: fresh clone of main, run the REAL script ------------------
git clone -q --branch main "$ORIGIN" "$BASE/work"
pushd "$BASE/work" >/dev/null
  set +e
  OUT="$(UPSTREAM_REPO="$UPSTREAM" UPSTREAM_REF=master BOT_BRANCH=bot/update-pi-subagents "$SCRIPT" 2>&1)"
  RC=$?
  set -e
  echo "$OUT"
  [ $RC -eq 0 ] || fail "script exited $RC"
  echo "$OUT" | grep -q '^changed=true' || fail "expected changed=true"
  echo "$OUT" | grep -q "^upstream_sha=$(cat "$BASE/up2.env")" || fail "expected upstream_sha=r2"
popd >/dev/null

# --- assertion (a)+(b): pushed branch still contains human commit AND fast-forward
git clone -q --branch bot/update-pi-subagents "$ORIGIN" "$BASE/check" || fail "branch missing after push"
git -C "$BASE/check" log --oneline | grep "fix: human dep-mirror" >/dev/null || fail "(a) human commit was lost by the sync"
PRE_TIP="$(grep -o 'PRE_TIP=.*' "$BASE/pre_tip.env" | cut -d= -f2)"
git -C "$BASE/check" merge-base --is-ancestor "$PRE_TIP" HEAD || fail "(b) push was not a fast-forward (previous remote tip lost)"

# --- nightly run 2: upstream unchanged -> no-op, nothing pushed ----------------
REMOTE_BEFORE="$(git ls-remote "$ORIGIN" refs/heads/bot/update-pi-subagents | awk '{print $1}')"
git clone -q --branch main "$ORIGIN" "$BASE/work2"
pushd "$BASE/work2" >/dev/null
  OUT2="$(UPSTREAM_REPO="$UPSTREAM" UPSTREAM_REF=master BOT_BRANCH=bot/update-pi-subagents "$SCRIPT" 2>&1)"
  echo "$OUT2"
  echo "$OUT2" | grep -q '^changed=false' || fail "(c) expected changed=false on no-op"
popd >/dev/null
REMOTE_AFTER="$(git ls-remote "$ORIGIN" refs/heads/bot/update-pi-subagents | awk '{print $1}')"
[ "$REMOTE_BEFORE" = "$REMOTE_AFTER" ] || fail "(c) no-op run pushed unexpectedly"

pass
