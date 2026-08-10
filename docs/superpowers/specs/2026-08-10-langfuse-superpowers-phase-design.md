# pi-langfuse-plus: Vendor Langfuse Extension + Superpowers Phase Metadata — Design

**Date:** 2026-08-10
**Status:** Approved (brainstorming)

## Goal

Bring the [gooyoung/pi-langfuse](https://github.com/gooyoung/pi-langfuse)
observability extension into this monorepo as a self-contained package, and
extend it the same way the bifrost extension was extended: subscribe to the
`superpowers:phase` event bus, retain the current phase in memory, and pass it
as Langfuse metadata whenever the extension passes git metadata.

## Background / Context

- `pi-bifrost` already shipped Superpowers phase tracking: a pure
  `applyPhaseUpdate` reducer, a `pi.events.on("superpowers:phase")` listener
  that retains the latest non-empty phase in memory, and attachment of the
  retained value at request time (`x-superpowers-phase` header). Unit-tested
  in `packages/bifrost/test/phase-tracker.test.ts`.
- The reference repo (`gooyoung/pi-langfuse`) is a complete Langfuse
  observability extension for pi (~3700 lines TS): one trace per run, root
  `agent` observation, per-request `generation` and per-tool `tool`
  observations, privacy presets, redaction, capabilities-gated REST fallback.
- Upstream passes **git metadata** to Langfuse via `collectSourceMetadata(cwd)`
  in `src/source-metadata.ts` (keys like `git_commit`, `git_branch`,
  `repo_identity`, `source_type`, ...), which is spread into the **root agent
  observation's `metadata`** at both `startAgentRun` and `finishAgentRun` in
  `src/handlers/agent.ts`, through `applyCapturePolicy`.
- The monorepo packages are self-contained under `packages/<name>/` with their
  own `package.json`, scripts, and tests (AGENTS.md). No git submodules, no
  committed lockfiles.

**Fork provenance (for future re-sync):**
> Forked from `gooyoung/pi-langfuse` @ `c79c527a7294e1d4b8153525d5218e87354cbcb1`
> (tag `v1.5.12`, dated 2026-08-10). Re-sync later by diffing
> `packages/langfuse/` against that commit (`git diff <commit> -- packages/langfuse`).

## Requirements

1. **Vendor** `pi-langfuse` into the monorepo as a self-contained package under
   `packages/langfuse/`, trimmed to the extension essentials (see Section 1).
2. **Package identity:** name `pi-langfuse-plus`, fresh version `0.1.0`, repo
   pointing at this monorepo — distinct from the published `pi-langfuse`.
3. **Listen** on the `superpowers:phase` event (`pi.events.on`), reading the
   `phase` string off the payload, same shape as bifrost.
4. **Retain** the phase in memory; non-empty strings retained verbatim;
   `""` / `null` / `undefined` / whitespace clears.
5. **Pass as metadata** when git metadata is passed, under the key
   `superpowers_phase`:
   - Root agent observation (trace-level) metadata — at `startAgentRun` and
     `finishAgentRun`.
   - Each `generation` observation — at `startGeneration`
     (`before_provider_request`), read live at request time.
6. When no phase is retained, the `superpowers_phase` key is simply **absent**
   (no stale/empty value sent).
7. Phase tracking logic factored into a **pure, testable utility**.
8. All upstream tests kept; new tests for the phase reducer/helper.

## Design

### 1. Package layout & vendoring

`packages/langfuse/` — trimmed vendored copy of upstream `c79c527` (v1.5.12):

```
packages/langfuse/
├── index.ts               # upstream entry, + phase listener (Design 2)
├── src/                   # full upstream src/ tree, + NEW src/phase.ts
│   ├── handlers/{agent,generation,tool,turn}.ts
│   ├── capture-policy.ts, commands.ts, config.ts, constants.ts,
│   │   langfuse.ts, limits.ts, observation.ts, redaction.ts,
│   │   source-metadata.ts, state.ts, types.ts, utils.ts
├── types/                 # upstream .d.ts shims (pi-coding-agent, node, langfuse)
├── test/                  # all upstream tests unchanged + NEW phase-tracker.test.ts
├── package.json           # renamed, deps kept, tooling aligned
├── tsconfig.json
└── README.md              # NEW concise README, pins upstream commit
```

Trimmed out of the vendored copy (not needed in this personal monorepo):
`README_CN.md`, `DEPLOY.md`, `DEVELOPMENT.md`(+CN), `.agents/skills/`,
`.github/workflows/publish.yml`, `image.png`, `skills-lock.json`.

**package.json changes from upstream:**
- `name: "pi-langfuse-plus"`, `version: "0.1.0"`.
- `repository` → `johnstegeman/pi-packages`.
- Keep `dependencies` unchanged (`@langfuse/client`, `@langfuse/otel`,
  `@langfuse/tracing`, `@opentelemetry/api`, `@opentelemetry/context-async-hooks`,
  `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace-base`) and the
  `peerDependencies` on `@earendil-works/pi-coding-agent`. This is the first
  monorepo package with real runtime deps; testing requires
  `cd packages/langfuse && npm install` first (no lockfile committed, per repo
  convention).
- `test` script → `node --import tsx --test test/*.test.ts` (repo convention);
  devDeps from upstream (`tsx`, `typescript`) plus `@types/node`.
- `pi.extensions: ["./index.ts"]` (unchanged from upstream).

**Registration / docs:**
- Root `package.json` → add `"./packages/langfuse/index.ts"` to `pi.extensions`.
- Root `README.md` and `AGENTS.md` package lists → add the langfuse row.
- New `packages/langfuse/README.md` → setup (env vars + `/langfuse-setup`),
  privacy presets, phase-metadata behavior, install path, and the pinned
  upstream commit with re-sync instructions.

### 2. Phase tracking (bifrost pattern)

New `src/phase.ts`:

```ts
export function applyPhaseUpdate(
  _current: string | null,
  incoming: string | null | undefined,
): string | null {
  return incoming && incoming.trim() !== "" ? incoming : null;
}

let retainedPhase: string | null = null;

export function setPhase(incoming: string | null | undefined): void {
  retainedPhase = applyPhaseUpdate(retainedPhase, incoming);
}

// Live read at metadata-attach time. Returns a fragment to spread
// into observation metadata: { superpowers_phase: <phase> } or {}.
export function buildPhaseMetadata(): Record<string, string> {
  return retainedPhase ? { superpowers_phase: retainedPhase } : {};
}
```

Semantics (identical to bifrost):
- Non-empty incoming string → retained (verbatim; `.trim()` used only for the
  emptiness check).
- `null` / `undefined` / `""` / whitespace-only → `null` (clear).
- `_current` accepted but intentionally unused today (same as bifrost); kept for
  future semantics without a breaking caller change.
- **Single module-global in-memory value**, not per-session: the
  `superpowers:phase` event carries no session id, and one run is active at a
  time. langfuse's per-session `state` is untouched.

Event listener in `index.ts` (bifrost's type-safe guard):

```ts
pi.events.on("superpowers:phase", (data) => {
  setPhase(
    typeof data === "object" && data !== null && "phase" in data
      ? (data as { phase: unknown }).phase
      : null,
  );
});
```

### 3. Metadata attachment

`buildPhaseMetadata()` is spread wherever git metadata goes, through
`applyCapturePolicy` (so it obeys the same privacy presets and string
coercion).

1. **Root agent observation (trace-level)** — `src/handlers/agent.ts`:
   - `startAgentRun`:
     `metadata: { cwd, ...sourceMetadata, ...buildPhaseMetadata(), model, provider, sessionId }`
   - `finishAgentRun`:
     `metadata: { cwd, ...sourceMetadata, ...buildPhaseMetadata(), completed, model, provider, totalTools, ...scores }`
2. **Generation observations** — `src/handlers/generation.ts`,
   `startGeneration` (`before_provider_request`, where the `generation`
   observation is created). Phase is read **live at request start**, so a run
   spanning phases (e.g. brainstorming → development) records, on each
   generation, the phase active when that request was made.

When no phase is retained → `buildPhaseMetadata()` returns `{}` → the key is
absent; no stale/empty value sent (mirrors bifrost's "header omitted when no
phase").

### Data flow

```
set_phase tool (Superpowers)
  └─ emit("superpowers:phase", { phase })
       └─ index.ts listener ──setPhase/applyPhaseUpdate──▶ module-global retainedPhase
                                                            │ live read via buildPhaseMetadata()
  before_agent_start / startAgentRun ──────────────────────► root metadata.superpowers_phase
               agent_end / finishAgentRun ─────────────────► root metadata.superpowers_phase
       before_provider_request / startGeneration ──────────► generation metadata.superpowers_phase
```

### Error handling

- Malformed/empty payload → `data?.phase` is `undefined` → `setPhase(null)` →
  reducer clears.
- No new error paths: listener and `buildPhaseMetadata()` are synchronous and
  exception-free.
- Cleared mid-run → subsequent attach points omit the key; already-uploaded
  observations keep the value captured at their own attach time.

### Testing

- Keep all 13 upstream test files untouched (they characterize vendored
  behavior we did not change).
- New `packages/langfuse/test/phase-tracker.test.ts` (repo's `node:test` +
  `node:assert/strict` pattern), testing `src/phase.ts`:
  - non-empty string retained: `applyPhaseUpdate(null, "brainstorming")` → `"brainstorming"`
  - empty string clears: `applyPhaseUpdate("brainstorming", "")` → `null`
  - `null` clears: `applyPhaseUpdate("brainstorming", null)` → `null`
  - `undefined` clears: `applyPhaseUpdate("brainstorming", undefined)` → `null`
  - whitespace-only clears: `applyPhaseUpdate("brainstorming", "  ")` → `null`
  - new value replaces: `applyPhaseUpdate("old", "new")` → `"new"`
  - `buildPhaseMetadata()` returns `{ superpowers_phase }` when retained and
    `{}` when cleared.
- Metadata wiring stays inline in the handlers (mirrors the repo's existing
  inline-hook pattern, e.g. bifrost's `x-pi-session`).

### Verification

1. Vendor the trimmed copy as-is; `cd packages/langfuse && npm install &&
   npm test` to establish the green baseline.
2. Apply Design 2/3 changes; run the suite again + `tsc --noEmit` typecheck.
3. Sanity-check root `package.json` registration.

## Files Changed

- `packages/langfuse/**` — vendored from upstream `c79c527`, trimmed; modified
  `index.ts`, `src/handlers/agent.ts`, `src/handlers/generation.ts`.
- `packages/langfuse/src/phase.ts` — new phase-tracking module.
- `packages/langfuse/test/phase-tracker.test.ts` — new tests.
- `packages/langfuse/package.json`, `packages/langfuse/README.md` — fork
  identity + docs.
- Root `package.json`, `README.md`, `AGENTS.md` — registration + package list.

## Out of Scope

- Persistence of the retained phase (memory only, per requirement).
- Phase metadata on `turn` / `tool` observations (root + generation only, per
  approved decision).
- Any behavior change to upstream extension features (privacy, redaction,
  commands, fallback ingestion) other than adding the phase metadata.
- Changes to the `set_phase` emitter or any other package.
