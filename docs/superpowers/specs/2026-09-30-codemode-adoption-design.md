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
   `settings.json`. Subagent sessions get it through a change to our vendored pi-subagents
   copy (§2).
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
  this exact case (`packages/pi-subagents/src/index.ts:2661`): the throwing
  `getAllTools`/`setActiveTools` stubs exist only until `core.bindCore` runs, so the case
  is a host that loads extension definitions without ever binding a session — standalone
  `discoverAndLoadExtensions`, for instance. It is **not** print mode: a bound print-mode
  session exposes both APIs normally. The activator uses the same guard.

### 2. Activation — subagent sessions: vendored pi-subagents change

`packages/pi-subagents/src/agent-runner.ts` builds a `DefaultResourceLoader` for every
subagent session. Before Task 7 it passed **no** codemode factory, and the SDK docs are
explicit that SDK sessions do not load codemode by default — so no subagent could reach a
codemode- or `deferred`-exposed tool.

**Variant B, decided by the Task 1 spike and landed in Task 7.** The runner passes the
factory directly:

```ts
// agent-runner.ts:766
extensionFactories: [createCodemodeExtension()],
```

The rejected variant — `additionalExtensionPaths: [..., "builtin:codemode"]` — looked
attractive because it imports nothing, but the spike measured it: an SDK-constructed
`DefaultResourceLoader` **silently ignores a `builtin:` entry**, so codemode never loads and
the subagent never sees it. Variant B is therefore the implementation of record, and it is a
change to our vendored copy of pi-subagents (see "Vendoring and divergence record" below)
rather than an upstream patch.

**Landed in Task 7.** `createCodemodeExtension()` registers `codemode` **inactive**, so
activation comes from `installExtensionToolScope`'s eager `renarrow()` at session start
(`agent-runner.ts:285`), which sets the active set to `session.getAllTools() ∩ inScope()`.
That alone is not enough, and the spike measured why. Two independent mechanisms have to be
fixed, and Task 7 lands both (each bracketed by the `LOCAL PATCH` marker):

1. **Keep it loaded.** `extensionsOverride` (`agent-runner.ts:744-751`) filters the loaded set
   down to the agent's `extensions:` names. An inline factory has no usable canonical name —
   an unnamed entry becomes `<inline:N>` by array index — so a *name allowlist* filtered
   codemode out of the **loaded** set before `inScope()` ever ran, and `readmitToolNames`
   (which can only re-admit names already in `session.getAllTools()`) could not rescue it.
   The override now exempts `<inline:*>` entries: inline factories are injected by the runner,
   not discovered from disk, so the disk-extension allowlist does not govern them.
2. **Re-admit it into the active set.** When the agent's `tools:` carries any `ext:` selector,
   `inScope()`'s `optInActive` branch (`agent-runner.ts:263`) admits only *named* extensions,
   and codemode's canonical name can never appear in an `ext:` selector. `"codemode"` is
   therefore added to `readmitToolNames` at the `installExtensionToolScope` call site
   (`agent-runner.ts:1059`) — the same mechanism already used to re-admit nested tools.

So the spike's finding holds in the code: `readmitToolNames` is **necessary but not
sufficient**, and R1's Variant A is dead (see the risk table).

`noExtensions`/`isolated` subagents skip `installExtensionToolScope` entirely and get no
codemode. Accepted: they also load no extension tools, so they could never reach
`beads_*` regardless.

No `BUILTIN_TOOL_NAMES` change is needed — the `denyTools` loop
(`agent-runner.ts:942`) denies only names in that list, and `codemode` is not one.

#### 2.1 The `@earendil-works/*` 0.99.1 bump — landed, and what it forced

`packages/pi-subagents/package.json` pinned `@earendil-works/*` at **0.84.2** in
`devDependencies`. The bump to `0.99.1` (plus a regenerated `package-lock.json` and the peer
range raised from `>=0.84.0` to `>=0.99.0`) was needed for **two independent reasons**:

- `createCodemodeExtension` does not exist before 0.99.0, so Variant B cannot be typechecked
  without it; and
