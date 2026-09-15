# Design: Multi-worktree molecule disambiguation in the Superpowers widget

**Date:** 2026-09-15
**Status:** Approved (brainstorming, molecule `pi-packages-mol-r6vu`, discovered-from `pi-packages-3iej.10`)
**Owner:** pi-beads + pi-superpowers-plus
**Related:** [`2026-09-03-step-labels-at-pour-design.md`](./2026-09-03-step-labels-at-pour-design.md), [`2026-09-14-superpowers-extension-lifecycle-widget-robustness-design.md`](./2026-09-14-superpowers-extension-lifecycle-widget-robustness-design.md)

## Context

Two concurrent Superpowers cycles running in separate git worktrees of one repo
do not each show their own molecule; they can show the wrong one.

Findings that motivate this design:

- Worktrees share one beads DB: a worktree's `.beads/` has no `embeddeddolt`;
  the DB lives in the main checkout (`.beads/embeddeddolt/<db>`). All worktrees
  read/write the same store.
- `bd mol current --json` with no id infers "from `in_progress` issues assigned
  to the current agent". The agent is `git user.name`, identical in every
  worktree, so with two active cycles the JSON array can contain multiple
  molecules.
- `parseMoleculeCurrent` (`packages/pi-superpowers-plus/extensions/beads-molecule-widget.mjs`)
  does `Array.isArray(arr) ? arr[0] : arr` — it takes only the first and locks
  onto it, so both sessions render the same first molecule. It never shows both.
- Refresh triggers are in-process only: `pi.events.on("beads:changed")` fires
  from the pi-beads extension inside the same pi process, so worktree A's writes
  never trigger worktree B to re-read. B's widget goes stale until its own
  `agent_start`/`session_start`.

The prior lifecycle-widget-robustness spec explicitly deferred this as
`pi-packages-3iej.10`; this design resolves it.

## Goals & constraints

- Each session's widget resolves the molecule belonging to **its own
  worktree**.
- With two active cycles in two worktrees of one repo, each session shows its
  own molecule and **never silently displays another worktree's molecule**.
- The discriminator is derived from the workspace, not from process-local
  identity. No change to audit identity (no per-session actor/assignee).
- No `bd` CLI changes; no change to the pi-beads tool count or user-facing tool
  schemas; no change to `beads_mol_current`/`beads_mol_ready` output.
- The mechanism follows the existing "the safety of a label" principle —
  invisible plumbing when healthy, and **fail-safe** (never guess) when it
  cannot be guaranteed.

## Non-Goals

- **Cross-process freshness.** Worktree B still learns about A's writes only on
  its next `agent_start` (or its own in-process event). The residual per-turn
  latency is documented, not fixed. A poll / mtime watch / shared daemon is out
  of scope.
- **Two concurrent sessions in the *same* worktree.** They compute the same
  workspace key and legitimately share the molecule. Documented limitation.
- Per-session actor/assignee scoping (changes audit identity semantics).
- Any change to the widget's rendering, phase views, or the coalescer.

## Architecture

Two independent packages must agree on one workspace key: the write side is
`pi-beads` (`beads_mol_pour`), the read side is `pi-superpowers-plus` (widget).

```
WRITE  packages/pi-beads/src/index.ts
         └─ workspaceKey(activeCwd) ──► bd update <root> --add-label ws:<key>
              (inside beads_mol_pour; source is the session worktree)

READ   pi  ──► beads-molecule-widget.ts (adapter)
                    │  resolveWorkspaceKey(cwd) via injected exec
                    │  (git rev-parse --show-toplevel + realpath);
                    │  event wiring unchanged; passes cwd + workspaceKey
                    ▼
              beads-molecule-widget-controller.mjs
                    │  bd list --type molecule --label ws:<key> --json
                    │  then bd mol current <root> --json (existing machinery)
                    ▼
              beads-molecule-widget.mjs (pure)
                    · workspaceKey() / label builder
                    · pickWorkspaceMolecule()  ← selection + fallback policy
                    · existing parse / render / frame functions (mostly unchanged)
```

The key is computed independently on both sides from the same spec and guarded
by a shared golden fixture (see Testing).

## Workspace key

