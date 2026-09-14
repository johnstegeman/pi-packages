# Reconcile deferred items, unimplemented promises, and upstream adoption — Design

**Bead:** `pi-packages-3iej.8` (Superpowers stack remediation, task 8)
**Status:** Approved (2026-09-14)
**Molecule:** poured workflow for this topic; implement step is the plan root.

## Summary

The audit in `pi-packages-3iej` surfaced ~80 findings; the HIGH and notable
MEDIUMs were fixed across tasks 1–7. This task reconciles the long tail so
nothing is silently dropped: every deferred item gets a **durable bead** or an
**explicit won't-fix**, and no **orphan promises** remain in the CHANGELOG or
specs.

Because several referenced items were small and already scoped, this run does
both: it **implements** M27, M28, M29, and the M26 smoke assertion, and it
**reconciles** everything else (new tracking beads, duplicate-bead closures,
SDD-ledger sweep, CHANGELOG truth-up, npm-audit triage). The acceptance is met
by a single durable reconciliation-ledger bead whose disposition table is the
audit artifact.

## Provenance

- Parent epic `pi-packages-3iej` § "Reconcile deferred items & upstream
  adoption" (M26–M29, orphan CHANGELOG promises, npm audit, upstream carry).
- `docs/superpowers/specs/2026-09-10-cost-tracking-on-task-beads-design.md:135,140`
  — the promised `cost.main.*` follow-on bead that was never created, and the
  "No E2E" note.
- `packages/pi-superpowers-plus/CHANGELOG.md:83,153,222` — orphan promises.
- `.superpowers/sdd/pi-packages-mol-y4x2/progress.md` and the main-worktree
  `2026-08-10-langfuse-single-phase-tag/progress.md` — recoverable deferred
  minors.

## Scope

**In:** M26 (bead + smoke), M27 (Explore override), M28 (per-agent-type
models), M29 (sync-loop hardening tier B); reconciliation of M5/M8/M9/M20,
orphan CHANGELOG promises, npm audit, and SDD-ledger minors; related-bead
lifecycle.

**Out:** building `cost.main.*` attribution (stays with the new follow-on
bead); any edit under `packages/pi-subagents/` (upstream squashed subtree —
carry only); re-litigating the won't-fix items already recorded on `pi-packages-8cd`.

## Decisions (approved in brainstorming)

1. **Scope C** — reconciliation + implement M26/M27/M28/M29; close/update the
   related tracking beads.
2. **M26 is literal** — mint the missing `cost.main.*` follow-on bead and add
   the promised smoke assertion for the *already-shipped* subagent cost
   attribution. Do not build `cost.main.*` here.
3. **M27 ships a 6th `agent-templates/explore.md`**, copy-in like the other
   five, keeping the built-in description/toolset and fast-recon behavior, with
   **no `model:` pin** (an override without a pin inherits the session model,
   which removes the built-in haiku default).
4. **M28 reads a dedicated `subagent-models.json`**, not pi `settings.json`.
   pi's public `SettingsManager` is a typed, closed schema with no generic
   accessor, and every config-bearing package in this repo uses its own JSON
   file. Global `~/.pi/agent/subagent-models.json`, project
   `.pi/subagent-models.json` (project wins, per-key).
5. **M28 key set:** `implementer`, `task-reviewer`, `code-reviewer`,
   `verifier`, `worker`, `explore`. Unset types inherit; a per-call `model` is
   never overwritten; a frontmatter pin stays authoritative (pi-subagents
   resolves `agentConfig.model ?? params.model`).
6. **M29 tier B:** all five items. No root `package.json` script — the run
   recipe is documented.
7. **Reconciliation record shape:** one durable reconciliation-ledger bead
   (child of `pi-packages-3iej`) holding the full disposition table.
8. **SDD ledgers:** the `go6y.3` (3) and `dns3.4` (2) workspaces are gone from
   every worktree and carry only counts in their close reasons — mint one
   provenance placeholder bead per task marked content-unrecoverable. Sweep the
   recoverable `y4x2` (6) and langfuse single-phase-tag (1) minors into durable
   beads.
9. **npm audit won't-fix:** the three `pi-superpowers-plus` advisories are
   dev-only transitives pinned to the pi version the typecheck targets; recorded
   in the ledger.

## Design

### M27 — `agent-templates/explore.md`

- New copy-in template; the filename `explore` overrides pi-subagents' built-in
  `Explore` agent (custom agents resolve by filename against the built-ins).