- `exposure`, `namespace` and `outputSchema` are absent from the 0.84.2 `ToolDefinition` type,
  so §3's tool-surface changes fail `tsc --noEmit` regardless of which activation variant wins.

The bump is **done**: the package carries `0.99.1` devDeps with peer ranges at `>=0.99.0`, so
both reasons are retired and Tasks 6 and 7 build on real 0.99.1 types.

**R3 fired, and this is what forced the vendoring decision.** At 0.99.1 the package did not
typecheck — 2 errors in `src/mention-clone.ts` (`ExtensionContext` vs `ExtensionToolContext`;
`agent.state.systemPrompt` now read-only) — and 17 e2e tests across 7 files failed. All 17
traced to **one** root cause, and it was not a regression: the faux-provider harness still read
the pre-0.86.0 `Context.tools` / `Context.systemPrompt`, so every responder misclassified the
parent session as a child and never emitted its tool call. There is no intermediate version to
pin — the codemode types arrived in 0.99.0, the same release whose loop changed these
behaviours. Adapting the fork therefore meant carrying a third, materially larger local
divergence on a nightly-synced subtree, which is what tipped the decision to vendor it instead
(see "Vendoring and divergence record" below).

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
- `outputSchema` on `get_subagent_result` → `{ status?, result?, error?, agentId? }` (all
  optional: the not-found path returns only `{ error }`).

**Consequence worth knowing before you read a failing suite.** pi only auto-activates
`direct`/`model-only` tools, so from this change onward the three moved tools are
*registered but not declared* in any session that has not activated them — including an SDK
or print-mode session with no codemode, which is exactly what decision 2 accepts. A model in
such a session that emits `get_subagent_result(...)` directly gets "Tool not found"; it has to
reach it from a codemode script. pi-subagents' own print-mode e2e suites script direct calls,
so they opt the tool back in explicitly (`activateTools` in `test/helpers/print-mode-runner.ts`),
which declares it exactly as it was before. That is a test-harness accommodation, not a
fallback in the extension.

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

## Vendoring and divergence record

pi-subagents is a **vendored fork** this repo owns and edits directly. It is no longer a
squashed git subtree synced nightly from upstream: the sync workflow
(`.github/workflows/sync-pi-subagents.yml`) and both sync script directories (`scripts/sync/`,
`scripts/sim/`) are deleted, no CI job references them, and there is no "do not hand-edit"
rule. The root guardrail check this section used to specify
(`scripts/ci/check-pi-subagents-patch.mjs`) was **closed as superseded** — it existed to catch a
subtree sync silently dropping our delta, and there are no syncs left to guard.

`docs/pi-subagents-local-patch.md` is the divergence record: it exists so a reader comparing our
copy against upstream can tell an intentional local change from an upstream one, and so the
in-code marker has somewhere to point. The divergences carried today:

1. **`686e30d` — host-provided typebox declared as peers.** Upstream declares
   `@sinclair/typebox` / `typebox` under `dependencies`; pi supplies both to extensions itself,
   and the root dep-mirror gate mirrors a package's runtime dependencies into root, so
   upstream's shape made root depend on packages pi provides. `package.json` and the lockfile
   only; a JSON manifest has nowhere to carry a marker.
2. **The 0.99.1 port.** devDeps at `0.99.1`, peer ranges at `>=0.99.0`, `src/mention-clone.ts`
   adapted to the split extension context and the read-only agent system prompt, the `Agent`
   handler's ctx narrowed to `ExtensionContext`, and the test harness moved to the 0.86.0
   `TranscriptContext`. Forced by the R3 outcome recorded in §2.1. This divergence carries
   **no** `LOCAL PATCH` markers: we own the file outright, so the port is the state of our copy,
   not a patch applied on top of somebody else's.
3. **The code-mode delta (this plan).** Every changed line bracketed by
   `// LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md`, with the delta
   recorded in that doc.

The marker rule survives the vendoring, with a changed purpose: it is now a **divergence marker
for a future reader comparing us to upstream**, not sync-conflict management. `AGENTS.md`
describes the package as a vendored fork we own.

