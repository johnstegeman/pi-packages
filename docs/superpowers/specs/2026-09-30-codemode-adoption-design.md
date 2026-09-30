# pi-packages code-mode adoption (stage A) — Design

- **Date:** 2026-09-30
- **Issue:** `pi-packages-mol-0ggz` (brainstorming molecule, topic "Adopt pi code mode across pi-packages")
- **Packages:** new `packages/codemode-bootstrap`, `packages/pi-beads`, `packages/pi-subagents`
- **Verified against:** pi 0.99.1 (`@earendil-works/pi-coding-agent` 0.99.1), `bd` 1.3.0

## Context

pi 0.99 introduced code mode: the built-in `codemode` extension lets the model run
JavaScript in a QuickJS sandbox that calls other tools through `tools.<name>(args)`, and
it introduced tool-exposure metadata — `exposure` (`direct` | `model-only` | `codemode` |
`deferred` | `hidden`), `namespace`, `outputSchema`/`structuredContent`, `annotations`,
`prepareLoadout()` and `ctx.executeTool()`.

pi-packages registers **31 tools and uses none of it**. Every tool is `direct`, so every
declaration ships in the model's prompt in every session:

| Package | Tools | Notes |
|---|---|---|
| `pi-beads` | 23 | all return text via `textResult(...)`; descriptions 59–504 chars plus parameter schemas |
| `pi-subagents` | 4 | `Agent`, `SubagentWorkflow`, `get_subagent_result`, `steer_subagent` |
| `hashline-edit` | 3 | overrides the built-in `read`/`edit`/`grep` |
| `pi-superpowers-plus` | 1 | `set_phase` |

Two prior specs establish the motivation and the measurement method:

- `2026-09-14-pi-beads-tool-surface-design.md` — "The package is deliberately
  context-lean; tool schemas cost every session."
- `2026-09-11-tool-description-mode-compact-design.md` — measures `SubagentWorkflow`'s
  description at **19,527 chars (~4.9k tokens)**, states it is **fixed upstream and not
  reducible by `toolDescriptionMode`**, and measures `Agent` prose at 4,562 chars full /
  985 chars compact. Code mode is the only available lever for the fixed 4.9k chunk.

`codemode` is not currently enabled in `~/.pi/agent/settings.json` (no `defaultTools`).

## Goal

Cut the per-session tool-declaration payload pi-packages ships, by making code mode the
way the model reaches the `pi-beads` and `pi-subagents` tools — and make code mode
on-by-default for the user's sessions and subagents.

## Staging

- **Stage A (this spec):** `codemode.mode: "on"`. Built-ins and the tools left `direct`
  behave exactly as today; the moved tools are reached through `codemode` scripts.
- **Stage B (out of scope):** `codemode.mode: "only"`, where pi hides *all* active
  built-in and extension tools from the model. Re-evaluated once A is in daily use.

## Decisions (from brainstorming)

1. **Staged** — ship A, evaluate B later.
2. **No non-codemode fallback required.** A tool may be unreachable when `codemode` is
   off (`-builtin:codemode`, `--no-extensions`, an SDK session, a subagent that does not
   inherit it). This was chosen deliberately over a dynamic-exposure design.
3. **The packages self-guarantee codemode.** No reliance on out-of-repo
   `settings.json`. Subagent sessions get it through a pi-subagents patch.
4. **Scope:** all 23 `pi-beads` tools, and 3 of the 4 `pi-subagents` tools (`Agent`
   excepted, per decision 6). `hashline-edit` and `set_phase` stay `direct` —
   hashline-edit *is* the model's file I/O path, and hiding it would be stage B for file
   operations by another name.
5. **`outputSchema`/`structuredContent` are in scope**, on the read tools.
6. **`Agent` stays `direct`.** Its description is not merely a schema: it carries
   behavioural guidance (background-by-default, never fabricate a pending agent's results,
   trust-but-verify). Keeping it `direct` preserves that prose.
7. **Verification:** functional assertions in CI plus one recorded measurement — no
   byte-count assertion.
8. **Approach 2:** pi-subagents carries a **permanent local divergence**; no upstream PR.

## Architecture

### 1. Activation — top level: new `packages/codemode-bootstrap`

A small extension, registered in the root `package.json` under `pi.extensions`.

- On `session_start`: if `codemode` is registered and not in `pi.getActiveTools()`, call
  `pi.setActiveTools([...pi.getActiveTools(), "codemode"])`.
- **Adds only.** Never removes or reorders any other tool. Idempotent.
- Degrades to a no-op where the tool APIs are unavailable. pi-subagents already guards
  this exact case (`packages/pi-subagents/src/index.ts:2644` notes that
  `getAllTools`/`setActiveTools` are unavailable in some hosts, e.g. print mode); the
  activator uses the same guard.