```
workspaceKey(cwd):
  toplevel  = git -C <cwd> rev-parse --show-toplevel    // on failure/empty: realpath(cwd)
  canonical = realpath(toplevel).replace(/\/+$/, "")
  key       = sha256(canonical).hex.slice(0, 12)
```

- `realpath` resolves symlinks so two spellings of one worktree hash alike;
  stripping trailing slashes makes `/repo` and `/repo/` identical.
- Distinct worktrees of one repo have distinct toplevels → distinct keys.
- Outside a git repo the canonicalized `cwd` still yields a stable key, so a
  non-worktree session still stamps and resolves.
- The spec is duplicated in `pi-beads` and `pi-superpowers-plus`; a shared
  vectors file asserted in both test suites is the contract that keeps them
  identical. (Chosen over a shell-out to `git hash-object`, which would add a
  subprocess to every refresh.)

## Write path — stamping at pour

In `beads_mol_pour.execute` (`packages/pi-beads/src/index.ts`), after the
existing `step:<key>` labeling pass:

```ts
const key = workspaceKey(activeCwd);            // session worktree, NOT repoDir
const u = await bd(["update", root, "--add-label", `ws:${key}`], repoDir);
```

- **Root only.** Steps/gates stay `step:<key>`-only.
- **Source is `activeCwd`**, not the `repo` target: the molecule belongs to the
  workspace that poured it.
- The label value carries no user input and needs no escaping.

**Failure handling.** A failed `ws:` label write does **not** roll back the
pour or block the molecule — the label is display plumbing and its absence
fails safe. It must not be silent: append a diagnostic line to the tool result,
e.g.

```
<normal pour output>
ws label: FAILED (ws:8f3a2c1d) — widget will fall back to single-molecule inference
```

This mirrors the existing "fails loudly" convention without turning a cosmetic
failure into "do not use".

## Read path, selection, and fallback

The adapter resolves the workspace key from `cwd` (via injected `exec`: `git
rev-parse --show-toplevel` + realpath) and injects it into the controller, which
does NOT shell out to git itself. Refresh flow, replacing the current
`nextRefreshArgs` → one bd call:

```
refresh():
  gen = ++refreshGen
  1. key = injected workspaceKey             // resolved + memoized by the adapter
       └─ if key changed since last refresh → drop activeMolecule + lock
  2. if lockedMoleculeId usable:
       → bd mol current <locked> --json       // existing by-id path; unchanged
     else:
       a. roots = bd list --type molecule --label ws:<key> --json
          · roots.length == 1 → frame = bd mol current <root> --json
          · roots.length >  1 → for each root: frame = bd mol current <root> --json,
                                 zip with that root's updated_at from (a),
                                 select via pickWorkspaceMolecule(items)
          · roots.length == 0 → global = bd mol current --json
                                 · global.length == 1 → adopt it
                                 · otherwise          → clear (ambiguous / none)
       b. adopt the selected frame; lock its id (existing applyMoleculeFrame rules)
  3. apply frame + render (generation guard + applyErrorFrame as today)
```

**Pure selector** (`beads-molecule-widget.mjs`):

```js
pickWorkspaceMolecule(items) // items = [{ frame, updatedAt }]; NOT required to be pre-sorted
  score(f) = f.current_step && !finished ? 2   // active
           : !finished                 ? 1     // open, not yet started
           : 0                                  // finished
  finished = f.doneCount === f.total && !f.current_step
  pick = max(score); ties broken by newest updatedAt, then smallest molecule_id
```

