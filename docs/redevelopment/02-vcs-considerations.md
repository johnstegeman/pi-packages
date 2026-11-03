# 02 — VCS considerations: worktrunk vs jj (vs both)

Primary source: spike bead **`pi-packages-tutyu`** ("Spike: what a jj (Jujutsu)
migration would require in this monorepo"), plus the current checkout layout.
The statusline package (the only *functionally broken-under-jj* consumer) is out of
scope for the redevelopment, which shrinks the must-fix list considerably.

## 1. Status quo: bare repo + worktrunk

- `/Users/jstegeman/Projects/_ai/pi-packages` — **bare** repo
  (`core.bare=true`, `worktrunk.default-branch/history/history-path` config).
- `/Users/jstegeman/Projects/_ai/pi-packages/main` — linked worktree (`.git` is a
  **file**), branch `main`.
- `.worktrees/` in `.gitignore` encodes the convention. No git hooks anywhere
  (`bd init --skip-hooks`, no husky, no `core.hooksPath`).
- CI is untouched by VCS choice: `actions/checkout` + `gh` work off git refs/GitHub
  API. Lockfiles, `npm ci`, gates keep working under any colocated option.

## 2. Git-coupling inventory (kept packages only)

| Coupling | Where | Under colocated jj |
|---|---|---|
| Subagent worktree isolation: `worktree add --detach`, `status --porcelain`, `add -A`, `commit --no-verify`, `branch`, `worktree remove/prune` (~15 calls) | `pi-subagents/src/worktree.ts` | **Clean 1:1 port** via `jj workspace add --colocate` (jj ≥ 0.46). Hazard: calling `git worktree add` inside a colocated jj repo creates a worktree jj doesn't know about, and `jj workspace forget` deletes the matching git worktree — the two cleanup paths can fight. Must branch on repo kind, not half-migrate. |
| Umbrella root discovery: `git -C <cwd> rev-parse --show-toplevel` | `pi-beads/src/index.ts` (~line 281) | Works when colocated; silently falls back to cwd without a `.git`, which changes umbrella routing — needs an explicit failure mode in a no-fallback repo (**[decide] Q2b**). |
| Checkout-root discovery: `rev-parse --git-common-dir` (mirrors bd's own root-finding; advisory, never throws) | `pi-superpowers-plus/extensions/formula-seed.ts` | With git-worktree-backed jj workspaces resolves to the shared git dir ⇒ same root bd computes. Semantics preserved. |
| Molecule widget root discovery: `rev-parse --show-toplevel` | `pi-superpowers-plus/extensions/beads-molecule-widget.ts` (~line 41) | Benign; verify in a workspace checkout. |
| Skill prose: ~50 hardcoded git commands across ~20 skill files — `using-git-worktrees` (whole skill: `GIT_DIR != GIT_COMMON` detection, consent flow), `finishing-a-development-branch` (merge/rebase/PR menu, worktree cleanup), `subagent-driven-development` + `scripts/review-package` + `scripts/sdd-workspace` (`git rev-parse HEAD`, `git log`, `git diff -U10`), `verification-before-completion`, `requesting-code-review`, `systematic-debugging` refs, `pi-subagents/AGENTS.md`, root `AGENTS.md` | `pi-superpowers-plus/skills/` | Wording, mostly. Two genuine semantic breaks below. |
| `wave-parallel.js` tells N agents to commit to a **shared working copy**, retrying once on `index.lock` | `pi-superpowers-plus/skills/subagent-driven-development/scripts/` | **Semantic break.** jj snapshots the whole tree into one `@` per workspace; concurrent agents get captured together; the `index.lock` rationale vanishes. jj-correct model: one `jj workspace add` per agent, or no commits + review via `jj diff`. |
| `review-package` `base..head` commit ranges (consumed by final-review/fix-loop reviewers in 400-line slices) | same scripts | Works if colocated (jj keeps bookmarks in git refs) but needs an explicit smoke test, not an assumption. jj form: `jj diff --from A --to B -- <paths>`. |
| `.git`-file detection, worktree/branch rules in prose | `pi-subagents/AGENTS.md` | Rewrite for chosen VCS. |

(The statusline's `git-status.ts` — the one *functionally dead* consumer under jj,
since autosnapshot keeps `git status` clean — is out of scope.)

## 3. jj 0.46.0 facts that shape the decision

- **Workspace colocation via git worktrees** (`jj workspace add --colocate`,
  `git.colocate` default, `jj git colocation status|enable|disable` on child
  workspaces). Every workspace is a real git working tree, so plain-git code paths
  keep working in every workspace. `jj workspace forget` deletes the matching git
  worktree; `jj workspace remove` snapshots then deletes. Requires git ≥ 2.42.
- **pi-subagents worktree isolation maps 1:1**:
  `worktree add --detach <path> HEAD` → `jj workspace add --colocate <path> --revision @`;
  `status --porcelain` → `jj diff --summary` / `jj st`;
  `add -A && commit --no-verify -m` → `jj commit -m`;
  `branch <name>` → `jj bookmark create <name> -r @-`;
  `worktree remove --force` + `prune` → `jj workspace remove` (one command).
- Multi-remote push is config-only (`git.push` string-or-array, `revsets.git-push`) —
  low impact today but removes a reason to shell out to git.
- Bonus: jj hunk headers carry enclosing function/symbol — directly helps the
  400-line review slices.
- Local env already satisfies the floor (jj 0.46.0 installed; `git.colocate` true;
  git 2.56/2.54 ≥ 2.42). Note user config `git.write-change-id-header = true`:
  automation using explicit `jj commit -m` is unaffected, but anything parsing
  commit *descriptions* sees `JJ: …` trailers.
- Beads is VCS-agnostic (embedded Dolt, `.beads/` git-ignored, no JSONL→git export).
  `bd doctor` is the cheap post-conversion check. bd's repo-root detection in a
  jj workspace — an open question when the spike was written — was **answered by
  the live probe: unchanged** (section 6, probe 11).

## 4. Options for the new repo (**[decide] Q1**)

1. **worktrun-only (status quo)** — zero porting cost; everything keeps working as
   vendored. jj questions stay open.
2. **jj colocated, single working copy** — drop bare+worktrunk; all git-based code
   keeps running; accept: no jj-native subagent worktree isolation until
   `worktree.ts` branches on repo kind, and no two agents committing in one
   workspace (affects `wave-parallel.js` model).
3. **jj colocated + `jj workspace add --colocate` multi-workspace** — the "both"
   option: worktrunk-style multi-checkout *and* jj-native; subagent isolation gets
   the clean 1:1 port. The spike's open questions (what `git rev-parse
   --git-common-dir` / `git status --branch` report inside a colocated
   workspace checkout) were answered by the live probe (section 6).
4. **worktrunk for humans + git for machines** (keep `worktree.ts` git-only and
   document it) — the minimal-change option the spike lists as an open question.
5. **worktrunk + jj colocated inside it (the proposed hybrid) — VERIFIED WORKABLE
   (live probe, 2026-11-02; findings in section 6).** Refined division of labor,
   confirmed end to end: **jj owns branch creation** (`jj bookmark create/set` —
   the git branch appears immediately), **wt owns worktree creation** (`wt switch
   <branch>` attaches a worktree to the existing branch with HEAD attached and
   runs the post-start hooks), **jj works inside** (colocate + commit; overlapping
   independent jj repos per worktree coexist safely on one bare repo), and a
   **re-attach step restores wt's branch view**: after `jj bookmark set <branch> -r
   @-`, `git checkout <branch>` re-attaches HEAD and jj absorbs it cleanly (`@`
   becomes an empty commit on the branch tip) — wt then sees a normal branch
   worktree. Wrap `bookmark set` + `git checkout` in a wt alias or post-commit
   convenience and wt's branch-centric views/merges/removals never degrade.
   Residual costs: between re-attach points HEAD is detached (wt shows the worktree
   by hash; branch-based `wt remove` needs the path form — path-form removal cleans
   up fully, verified); wt's post-start hooks announced-but-not-executed during
   `wt switch` in this probe (executed fine via `wt hook post-start -y` / after
   approval seeding — automation should pre-approve via `wt config approvals`);
   git post-commit hooks do not fire for jj-made commits (irrelevant to wt's
   creation-time hooks). bd is entirely unaffected (see section 6).

Spike's minimum viable path if jj proceeds: (1) one colocated working copy,
(2) accept the three known regressions, (3) then in value order: subagent
`jj workspace add --colocate` isolation → review-package range smoke test →
wave-parallel per-workspace model → formula-seed root resolution → skill prose.

## 5. Redevelopment-specific implications

- A **new** repo can be jj-native from day one: no migration, no dual-mode in
  `worktree.ts` — write it against the chosen VCS only (consistent with the
  no-fallback posture: `jj root` fails loudly when `.jj` is absent, rather than
  silent cwd fallback).
- Skill prose should be written for the chosen VCS once (Q9 — which now leans
  toward shipping a dedicated jj SKILL.md in pi-rex carrying the measured
  footguns, plus jj-aware SDD scripts), not ported twice.
- If worktrun-only is chosen, the current `worktree.ts` + skill prose carry over
  nearly verbatim (cheapest path).
- `gh` is unaffected under any colocated option; only `gh pr checkout`/branch
  detection need refs current.

## 6. Findings — worktrunk + jj colocated (live probe, 2026-11-02)

Environment: jj 0.46.0, git 2.56.0, bd 1.3.2, wt v0.81.0. Throwaway fixtures:
/tmp/wtjj-probe (bare + wt-created linked worktrees, pmm-iris-style `[post-start]`
hooks: copy-ignored + `.beads/redirect` + dev marker) and /tmp/bd-layout-test
(wrapper layout). Both fixtures were left in place for re-inspection.

| # | Probe | Result |
|---|---|---|
| 1 | `jj git init --colocate` inside a wt-created linked worktree (`.git` is a file) | **works**, with warning "Initialized a new colocated jj repo inside a Git worktree" + hint to prefer `jj workspace add`. Each worktree becomes an *independent* jj repo (own op-log); two colocated worktrees + a colocated main coexisted with no ref conflicts |
| 2 | `git rev-parse --show-toplevel` | the worktree root — unchanged. pi-beads umbrella discovery and the molecule-widget root keep working |
| 3 | `git rev-parse --git-common-dir` / `--git-dir` | bare repo / per-worktree gitdir — unchanged. formula-seed's dirname rule preserves its semantics |
| 4 | untracked vs gitignored files under jj | **gitignored files are invisible to jj** (the copy-ignored payload survives untouched); untracked-but-not-ignored files are absorbed into `@` as adds at colocation/snapshot time |
| 5 | `git status --porcelain=v1 --branch` with pending jj changes | shows snapshot-vs-HEAD differences as *staged* changes; clean once committed; the branch line is intact until the first jj commit (see #6) |
| 6 | jj commit -> git HEAD | commit reaches git; **HEAD detaches** (standard colocated behavior: HEAD tracks the working-copy state, bookmarks are refs). `jj bookmark set` moves the git branch but does not re-attach; **`git checkout <branch>` re-attaches and jj absorbs it cleanly** (verified: `@` becomes an empty commit on the branch tip, wt sees a normal branch worktree again) |
| 7 | bookmarks <-> git branches | sync both ways (`jj bookmark create` -> git branch appears; `jj bookmark set` -> git branch moves) |
| 8 | git post-commit hook vs jj commit | hook fires for plain `git commit` (control), **does not fire for `jj commit`** — irrelevant to wt's creation-time hooks but fatal to any git-hook dependency |
| 9 | wt list / wt remove on a colocated worktree | `wt list` copes but shows detached worktrees (hash in the Branch column). Branch-based `wt remove <branch>` refuses ("a detached worktree is @ ..."); **path-based `wt remove <path>` removes fully** (worktree dir incl. `.jj`, per-worktree gitdir) |
| 10 | `git worktree add --detach <tmp> HEAD` inside a colocated worktree | works — today's pi-subagents isolation path functions unchanged (creates a worktree the worktree-local jj repo does not register; harmless for throwaway copies) |
| 11 | `bd where` / `bd info` before vs after colocation | **identical** — bd is unaffected by jj. Placement rule (observed): wrapper layout (`<w>/.git` bare inside `<w>`) -> `.beads` at `<w>/.beads`; `<name>.git`-named bare dir -> `.beads` inside it. bd's own detection finds the wrapper-root DB from **any worktree with no redirect needed**; the pmm-iris `.beads/redirect` agrees with detection in the wrapper layout. `bd bootstrap` is the existing-workspace setup/recovery path (errors without one) — use `bd init` for fresh projects |
| 12 | concurrent `bd` from two worktrees | no lock errors (quick read test only — the embedded-Dolt exclusive-lock serialization and the widget contention gate remain necessary) |
| 13 | variant B: `jj workspace add --colocate <path>` from a colocated worktree | works — creates a real git worktree registered as a jj workspace of the parent repo (`jj workspace list` shows both). This is the subagent-isolation 1:1 mapping |
| 14 | the refined flow: jj creates the branch, wt creates the worktree | `jj bookmark create feature-z` (git branch appears) -> `wt switch feature-z` -> **worktree with HEAD attached** + post-start hooks announced |

**Recommended workflow for the new repo (option 5):** wrapper layout (`repo/.git`
bare + worktrees + `.beads` as siblings inside `repo/` — matches production and
makes bd detection, the `{{ repo_path }}/../.beads` redirect template, and jj all
agree); **one jj repo per directory** (backed by the wrapper's bare `.git` —
   the documented bare-repo pattern; `main` is its colocated workspace, the
   junk-collecting default workspace is forgotten); feature worktrees via
   `jj workspace add --colocate` + manual `wt hook post-start` +
   `jj bookmark create`/`set` + `git checkout` re-attach; work inside via jj;
   subagent isolation via
given worktrees via `wt switch <branch>`; work inside via jj; a `bookmark set` +
`git checkout <branch>` re-attach step (wrap in a wt alias) keeps wt's
branch-centric operations fully functional; subagent isolation via
`jj workspace add --colocate` (probe 13).

**Remaining caveats / not yet tested:** wt post-start hooks need one-time
approval seeding before they execute during `wt switch` non-interactively
(seed once via `wt hook post-start -y` or `wt config approvals add` — after
seeding they ran automatically; see section 7); pi-beads was
verified against bd 1.2.2 while this machine runs 1.3.2 (probes worked; re-pin
the tool's parsing tests against the version the new repo standardizes on); the
jj op-log/ref interactions of N independent colocated repos were exercised
lightly (create/commit/bookmark only).

## 7. From-scratch repo bootstrap — a `ginit` function (gclone analog)

The pmm-iris layout was produced by the fish function **`gclone <remote> <dir>`**
(~/.config/fish/functions/gclone.fish): `take <dir>`; `git clone --bare <remote>
.git` (bare clone *into* `.git` — this is what creates the wrapper layout);
configure origin fetch + set-head; `git worktree add -b chore/setup setup`; `cd
setup && bd bootstrap --yes` (existing-workspace setup — the clone carries beads
context); `chmod 700 .beads`; remove the setup worktree and branch; `wt switch
main`; `git branch --set-upstream-to=origin/main main`; `rex window rename main`.

A new repo created **from scratch** needs a sibling function (call it `ginit
<dir>`). Verified end to end in throwaway fixtures (/tmp/ginit-test*, since
removed); deltas from gclone are marked:

```fish
function ginit
  take $argv[1]
  git init --bare -b main .git          # DELTA: no remote; -b main (default is master)
  # DELTA: zero-commit bare repo needs an ORPHAN worktree (git >= 2.42):
  git worktree add --orphan -b chore/setup setup
  cd setup
  # DELTA: seed commit — commit the wt config BEFORE `wt switch main` so every
  # worktree (main included) gets the post-start hooks:
  #   .gitignore (.env, .worktrees/), .worktreeinclude (.env*),
  #   .config/wt.toml ([post-start] copy-ignored + .beads/redirect hooks)
  #   ... plus whatever else belongs in the initial commit ...
  git add -A && git commit -m "seed: gitignore, worktreeinclude, wt hooks"
  cd ..
  git worktree remove setup
  git branch main chore/setup           # DELTA: main doesn't exist yet (no origin)
  git branch -d chore/setup             # merged into main now; gclone's plain -d
                                       # only works because ITS setup worktree
                                       # makes no commits
  wt -y switch main                     # creates the main worktree + runs hooks
  # DELTA: bd init (not bootstrap — nothing to recover), FROM THE WRAPPER ROOT
  # so the id prefix is the repo name (verified: run from a worktree instead and
  # the prefix is the worktree name):
  bd init --skip-hooks --skip-agents
  chmod 700 .beads
  cd main
  jj git init --colocate                # NEW (option 5): main is the jj home
  # optional, as gclone does:
  # rex window rename main
end
```

Notes for the spec:

- **Approval seeding**: wt post-start hooks need one-time approval; in
  non-interactive first use they may be announced-but-skipped. Seeding once via
  `wt hook post-start -y` (or pre-approving with `wt config approvals add`)
  makes them run automatically on every subsequent `wt switch` — after seeding,
  the hooks executed during `wt switch main` in the fixture. This corrects the
  stronger wording of the section-6 caveat.
- The redirect hook (`{{ repo_path }}/../.beads`) is correct **only** in the
  wrapper layout — which `git init --bare .git` (and gclone's `clone --bare
  … .git`) produces. Keep the layout convention in the new repo.
- bd init from the wrapper root also means `bd where` from any worktree resolves
  via detection *or* redirect — both agree (probe 11).
- A ginit-created repo has no origin; add the remote + upstream wiring later
  (gclone's `set-upstream-to` step) when a remote exists.

Feature item for the new repo: ship `ginit` (and possibly a gclone refresh that
colocates main) as part of the setup docs/skills, so the wrapper layout, hooks,
beads placement, and jj colocation are reproducible rather than tribal knowledge.

**Implemented and tested (2026-11-02):** the function lives at `~/ginit.fish`
(`ginit <dir> <gh-remote-uri>`, remote assumed plain and empty; source it or
symlink into `~/.config/fish/functions/` for autoloading). Deltas from the
sketch above, all verified end to end against a stand-in remote:

- bare repo via `git init --bare -b main .git` + `git remote add origin`
  (deterministic HEAD; no clone of an empty repo).
- `bd dolt remote add origin <uri> --allow-git-origin` — the refusal without
  the flag is bd's own guard, and its hint names this exact monorepo layout;
  the ssh short form is normalized to `git+ssh://git@host/path.git` (pmm-iris
  form; local paths normalize to `git+file://`).
- `bd dolt push` after init lands `refs/dolt/data` +
  `refs/heads/__dolt_remote_info__` on the gh repo — pmm-iris's exact remote
  shape; verified round-trip (bd create → bd dolt push → remote ref advanced).
- `bd init` auto-derives `.beads/config.yaml` `sync.remote` from git origin —
  no manual YAML writing needed.
- `jj bookmark track main@origin` after colocation (jj's own post-init hint),
  non-fatal.
- `git remote set-head origin --auto` after the initial push (resolves on gh;
  fails harmlessly on remotes that don't advertise HEAD).
- Prefix confirmed = repo directory name (`test-repo-*` ids), redirect hook
  runs (wt post-start), HEAD attached on main, `.jj` colocated in main.

**Incident + hardening (2026-11-03):** the first real run was executed from
inside an existing beads workspace (pi-rex nested under the pi-packages
wrapper), and `bd init` **adopted the parent workspace** — it created a new
empty per-prefix dolt database (`pi_rex`) inside the parent's
`.beads/embeddeddolt/`, flipped the parent's `metadata.json` to it, and
overwrote `sync.remote`. Two facts made recovery trivial: dolt databases are
**per-prefix directories** under `.beads/embeddeddolt/` (the original `beads`
db was untouched — `bd dolt set database beads` restores it), and dolt
**remotes are per-database** (the bad run's remote add/remove never touched
the original db's remotes). The `bd dolt push` in the bad run pushed only
the empty new db — no issue data leaked. ginit now guards against the class:
an ancestor walk refuses to run inside any *real* beads workspace (one with
`embeddeddolt/` or `metadata.json` — `~/.beads` holds only bd global state
and is correctly ignored; verified by probe that a correctly-placed run
under `$HOME` still creates a fresh db at the wrapper), and a post-init
placement check aborts before any remote/push step if the db did not land
at the wrapper root. The function now lives at
`~/.config/fish/functions/ginit.fish` (autoloaded). Also verified: https
remote URIs work (bd normalizes to `git+https://`).

**jj construction revised (2026-11-03, ginit v3):** the per-worktree
`jj git init --colocate` step is REPLACED by the directory-level repo the
user actually wanted (and the jj docs sanction: "Bare repositories: Yes. You
can use `jj git init --git-repo=<path>` to create a repo backed by a bare
Git repo"):

1. `jj git init --git-repo .git .` at the wrapper — ONE jj repo per
   directory, store at `<dir>/.jj/repo`, backed by the wrapper's bare `.git`.
2. `jj workspace add --colocate main` — main becomes a git worktree +
   **colocated jj workspace of the directory repo** (the nested-workspace
   warning at this step is expected and benign — see 3).
3. `jj workspace forget default` — MUST run AFTER the add (forgetting
   before does not stick: with no current workspace, `jj workspace add`
   recreates a default). The default workspace's working copy is the
   wrapper dir itself and would snapshot every sibling worktree as junk;
   forgetting it also makes later `jj workspace add` calls warning-free.
4. `git -C main checkout main` — attach HEAD (wt-friendly branch view).
5. `wt -C main -y hook post-start` — jj (not wt) created the worktree, so
   wt's hooks must run manually (idempotent).

Verified end-to-end (fixture + full ginit run): workspace list shows only
`main`; `jj` from the wrapper root answers "No working copy." (clean, honest);
future `jj workspace add --colocate <dir>/<name>` joins the SAME repo (one
op-log, `jj workspace list` visibility, shared git store). **Workflow
consequence:** feature worktrees are created by jj, not wt — the flow is
`jj workspace add --colocate` → `wt hook post-start` → `jj bookmark
create/set` → `git checkout` — wt's role becomes listing/removing worktrees
and running hooks on demand (path-based), since worktrees wt creates itself
would have no jj workspace.

**Redirect dropped (2026-11-03, ginit v4):** the seeded wt `[post-start]` config
no longer creates a worktree `.beads/redirect` — in the wrapper layout bd's
upward detection finds the wrapper-root `.beads` from any worktree with no
redirect at all (the pi-packages production model, verified in fixtures and
by this session's own bd usage). The redirect was belt-and-suspenders for a
case that doesn't occur, and under the jj-workspace construction an untracked
unignored file is worse than noise — **jj snapshots it into `@`**. ginit now
seeds `.beads/` into `.gitignore` as pure insurance (ignored-but-absent =
zero noise; protects against anyone running `bd init` inside a checkout
later) and the only post-start hook is `copy-ignored`. pmm-iris (which used
redirect + ignore-the-whole-.beads) is being updated by the user to match:
drop the `beads` hook from `.config/wt.toml`, delete worktree `.beads/`
dirs, keep the `.gitignore` `.beads/` line.

**Default workspace hardened + automation closed (2026-11-03, ginit v6/v8):**

- **`jj workspace forget default` was WRONG** — a forgotten default gets
  resurrected by any stray jj command run from a non-workspace dir (e.g. a
  plain git worktree, or an agent cd-ing around), and the resurrection
  junk-snapshots the wrapper (including `.beads` internals) into `@`. Fix:
  never forget it — make it inert: `jj sparse set --clear` (snapshots see
  nothing) + `jj new "root()" -m …` (re-parent its `@` onto the root so
  strays show "no changes" instead of deletion noise). Ordering is critical:
  the clear runs AFTER `workspace add main` (new workspaces inherit the
  current workspace's sparse patterns — main must inherit the full set), and
  `root()` must be quoted in fish (fish treats `(…)` as command substitution
  — an unquoted `root()` silently runs as `jj new -m …` with no revision;
  diagnosed via `jj op log`). Stray-jj attacks from non-workspace dirs are
  now fully contained (verified).
- **wt hooks CANNOT create jj workspaces** — two hard blockers, both tested:
  `jj workspace add --colocate` refuses an existing worktree ("Destination
  path exists and is not an empty directory"), so a post-start hook can't
  adopt a wt-created worktree; and wt refuses to switch to a pre-existing
  detached worktree ("there's a detached worktree at the expected path"), so
  a pre-start hook that jj-creates first blocks wt.
- **wt hooks CAN remove them** — ginit seeds `[pre-remove]` `jj = "jj
  workspace forget {{ branch }} 2>/dev/null || true"` (template vars verified;
  the guard keeps non-jj worktrees removable). `wt remove <name>` now cleans
  up both sides.
- **Creation automation is the `gws` fish function**
  (`~/.config/fish/functions/gws.fish`): finds the wrapper, runs `jj workspace
  add --colocate` FROM MAIN (full sparse inheritance; the sparse-cleared
  default must never be the context), `git checkout -b <name>` (branch +
  attach), `wt hook post-start` (hooks). Full lifecycle tested: `gws feature5`
  → work → `wt remove feature5` → workspace forgotten + worktree gone.