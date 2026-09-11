# pi-beads write-path correctness

Molecule: `pi-packages-mol-0vre` · Task: `pi-packages-3iej.1` (epic `pi-packages-3iej`)

Date: 2026-09-11 · Status: approved design (`review.verdict=done` on `pi-packages-mol-cnn8`)

## Problem

An eight-dimension read-only audit of the Superpowers stack (`wf_47db8bcd4e66`)
found six write-path defects in `packages/pi-beads`, all confirmed and
re-verified by hand:

- **H2 — dashed-prefix routing.** `dirForPrefix` (`src/index.ts:247`) and
  `samplePrefixOf` (`:168`) truncate ids at the first hyphen. In umbrella mode
  `prefixToDir` keys the umbrella's *full* native prefix (`bd where` →
  `prefix: pi-packages`), so `dirForPrefix("pi-packages-n4m5")` looks up `pi`
  and returns `null`. Every write tool (`beads_update`/`close`/`reopen`/`dep`/
  `comment`) then fails with `unknown repo for id …`, and cost-tracking
  (`src/cost-tracking.ts`) silently drops the contribution. The test fixture
  only exercises dashless prefixes (`umb`, `backend`), so the suite is green.
- **H3 — silent repo fallback.** `resolveCreateTarget` (`:260`) returns
  `resolveRepoTarget(repoParam) ?? defaultRepoDir`, used by `beads_create`
  (`:762`) and `beads_mol_pour` (`:1217`). A typo'd `repo` silently creates the
  bead in the cwd's repo instead of erroring.
- **M2 — create_list loses durability on partial paths.** `beads_create_list`
  returns before `afterWrite` (JSONL export + `beads:changed`) on the
  human-gate-setup failure path (`:849`) and the partial-task-failure path
  (`:875`), so beads that were already minted are never exported or synced.
- **M1 — create_list write amplification.** Each call runs N creates plus up to
  2N separate `bd link` invocations (~3N bd processes).
- **M3 — close cascade hides failure.** The parent-step cascade discards a
  non-zero `bd close` (`:1049` `if (!rc.ok) break;`) and still reports plain
  `closed …`, so an unsatisfied gate on the parent is invisible.
- **M4 — cost-tracking races.** Handlers are registered unconditionally on
  every factory run, and the `show`→merge→`update` sequence is an unserialized
  read-modify-write, so overlapping `subagents:completed` events for the same
  bead are last-write-wins and lose a contribution.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Scope | All six: H2, H3, M2, M3, M4, M1. |
