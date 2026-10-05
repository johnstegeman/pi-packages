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


## Stage B evaluation (`codemode.mode: "only"`) — 2026-10-05

- **Issue:** `pi-packages-t6wc` (spike) — molecule `pi-packages-mol-vcgf`
- **Verified against:** pi **1.0.3** (the installed binary — see Provenance), `bd` 1.3.0
- **Deliverable:** a decision, not a code change. No settings change, in this repo or the agent dir.

Stage A is shipped and in daily use, so decision 1's precondition is met: this is the
evaluation of stage B. B is a settings flip (`codemode.mode: "only"`), not a build, so the
cost is in bounding what adopting it would do — not in writing it. This section starts as
the method and is grown in place by the spike's implementation with **Findings** and
**Verdict**.

### Method

#### 1. Measurement — two real transcripts

Both sessions run from one throwaway agent dir (`PI_CODING_AGENT_DIR=<tmp>`) with identical
model, extensions and task; the only difference is `codemode.mode`.

| Side | What the model receives |
|---|---|
| `on` | the `codemode` declaration, plus every declared tool's description with the appended `describeScriptCall` note |
| `only` | the `codemode` declaration, now listing all callable tools under `inlineBudget`; direct + declared tools hidden |

Net saving = (declared payload under `on`) − (declared payload under `only`), chars/4,
reported with the same caveats that bounded the stage-A number. The saving is **reported,
not thresholded** — it is a finding, not a gate.

#### 2. Truncation — read from the `only` transcript

The mode-`only` codemode description *is* the list, so the answer is read, not modelled:
which tools appear, which namespaces carry the `" (some tools not listed)"` marker, and
whether `read` / `edit` / `bash` / `write` are present. A core tool demoted to
`searchTools()` discovery is a reliability regression no token saving justifies, so its
absence is disqualifying on its own.

#### 3. White-box cross-check — bounded, and droppable

The pi 1.0.3 binary embeds its JS bundle in readable form; `selectCatalog` and
`prepareCodemodeLoadout` were extracted from it and are the basis for this cross-check. The
harness reimplements `selectCatalog` (≈15 lines, exact) and the per-tool section-cost rule
(`ceil(section.length / 4)`), runs them over the full callable set as the real declarations
render it, and predicts both the shown set and the **order** tools fall out in — the latter a
nuance the transcript alone cannot show. The cross-check passes when the predicted shown set
equals the set actually listed in the `only` transcript. If it cannot be reconciled, the
harness is **discarded** and only the transcript facts are reported — no acceptance
criterion depends on the white-box side.

The extraction already predicts two of the gate results below — codemode is
`exposure: "model-only"` and `hiddenDeclarations` contains only `direct` tools, so codemode
cannot hide itself; and hiding lives in codemode's own `prepareLoadout`, which never runs
when the tool is absent. Those are **hypotheses to confirm**, not findings.

#### 4. Gate re-check matrix

Under `on` the nested (script) path is one of two ways to call a tool. Under `only` it is
**the only way**, so every gate that merely *also* ran there becomes the whole enforcement
surface. Gates 1–2 are behavioural — existing suites plus a mode-`only` variant — never
source-text assertions, per stage A's rule.

| # | Gate | Why `only` changes it | How re-checked | Pass criterion |
|---|---|---|---|---|
| 1 | **Tool-scope veto** (`createToolScopeVeto`, Divergence 4) | Becomes the *sole* call-time guard for every tool in every session | Existing `test/e2e/codemode-nested-scope.e2e.test.ts` **plus a mode-`only` variant** | A tool excluded by `ext:<ext>/<tool>` is refused on the nested path; an included one is allowed |
| 2 | **Registry gate** (`tools:` → `allowedToolNames`/`excludeTools`) | `hiddenDeclarations` is `direct ∧ declared ∧ callable`, so active-set narrowing now decides what is *listed* as well as callable | `agent-runner.test.ts` plus a mode-`only` case that narrows with `tools:` | An excluded tool is neither listed in the codemode description nor callable from a script; an allowed one is both |
| 3 | **codemode-bootstrap activator** | The activator must still turn codemode on when the direct tools are gone, and codemode must not hide itself | `activator.test.mjs` plus a real mode-`only` session asserting codemode is declared | codemode is active **and** declared under `only` |
| 4 | **`-builtin:codemode` / `--no-extensions` degradation** | The brick risk: if hiding were global, a session without codemode would have no tools at all | Two real sessions under `codemode.mode: "only"`: one with `-builtin:codemode`, one with `--no-extensions`; plus the registered-but-inactive sub-case | `-builtin:codemode`: `read`/`edit` still declared and callable. `--no-extensions`: no codemode tool exists, so the mode is inert and the default built-ins remain. Neither path bricks |