- Frontmatter: the built-in `description`, `tools: read, bash, find, grep, ls`,
  `thinking: medium`, and a `max_turns` — **no `model:`**.
- Body: the built-in fast-recon instructions, unmodified in intent.
- README: template count 5 → 6, table row added, install command already globs
  `agent-templates/*.md`.

### M28 — per-agent-type subagent models

**Config file** `subagent-models.json`:

```json
{
  "models": {
    "implementer": "claude-sonnet-4-5",
    "task-reviewer": "claude-sonnet-4-5",
    "code-reviewer": "claude-sonnet-4-5",
    "verifier": "claude-sonnet-4-5",
    "worker": "claude-haiku-4-5",
    "explore": "claude-sonnet-4-5"
  }
}
```

The file's top-level `models` map is the config surface; any other top-level
keys are ignored.

Precedence: project `.pi/subagent-models.json` over global
`~/.pi/agent/subagent-models.json`, merged per key. Both absent → no injection.

**`extensions/subagent-models.mjs` (pure, dependency-free, testable):**

- `SUPPORTED_TYPES` — the six keys above.
- `mergeModelsConfig(globalModels, projectModels)` — per-key merge of the two
  files' `models` maps, project wins, ignores unknown/extra keys, tolerates
  `undefined`/malformed input by ignoring it (never throws).
  files' `models` maps, project wins, ignores unknown keys, tolerates
  ignores unknown/extra keys, tolerates `undefined`/malformed input by ignoring
  it (never throws).
- `modelForCall({ config, subagentType, currentModel })` — returns the model to
  inject, or `undefined`: `undefined` when the type is unconfigured, when
  `currentModel` is already set, or when the type is unknown; otherwise the
  configured model.
- `parseModelsConfig(rawText)` — JSON parse guarded; returns `{}` on malformed
  input so a bad config file can't abort a tool call.

**`extensions/subagent-models.ts` (pi wiring):**

- Read global (`getAgentDir()/subagent-models.json`) and project
  (`<cwd>/.pi/subagent-models.json`) files; project overrides global.
- `pi.on("tool_call", (event) => { … })`: return unless
  `event.toolName === "Agent"`; read `event.input.subagent_type`, lowercase it;
  set `event.input.model` in place only when `modelForCall` returns a value.
  Do not touch `model` when the caller set it. Frontmatter pins need no special
  handling (pi-subagents gives them precedence).

**`test/subagent-models.test.mjs`:** merge precedence (project over global,
per-key), selection for each supported type, unconfigured type → no injection,
pre-set `model` preserved, unknown type ignored, malformed file → `{}`, and a
fake-`pi` harness proving the `tool_call` handler mutates only `Agent` calls
with the right type.

**Docs:** README "Per-agent-type models" section (schema, precedence, the
`scopeModels` caveat — an injected model is treated as caller-supplied and may
hard-error out of scope), a `config-examples/subagent-models.json` snippet,
`package.json` `test` wiring, CHANGELOG entry.

**Interaction with M27:** because `explore.md` carries no frontmatter pin, the
M28 map's `explore` key can choose its model; an unset `explore` key inherits
the session model.

### M29 — sync-loop hardening tier B

- `scripts/ci/check-deps-mirror.mjs`:
  - Wrap `semver.intersects(rootRange, subRange)` in `try/catch`; on a throw
    print `INVALID RANGE <name>: root "<rootRange>" / subtree "<subRange>" — not
    valid semver ranges.` and set `failed = true` (gate failure, exit 1) instead
    of crashing.
  - Exit-2 message echoes the actual `NODE_PATH`:
    `process.env.NODE_PATH || '/tmp/depsmirror/node_modules'`.
- `scripts/ci/check-deps-mirror.test.mjs`:
  - `INVALID RANGE` case (root `croner: "not-a-range"`) → exit 1.
  - Exit-2 case: spawn with `env: { ...process.env, NODE_PATH: "" }` and a
    scratch cwd (no `node_modules` up-tree) → exit 2.
- `.github/workflows/ci.yml` `deps-mirror` job: `actions/cache@v4` for
  `/tmp/depsmirror` (key `depsmirror-semver7-${{ runner.os }}-v1`), install
  guarded by the cache hit; add a step that runs the `.test.mjs` files with the
  same `NODE_PATH`.
