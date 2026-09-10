#!/usr/bin/env bash
# scripts/sim/simulate-sync.sh
# Faithful simulation of the merge-onto-branch sync against scratch repos built with real
# `git subtree add/pull`, verifying scripts/sync/sync-subtree.sh preserves:
#   (a) a human commit on bot/update-pi-subagents survives the next sync
#   (b) the sync push is a fast-forward (no --force anywhere)
#   (c) a no-op run (upstream unchanged) pushes nothing
# plus scenario S2 (a subtree-pull conflict with a committed human edit exits
# loudly with the Manual-resolution ERROR) and scenario S3 (a deleted/nonexistent
# bot branch is re-established on origin by a fresh no-op run).
# Exit 0 on PASS; non-zero with a "FAIL: ..." message otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # repo root
SCRIPT="$ROOT/scripts/sync/sync-subtree.sh"
[ -x "$SCRIPT" ] || chmod +x "$SCRIPT"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "SIM PASS: (a) human commit preserved, (b) fast-forward push, (c) no-op pushes nothing, S2 loud conflict, S3 fresh-branch establishment"; exit 0; }

# Deterministic git identity for ALL commits in this script (raw git in the
# scenario clones does not inherit the dev machine's global config; on CI it
# is unset).
export GIT_AUTHOR_NAME=Sim GIT_AUTHOR_EMAIL=sim@example.com
export GIT_COMMITTER_NAME=Sim GIT_COMMITTER_EMAIL=sim@example.com

# Portable in-place edit: macOS `sed -i ''` breaks on GNU sed (a `-i ''`
# consumes the script as a filename), so edit via a temp file instead.
sed_inplace() {
  local f="$1"; shift
  sed "$@" "$f" > "$f.sed.tmp" && mv "$f.sed.tmp" "$f"
}

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
  sed_inplace package.json 's/"pi-packages"/"pi-packages","fix_by_human":true/'
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

# --- scenario S2: loud subtree-pull conflict (RC != 0) ------------------------
# A committed human edit conflicting with upstream must fail the sync loudly
# (designed manual-resolution escape hatch), never be silently clobbered.
# Deterministic: both sides edit the SAME line of extra.ts.
git clone -q --branch bot/update-pi-subagents "$ORIGIN" "$BASE/s2-human"
pushd "$BASE/s2-human" >/dev/null
  sed_inplace packages/pi-subagents/src/extra.ts 's/export const two = 2;/export const two = 2; \/\/ S2 human fix/'
  git add packages/pi-subagents/src/extra.ts
  git commit -qm "fix: S2 human edit on extra.ts (sync branch)"
  git push -q origin bot/update-pi-subagents
popd >/dev/null

pushd "$BASE/upstream-src" >/dev/null
  sed_inplace src/extra.ts 's/export const two = 2;/export const two = 2; \/\/ S2 upstream change/'
  git add -A; git commit -qm "r3: upstream edits extra.ts (same line)"
  git push -q origin master
popd >/dev/null

git clone -q --branch main "$ORIGIN" "$BASE/s2-run"
pushd "$BASE/s2-run" >/dev/null
  set +e
  S2_OUT="$(UPSTREAM_REPO="$UPSTREAM" UPSTREAM_REF=master BOT_BRANCH=bot/update-pi-subagents "$SCRIPT" 2>&1)"
  S2_RC=$?
  set -e
  echo "$S2_OUT"
  [ $S2_RC -ne 0 ] || fail "S2: expected non-zero exit on subtree-pull conflict"
  echo "$S2_OUT" | grep -q "Manual resolution required" || fail "S2: expected loud ERROR message"
popd >/dev/null

# --- scenario S3: fresh-branch path must establish the branch on origin (C1) --
# First-run / deleted-branch condition: no bot branch exists and upstream == main's
# subtree (no drift). The sync must push the fresh branch even on a no-op, else
# the next run repeats the tolerated fetch failure forever.
git init -q --bare "$BASE/s3-upstream.git"
git init -q "$BASE/s3-upstream-src"
pushd "$BASE/s3-upstream-src" >/dev/null
  echo '{"name":"s3-sub","dependencies":{}}' > package.json
  mkdir -p src; echo 'export {}' > src/index.ts
  git add -A; git commit -qm "s3 r0: upstream base"; git branch -M master
  git remote add origin "$BASE/s3-upstream.git"; git push -q origin master
popd >/dev/null
git init -q --bare "$BASE/s3-origin.git"
git init -q "$BASE/s3-main"
pushd "$BASE/s3-main" >/dev/null
  echo '{"name":"s3-main"}' > package.json
  git add -A; git commit -qm "s3 r0: main base"; git branch -M main
  git subtree add -q --prefix packages/pi-subagents "$BASE/s3-upstream.git" master --squash -m "chore: fold in s3 upstream"
  git remote add origin "$BASE/s3-origin.git"; git push -q origin main
popd >/dev/null

# run 1: fresh branch, no drift -> must still push (changed=false)
git clone -q --branch main "$BASE/s3-origin.git" "$BASE/s3-run1"
pushd "$BASE/s3-run1" >/dev/null
  OUT3="$(UPSTREAM_REPO="$BASE/s3-upstream.git" UPSTREAM_REF=master BOT_BRANCH=bot/update-pi-subagents "$SCRIPT" 2>&1)"
  echo "$OUT3"
  echo "$OUT3" | grep -q '^changed=false' || fail "S3: expected changed=false on fresh no-op run"
popd >/dev/null
[ -n "$(git ls-remote "$BASE/s3-origin.git" refs/heads/bot/update-pi-subagents)" ] \
  || fail "S3: fresh-branch path did not push the branch (C1 regression)"

# run 2: branch now exists -> existing-branch path, still no drift
# run 3: delete the remote branch -> fresh path again, branch re-established
git clone -q --branch main "$BASE/s3-origin.git" "$BASE/s3-run2"
pushd "$BASE/s3-run2" >/dev/null
  OUT4="$(UPSTREAM_REPO="$BASE/s3-upstream.git" UPSTREAM_REF=master BOT_BRANCH=bot/update-pi-subagents "$SCRIPT" 2>&1)"
  echo "$OUT4"
  echo "$OUT4" | grep -q '^changed=false' || fail "S3: expected changed=false on second no-op run"
  echo "$OUT4" | grep -q 'Using existing' || fail "S3: second run should take the existing-branch path"
popd >/dev/null
git push "$BASE/s3-origin.git" :refs/heads/bot/update-pi-subagents
git clone -q --branch main "$BASE/s3-origin.git" "$BASE/s3-run3"
pushd "$BASE/s3-run3" >/dev/null
  OUT5="$(UPSTREAM_REPO="$BASE/s3-upstream.git" UPSTREAM_REF=master BOT_BRANCH=bot/update-pi-subagents "$SCRIPT" 2>&1)"
  echo "$OUT5"
  echo "$OUT5" | grep -q 'Creating fresh' || fail "S3: run 3 should hit the fresh-branch path"
  echo "$OUT5" | grep -q '^changed=false' || fail "S3: expected changed=false on run 3"
popd >/dev/null
[ -n "$(git ls-remote "$BASE/s3-origin.git" refs/heads/bot/update-pi-subagents)" ] \
  || fail "S3: deleted branch was not re-established on origin"

pass