### 2. Activation — subagent sessions: pi-subagents patch

`packages/pi-subagents/src/agent-runner.ts:747` builds a `DefaultResourceLoader` for every
subagent session with **no** codemode factory, and the SDK docs are explicit that SDK
sessions do not load codemode by default.

Preferred patch (**pending spike R1**), which avoids importing anything and therefore
avoids the dependency bump described below — `additionalExtensionPaths` accepts
`"builtin:<name>"`:

```ts
// agent-runner.ts:727
const additionalExtensionPaths = [...(extensionsSpec?.paths ?? []), "builtin:codemode"];
```

Fallback patch if R1 fails:

```ts
// agent-runner.ts:747
extensionFactories: [createCodemodeExtension()],
```

Either way, `createCodemodeExtension`/`builtin:codemode` registers `codemode`
**inactive**, so activation must come from `installExtensionToolScope`'s `renarrow()`
(`agent-runner.ts:280`), which sets the active set to `session.getAllTools() ∩ inScope()`.
That includes `codemode` because it is registered by an extension — **except** when the
agent's `extensions:` uses `ext:` selectors, where `inScope()`'s `optInActive` branch
(`agent-runner.ts:258`) admits only *named* extensions and an inline builtin extension may
match no canonical name. Mitigation: add `"codemode"` to `readmitToolNames` at the
`installExtensionToolScope` call site (`agent-runner.ts:1035`), the mechanism already used
to re-admit nested tools.

`noExtensions`/`isolated` subagents skip `installExtensionToolScope` entirely and get no
codemode. Accepted: they also load no extension tools, so they could never reach
`beads_*` regardless.

No `BUILTIN_TOOL_NAMES` change is needed — the `denyTools` loop
(`agent-runner.ts:942`) denies only names in that list, and `codemode` is not one.

#### 2.1 Dependency bump — only if the fallback patch is needed

`packages/pi-subagents/package.json` pins `@earendil-works/*` at **0.84.2** in
`devDependencies`; `createCodemodeExtension` does not exist before 0.99.0. The fallback
patch therefore forces: bump the three `@earendil-works/*` devDeps to `0.99.1`, regenerate
`package-lock.json`, and raise the peer range from `>=0.84.0` to `>=0.99.0`. The preferred
patch avoids all of this, which is why R1 is retired first.

### 3. Tool surfaces

#### pi-beads — all 23 tools leave `direct`

Namespace: `{ name: "beads", description: "Beads issue tracker — umbrella aggregate across all repos" }`.

The split is not by importance: pi's `selectCatalog` fills the `codemode.inlineBudget`
(3000 estimated tokens) **cheapest-declaration-first**, not most-important-first. So
`deferred` is the correct lever for "rare, do not spend budget on this", which frees
budget for the hot path.

| Exposure | Tools | Count |
|---|---|---|
| `codemode` | `ready`, `list`, `show`, `deps`, `create`, `create_list`, `update`, `close`, `comment`, `comments`, `dep`, `undep` | 12 |
| `deferred` | `reopen`, `promote`, `gate_create`, `gate_resolve`, `mol_pour`, `mol_show`, `mol_current`, `mol_ready`, `memories`, `stale`, `lint` | 11 |

`deferred` tools are excluded from the codemode listing
(`selectCatalog` filters `entry.deferred`) but remain discoverable through
`searchTools(query, { limit, namespace })` and `ALL_TOOLS` inside a script — BM25 indexes
their description and parameters. They appear in the listing only as a namespace heading
with a tool count.

#### pi-beads — `outputSchema` + `structuredContent` on reads

Applies to `ready`, `list`, `show`, `deps`, `comments`, `mol_show`, `mol_current`,
`mol_ready`, `stale`, `lint`, `memories`. These tools already parse `bd --json`
internally (`stripTemplates`, `fmtRows`, `fmtShow`, `fmtComments`, `fmtMemories`), so
`structuredContent` re-exports the existing parse rather than adding a second one.

`content` keeps today's compact text unchanged, so a tool activated explicitly still
renders exactly as it does now.

#### pi-subagents

- `Agent` → **stays `direct`** (decision 6).
- `SubagentWorkflow` → `deferred`; its ~19.5k chars / ~4.9k tokens leave the declarations
  entirely.
- `get_subagent_result`, `steer_subagent` → `codemode`.
- Namespace: `{ name: "subagents", description: "Subagent dispatch and workflow orchestration" }`.
- `outputSchema` on `get_subagent_result` → `{ status, result?, error?, agentId? }`.

### 4. What stays declared, and the cost side of the ledger

