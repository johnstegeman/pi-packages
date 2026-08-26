# pi-beads fork with ephemeral (wisp) support — Design

**Date:** 2026-08-26
**Status:** Approved (all design sections reviewed 2026-08-26)
**Branch:** `feat/pi-wisp`

## Goal

Bring the upstream [`abix5/pi-beads`](https://github.com/abix5/pi-beads) (v0.2.2)
extension into this `pi-packages` monorepo as a **vendored fork** so it can be
extended in-place, and extend its `beads_create` tool with an `ephemeral`
parameter that passes `--ephemeral` to `bd create` — creating **wisps**
(ephemeral beads for operational work with no audit value once closed).

## Context

- This repo is a monorepo of independent pi extensions/themes under
  `packages/<name>/`, registered centrally in the root `package.json` `pi`
  manifest. This is a git worktree on branch `feat/pi-wisp`.
- The `beads_*` tools currently active come from npm-installed
  `@abix5/pi-beads@0.2.2` in `~/.pi/agent/npm`.
- `bd create --ephemeral` creates a wisp: real beads worked on normally,
  flagged `Ephemeral=true`, excluded from federation sync by default
  (`federation.exclude_types` defaults to `[wisp]`), and purged wholesale via
  `bd mol wisp gc` or `bd purge --force`. A wisp can be promoted to permanent
  with `bd mol squash`. Verified against bd 1.2.2 (Homebrew).
- This is a **vendored fork** (approach A chosen): the code is copied into the
  monorepo and owned by it going forward; there is no upstream sync link.

## Approach: vendored fork

1. Copy the upstream repo contents into `packages/pi-beads/`, keeping it
   faithful: `package.json`, `src/` (`index.ts`, `widget-lines.mjs`,
   `widget-lines.test.mjs`), `skills/beads/SKILL.md`, `README.md`, `LICENSE`,
   `Makefile`, `docs/`, `scripts/`, and its `.gitignore`.
2. The vendored `package.json` keeps the `@abix5/pi-beads` name — the package
   name is cosmetic when installing from git (identity is the repo URL), so no
   rebranding is needed. Its `pi.extensions` / `pi.skills` manifest is retained
   so a standalone path install (`pi install ./packages/pi-beads`) works.
3. Register the package in the root `package.json` `pi` manifest so a
   whole-repo git install loads it:
   - `extensions`: add `"./packages/pi-beads/src/index.ts"`
   - `skills`: add `"./packages/pi-beads/skills"` (new key; root currently
     registers no skills).

## Extension change — `beads_create` `ephemeral` parameter

In `packages/pi-beads/src/index.ts`, the `beads_create` tool:

1. **Parameter** (added to `parameters.properties`):

   ```ts
   ephemeral: {
     type: "boolean",
     description: "Create as an ephemeral bead (wisp) by passing --ephemeral to bd create. Wisps stay out of federation sync and can be purged with `bd mol wisp gc` / `bd purge --force` once closed. Boolean true or the string \"true\" both work.",
   },
   ```

2. **Arg wiring** (beside the existing `args.push(...)` calls):

   ```ts
   if (params.ephemeral === true || params.ephemeral === "true")
     args.push("--ephemeral");
   ```

3. Everything else in the create path is unchanged: repo routing
   (`resolveCreateTarget`), the other flags (`-t`, `-p`, `-d`, `--parent`,
   `-l`, `--notes`, `--design`), `bd` execution, and `afterWrite` aggregate
   refresh.

### Behavior

```
beads_create({ title, ephemeral: true })   →  bd create "<title>" --ephemeral
beads_create({ title, ephemeral: "true" }) →  bd create "<title>" --ephemeral
beads_create({ title })                    →  bd create "<title>"            (no flag)
```

No value is rejected; anything falsy simply omits the flag.

## Bundled skill update — `skills/beads/SKILL.md`

- Add `ephemeral?` to the `beads_create({...})` signature in the write-tools
  table.
- Add a wisp example to the "Typical flows" section, e.g.:

  ```
  beads_create({ repo: "main-orchestrator", title: "Release check", type: "task", ephemeral: true })
  ```

  with a one-line note: `ephemeral: true` passes `--ephemeral`, creating a wisp
  (excluded from federation sync; purge with `bd mol wisp gc` / `bd purge
  --force`; promote with `bd mol squash`).

## Testing & verification

- Keep upstream `src/widget-lines.test.mjs`; run it via the vendored
  `npm test` (`node --test src/widget-lines.test.mjs`). It has no dependencies
  and runs as-is in the monorepo.
- The `ephemeral` wiring is not covered by that suite (it shells out to `bd`),
  so verification is a manual smoke test:
  1. `bd create "smoke test wisp" --ephemeral --dry-run` — confirm flag shape on
     installed bd 1.2.2.
  2. In a pi session, `beads_create({ repo, title, ephemeral: true })` → confirm
     returned id; `bd mol wisp list` (or `bd ready`) shows it as ephemeral.
  3. `beads_update({ id, status: "closed" })`, then clean up via
     `bd mol wisp gc` / `bd purge --force` (or delete) so no test residue
     remains in the beads DB.

## Docs

- Root `README.md` and `AGENTS.md`: add `pi-beads` to the `packages/` tree
  listing.

## Ops / rollout (not code)

1. `pi remove npm:@abix5/pi-beads` so the fork is the only source of `beads_*`
   tools once the monorepo install loads (avoids doubly-registered tools).
2. Install from git: `pi install git:github.com/johnstegeman/pi-packages` (or
   `pi -e ./` for a single-run test) from this branch.

## Out of scope (explicitly deferred)

- `--wisp-type` (`heartbeat|ping|patrol|gc_report|recovery|error|escalation`)
  for TTL-based compaction.
- `--estimate` or other TTL/due options for wisps.
- Any behavioral change to read/list/show tools regarding ephemeral filtering
  (read paths already span repos; wisps simply appear/close like normal beads).

## Success criteria

- `packages/pi-beads/` exists, is registered in the root `pi` manifest
  (extension + skill), and `npm test` passes in the package.
- `beads_create` accepts `ephemeral` (boolean `true` or string `"true"`) and
  passes `--ephemeral` to `bd create`.
- The bundled `beads` SKILL.md documents `ephemeral` and wisp lifecycle.
- Root `README.md` / `AGENTS.md` list `pi-beads`.
- Smoke test confirms a wisp is created and is purgeable.