This encodes the fallback policy: a single workspace match always wins; with
several, the active cycle leads and a finished one never shadows it; a
finished-only workspace still shows its most recent finished frame (preserving
today's "finished banner" behavior).

**Lock and cwd semantics.**

- Successful selection locks the root id (existing behavior); subsequent
  refreshes take the by-id path and skip the workspace query until the molecule
  finishes, at which point the lock drops and re-resolution runs — this is how
  a newly poured molecule in the same worktree is picked up.
- `setCwd` to a **different** workspace key clears `activeMolecule` + lock so
  the previous worktree's molecule cannot leak into the new one.

## Error handling

- `bd list` non-zero + `isCleanNotFound` (e.g. `no beads database found`) →
  clear frame + lock.
- `bd list` non-zero otherwise (transient / `bd: command not found`) → keep the
  previous frame + lock, `console.warn` — same fail-safe rule as
  `applyErrorFrame`.
- The generation guard stays: a superseded multi-step refresh can never apply.

## Testing

### Shared golden fixture

A single vectors file at repo root, `scripts/fixtures/workspace-key-vectors.json`:

```json
[
  { "path": "/Users/me/repo",          "key": "35696fd2bb77" },
  { "path": "/Users/me/repo/",         "key": "35696fd2bb77" },
  { "path": "/private/tmp",            "key": "11fe14a563f7" },
  { "path": "/repo/worktrees/feature", "key": "6b8e99cc467b" },
  { "path": "/repo/worktrees/other",   "key": "2404d77127d9" }
]
```

Both suites load it by relative path (`../../../scripts/fixtures/…` from either
package's `test/`) and assert their `workspaceKey` reproduces every `key`. If
either side's normalization drifts, both go red.

### `pi-superpowers-plus` (`packages/pi-superpowers-plus/test/`)

In `beads-molecule-widget.test.mjs` / `beads-molecule-widget-controller.test.mjs`:

- `workspaceKey` golden-fixture pass (trailing slash + symlink cases).
- `pickWorkspaceMolecule`: single match wins; multiple matches → active beats
  started beats finished; tie-break newest `updated_at`; finished-only workspace
  shows newest finished.
- Controller with fake `exec`:
  - 1 root → by-id `bd mol current`.
  - N roots → selector outcome adopted.
  - 0 roots + 1 global candidate → adopt it.
  - 0 roots + ≥2 global candidates → clear (never guesses another worktree).
  - 0 roots + any `ws:`-stamped open molecule elsewhere → clear (never adopts
    an unscoped global candidate owned by another worktree; the FIX A guard).
  - lock held → workspace query skipped.
  - cwd key change → frame + lock reset.
  - `bd list` transient error → frame kept; clean not-found/no-DB → cleared.
  - superseded multi-step refresh → result discarded (generation guard).
- `package.json` test script updated for any new files.

### `pi-beads` (`packages/pi-beads/test/`)

- `workspaceKey` golden-fixture pass (same vectors).
- `beads_mol_pour` emits `bd update <root> --add-label ws:<key>` with `key`
  derived from the session `activeCwd`, and **not** from `repo`.
- `ws:` label write failure → pour still returns success plus the
  `ws label: FAILED …` diagnostic; step-label hard-fail path unchanged.
- Existing tool-surface doc-drift guard still passes (no tool added/removed).

### Manual two-worktree smoke

Cross-process behavior is not automatable in the suites; verify by hand:

1. In one repo, add two worktrees: `git worktree add ../wt-a && git worktree add
   ../wt-b`. Both share the main checkout's beads DB.
2. Open a pi session in each worktree and pour a superpowers molecule in each.
3. Confirm each session's widget shows **its own** molecule (the reference to
   the molecule poured in that worktree).
4. Open an idle third worktree (one with no molecule poured) and confirm its
   widget shows **nothing** — it must not render another worktree's molecule.
   This is the zero-roots fallback guard (FIX A).

## Acceptance Criteria

- Two active Superpowers cycles in two worktrees of one repo: each session's
  widget displays its own molecule and never silently displays another
  worktree's.
- `cd packages/pi-superpowers-plus && npm test` green.
- `cd packages/pi-beads && npm test` green.
- `biome check .` passes.
- No change to `bd` CLI usage, pi-beads tool count, or user-facing tool schemas.
- Manual two-worktree smoke documented (cross-process, not automatable).

## Migration / rollout

Molecules poured before this feature have no `ws:` label. The fallback keeps a
single-molecule repo (and the common solo case) working unchanged; on a repo
with several unstamped molecules the widget clears rather than guessing.
Re-pouring, or any post-feature pour, stamps the root.

## Known Limitations

- **Freshness is per-turn.** A worktree sees another worktree's write only on
  its next `agent_start` (or its own in-process event). No cross-process
  signal.
- **Same-worktree sessions share a molecule** by definition of workspace.
- **Residual risk:** if `activeCwd` and the widget's `cwd` ever disagree within
  one session, the widget will not find its own stamp and falls back to the
  single-candidate rule — fail-safe, not wrong-worktree.