## Verification

Chosen shape: functional assertions in CI, one recorded measurement, no byte-count
assertion.

- **Reachability tests (per package gate).** `pi-beads` and `pi-subagents` export their
  exposure/namespace table as data; a table-driven test asserts all 23 + 4 tools carry the
  expected `exposure` and `namespace`, that the read tools carry an `outputSchema`, and
  that no moved tool is left `direct`. This is the assertion that pins the actual claim.
- **Activator tests.** Adds `codemode` when registered and absent; idempotent; adds
  nothing else; no-ops cleanly when `getActiveTools`/`setActiveTools` throw.
- **Registration-time exposure tests (per package gate).** Each package's own suite
  instantiates the real extension with a mock `pi` and inspects the tool objects pi would
  actually receive — `pi-subagents`' `test/tool-exposure.test.ts` is the model. A
  source-text assertion cannot show what pi gets, so none is used.
- **Recorded measurement (taken 2026-10-01, at `11f2271`).** chars/4 heuristic, the same method and
  caveat as the `tool-description-mode-compact` spec; recorded as an estimate, not asserted.
  The two sides were measured at different levels of rigour, and that is stated rather than
  smoothed over.

  **Removed from every session's declarations**

  | item | chars | est. tokens | how measured |
  |---|---|---|---|
  | `pi-beads`, all 23 tools (description + parameter schema) | 13,046 | **3,262** | exact — the real registered tool objects |
  | `SubagentWorkflow` description | 19,527 | **4,881** | the repo's own prior measurement, confirmed fixed/unreducible |
  | `get_subagent_result` + `steer_subagent` descriptions | 1,183 | **~300** | exact from source; their parameter schemas are small and not counted |
  | **total** | | **~8,400** | |

  **Added**

  | item | chars | est. tokens | how measured |
  |---|---|---|---|
  | the `codemode` tool declaration | 5,016 | **1,254** | exact — from a real session transcript |
  | appended `declare const tools: {...}` sample per remaining declared tool | 380 each | **~95 each** | exact — 29 samples averaged from a real transcript |

  A top-level session declares roughly ten tools after this change (`read`, `bash`, `edit`,
  `write`, hashline-edit's `read`/`edit`/`grep`, `set_phase`, `Agent`, `codemode`), so the
  appended samples add roughly **~950** est. tokens. **Net ≈ 6,200 est. tokens per session**,
  dominated by `SubagentWorkflow` — the one item `toolDescriptionMode` provably could not
  touch. The added side scales with the number of tools left declared, so the net narrows on a
  configuration that declares many tools.

  Two caveats, stated because they bound the claim: the appended-sample figure comes from a
  subagent transcript with 30 declared tools (a top-level session declares fewer, so it is an
  average, not a per-session count), and the helper tools' parameter schemas are excluded from
  the removed side, making the net slightly conservative.
- **Manual end-to-end (taken 2026-10-01, at `11f2271`).**
  - *Top level, verified.* A real `pi -p` session with the worktree's `codemode-bootstrap` +
    `pi-beads` (plus `builtin:codemode`, and `-e` for `bifrost` because `-ne` drops the
    provider) was asked to run `return (await tools.beads_ready({ limit: 3 })).output` through
    the codemode tool. It returned real beads rows — so the activator turned codemode on and a
    `beads_*` tool was reachable through a script. The write tools share that path and were not
    exercised by mutating beads state; their exposure is pinned by the registration-time test.
  - *Subagent, verified.* Task 7's probe: a real subagent reached codemode and returned `ok`,
    corroborated by the persisted session's 30-tool `toolsAdded` list ending in `codemode`.
  - *Subagent reaching a codemode-exposed `beads_*` tool — deferred to the smoke test.* A
    subagent's own loader discovers extensions from the **installed** clone, so this cannot be
    shown from the worktree: it needs the package installed (`pi update` after the branch
    lands). The mechanism it depends on is covered above; the installed-state assertion belongs
    to the human smoke test.
  - *Scope veto, verified.* `test/e2e/codemode-nested-scope.e2e.test.ts` drives a real codemode
    script from an agent narrowed by `ext:<ext>/<tool>` and shows the excluded tool is refused —
    RED before the fix (the excluded tool executed), GREEN after.
- **Gates.** `npm test` at root, with `codemode-bootstrap` present in the inventory
  (`node scripts/ci/package-gate.mjs --list`).

## Risks, in retirement order

| # | Risk | Retire by |
|---|---|---|
| R1 | `builtin:codemode` in `additionalExtensionPaths` does not survive the loader's `ext:` filtering, forcing the larger fallback patch and the dependency bump | **failed** — the Task 1 spike measured that an SDK-built loader silently ignores the `builtin:` entry, so Variant A never loads codemode at all; Variant B chosen (§2) |
| R2 | The codemode extension is dropped for agents using `ext:` selectors and `readmitToolNames` does not rescue it | **retired by Task 7** — `readmitToolNames` is necessary but not sufficient: a name-allowlist `extensions:` dropped codemode from the *loaded* set first. Task 7 lands both fixes — the `<inline:*>` exemption in `extensionsOverride` and `"codemode"` in `readmitToolNames` (§2) — and pins them in `test/agent-runner.test.ts` |
| R3 | Bumping pi-subagents devDeps 0.84.2 → 0.99.1 breaks the typecheck or tests | **retired (fired)** — 2 typecheck errors + 17 e2e failures, one root cause; forced the vendoring decision and the port (§2.1) |
| R4 | The net token win is eaten by appended `declare const tools` signatures on the remaining declared tools | measurement |
| R5 | Subagents cannot reach codemode-exposed beads tools | end-to-end |
| R6 | Skills that name `beads_*` tools now require a script; `packages/pi-beads/skills/beads/SKILL.md` and the superpowers skills may need a short note | doc pass in the plan |
| R7 | The port leaves a behaviour silently broken that no test covers | **retired** — the port did exactly this to `src/mention-clone.ts`'s transcript seeding (both writes discarded, so a spawned mention ran with no conversation and a rebuilt prompt, while the suite stayed green on a fake that asserted the module's own writes). Fixed by `pi-packages-r6i4`; now pinned by `test/mention-clone.test.ts` and `test/e2e/mention-clone-seeding.e2e.test.ts`, which read the projection the provider is actually handed. A green suite is not evidence that a ported path still runs. |
| R8 | Loading codemode in subagents makes a nested (script) call reachable that the subagent tool scope does not gate, so a script can call a tool the agent's `ext:` narrowing excluded | **retired by the final-review fix** — the scope veto was installed only as a property patch on `session.agent.beforeToolCall`, which the nested path never consults (`ctx.executeTool()` → `_executeNestedToolCall` → the session's own `_beforeToolCall`, i.e. extension `tool_call` handlers only); and `_getCallableTools()` returns every `codemode`/`deferred` tool regardless of the active set, so re-narrowing the active set cannot bound a script either. The veto is now registered as an extension `tool_call` handler too, re-asserting the same `inScope()` predicate. Pinned by `test/e2e/codemode-nested-scope.e2e.test.ts`; recorded in `docs/pi-subagents-local-patch.md` (Divergence 4, edit 4). The pre-existing rule holds: a new activation path is a new reachability surface, and every gate the old path relied on has to be re-checked on it. |

## Implementation order

1. Spike R1 → R2. **Done:** R1 failed (Variant A never loads codemode); R2 recorded the
   allowlist hazard and was retired by Task 7's two changes (§2).
2. `packages/codemode-bootstrap` package, tests, root manifest entry, gate row.
3. pi-beads exposure/namespace + `outputSchema`/`structuredContent` on reads.
4. pi-subagents: vendor the fork, port it to 0.99.1, then the code-mode delta
   (exposure/namespace/`outputSchema`/`structuredContent`) plus
   `docs/pi-subagents-local-patch.md`. **No root guardrail check** — superseded by the
   vendoring.
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
