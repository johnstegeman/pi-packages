# pi-beads: remove the in-progress widget — Design

**Date:** 2026-09-02
**Status:** Approved (design sections reviewed 2026-09-02)
**Branch:** `johnstegeman/remove-pi-beads-widget`
**Package:** `packages/pi-beads` (fork of `@abix5/pi-beads`, v0.2.2)

## Goal

Remove the **above-editor board widget** (`beads-wip`, placement `aboveEditor`)
from the pi-beads extension entirely — code, tests, docs, and metadata — so the
package ships the context-lean `beads_*` tooling, umbrella routing, and pieces
below **without** the passive visual board that pi draws next to the editor.

Everything except the widget stays byte-for-byte functional:

- the ten `beads_*` tools (`beads_ready|list|show|deps|create|update|close|dep|undep|comment`)
- umbrella multi-repo mode (aggregate reads, prefix-routed writes, auto re-sync, single-repo fallback)
- the lean prime (`bd prime --mcp` once per segment + focus line)
- the read digests (`fmtRows` / `fmtShow` / `fmtDeps`)
- the `bd✓` / `bd✗` status-line segment (`setStatusLine`) — **unchanged**
- the four slash commands `/beads`, `/beads-sync`, `/beads-init`, `/beads-mode` — **unchanged**
- the bundled `beads` skill (registered via `resources_discover`) — **unchanged**

The widget is a **leaf**: no other part of the extension depends on its state,
so this is pure deletion with no migration.

## What the widget is (removal scope)

| Piece | Location |
|---|---|
| Widget state + render path | `src/index.ts`: `uiRef`, `WipEntry`, `wip`/`todo`/`done` maps, `readyCount`, `widgetState()`, `renderWip()` |
| Widget data readers | `src/index.ts`: `refreshReady()`, `refreshDone()`, `loadWip()`, `metaOf()` |
| Widget lifecycle hooks | `src/index.ts`: `agent_start` handler (per-turn done re-read); widget branches of `session_start` and `afterWrite()`; widget mutations in `beads_update` (`in_progress`/closed block) and `beads_close` |
| Pure renderer + tests | `src/widget-lines.mjs`, `src/widget-lines.test.mjs` |
| Screenshot pipeline | `scripts/widget-shots.mjs`, `docs/shots.tape`, `docs/assets/*.png`, `Makefile` (`test`/`shots` targets), `SPEC-ui.md` |
| Manifest bits | `package.json`: `test` script, `pi.image`, `src/widget-lines.mjs` in `files`, "an in-progress widget" in `description` |

Not in scope (kept): the status-line segment, all tools, the prime, all slash
commands, the skill, umbrella routing.

## Design

### 1. `src/index.ts` — delete widget machinery

Delete (referencing line numbers at the time of writing):

- line 33 — the `widgetLines, formatAge, parseClosedWisps` import
- lines 69–86 — widget state: `uiRef`, `WipEntry`, `wip`, `todo`, `done`, `readyCount`
- `widgetState()` and `renderWip()` (lines 375–426)
- `refreshReady()` and `refreshDone()` (lines 430–479)
- `metaOf()` (lines 481–497) and `loadWip()` (lines 500–521)
- the `agent_start` handler (lines 556–565) — it existed only to repaint the
  done list from closed wisps each turn
- in `afterWrite()` (lines 219–229) — drop the
  `void Promise.allSettled([refreshReady(), refreshDone()]).then(renderWip, ...)`
  fire-and-forget; **keep** `bd export -o .beads/issues.jsonl` and
  `needSync = true`, so the aggregate stays fresh for the next **read**
- in `beads_update` (lines 919–936) — drop the `if (params.status)` block that
  mutated `wip`/`todo` and repainted. The database remains the source of truth
  for status; `beads_ready` / `beads_list` already reflect changes by querying
  `bd`. No tool behavior changes.
- in `beads_close` (lines 985–993) — drop the in-memory `wip.delete` /
  `todo.delete` loop and the `renderWip()` call. Keep `closedIds` bookkeeping,
  which feeds the returned `closed ...` message.
- in `session_start` (lines 527–554) — drop `uiRef` capture and the
  `beadsReady ? (loadWip/refreshReady/refreshDone → renderWip) : (clear + renderWip)`
  branch. Keep `activeCwd`, `resolveTopology()`, `setStatusLine(ctx)` (the
  status segment uses `ctx.ui`, not `uiRef`, and is unchanged), and the existing
  try/catch that notifies on init failure.

