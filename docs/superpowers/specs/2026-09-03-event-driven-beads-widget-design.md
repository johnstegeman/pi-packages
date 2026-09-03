# Event-driven beads molecule widget refresh

Molecule: `pi-packages-mol-0eh` · Related beads: `pi-packages-48r`, `pi-packages-i1i`

## Problem

`beads-molecule-widget.ts` polls `bd mol current --json` and `bd mol show --json`
every 5s for the lifetime of a session (`startPolling`/`setInterval`). Under load
(many concurrent sessions/agents against the same `.beads` DB) this poll traffic
was observed locking the beads database, causing contention with real mutating
work. The fix is to make the widget purely event-driven: pi-beads tools emit an
event after every mutation, and the widget refreshes in response instead of on
a timer.

This requires closing the tool-coverage gap tracked in `pi-packages-i1i` first —
today several molecule-workflow mutations (`bd mol pour`, `bd update --claim`,
`bd gate resolve`, etc.) go through raw `bd` CLI calls from skill docs rather
than pi-beads tools, so they would be invisible to an event-only widget.

## Design

### 1. Event emission (pi-beads)

`afterWrite(repoDir)` in `packages/pi-beads/src/index.ts` is already called by
every mutating tool (`beads_create`, `beads_update`, `beads_close`, `beads_dep`,
`beads_undep`, `beads_comment`). Add `pi.events.emit("beads:changed")` there.

`afterWrite` currently early-returns in single-repo mode:

```ts
async function afterWrite(repoDir: string): Promise<void> {
  if (!isUmbrella) return; // single-repo: same DB the reads use, nothing to sync
  await bd(["export", "-o", ".beads/issues.jsonl"], repoDir, 30000);
  needSync = true;
}
```

Restructure so the JSONL export stays umbrella-only but the emit fires in both
modes:

```ts
async function afterWrite(repoDir: string): Promise<void> {
  if (isUmbrella) {
    await bd(["export", "-o", ".beads/issues.jsonl"], repoDir, 30000);
    needSync = true;
  }
  pi.events.emit("beads:changed");
}
```

The event is generic — no payload beyond the name. Every mutating tool call
fires it regardless of which bead changed or whether it's relevant to the
widget's currently-displayed molecule; the widget's coalescing (below) absorbs
the cost of any resulting no-op re-renders. This keeps pi-beads decoupled from
widget internals.

**New tools** (closing the `pi-packages-i1i` gaps), each ending in the same
`afterWrite`/emit call as existing mutating tools:

- `beads_reopen` — wraps `bd reopen <ids...> [--reason]`.
- `beads_gate_create` — wraps `bd gate create --type=<type> --blocks <id> --reason <reason>`.
- `beads_gate_resolve` — wraps `bd gate resolve <gate-id>` **and then `bd close
  <gate-id>`** as a single atomic tool call. Per the brainstorming/writing-plans
  skill docs, resolving a human gate only unblocks its dependents; the gate
  bead itself stays open until explicitly closed, and a later dependent's
  `bd close` fails ("blocked by open issues") if that second close is skipped.
  Folding both steps into one tool call removes this footgun instead of relying
  on skill authors to remember the follow-up close. If `bd close` fails after a
  successful resolve, the tool reports the resolve succeeded and surfaces the
  close error so the caller can retry just the close.
- `beads_mol_pour` — wraps `bd mol pour <formula> --var k=v ...`, returns the
  root issue id. Mutates → emits.
- `beads_mol_show` / `beads_mol_current` — wrap `bd mol show`/`bd mol current
  --json`. Read-only → no emit.
- `beads_update` gains optional params: `claim: boolean` (→ `--claim`),
  `setMetadata: string` (`key=value`, → `--set-metadata`), `description:
  string` (→ `--description`, replaces body instead of notes).
- `beads_dep` / `beads_undep` gain optional `type` param (default `"blocks"`,
  also accepts `"discovered-from"` / `"related"`) → `--type`.
- `beads_show` gains optional `full: boolean` to include the description body
  (compact mode remains the default).

No `beads_force_close` tool is added. Force-close was a workaround for the
brainstorming/molecule skills closing steps out of order; §3 fixes the skills
to resolve gates and close steps in the correct sequence instead, so
`--force` is never needed.

