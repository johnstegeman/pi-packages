# A pour guard, and a widget that follows the live molecule — design

**Date:** 2026-10-19
**Molecule:** `pi-packages-mol-k84k7` (`superpowers-workflow`, topic "Molecule widget: the id lock pins the display to a stale molecule from an earlier session")
**Bead:** `pi-packages-rsb9s`
**Scope:** `packages/pi-beads` (`beads_mol_pour`) and `packages/pi-superpowers-plus` (widget, brainstorming skill, tests, `CHANGELOG.md`).

## Problem

The molecule widget picks a workspace molecule once and then queries it **by id** forever. It
releases that lock only when the locked molecule is *finished* or *gone*, so a molecule left behind
by an abandoned session pins the display to a dead molecule while the live one runs underneath.

**The evidence.** `~/.pi/agent/sessions/--Users-jstegeman-orca-workspaces-pmm-iris-u0ssf--/`:

| session | started | poured | outcome |
|---|---|---|---|
| `…11-12-21…jsonl` | 11:12:21Z | `pmm-iris-mol-anhe` at 11:13:02Z | stopped 12 lines in — never claimed a step |
| `…11-13-43…jsonl` | 11:13:43Z | `pmm-iris-mol-xseu` | worked correctly (7/15, close reasons recorded) |

Two *different* sessions, not one: the leftover came from an abandoned run, and the widget showed
`anhe` for the whole of the live one. Deleting `anhe` cleared the lock.

**Two defects, one symptom.**

1. **The pour has no guard.** `packages/pi-beads/src/index.ts:1927-1963` builds `bd mol pour` and
   fires it. Nothing asks whether this workspace already has a molecule, so a second one is created
   silently. The handler already knows the workspace key — it stamps `ws:<key>` on the root two
   lines after pouring (`:1956-1957`).
2. **The widget never reconsiders.** `lockedMoleculeId` is set from the first frame that parses
   (`beads-molecule-widget-controller.mjs:70`); every later refresh short-circuits through
   `hasLockedMolecule` → `nextRefreshArgs(lockedMoleculeId)` (`:244-249`), so
   `pickWorkspaceMolecule` — the only scoring of candidates — is consulted **only while unlocked**.

Fixing only the widget leaves two molecules behind for the user to clean up; fixing only the pour
leaves the molecules already in the wild invisible. Both are in scope.

## Goal

- A session never silently ends up tracking one molecule while the widget shows another.
- A second molecule for one workspace is a loud, user-decided event, not a silent one.
- The widget displays the molecule that is actually being worked.

## Non-goals

- **No bead parameter on the pour.** Brainstorming can start with no bead at all, so the tool cannot
  know which bead a molecule is for. The check stays workspace-wide and the user decides.
- **No session identity.** Nothing records which session poured what (no session label, no
  per-session state); the guard is stateless.
- **The guard never deletes anything.** Clearing a leftover is the user's call, carried out by the session only after they ask (D3); no new tool is added for it.
- Reworking `pickWorkspaceMolecule`'s scoring, the multi-worktree guard, or the contention gate.

## Anti-goals

- A guard that also blocks a fresh pour after the previous molecule **finished**.
- A widget that flickers or jumps between two molecules that are both genuinely live.
- A skill that still promises the pour cannot fail.

## Decisions

### D1 — The pour refuses when the workspace already has an unfinished molecule

In `beads_mol_pour`, compute the workspace key *before* pouring (today it is computed at `:1956`,
after) and query the target repo:

```
bd list --type molecule --label ws:<wsKey> --json
```

Non-empty → return the refusal; `bd mol pour` is never invoked.

**A check that fails is not an empty check.** If the list query exits non-zero after bd's own retries,
or returns a shape the guard cannot read, the pour **proceeds**, with a loud warning appended to its
result (the existing `ws label: FAILED …` note is the precedent). Refusing would stall the whole
brainstorming skill with no molecule and no escape — the guard is stateless, so there is no override —
and D5 is now the backstop for exactly that case. The guard must therefore distinguish *empty* from
*unreadable*: an unrecognized shape is a failed check, never "no molecule here".

**One query is enough, and this was verified rather than assumed.** A molecule root is closed when
its last step closes: `pi-packages-mol-9o057` has `closed_at` 19:52:00Z against its
`Finish development branch` step at 19:51:56Z, and all 52 completed molecules in the `pmm-iris`
database are `closed`. `bd list` excludes closed issues, so **every root the query returns is
unfinished** — no per-root `mol current` probe, and no second implementation of the widget's
scoring rule in pi-beads.

The workspace key is the one the pour would stamp, computed from `activeCwd` the same way
(`resolveWorkspaceKey`, `:278-288`), and the list runs in the same `repoDir` the pour targets. The
guard therefore sees exactly what the widget sees.

### D2 — The refusal reports what it found

Required in the message:

- the existing molecule's **root id**;
- the **bead** it is linked to, if it has one;
- how far along it is (**done/total**), plus every step's title **and status**, so the user can tell
  whose molecule it is and where a resume would land.