- Documented local recipe (README or AGENTS; **no** root script):

  ```bash
  npm install --no-save semver@^7 --prefix /tmp/depsmirror --silent
  bash scripts/sim/simulate-sync.sh
  NODE_PATH=/tmp/depsmirror/node_modules node scripts/ci/check-deps-mirror.mjs
  NODE_PATH=/tmp/depsmirror/node_modules node --test scripts/ci/check-deps-mirror.test.mjs
  ```

The already-landed should-fix items (sim S2 conflict `18a9375`, S3 fresh-branch
`84a0be5`, actionlint pin `1a9f382`) are verified, not re-implemented.

### M26 — smoke assertion

In `packages/pi-beads/test/cost-tracking.test.mjs`, add
`smoke: realistic subagent completion drives the shipped entrypoints
end-to-end`: call the real `piBeadsLean(pi)` + `costTracking(pi)`, fire a
payload shaped exactly as pi-subagents emits
(`{ id, type, status, description: "… bead:rep-1", usage: { input, output, cacheRead, cost: { total } } }`)
on the registered `subagents:completed` handler, and assert the full written set
(`cost.agents.<id>.*`, `cost.total`, `cost.agents.count`, `beads:changed`). Add
a contract assertion that the extension subscribes to the exact documented event
names (`subagents:completed`, `subagents:failed`).

Residual gap, kept explicit: a live-model E2E is not CI-viable; the spec's
manual QA step (one real completion) remains, and is noted on the new
`cost.main.*` follow-on bead — which this run mints but does **not** build.

### Reconciliation & bookkeeping

**Mint:** M26 `cost.main.*` follow-on (`related` to the cost-tracking spec and
`mol-go6y`); M8 upstream carry (skill preloading from package-manifest roots);
M20 `bd merge-slot`; real LSP extension; `go6y.3` and `dns3.4` provenance
placeholders (content unrecoverable); recovered-ledger sweep beads for `y4x2`
(6 minors, quoted from `progress.md`) and the langfuse single-phase-tag ledger
(1 minor).

**Reconciliation-ledger bead** (child of `pi-packages-3iej`): the single
disposition table — every item → `done-this-run` / `new bead <id>` /
`duplicate-of <id>` / `won't-fix: <reason>` (npm-audit dev-only transitives
land here). Closed when reconciled.

**Close as delivered-this-run:** `pi-packages-78y` (M27), `pi-packages-rzy`
(M28), `pi-packages-8cd` (M29) — close reason names the landing commit; each
linked to this molecule.

**Keep open, `related`-link:** `pi-packages-1fjq` ↔ `pi-packages-x33o`
(upstream carry; `packages/pi-subagents` is never hand-edited).

**CHANGELOG:** delete the `/superpowers query` future-work line; rewrite the
"Per-role model selection deferred" line to point at the shipped
`subagent-models.json` setting; add `[Unreleased]` entries for M26–M29.

## Non-goals

- Building `cost.main.*` attribution.
- Any edit under `packages/pi-subagents/`.
- A structural guard test for CHANGELOG promises (verification stays a grep
  step).
- A root `package.json` script alias.

## Testing

- `cd packages/pi-superpowers-plus && npm test` — biome plus every node:test,
  including `test/subagent-models.test.mjs`.
- `cd packages/pi-beads && npm test` — includes the new M26 smoke.
- `bash scripts/sim/simulate-sync.sh`.
- `NODE_PATH=/tmp/depsmirror/node_modules node scripts/ci/check-deps-mirror.mjs`
  and the `.test.mjs` suite (also wired into CI).

## Verification

- All suites above green.
- Manual: reload pi, dispatch a configured `subagent_type` and confirm the
  injected model is used; dispatch an unconfigured type and confirm inheritance;
  confirm a pinned/frontmatter agent is unaffected.
- README template count is 6 with the `explore` row; the two orphan CHANGELOG
  lines are gone/updated.
- **No-orphan-promises check:** grep `CHANGELOG.md` and
  `docs/superpowers/specs/**` for `not implemented`, `fast-follow`, `deferred`,
  `future work`; every hit is resolved or names a live bead. Result recorded in
  the reconciliation-ledger bead.

## Acceptance

- Every deferred item from this task has a durable bead or an explicit
  won't-fix recorded in the reconciliation-ledger bead.
- No orphan promises remain in `CHANGELOG.md` / specs.
- M26–M29 implemented as specified, with tests and docs.
- `78y`, `rzy`, `8cd` closed as delivered; `1fjq`/`x33o` linked and open.
- CI and local suites green.