`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, hashline-edit's `read`/`edit`/`grep`,
`Agent`, `set_phase` and `codemode` itself all remain declared.

While `codemode` is active in `mode: "on"`, **every** declared callable tool has its
description replaced by `renderToolSample(toCodemodeDeclaration(tool))`, which *keeps* the
original description and appends:

````text
codemode tool declaration:
```ts
declare const tools: { ... };
```
````

So the net saving is **26 declarations out, minus an appended signature on every
remaining declared tool** (roughly a dozen, depending on `defaultTools` and whether
hashline-edit's opt-in `grep` is enabled). For a tool with a rich parameter schema such
as `Agent` that block is not small. The direction is expected to be a clear win; the
magnitude is not asserted until measured (R4).

### 5. Deliberately not doing

- **Not enabling `tool_search`.** In-script `searchTools()` / `ALL_TOOLS` is the discovery
  path; `tool_search` is a second model-facing search that would add a declaration for no
  extra capability.
- **Not changing `codemode.mode`** — stays `"on"` (pi default), which is what keeps A
  staged.
- **Not raising `codemode.inlineBudget`** — a global knob; raising it re-spends the tokens
  A exists to save, and cannot distinguish these packages from MCP servers drawing on the
  same budget.

## Divergence policy and guardrail

pi-subagents is a squashed git subtree (`b10e000`) with no local non-merge commits and no
patch mechanism; `scripts/sync/sync-subtree.sh` fails loudly on conflict
("Manual resolution required"). This design accepts a permanent divergence anyway.

1. Smallest possible footprint. Every changed line bracketed by
   `// LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md`.
2. New `docs/pi-subagents-local-patch.md` recording the exact delta and why.
3. A **root-level** check, `scripts/ci/check-pi-subagents-patch.mjs`, living outside the
   subtree so a sync cannot wipe it, asserting the local delta is still present. Wired
   into root `npm test` and CI, in the spirit of the existing dep-mirror check. This turns
   a sync that silently drops the patch into a CI failure instead of a quiet regression.
4. A note on the pi-subagents entry in `AGENTS.md`.

## Verification

Chosen shape: functional assertions in CI, one recorded measurement, no byte-count
assertion.

- **Reachability tests (per package gate).** `pi-beads` and `pi-subagents` export their
  exposure/namespace table as data; a table-driven test asserts all 23 + 4 tools carry the
  expected `exposure` and `namespace`, that the read tools carry an `outputSchema`, and
  that no moved tool is left `direct`. This is the assertion that pins the actual claim.
- **Activator tests.** Adds `codemode` when registered and absent; idempotent; adds
  nothing else; no-ops cleanly when `getActiveTools`/`setActiveTools` throw.
- **Root guardrail check** as above.
- **Recorded measurement.** Before/after assembled declaration payload using the chars/4
  heuristic — the same method and caveat as the `tool-description-mode-compact` spec —
  recorded here as an estimate, not asserted.
- **Manual end-to-end.** One session performing a beads read and write entirely through a
  codemode script, an `Agent` dispatch plus `get_subagent_result`, and a **subagent**
  reaching a beads tool through codemode. Transcript evidence recorded.
- **Gates.** `npm test` at root, with `codemode-bootstrap` present in the inventory
  (`node scripts/ci/package-gate.mjs --list`).

## Risks, in retirement order

| # | Risk | Retire by |
|---|---|---|
| R1 | `builtin:codemode` in `additionalExtensionPaths` does not survive the loader's `ext:` filtering, forcing the larger fallback patch and the dependency bump | spike — decides patch size |
| R2 | The codemode extension is dropped for agents using `ext:` selectors and `readmitToolNames` does not rescue it | spike |
| R3 | Bumping pi-subagents devDeps 0.84.2 → 0.99.1 breaks the subtree's typecheck or tests | spike — only if R1 fails |
| R4 | The net token win is eaten by appended `declare const tools` signatures on the remaining declared tools | measurement |
| R5 | Subagents cannot reach codemode-exposed beads tools | end-to-end |
| R6 | Skills that name `beads_*` tools now require a script; `packages/pi-beads/skills/beads/SKILL.md` and the superpowers skills may need a short note | doc pass in the plan |

## Implementation order

1. Spike R1 → R2 (and R3 only if R1 fails).
2. `packages/codemode-bootstrap` package, tests, root manifest entry, gate row.
3. pi-beads exposure/namespace + `outputSchema`/`structuredContent` on reads.
4. pi-subagents local patch + root guardrail check + `docs/pi-subagents-local-patch.md`.
5. Docs: `AGENTS.md` note, skill note (R6).
6. Measurement + manual end-to-end.

## Out of scope

- `codemode.mode: "only"` (stage B).
- `hashline-edit` and `set_phase` exposure changes.
- Upstreaming the pi-subagents delta (decision 8).
- Any SDK entrypoint that would have to load codemode itself.
- Enabling `tool_search`; raising `codemode.inlineBudget`.
- The unrelated root `package.json` peerDependencies fix, tracked separately as
  `pi-packages-s77l`.