Both come from queries the refusal path can afford:

- `bd list … --json` returns `dependencies` inline — our own molecule returns its `discovered-from`
  link to `pi-packages-rsb9s` — so the bead costs nothing extra;
- one `bd list --parent <root> --all --json` yields progress, every step's status, and the step
  titles, including the `step:conversation` step, whose title reads `Draw out intent: <topic>`.
  Print it verbatim:
  pi-beads must **not** re-implement the widget's `topicFor`, which resolves the formula's prefix
  from the shipped formula file.

The refusal is a `textResult` — the `resolveCreateTarget` precedent (`:512-521`) — so it lands in
chat, and it also fires `ctx.ui.notify(<same message>, "warning")` so the stop is user-visible even
if the model fails to relay it. `beads_mol_pour`'s `execute` currently drops `ctx`
(`async execute(_id, params)`); it gains the fifth argument, which `session_start` already uses
(`:905-908`).

### D3 — The user chooses, and the session carries the choice out

Neither branch is the agent's to pick. The refusal names the root and the command, and stops.

- **Carry on with the existing molecule.** The root id from the refusal becomes the session's
  molecule for the rest of the run, and the session **resumes at the first step that is not closed** —
  it never re-claims a closed step, and never starts the workflow over. That is why the refusal report
  carries every step's status (D2): the resume point is read from it, not guessed. Nothing new is
  needed in the API — every tracking call already resolves steps by `step:<key>` label under
  `mol: <root>`. **No `adopt` parameter is added to the tool.**
