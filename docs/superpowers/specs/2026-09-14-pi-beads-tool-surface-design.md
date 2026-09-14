# pi-beads tool surface: comments read-back, promote, claim/continue, memories, stale/lint — Design

- **Date:** 2026-09-14
- **Issue:** `pi-packages-3iej.4` (epic `pi-packages-3iej`, Superpowers stack remediation)
- **Packages:** `packages/pi-beads`, `packages/pi-superpowers-plus`
- **Verified against:** `bd` 1.2.2 (6c124203e)

## Context

A read-only audit of the Superpowers stack found six gaps in the `pi-beads` tool
surface. This design closes them in one plan. Each finding below was re-verified
against the live `bd 1.2.2` CLI before designing:

| # | Gap | Verified reality |
|---|-----|------------------|
| H4 | Comments are write-only — `beads_comment` exists (`src/index.ts`), but `beads_show` runs `bd show --json` with no comments and there is no read wrapper. | `bd comments <id> --json` lists comments (array). |
| H5 | `skills/beads/SKILL.md:109` tells agents to promote a wisp with `bd mol squash <id>`; `using-superpowers/SKILL.md:27` also mentions squash. | The real command is `bd promote <id> [--reason]`. |
| M16 | No atomic claim / continue ergonomics. | `bd ready --claim` and `bd close --continue/--suggest-next/--claim-next/--no-auto` exist. |
| M17 | `bd remember/recall/memories/forget` are unwrapped; memories inject at prime time. | Memories are a per-DB key→value store (`{key: content, schema_version}`), injected by `bd prime`. |
| M19 | No stale/abandoned-work view at session start. | `bd stale --json` exists (default 30 days). |
| M18 | No lint wrapper and no `acceptance` path; plan task template lacks Acceptance Criteria. | `bd lint --json` and `bd create --acceptance` exist. |

## Decisions (from brainstorming)

1. **One spec/plan for all six findings** — they are independent, each small.
2. **Conservative tool surface** — prefer flags on existing tools over new tools;
   add a dedicated tool only for a genuinely new capability. The package is
   deliberately context-lean; tool schemas cost every session.
3. **Span two packages** — fix the H5 doc lie and add the M18 Acceptance Criteria
   template section in `pi-superpowers-plus`, so the tools are actually used.
4. **Memories route to the umbrella/aggregate DB** — `pi-beads` injects memories
   into a session by running `bd prime --mcp` against the umbrella dir, so a
   memory written anywhere else would never surface. All memory verbs therefore
   run against `umbrella`.
5. **Approach: inline wrappers** mirroring the existing `pi.registerTool` style.
   No refactor, no module split, no generic `bd` passthrough.

## Architecture

All additions live inline in `packages/pi-beads/src/index.ts`, following the
existing pattern:

- a constant in the `TOOL` map (currently ~line 47);
- a `pi.registerTool({ name, label, description, parameters, execute })` block;
- `execute` builds an argv array, calls `bd(args, dir)`, and returns
  `textResult(...)`.

Two small formatter helpers (`fmtComments`, `fmtMemories`) are added beside the
existing `fmtShow` / `fmtRows` formatters. **No existing tool is refactored**, no
new source files are added, and `index.ts` is not split.

### Routing rules

| Kind | Routing | Post-step |
|------|---------|-----------|
| Reads (comments, stale, lint, memories list/recall) | `await ensureFresh()` then `bd(args, umbrella)` | none |
| Writes (`beads_promote`, memory writes) | resolve owning repo; `beads_promote` by id prefix via `dirForPrefix`; memories always `umbrella` | `await afterWrite(dir)` (re-export + `beads:changed`) |
| `acceptance` on create | passed as `--acceptance` on the existing per-repo `bd create` argv | existing `afterWrite` unchanged |

Read tools never emit `beads:changed`. Write tools always emit exactly once via
the existing `afterWrite`.

## Tools

### H4 — `beads_comments({ id })` (read, umbrella)

```text
bd comments <id> --json
```

`comments --json` returns an array. `fmtComments` renders one compact line per
comment (author · time · text) and falls back to raw text if the shape is
unexpected. The alternative `beads_show({ includeComments })` flag is
**intentionally not added** — one clear read path is enough, and `beads_show`
stays lean.

### H5 — `beads_promote({ id, reason? })` (write, routed by id prefix)

```text
bd promote <id> [--reason <reason>]
```

Unknown prefix yields the same error string as `beads_comment`
(`unknown repo for id '<id>'`).

Documentation fixes in the same changeset:

- `packages/pi-beads/skills/beads/SKILL.md:109` → `` `bd promote <id>` ``.
- `packages/pi-superpowers-plus/skills/using-superpowers/SKILL.md:27` → correct
  the note to point at `bd promote` / `beads_promote`.

### M16 — flags on existing tools

- `beads_ready({ ..., claim? })` appends `--claim` and returns the claimed issue
  through the existing `fmtRows`.
- `beads_close({ ids, reason?, continue?, suggestNext?, claimNext?, noAuto? })`
  maps `continue`→`--continue`, `suggestNext`→`--suggest-next`,
  `claimNext`→`--claim-next`, `noAuto`→`--no-auto`. Flags are appended per-repo.
  The existing parent-step cascade runs afterward **unchanged**, so the two
  compose.