| Q2 | `beads_create_list` contract under M1 | Exact contract preserved: direct children, plan-order `t1..tN`, unchanged return shape. `bd batch` (no `--parent`/`--silent`) is rejected; `bd create --graph` is a possible follow-up, not this run. |
| Q3 | Prefix discovery (H2) | Hybrid (option C): try `bd where` (`nativePrefixOf`) for every repo; fall back to a longest-common-prefix sampler when it fails. |
| Q4 | Prefix matching | `dirForPrefix` does longest-known-prefix matching over `prefixToDir`; no truncation anywhere. |
| Q5 | M1 mechanism | Keep per-task creates; wire all gate/chain edges in one `bd dep add --file <tmp.jsonl>` call (`N+3` bd calls), replacing the `bd link` loop. (`bd create --deps 'blocks:id'` makes the *new* issue the blocker of `id` — the reverse of the required direction — so it is unusable here.) |
| Q6 | Target bd | 1.2.2 (what the suite pins and what the repo's tools are verified against). No silent fallback paths for unsupported flags. |

## Behavior contract

### 1. Topology and prefix resolution (H2, Q3, Q4)

`resolveTopology` discovers each repo's prefix in this order:

1. `nativePrefixOf(dir)` — `bd where` in that repo directory, parse
   `^\s*prefix:\s*(\S+)`. Used for the umbrella **and** every additional repo.
2. `samplePrefixOf(dir)` — only when `bd where` yields nothing. The fallback
   samples up to 5 ids (`bd list --all -n 5 --json`) and returns their
   **longest common prefix ending at a hyphen boundary**. For a single id it
   strips a trailing `.N` step suffix and any `-mol-…` segment, then takes
   everything before the last hyphen. This yields `crmback` from
   `crmback-1a2`, `pi-packages` from `pi-packages-n4m5`, and `pi-packages` from
   `pi-packages-mol-1zth.2`.

`dirForPrefix(id)` matches against the known prefixes with the **longest** key
`k` such that `id === k || id.startsWith(k + "-")`; no key matches → `null`
(unchanged error behavior for genuinely unknown ids).

`prefixToDir` keys are always the real prefixes (e.g. `pi-packages`), so the
umbrella's native prefix and additional-repo prefixes line up with incoming ids.

### 2. Create-target safety (H3)

`resolveCreateTarget` becomes explicit about the two cases:

- `repo` omitted → `defaultRepoDir` (unchanged).
- `repo` supplied but unresolved → an error result; **no create is attempted**.
  The message mirrors the read tools:
  `unknown repo '<x>' (known: <basenames/prefixes>)`.

Applies to `beads_create` and `beads_mol_pour`.

### 3. `beads_create_list`: durability and batching (M2, M1, Q2, Q5)

- **Durability:** any return path that has already minted beads calls
  `await afterWrite(repoDir)` first — the human-gate-setup failure path and the
  partial-task-failure path included.
- **Batching:** after all creates, write every edge to a temp JSONL file
  (`{"from":<dependent>,"to":<blocker>,"type":"blocks"}`) and issue one
  `bd dep add --file <path>` call. Direction is the verified-correct one:
  `from` = dependent, `to` = blocker (same as `bd dep add D C` → D depends on C).
  Edges are: each task depends on the gate; task *i* depends on task *i−1*. The
  `bd link` loop is removed. bd invocations drop from ~`3N+2` to `N+3`.
  (`bd create --deps 'blocks:id'` is NOT usable: it makes the new issue the
  blocker of `id`, inverting the graph — empirically verified on bd 1.2.2.)
- **Contract:** creates keep `--parent <parent> --silent`; ids are still
  real `parent.N` children emitted in plan order; the return string is
  unchanged (`gate:`/`human-gate:`/`t1:..tN:`).
- **Failure:** a task create that fails returns the existing partial-failure
  report (after `afterWrite`), not a silent fallback; a failed bulk dep call is
  surfaced after `afterWrite`.

### 4. `beads_close` cascade (M3)

The cascade still runs. A non-zero parent close is captured as a surfaced
failure detail (parent id + `bd` stderr) while the successfully closed ids are
still returned. An already-closed parent is success, not an error.

### 5. Cost-tracking serialization (M4)

- `subagents:completed` / `subagents:failed` handlers are registered **once**
  at module scope behind a guard, not per factory run.
- The `show`→merge→`update` sequence for a given bead is serialized through a
  module-level `Map<beadId, Promise<void>>` chain; different beads still run
  concurrently.
- `getBeadsRuntime()` remains read at event time, so the process-global
  runtime assignment stays harmless.

## Testing

All tests use the existing fixture `bd` stub (subprocess-boundary double).

- **Prefix routing:** dashed native prefix in *both* single-repo and umbrella
  modes; `bd where` returning a prefix for an additional repo (hybrid path); a
  `bd where`-fails case exercising the sampler fallback.
- **create_list:** assert **zero `link`/`--deps` invocations**, assert the bulk
  `bd dep add --file` call's JSONL edge set (from/to/type direction), and assert
  `afterWrite`/`export` on the partial-failure and human-gate-setup-failure
  paths; assert ids/return shape unchanged.
- **close:** cascade failure surfaced while successful closes are still
  reported.
- **cost-tracking:** a unit test proving two overlapping same-bead events both
  land (no lost write), and that two factory runs do not stack handlers.
- Existing `packages/pi-beads` suite stays green (`npm test`).

## Bounds / non-goals

- No change to tool names, parameters, or return shapes.
- No tool-surface expansion (that is `pi-packages-3iej.4`).
- No `bd create --graph` rewrite; no `bd batch`.
- No changes to `packages/pi-subagents` (upstream subtree) or
  `packages/pi-superpowers-plus`.

## Risks

- **`bd where` in a hydrated additional repo is unverified here** (the fixture
  currently models it as failing). The hybrid design contains this: the sampler
  fallback covers it, and the fixture is updated to model both outcomes.
- **`bd dep add --file` availability/version.** Available on bd 1.2.2; a
  non-zero exit is surfaced (after `afterWrite`) rather than retried. Edge
  direction is pinned by a fixture that echoes the JSONL contents.