### 2. Widget: remove polling, event-driven leading+trailing coalesce

In `packages/pi-superpowers-plus/extensions/beads-molecule-widget.ts`:

- Delete `pollTimer`, `timersStarted`, `startPolling`, and the `setInterval`
  call from `session_start`.
- Subscribe once: `pi.events.on("beads:changed", handleChanged)`.
- Coalescing state: a `coalesceTimer` handle and a `dirty` boolean.
  - `handleChanged()`:
    - If `coalesceTimer` is not running: refresh immediately (leading edge) —
      `refreshMolecule(cwd).then(() => refreshChildren(cwd)).then(renderMolecule)`
      — then start a 10s timer.
    - If `coalesceTimer` is already running: set `dirty = true` and return
      (suppress this render).
  - Timer fires after 10s:
    - If `dirty`: run the same refresh chain, reset `dirty = false`, restart
      the 10s timer.
    - If not `dirty`: clear `coalesceTimer` (idle until the next event).
- This caps updates to at most 1 per 10s during a burst, never delays the
  first update in a burst, and needs only one timer + one flag (no per-event
  timer reset, which would risk starving updates under steady mutation
  traffic).
- `session_start` and `agent_start` keep their existing unconditional refresh
  calls (initial paint / per-turn resync) — unchanged.
- The widget's manual `invalidate()` callback is unchanged.
- Net effect: any out-of-band mutation not made through a `beads_*` tool
  (e.g. a raw `bd` CLI call from outside pi, another process touching the
  same `.beads` DB) will not trigger a refresh until the next `beads:changed`
  event or the next `session_start`/`agent_start`. This is accepted per
  explicit scoping — polling is removed with no backstop.

### 3. Skill updates

Update `brainstorming`, `writing-plans`, and `executing-plans` skill docs to
call the tools above instead of raw `bd` bash invocations, so molecule-workflow
progress is visible to the event-driven widget:

| Raw `bd` call | Replacement |
|---|---|
| `bd mol pour ...` | `beads_mol_pour` |
| `bd update <step> --claim` | `beads_update` with `claim: true` |
| `bd close <step> --reason ...` | `beads_close` (already a tool) |
| `bd update <id> --set-metadata review.verdict=...` | `beads_update` with `setMetadata` |
| `bd gate resolve <gate-id>` followed by `bd close <gate-id>` | `beads_gate_resolve` (does both in one call, see §1) |
| `bd mol current <root> --json` / `bd mol show <root>` | `beads_mol_current` / `beads_mol_show` |
| `bd dep add <root> <issue> --type discovered-from` | `beads_dep` with `type: "discovered-from"` |
| `bd comment <id> "..."` | `beads_comment` (already a tool) |

`bd cook <formula> --persist` remains a raw CLI call — it prepares the proto
template and is not itself a mutation the widget needs to react to; `bd mol
pour` (the step that creates real, trackable issues) is the one that must go
through a tool.

No skill references `bd close --force` today, so no force-close call sites
need fixing beyond ensuring steps are claimed/closed/gates-resolved in the
documented order (already the documented behavior — this design doesn't
change ordering, only the call mechanism).

## Testing

- `packages/pi-beads`: unit tests for each new tool's argv construction and
  for the `afterWrite` emit firing in both single-repo and umbrella modes.
- `packages/pi-superpowers-plus`: widget tests covering leading-edge render,
  trailing coalesce (burst of N events → 2 renders: immediate + one after
  10s), idle timer teardown when not dirty, and removal of the old polling
  behavior.
- Manual QA: run a real brainstorming session exercising pour/claim/gate-
  resolve/close and confirm the widget updates promptly without a poll timer
  running (verify via `session_start`/`agent_start` still refresh, no
  `setInterval` present).

## Out of scope

- Filtering `beads:changed` by relevance to the active molecule (rejected —
  generic event, cheap re-fetch is preferred over added complexity).
- A shared `MoleculeOps` abstraction layer used by both tools and skills
  (Approach C, not chosen — YAGNI for this fix).
- A polling backstop for out-of-band raw `bd` mutations (explicitly removed
  per scoping decision).