Gate 1's mode-`only` variant is the only *new* test artifact the spike may need. If the
existing suite already runs under the mode override, the spec records that rather than
adding a redundant test.

#### 5. Isolated trial

- **Setup:** one throwaway `PI_CODING_AGENT_DIR` with `codemode.mode: "only"` and nothing
  else; the worktree's extensions loaded with `-e` (plus `-e bifrost` for the provider, as
  stage A needed), `builtin:codemode` present. Same dir, config and task as the `on`
  session of §1, so the only difference is the mode.
- **Task:** a scratch directory, not a real file: hashline `read` a file → take its anchor →
  `edit` through a script variable → read back → one `bash` call. The point is the **anchor
  round-trip**: the line-hash `edit` consumes must survive being passed as a script variable
  rather than typed directly.
- **Bound:** one session, no writes outside the scratch dir, no repo state touched.
- **Artifacts:** the persisted session JSONL (it also feeds §1's `only` side) plus a short
  friction log — what was awkward, what the model had to look up with `searchTools()`.

#### 6. Verdict rule

- **Decided by the hard gates.** All four pass → eligible for a go. Any failure → **no-go**,
  or **go-with-mitigations** if the failure is confined and the mitigation is named.
- **The token saving is reported, never thresholded.**
- **Verdict vocabulary:** `go` / `no-go` / `go-with-mitigations`. A mitigation that is real
  work gets a follow-up bead id written into this spec, so a "go with mitigations" cannot
  quietly become a go.
- Every verdict states the version it is true of — pi 1.0.3, the binary sha256, and the
  config (`inlineBudget: 3000` default, `defaultTools` as tested). A verdict without that
  scope is not a verdict.

### How the harness is validated

- **The two sessions must differ only in the tool-declaration region.** Same agent dir,
  model, extensions and task. The diff is inspected before any number is reported; anything
  outside the declarations means the comparison is confounded and is fixed first.
- **The white-box cross-check must reconcile** with the `only` transcript's listing, or it is
  discarded.
- **Provenance is recorded** (`pi --version`, binary sha256, function byte offsets) so the
  extraction can be repeated against the same artifact.

### Risks and abort conditions

| Risk | Handling |
|---|---|
| The embedded 1.0.3 bundle differs from the published `@earendil-works` 1.0.3 package | The **binary is the source of truth** — it is what runs; offsets + sha256 recorded |
| The transcript does not expose the full declared payload | Verified on the first `on` session **before** the parser is written; stage A read a 5,016-char codemode declaration from a transcript. If it does not, the measurement is recorded as **blocked**, not estimated |
| `codemode.mode` is a session-start global a subagent session may not inherit from the isolated dir | Probed explicitly: a subagent run under the mode-`only` dir must show the hidden direct set, or gates 1–2 are reported as **unverified**, not passed |
| The trial's ergonomics read is subjective | Transcript + friction log recorded and the user weighs in; no subjective number is asserted |
| `inlineBudget` is a knob the user could change | Held at the default 3000 in the isolated dir; the finding is reported at that value, with the knob named |

**Abort condition:** if the `only` session cannot be established at all (codemode does not
load in the isolated dir), the spike reports **blocked with the reason** rather than a
guessed number.

### Provenance

Recorded 2026-10-05 against pi 1.0.3:

- `pi --version` → `1.0.3`
- binary sha256 → `8207ce945286b0f7243b7ac25ae39a1bef938c526427666089197ef29378d119`
  (`/Users/jstegeman/.local/share/mise/installs/pi/1.0.3/pi/pi`; the `pi` on `PATH` resolves
  to the same artifact — identical sha256)
- embedded-bundle byte offsets (`grep -aob`):
  - `function selectCatalog` → 73883895
  - `function prepareCodemodeLoadout` → 73887381
  - `function toCodemodeDeclaration` → 73883309
  - `function renderToolSample` → 73815214

(The exploration note recorded 73887911 for `prepareCodemodeLoadout`; that offset does not
reproduce on this binary — it lands mid-function. Use the measured 73887381.)

### Findings

#### Measurement

Two real `pi -p` sessions, same prompt, same `-e` extension set and `-nc`; the only
difference is `.pi/settings.json` (`codemode.mode`). Both are persisted under
`/tmp/codemode-stage-b/sessions-{on,only}/` (the `only` transcript is reused by §2).

| Side | Declared tools | Chars | chars/4 est. |
|---|---|---|---|
| `on` | 8 — `read`, `bash`, `edit`, `write`, `grep`, `Agent`, `set_phase`, `codemode` | 22,144 | 5,536 |
| `only` | 1 — `codemode` | 12,626 | 3,157 |
| **Net** | 7 declarations removed | **9,518** | **~2,380** |

The seven `direct`-exposure tools are hidden from the request under `only`. The
`codemode` declaration itself grows only 59 chars (12,451 → 12,510): it now lists those
tools as nested callables, but the 3,000-token `inlineBudget` caps the listing. Net saving
≈ 9,518 chars ≈ 2,380 est. tokens.

Caveats (same as stage A): `chars/4` is a heuristic, not a tokenizer; the removed side
counts each tool's description + parameter schema; the added side is the `codemode`
declaration.

**Declared-tool diff.** `toolsAdded` is the *active* set and still carries declarations
that a `prepareLoadout` hook hides from the request ("They stay active and callable, and
the transcript still declares them" — `@earendil-works/pi-coding-agent` types.d.ts), so a
raw sum over it is not the model-facing payload: it reads `on` 22,144, `only` 21,768 (net
376). The model-facing payload is the active set minus `hiddenDeclarations`, which
`prepareCodemodeLoadout` sets to `[]` under `on` and to the declared `direct` tools under
`only`. Cross-checked behaviourally: the `on` session called `read`, `edit` and `bash`
directly; the `only` session called only `codemode`. The seven hidden names come from the
`on` transcript's appended `describeScriptCall` notes, which only directly-declared tools
carry (`codemode`, being `model-only`, has none in either mode).

`Agent` is hidden like the rest but does **not** appear in the `only` codemode listing
either — it has no namespace, so its budget omission carries no `(some tools not listed)`
marker. Under `only` it is reachable only through `searchTools()`/`ALL_TOOLS`. §2 owns the
truncation read; it is flagged here because it is the discovery regression §2 warns about.

#### Truncation

The mode-`only` codemode declaration *is* the list, so this is read from the budget-3000
session, not modelled. A third session — identical except `codemode.inlineBudget: 100000`
(`/tmp/codemode-stage-b/sessions-full/`, same `-e` set and `-nc`) — lists every callable tool
with no truncation marker, and is the cost table the white-box cross-check runs over.

At the default `inlineBudget: 3000`, **17 of 21** callable tools are listed:

| Group | Listed / total | Marker | Listed |
|---|---|---|---|
| (no namespace) | 6 / 7 | none — the group has no heading | `read`, `bash`, `edit`, `write`, `grep`, `set_phase` |
| `beads` | 9 / 12 | ` (some tools not listed)` | `beads_ready`, `beads_list`, `beads_show`, `beads_deps`, `beads_close`, `beads_dep`, `beads_undep`, `beads_comment`, `beads_comments` |
| `subagents` | 2 / 2 | none | `get_subagent_result`, `steer_subagent` |

All four core tools **survive**: `read=true edit=true bash=true write=true`. `grep` and
`set_phase` survive too.

**Incompleteness is reported for namespaces only.** `beads` carries the
` (some tools not listed)` marker; `subagents` is complete. The non-namespaced group has no
`## ` heading, so a dropped non-namespaced tool carries no marker at all: `Agent` is omitted
silently and is discoverable only via `searchTools()`/`ALL_TOOLS` (still callable by literal
name). This is read from the parsed transcript and confirms the Measurement flag above.

**Dropped at 3000:** `Agent`, `beads_create`, `beads_create_list`, `beads_update`.

**Cost table** (full session; each group cheapest-first — the queue order the rule consumes):

| Group | Tool | Cost |
|---|---|---|
| — | `write` | 91 |
| — | `read` | 124 |
| — | `grep` | 159 |
| — | `set_phase` | 168 |
| — | `bash` | 171 |
| — | `edit` | 297 |
| — | `Agent` | 1154 |
| `beads` | `beads_comment` | 62 |
| `beads` | `beads_undep` | 89 |
| `beads` | `beads_comments` | 97 |
| `beads` | `beads_dep` | 117 |
| `beads` | `beads_show` | 165 |
| `beads` | `beads_deps` | 170 |
| `beads` | `beads_close` | 216 |
| `beads` | `beads_list` | 267 |
| `beads` | `beads_ready` | 275 |
| `beads` | `beads_create` | 307 |
| `beads` | `beads_update` | 333 |
| `beads` | `beads_create_list` | 360 |
| `subagents` | `steer_subagent` | 164 |
| `subagents` | `get_subagent_result` | 180 |

**Truncation order.** `selectCatalog` was re-read verbatim from the 1.0.3 binary (offset
73883895) and matches the spec's quote: sort each group's entries cheapest-first, then
round-robin across groups, taking each group's cheapest affordable entry per turn and
dropping a group permanently when its next entry no longer fits. Group order is
non-namespaced first, then namespace name (`localeCompare`). Cost is
`ceil(section.length / 4)` (`CHARS_PER_TOKEN3 = 4`); `renderToolSection` builds the section as
the heading line plus `renderToolSample(declaration).trim()`. Admission order at 3000:

`write`(91) → `beads_comment`(62) → `steer_subagent`(164) → `read`(124) →
`beads_undep`(89) → `get_subagent_result`(180) → `grep`(159) → `beads_comments`(97) →
`set_phase`(168) → `beads_dep`(117) → `bash`(171) → `beads_show`(165) → `edit`(297) →
`beads_deps`(170) → `beads_close`(216) → `beads_list`(267) → `beads_ready`(275);
then `Agent`(1154) is refused (remaining 946, non-namespaced group dropped) and
`beads_create`(307) is refused (remaining 188, `beads` group dropped).

**White-box cross-check: MATCH.** Reimplementing `selectCatalog` and the section-cost rule
over the budget-100000 costs predicts exactly the 17-tool set the budget-3000 transcript
lists — including `Agent`'s silent omission. Harness:
`cd /tmp/codemode-stage-b && node listing.mjs sessions-only sessions-full`.
#### Gate 1 — tool-scope veto under `mode: "only"`

**PASS.** The nested (script) path is the only call path under `only`, so
`createToolScopeVeto` (Divergence 4) is the whole call-time enforcement surface; it holds.

**Harness version (applies to Gates 1 and 2).** The covering command exercises
`@earendil-works/pi-coding-agent@0.99.1` — the version `packages/pi-subagents/package.json:54`
pins and the e2e harness imports — **not** the 1.0.3 binary this spec is scoped to.
The gate conclusions transfer because the equivalent 1.0.3 code paths were verified:
`prepareCodemodeLoadout` returns the same `hiddenDeclarations`, `createCodemodeDescription`
filters deferred tools out of the count, and `_executeNestedToolCall` still passes
`beforeToolCall`. Every codemode-description string quoted below is a **0.99.1** string;
1.0.3 contains neither of the quoted literals and renders `Nested tools:` with
per-namespace `(tools not listed)` markers instead.

Agent dir `/tmp/codemode-stage-b/agentdir-only/` (`{"codemode":{"mode":"only"}}`).
Covering command, run from `packages/pi-subagents`:

```sh
PI_CODING_AGENT_DIR=/tmp/codemode-stage-b/agentdir-only \
  ./node_modules/.bin/vitest run test/e2e/codemode-nested-scope.e2e.test.ts
```

**Step 3 — the pre-existing case under `only`:** `1 passed (1)` (3.15s). That run
shows the nested path still works under `only`, but it does **not** show the mode took
effect — it would pass identically under the ambient `on` — so the two mode-`only`
cases added to the same file assert that first.

**Mode took effect.** `session._hiddenDeclarations` is `["read"]` under `only` and `[]`
under `on` (`read` is the agent's declared `direct` tool). Note `session.agent.state.tools`
is the *active* set and keeps hidden declarations (`["read","probe_allowed","codemode"]` in
**both** modes), so it cannot show the mode; pi's `_getLoadout` records the hide list in
the separate `_hiddenDeclarations` field. The plan's carry-forward named `state.tools` as
the probe — that is wrong, and the added case asserts on `_hiddenDeclarations` instead
(the gate behaviour assertions are exactly as planned).

**Result, verbatim from a real QuickJS script under `only`:**

- in-scope control (`ext:` narrowing selects it) — `tools.probe_allowed({})`:
  `Script completed ... probe_allowed ran`.
- out-of-scope (`ext:ext-veto-nested.mjs/probe_allowed` excludes it) — `tools.probe_denied({})`:

```
Script failed
Wall time 0.0 seconds
Output:

Script error:
Error: Tool "probe_denied" is not available to this subagent.

Tool calls made before the failure (they are not undone): probe_denied (error)
```

An `ext:`-excluded deferred tool is refused from a script while an in-scope one runs,
under `mode: "only"`.

#### Gate 2 — registry gate (`disallowedTools`) under `mode: "only"`

**PASS.** Same file, same run, `bootSession({ disallowedTools: ["probe_denied"] })` under
the mode-`only` agent dir. Precondition as in gate 1: `_hiddenDeclarations` contains
`read`, so the run is genuinely under `only`.

**Refused from a script.** `disallowedTools` becomes `excludeTools` on the session, so
`probe_denied` is never registered; the script's `tools` object has no such method:

```
Script failed
Wall time 0.0 seconds
Output:

Script error:
TypeError: not a function
    at <anonymous> (codemode.js:1:47)

No tool calls were made.
```

**Not listed.** The mode-`only` codemode description's *inline* listing is budget-truncated
in this fixture (0.99.1 renders `Nested tools: PARTIAL - 1 of 3 shown` at the default
`inlineBudget: 3000`), and the fixture's deferred tools are omitted from it whether or not
they are excluded — so absence from the description is not discriminating here. The
description's own discovery surface is `ALL_TOOLS` (the 0.99.1 description says deferred
tools "are still available on the global `tools` object and listed in `ALL_TOOLS`"), and
that **is** discriminating. Read from a script in the same session:

| Session | `ALL_TOOLS` |
|---|---|
| `only`, base | `["read","probe_allowed","probe_denied"]` |
| `only`, `disallowedTools: ["probe_denied"]` | `["read","probe_allowed"]` |

The excluded tool is neither callable nor listed. The added case asserts both the refusal
and the `ALL_TOOLS` absence, with `probe_allowed` present as a positive control so the
absence assertion cannot pass on error text or an empty catalog.
#### Gate 3 — `codemode` is declared under `mode: "only"`

**PASS.** Read from the **existing Task 1 transcript** (`/tmp/codemode-stage-b/sessions-only/`)
— no new session:

```sh
SB=/tmp/codemode-stage-b
node "$SB/parse-tools.mjs" "$SB/sessions-on" "$SB/sessions-only" | sed -n '/^only:/,/^hidden/p'
```

```
only: file=2026-10-05T12-05-12-681Z_stage-b-only.jsonl entries=1 n=1 chars=12626 est=3157  [toolsAdded n=8, 7 hidden]
  declared: codemode
hidden by mode=only: read, bash, edit, write, grep, Agent, set_phase
```

The `only:` line's model-facing `declared:` set is exactly `codemode`. The activator turned it
on, and `prepareCodemodeLoadout` does not hide it: `hiddenDeclarations` is `direct ∧ declared`
and `codemode` is `model-only`, not `direct`. The seven `direct` tools are hidden; codemode is
not. Observed tool list: `codemode` (n=1).

#### Gate 4 — `-builtin:codemode` / `--no-extensions` degradation

**PASS — neither path bricks.** Real sessions under `codemode.mode: "only"`
(`/tmp/codemode-stage-b/proj-degraded/.pi/settings.json`). The declared list is the model-facing
set (`toolsAdded` minus the hide set); the transcript's `sections.tools` region is quoted where
it discriminates.

The plan spells the disabled-codemode case `-builtin:codemode`. That is **not a pi 1.0.3 flag**:
`pi -builtin:codemode --version` → `Error: Unknown option: -builtin:codemode`. The mechanism is
omitting `-e builtin:codemode`: codemode is a *built-in extension* (`builtInExtensions` in the
1.0.3 bundle, `builtin: true`), loaded only when discovery is on or it is named explicitly.
Gate 4a's set omits it.

**4a — codemode absent** (`-ne`, so no built-in extensions; explicit `-e` set without
`builtin:codemode`):

```sh
SB=/tmp/codemode-stage-b; WT=/Users/jstegeman/orca/workspaces/pi-packages/t6wc
cd "$SB/proj-degraded" && pi -a -nc -ne -p --session-id stage-b-nocodemode \
  --session-dir "$SB/sessions-nocodemode" \
  -e "$WT/packages/codemode-bootstrap/index.ts" -e "$WT/packages/bifrost/index.ts" \
  -e "$WT/packages/hashline-edit/src/index.ts" -e "$WT/packages/pi-beads/src/index.ts" \
  -e "$WT/packages/pi-subagents/src/index.ts" -e "$WT/packages/pi-superpowers-plus" \
  "Reply with the single word ok."
node "$SB/parse-tools.mjs" "$SB/sessions-on" "$SB/sessions-nocodemode"
```

```
only: file=2026-10-05T13-17-52-849Z_stage-b-nocodemode.jsonl entries=1 n=7 chars=9142 est=2286
  declared: read, bash, edit, write, grep, Agent, set_phase
hidden by mode=only:
```

Observed tool list: `read, bash, edit, write, grep, Agent, set_phase` — no `codemode`, and
`read`/`edit`/`bash`/`write` all present. The mode is inert without codemode: hiding lives in
codemode's own `prepareLoadout` hook, which `_applyToolLoadout` runs only for tools in the
selected set, so an absent codemode leaves the direct tools declared. Corroborated by the
transcript's model-facing `sections.tools` region — `bash`, `write`, `Agent` reappear here,
whereas under `only` with codemode present (Task 1) that region held only `codemode`.

**Callable, not just declared.** A follow-up turn in the same degraded setup (session
`stage-b-4a-callable`, `/tmp/codemode-stage-b/sessions-4a-callable/`, same `-e` set) called the
direct `read` tool and it succeeded:
`toolName=read isError=False content=[{type: text, text: "1#7iR:alpha\n2#ine:beta\n3#ngS:gamma\n4#UO-:"}]`.

**4a control — the setup can still declare codemode.** The same `-ne` command plus
`-e builtin:codemode` and `-e codemode-bootstrap/index.ts`
(`/tmp/codemode-stage-b/sessions-4a-control/`) reproduces Task 1's `only` session exactly,
including the declaration payload:

```
only: file=2026-10-05T13-23-51-871Z_stage-b-4a-control.jsonl entries=1 n=1 chars=12626 est=3157  [toolsAdded n=8, 7 hidden]
  declared: codemode
hidden by mode=only: read, bash, edit, write, grep, Agent, set_phase
```

So 4a's codemode absence is the omitted `-e builtin:codemode`, not a broken session.

**Registered-but-inactive sub-case.** `-e builtin:codemode` *without* the bootstrap extension
(`/tmp/codemode-stage-b/sessions-registered/`) leaves codemode registered but inactive:
`toolsAdded` is `read, bash, edit, write, grep, Agent, set_phase` (no codemode) and nothing is
hidden. An inactive codemode contributes no hook, so this path does not brick either.

**4b — `--no-extensions`.** The plan's literal command (no `-e` at all) **does** write a session
before the provider failure the plan anticipated: `-ne` disables extension discovery, so
bifrost is absent and the model turn fails with
`404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-4-8"},"request_id":"req_011CfjAL9CyG52yQiQwqS7mf"}`,
but session start has already persisted `toolsAdded`.

```sh
SB=/tmp/codemode-stage-b
cd "$SB/proj-degraded" && pi -a -nc -ne -p --session-id stage-b-noext \
  --session-dir "$SB/sessions-noext" "Reply with the single word ok."
node "$SB/parse-tools.mjs" "$SB/sessions-on" "$SB/sessions-noext"
```

```
only: file=2026-10-05T13-22-43-469Z_stage-b-noext.jsonl entries=1 n=4 chars=2527 est=632
  declared: read, bash, edit, write
hidden by mode=only:
```

`toolsAdded` is exactly `read, bash, edit, write`, and the model-facing `sections.tools` region
lists all four:

```
<tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files
```

No codemode tool exists, so the mode is inert and the built-in tools (which are not extensions)
remain. The model turn's 404 does not affect the declaration read.

**Parser note (scratch, not committed).** `parse-tools.mjs` derives the mode-`only` hide set
from the `on` transcript and subtracts it only when the session actually contains `codemode` —
the hook owner. That leaves Gate 3's output unchanged and makes the degraded sessions read
correctly (an unconditional subtraction would have printed an empty `declared:` for 4a/4b,
which is the parser's artifact, not a brick).


### Verdict

Not yet reached. One of `go` / `no-go` / `go-with-mitigations`, with the evidence above, the
residual risks, and any mitigation's follow-up bead id.

### Re-verification note for the stage-A text

One stage-A claim is already suspect on 1.0.3 and is corrected here if the re-check
confirms it: "§3 pi-beads" says `selectCatalog` fills `codemode.inlineBudget`
"cheapest-declaration-first, not most-important-first". The 1.0.3 source is **round-robin
across groups, cheapest-first *within* each group** — each namespace gets a turn before any
group takes a second. Stage B's argument rests on how the budget is spent, so the sentence
is corrected with a note if the rest of the re-check holds.