Kept verbatim: `bd()` runner, topology resolution, `ensureFresh`,
`buildPrimeBlock` (its "Current focus" line reads `in_progress` from `bd`, which
is independent of the widget and stays), `setStatusLine`, all ten tools, all
four slash commands, `resources_discover`.

### 2. Files and directories deleted outright

- `src/widget-lines.mjs`
- `src/widget-lines.test.mjs`
- `scripts/` (contains only `widget-shots.mjs`)
- `docs/` (contains only `shots.tape` and `assets/*.png`)
- `SPEC-ui.md`
- `Makefile` (only `help`/`test`/`shots`, all widget-centric)

### 3. Metadata

- `packages/pi-beads/package.json`:
  - `description`: remove "an in-progress widget"
  - `files`: remove `src/widget-lines.mjs`
  - `pi.image`: remove (widget screenshot)
  - `scripts.test`: remove (the only test suite was widget rendering)
  - `name`, `version` (0.2.2 — leave alone), `main`, `exports`, `peerDependencies`,
    `engines`, `publishConfig` — unchanged
- Root `AGENTS.md` — the "Running tests → pi-beads: `cd packages/pi-beads && npm test`"
  bullet must be removed (no tests remain); replace with a one-line note that
  pi-beads carries no automated tests.

### 4. `README.md`

Remove widget-related content and keep the rest:

- header blurb — drop the "Next to the editor sits a widget…" sentence
- delete "What a session looks like" (widget.png) and "Widget legend" sections,
  and the narrow-pane paragraph + widget-narrow.png
- "How it works" — drop the **Widget** bullet
- "Limitations" — drop the widget bullets (subagent/no-UI, session-memory done
  rows, ten-row budget); **keep** the cross-repo dependency and `bd` format
  bullets
- "Development" — drop `make test`/`make shots` lines (now only `/reload`)
- keep: Why, context-cost table, Install, Requirements, Configuration, Commands
  & tools, Quiet init, Not to be confused with
- where "What a session looks like" was, add a one-line note: no board is drawn
  anymore; `/beads` shows the ready + in-progress board on demand

### 5. Behavior deltas (what actually changes for users)

- **No board beside the editor.** The always-on `◐`/`○`/`✓` view is gone.
  `/beads` (unchanged) still prints a ready + in-progress board via a
  notification, and the tools cover every query.
- **One fewer `bd` subprocess per turn** — the `agent_start`
  `bd mol wisp list` re-read disappears. This is the only performance delta.
- **No reactive repaint on writes** — `afterWrite` still re-exports and marks
  the aggregate stale, so reads through the tools are just as fresh.
- **`bd✓`/`bd✗` still signals** whether `.beads/` exists, each turn.

### 6. Verification (no automated tests remain — by design)

1. `grep -nE 'widget|uiRef|setWidget|widgetLines|renderWip|WipEntry|readyCount|formatAge|parseClosedWisps' src/index.ts` → zero hits.
2. Type-strip parse check: `node --experimental-strip-types --check src/index.ts`
   proves the file is still valid TS as pi loads it.
3. Throwaway smoke (in `/tmp`, not committed): a minimal mock-`pi`
   (`registerTool`, `registerCommand`, `on`, `resources_discover`) that imports
   `src/index.ts` and asserts 10 tools, 4 commands, 1 skill registration, and
   that no widget was set. Also spot-check that `beadsReady=false` → statusline
   is `bd✗` and tools still behaviorally valid (no template errors).
4. `git diff` review for accidental deletions outside the widget's footprint.

## Out of scope

- No new features; no refactor of the remaining `index.ts` beyond deletion.
- No behavioral change to any tool or command.
- No version bump, no rename, no publish change.
- The `hashline-edit`-style hash anchors in the read line numbers are
  illustrative; implement against the actual file.

## Success criteria

- `packages/pi-beads` loads as a pi extension with only the widget gone; the ten
  tools, four commands, status-line segment, and bundled skill all present.
- No reference to widget state, `setWidget`, or the deleted files anywhere in
  the package or root `AGENTS.md`.
- `npm test` is removed for pi-beads; nothing else in the workspace calls it.
- `git status` clean after the commit; only intended files deleted.