- **Clear the leftover and pour fresh.** The session runs
  `bd delete <root> --cascade --force` (verified: `--cascade` recursively deletes the steps, which
  are the root's dependents) and pours again. The refusal message names that command **and what it
  takes with it** — the molecule, its steps, and the beads created under them, since the implement
  step's task beads are the root's dependents too — and the agent must not run it until the user
  says so.

**Invariant:** every path out of the refusal ends with a root id — the existing one, or a fresh pour
after the delete. The skill's step tracking has nothing to work with until then, which is why the
skill must stop rather than proceed.

### D4 — A second pour in the same session is the same refusal

Not a special case, and not detected as one. The guard is stateless and workspace-scoped, so a
second pour inside one session hits the same refusal as a leftover from an earlier session. That is
what "it shouldn't happen at all" means here: it can no longer *succeed*.

### D5 — The widget stops pinning to the first molecule it saw

In `refresh()`'s locked branch (`beads-molecule-widget-controller.mjs:244-249`):

- the single by-id query runs as it does today;
- then, **when the locked molecule's frame is not finished and has no current step** — the widget's
  own score 1, i.e. an idle or abandoned molecule — and `activeWorkspaceKey` is known, the
  controller runs the existing `refreshWorkspace` probe instead of returning. A locked molecule that
  has a current step (score 2) keeps the single cheap query.

Selection changes in one place, `pickWorkspaceMolecule` (`beads-molecule-widget.mjs:235`), which
gains an optional `preferId`:

> a candidate replaces the preferred molecule only when its score is **strictly greater** (2 > 1).
> Equal scores never switch.

**The idle-lock probe is additive only.** It never clears the widget and never adopts an equal-scoring
molecule: when the probe returns nothing, or the locked molecule is not among the candidates (a
molecule with no `ws:` label, say), the locked frame stays exactly as it is. The probe is a wrapper
around `refreshWorkspace`, not a call that inherits its clear-on-empty behaviour.

That is the no-flicker rule: two molecules both being worked (2 and 2) never trade the display, and
two idle molecules (1 and 1) keep the current one rather than jumping to whichever was touched last.

Unchanged: a finished molecule still drops the lock; the multi-worktree guard, the contention gate,
and the workspace-key reset all stay as they are. Cost is bounded — the extra probe runs only while
the locked molecule is idle, and the coalescer already caps refreshes at one per window (10 s).

### D6 — The skill's pour rule becomes conditional

`skills/brainstorming/SKILL.md`:

- **"Pour before you speak — unconditionally."** becomes: pour before you speak, and **if the pour
  refuses, stop** — bring the finding to the user verbatim and ask which of the two they want. Do
  not pour again until they decide.
- The rest of the HARD-GATE is unchanged. The pour still happens before anything is read and before
  the first message; what changes is that it can now come back with a no.
- **"an existing bead or epic does not release you from pouring"** stays as it is. The guard, not the
  bead, is what stops a second pour — that distinction is the point of the rule.
- The "note the root issue id from the `Root issue:` line" paragraph gains the refusal branch: on a
  refusal the root is the one the refusal names, and it is the molecule for the rest of the session.

`reference/process-flow.md` (its "(unconditional)" label) and `reference/anti-patterns.md` ("pour
before you speak", stated as absolute) move with it, as does the pinned string in
`test/skills-contract.test.mjs:284-287`.

## Widget and test consequences

- `pickWorkspaceMolecule(candidates, { preferId })` — new optional argument; existing callers are
  unaffected, and the controller's re-score is the only caller that passes it.
- The bead's acceptance criterion — a regression test at the `pickWorkspaceMolecule` /
  `applyMoleculeFrame` seam — is met by two cases: *idle lock + active candidate → the active one
  wins* and *idle lock + idle candidate → no switch*.
- Controller test: a locked idle molecule triggers the workspace probe; a locked active one does not.
- pi-beads test (via `test/helpers/fake-bd.mjs`): the pour refuses and creates nothing when an open
  `ws:`-labelled molecule exists, reporting its root, bead, and progress; the pour proceeds when only
  closed molecules exist; the refusal names the delete command.

## Files

| File | Change |
|---|---|
| `packages/pi-beads/src/index.ts` | pour guard + refusal report + `ctx.ui.notify`; `wsKey` computed before the pour; tool description gains the refusal |
| `packages/pi-beads/test/pi-beads.test.mjs` | refusal / proceed cases |
| `packages/pi-beads/README.md` | the `beads_mol_pour` row gains the refusal |
| `packages/pi-superpowers-plus/extensions/beads-molecule-widget.mjs` | `pickWorkspaceMolecule` gains `preferId` |
| `packages/pi-superpowers-plus/extensions/beads-molecule-widget-controller.mjs` | re-score while locked, when the locked molecule is idle — additive only (never clears, never adopts an equal score) |
| `packages/pi-superpowers-plus/test/beads-molecule-widget.test.mjs` | the two selection cases |
| `packages/pi-superpowers-plus/test/beads-molecule-widget-controller.test.mjs` | probe-on-idle-lock |
| `packages/pi-superpowers-plus/skills/brainstorming/SKILL.md` | conditional pour; refusal branch; adopted root; resume at the first unclosed step |
| `packages/pi-superpowers-plus/skills/brainstorming/reference/{process-flow,anti-patterns}.md` | wording |
| `packages/pi-superpowers-plus/test/skills-contract.test.mjs` | the pinned pour string moves |
| `packages/pi-superpowers-plus/CHANGELOG.md` | `[Unreleased]` entry |

## Acceptance criteria

- [ ] A pour into a workspace that already has an unfinished molecule creates **nothing** and returns
      a refusal naming the root, the linked bead, and the progress.
- [ ] The refusal names `bd delete <root> --cascade --force`, states what it removes, and the agent
      does not run it without the user's say-so; after it, the next pour succeeds.
- [ ] Carrying on with the existing molecule needs no new tool argument — the refusal's root id is
      the session's molecule — and a partway molecule resumes at the first step that is not closed,
      with no closed step re-claimed and no restart from step 1.
- [ ] A failed or unreadable existence check does not block the pour; it proceeds with a warning.
- [ ] A workspace whose only molecules are finished pours normally.
- [ ] A second pour in the same session hits the same refusal.
- [ ] Widget: idle lock + active candidate → the active molecule is displayed; two active → no
      switch; one molecule → unchanged behaviour; a finished molecule still drops the lock.
- [ ] The skill no longer presents the pour as unable to fail, and documents both branches.
- [ ] `npm test` at the repo root passes.

## Risks

- **False positive on a different bead.** The guard is workspace-wide, so a leftover for another bead
  stops a pour too. Accepted (human decision, this session): the refusal reports the bead and the
  topic, and the user decides.
- **Molecules with no `ws:` label are invisible to the guard** — a pre-multi-worktree molecule, or one
  whose label stamping failed (the pour already reports that failure). The widget has the same blind
  spot; closing it is not in scope here.
- **Ping-pong between two live molecules.** Prevented by the strictly-greater rule, and made rarer by
  the guard itself: two live molecules in one workspace now require a deliberate user override.
- **A failed check lets a second molecule through.** Accepted: the failure is loud, the widget fix
  covers the display, and the alternative stalls the skill. This is the one place the guard is
  deliberately not absolute.
- **One extra `bd` query per pour**, on the refusal path only.
- **Fork drift.** The guard is a local divergence in pi-beads (a fork of `abix5/pi-beads`), like the
  existing `ephemeral` support. pi-beads has no divergence record file — `docs/pi-subagents-local-patch.md`
  covers pi-subagents only — so the divergence lives in this document and in the `beads_mol_pour` row
  of `packages/pi-beads/README.md`.

## Out of scope

- The stale v1 template proto in the pi-packages beads DB.
- The `smoke-test-approved` gate and the finish phase.
- Any change to `pickWorkspaceMolecule`'s scoring weights, or to the no-id inference fallback.

## Left to the builder

- The exact wording of the refusal and of the skill's refusal branch.
- The exact queries behind the report. The root id, the linked bead, and progress are required; how
  progress is read (the `--parent` list above, or something cheaper) is the builder's choice.
- Where the refusal message is assembled, provided it is one string shared by the `textResult` and
  `ctx.ui.notify`.