### M17 — `beads_memories({ action, key?, content?, query? })` (umbrella)

One tool with an `action` enum keeps the schema small.

| action | argv | validation |
|--------|------|-----------|
| `remember` | `bd remember <content> [--key <key>]` | `content` required; write |
| `recall` | `bd recall <key> --json` | `key` required; read |
| `list` | `bd memories [<query>] --json` | read |
| `forget` | `bd forget <key>` | `key` required; write |

`fmtMemories` renders the `{key: content}` object for `list`. Unknown actions
are rejected before any bd call.

### M19 — `beads_stale({ days?, status?, limit? })` (read, umbrella)

```text
bd stale --json [-d <days>] [-s <status>] [-n <limit>]
```

`status` is validated against `open|in_progress|blocked|deferred` (bd's allowed
set) before the call. Defaults mirror bd: 30 days, limit 50. No `bd query`
passthrough in this plan (that was the rejected generic-passthrough approach).

### M18 — `beads_lint({ ids?, status?, type? })` (read, umbrella)

```text
bd lint [<ids...>] --json [--status <s>] [--type <t>]
```

`ids` is a space/comma-separated string parsed exactly like `beads_close` /
`beads_deps`. `lint --json` returns
`{ total, issues, results: [{ id, title, type, missing[], warnings }] }`.
Output is formatted as compact per-id `missing: …` lines, plus a clean
"no template warnings" result when `results` is empty.

### M18 — `acceptance` on writes

- `beads_create` gains `acceptance` → `--acceptance <text>`.
- `beads_create_list` tasks each accept `acceptance` → `--acceptance` on that
  task's `bd create`.
- `packages/pi-superpowers-plus/skills/writing-plans/SKILL.md`: add an
  **Acceptance Criteria** block to the task template (after Interfaces, before
  the steps) and instruct that each task's `acceptance` is passed through
  `beads_create_list` so `bd lint` is clean.

## Documentation updates

1. `packages/pi-beads/README.md`
   - Tool table: add `beads_comments`, `beads_promote`, `beads_memories`,
     `beads_stale`, `beads_lint`; note the new `beads_ready` / `beads_close`
     flags.
   - Read/write routing lists: add the new reads to the read list, add
     `beads_promote` and memory writes to the write list, and extend the
     "emit `beads:changed`" enumeration.
2. `packages/pi-beads/skills/beads/SKILL.md` — fix the promote command; add short
   examples for comments read-back, claim/continue, memories, stale, lint.
3. `packages/pi-superpowers-plus/skills/using-superpowers/SKILL.md` — correct the
   promote note.
4. `packages/pi-superpowers-plus/skills/using-superpowers/references/pi-tools.md`
   — extend the `beads_*` inventory.
5. `packages/pi-superpowers-plus/skills/writing-plans/SKILL.md` — Acceptance
   Criteria template section + `acceptance` pass-through instructions.

## Error handling

Reuse existing conventions verbatim; no new patterns:

- Missing args → `"<x> is required"`.
- Invalid enum → `invalid <field> '<v>' (allowed: a|b|c)` (mirrors `GATE_TYPES`).
- Unknown id prefix → `unknown repo for id '<id>' (known prefixes: …)`.
- bd failure → `bd <command> failed: ${r.err}`.
- `textResult`'s `clean()` continues to strip bd tip lines.

## Testing & verification

Harness: `packages/pi-beads/test/pi-beads.test.mjs` shadows `bd` with a `/bin/sh`
fixture on a prepended `PATH`; the fixture logs every argv (`INV`/`ARG` lines) and
returns canned topology / JSON. The extension's real `execute` runs unmodified,
so tests assert the exact argv each tool builds and that writes emit
`beads:changed`. New tools extend the fixture's `case "$1"` and add assertions.

| Finding | Tests |
|---------|-------|
| H4 | `comments <id> --json` argv, umbrella cwd, `fmtComments` output, missing-`id` error |
| H5 | `promote <id> --reason …` argv, owning-repo cwd, `beads:changed` emit, unknown-prefix error |
| M16 | `--claim` present when requested; each close flag mapped; no flags when unset; cascade still runs |
| M17 | correct argv for all four actions; umbrella cwd; writes emit; per-action validation; invalid action rejected before bd |
| M19 | `stale --json -d … -s … -n …` argv against umbrella |
| M18 | `lint … --json …` argv; `--acceptance` present when supplied, absent when not, on create and create_list |

Cross-package verification: the `pi-superpowers-plus` edits have no test harness;
verify by targeted `grep` that the stale `bd mol squash` promote claim is gone,
the Acceptance Criteria section exists in the task template, and the tool
inventory lists the new tools.

### Acceptance

1. `packages/pi-beads`: `npm test` green (both `pi-beads.test.mjs` and
   `cost-tracking.test.mjs`).
2. Every new tool has argv tests; every write has an emit test.
3. README + `skills/beads/SKILL.md` tables list the full `beads_*` set with no
   stale commands.
4. `bd lint` clean on a plan task carrying `acceptance`; the writing-plans
   template emits it.

## Out of scope

- Any refactor of existing tools or a shared routing/format layer.
- A generic `bd` / `bd query` passthrough tool.
- Splitting `index.ts` into modules.
- The `beads_show({ includeComments })` variant.
- Per-repo (non-umbrella) memories.
