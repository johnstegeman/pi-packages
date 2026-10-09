# pi-subagents: local divergences from upstream

`packages/pi-subagents/` is a **vendored fork** of
[`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) that this repo owns
and edits directly.

There is **no upstream sync**: no `git subtree`, no nightly
`.github/workflows/sync-pi-subagents.yml`, no `bot/update-pi-subagents` branch, and no
"do not hand-edit" rule. Changes are made in-tree like any other package here, and the
package's own gate (`cd packages/pi-subagents && npm run check`) is the authority.

This file is the divergence record. It exists so a reader comparing our copy against
upstream can tell an intentional local change from an upstream one, and so the in-code
marker below has somewhere to point.

## Divergence 1 — host-provided typebox declared as peers (`686e30d`)

Upstream declares `@sinclair/typebox` and `typebox` under `dependencies`. pi provides
both to extensions itself (`HOST_PROVIDED_EXTENSION_PACKAGES`), and the root dep-mirror
gate mirrors a package's runtime dependencies into root — so upstream's shape made the
root gate demand that root also depend on packages pi supplies.

We declare them under `peerDependencies` with `"*"` instead, which is what pi's docs
require for host-provided packages. Root no longer mirrors them, and both gates are
satisfied at once.

Only `package.json` and `package-lock.json` are affected. There is no in-code marker: a
JSON manifest has nowhere to carry one, and the change is visible in the diff.

## Divergence 2 — ported to `@earendil-works/*` 0.99.1

Upstream is written against 0.84.2 and does not typecheck or pass its e2e suite against
0.99.1. This fork is ported, so that Tasks 6 and 7 of the code-mode plan can build on
`exposure` / `namespace` / `outputSchema` / `structuredContent` — all of which landed
in 0.99.0, the same release that added `codemode`. There is no intermediate version to pin.

The port is:

- **devDependencies** at `0.99.1`; **peer ranges** at `>=0.99.0`.
- **`src/mention-clone.ts`** adapted to the split extension context and the read-only
  agent system prompt (see the file's own comments).
- **`src/index.ts`** — the `Agent` tool's handler now declares its context as
  `ExtensionContext` rather than the widened `ExtensionToolContext`, which is what
  keeps the clone's `MentionAgentTool` boundary honest.
- **Test harness** adapted to the provider-facing `TranscriptContext` introduced in
  0.86.0: a faux responder now reads tools and prompt through `getCurrentTools()` /
  `getCurrentSystemPrompt()` instead of the removed `Context.tools` /
  `Context.systemPrompt` fields.
- **`test/e2e/usage-reaches-session-stats.e2e.test.ts`** updated for pi's
  projection-based context-usage estimate.

This divergence carries **no** `LOCAL PATCH` markers. We own the file outright, so the
port is simply the state of our copy — not a patch applied on top of somebody else's.

## Divergence 3 — code-mode exposure, namespace and structured output (Task 6)

The code-mode plan (`docs/superpowers/specs/2026-09-30-codemode-adoption-design.md`) moves
three of this package's four tools off `direct` exposure, so their declarations stop shipping
in every prompt. `Agent` is deliberately untouched: its description carries behavioural
guidance the model must keep seeing.

| Tool | Before | After |
|---|---|---|
| `SubagentWorkflow` | `direct` | `exposure: "deferred"` + the `subagents` namespace |
| `get_subagent_result` | `direct` | `exposure: "codemode"` + the namespace + `outputSchema` + `structuredContent` on both return paths |
| `steer_subagent` | `direct` | `exposure: "codemode"` + the namespace |
| `Agent` | `direct` | unchanged |

Files: `src/index.ts` only (the namespace constant, the exposure fields, the output schema, and
the two wrapped returns). The upstream tool implementations, descriptions and parameter
schemas are untouched.

**Consequence, not a bug:** pi auto-activates only `direct`/`model-only` tools, so these three
are *registered but not declared* in any session that has not activated them. Reaching them
without a codemode script — an SDK or print-mode session, a subagent whose loader has no
codemode — answers `Tool not found`. The design accepts that (decision 2), and this package's
own print-mode e2e suites opt the tool back in explicitly (`activateTools` in
`test/helpers/print-mode-runner.ts`) because they script direct calls. Task 7 adds the
activation path for real subagent sessions.

Covered by `test/tool-exposure.test.ts` (instantiates the real extension with a mock `pi` and
inspects the registered tool objects) and by the `structuredContent` assertion in
`test/foreground-result-retrieval.test.ts`.

`Agent` is deliberately **not** in this namespace: measured on pi 1.1.0, adding it admits `Agent`
into a `codemode.mode: "only"` listing at the price of `edit`, a core tool (`pi-packages-graey`,
closed won't-fix).

## Divergence 4 — codemode activation in subagent sessions (Task 7)

`src/agent-runner.ts` builds every subagent session's `DefaultResourceLoader`, and an
SDK-constructed loader never loads the CLI's built-in codemode extension. pi-packages ships
tools with `codemode`/`deferred` exposure, which a subagent can only reach through codemode,
so the runner now injects the factory itself and makes sure it survives the agent's own
`extensions:`/`tools:` filtering. Four edits, each bracketed by the marker:

1. **Load it** — `extensionFactories: [createCodemodeExtension()]` on the subagent loader
   (`agent-runner.ts:766`).
2. **Keep it loaded under an `extensions:` name allowlist** — the `extensionsOverride`
   predicate (`agent-runner.ts:751`) exempts `<inline:*>` entries. Inline factories are
   injected by the runner, not discovered from disk, so the disk-extension allowlist does
   not govern them. Without this, a name allowlist filtered the codemode entry out of the
   loaded set — an unnamed inline factory canonicalizes to `<inline:N>`, which no name
   matches — and no later stage could re-admit a tool that never loaded.
3. **Re-admit it into the active set** — `readmitToolNames` at the
   `installExtensionToolScope` call site gains `"codemode"`. When the agent's `tools:`
   carries any `ext:` selector, `inScope()`'s opt-in branch admits only *named*
   extensions, and codemode's canonical name can never appear in one.
4. **Enforce the scope on the nested path** — the tool-scope veto is registered as an
   extension `tool_call` handler (`createToolScopeVeto`, `agent-runner.ts`) in addition to
   the existing `session.agent.beforeToolCall` wrap. Loading codemode is what made this
   necessary: before Task 7 no subagent could run a script, so no call could bypass the
   scope. It can now, and the two existing enforcement points do not cover it:

   - `beforeToolCall` is a property on the `Agent` instance. The nested path never consults
     it — `ctx.executeTool()` reaches `AgentSession._executeNestedToolCall`, whose
     `runToolCall` is handed the session's own `_beforeToolCall`, which dispatches extension
     `tool_call` handlers and nothing else. A wrap of the property is invisible there.
   - The active set cannot bound it either. `_getCallableTools()` returns the active `direct`
     tools **plus every registered `codemode`/`deferred` tool regardless of the active set**,
     which is exactly the set a script sees. An `ext:<ext>/<tool>` narrowing (or the `ext:`
     opt-in flip) re-narrows the active set, so a deferred tool it excluded stays callable
     from a script.

   The fix re-asserts the same `inScope()` predicate at call time on that path. The factory
   runs at `loader.reload()`, before the session exists and before `inScope()` is
   computable, so it reads the predicate through a holder `installExtensionToolScope` fills
   in. Until it is filled the handler is fail-open for **direct** calls — no prompt can run
   before the scope is installed, and pi's own `beforeToolCall` dispatcher emits this handler
   for direct calls too, so blocking them would freeze every `noExtensions` session — and
   fail-**closed** for **nested** ones: a session that never installs a scope is exactly
   `noExtensions`/`isolated`, where no script should reach a tool at all. The registration
   gate (`tools:` → `allowedToolNames`) is therefore defense in depth, not the only thing
   standing between a script and an out-of-scope tool. Both paths stay covered — the
   `beforeToolCall` wrap is kept, not replaced.

   Pinned by `test/e2e/codemode-nested-scope.e2e.test.ts`, which drives a real codemode
   script (real QuickJS executor, real session) against an agent narrowed by
   `ext:ext-veto-nested.mjs/probe_allowed` and asserts the excluded deferred tool is refused
   while the in-scope one still runs. The spec's risk table records the interaction as R8.

**Rejected alternative, for the record:** `additionalExtensionPaths: ["builtin:codemode"]`
does not work. The `builtin:<name>` code is supplied by the CLI when *it* constructs the
loader; a loader we construct has no code behind the name, so the entry is silently ignored
(`docs/sdk.md:112` implies otherwise; `docs/sdk.md:116` is the accurate statement). Measured
by the plan's spike, recorded in the design spec's §2.

A fifth, comment-only edit belongs to this divergence: the `getAllTools`/`setActiveTools`
`catch` in `src/index.ts` (`:2660`) said the APIs are "unavailable in some hosts (print mode,
RPC)". That is over-conservative — a bound print-mode session exposes both — and the
corrected design spec cites the comment, so it now names the real case: a host that loads
extension definitions without ever binding a session (standalone `discoverAndLoadExtensions`),
where the throwing stubs exist only until `core.bindCore` runs.

Files: `src/agent-runner.ts`, `src/index.ts`. Covered by `test/agent-runner.test.ts`'s
"subagent codemode activation" block, which asserts on the loader's constructor options and
on the session's active tool names — not on source text — and by the tool-scope veto test in
its "agent-runner async extension tool registration" block (`:1551`; the test is at `:1713`),
which drives the veto factory through those same loader constructor options.


## Divergence 5 — the mention clone's transcript seeding (0.99.1 port fallout)

`src/mention-clone.ts` seeds its throwaway session through that session's own
`SessionManager` — canonical for an `AgentSession`'s provider context since
0.87.0 — and forces the parent's live system prompt with a `before_agent_start`
handler that returns `systemPrompt`. That is pi's documented way to force a
run's prompt: the runner turns it into `systemPromptOptions.forceSystemPrompt`,
which the request projects as the provider's leading system message. The handler
rides an inline extension on the clone's own `DefaultResourceLoader`, so it
applies to the clone and nowhere else.

The 0.99.1 port had left the seeding writing to `session.agent.state.messages`
and to the leading transcript system message. Both writes were **discarded**
before the turn — the session refreshes its provider context from the
`SessionManager` and derives the prompt from `systemPromptOptions` — so a spawned
mention ran with no conversation and a prompt rebuilt from cwd/agentDir, the
opposite of what the module exists to do. The suite stayed green because nothing
covered the seeding: the old fake session asserted on the array the module
happened to write to, which passes against a clone that seeds nothing.

Files: `src/mention-clone.ts` only. Covered by `test/mention-clone.test.ts`
(reads the projection the session hands the provider, not the module's own
writes) and `test/e2e/mention-clone-seeding.e2e.test.ts` (a real `AgentSession`
driven through a faux provider, asserting on the transcript the provider was
actually handed).

## Divergence 6 — the workflow `args` shape guard (`pi-packages-x33o`)

Upstream accepts any JSON value as a workflow's top-level `args`, a bare string included. A
caller that passes `args: '{"base":"c311606"}'` gets a string inside the realm, every `args.x`
is `undefined`, and the run dies at the return marshal with *"Cannot pass undefined across the
workflow VM boundary (at the workflow result.base)"* — an error that blames the result for an
input problem. `walk()` permitted it because it returns early for `typeof value === "string"`.

`assertWorkflowArgs` (`src/workflow/runtime.ts`, called from `runWorkflow` immediately before
`assertBoundarySafe`) rejects anything whose `typeof` is not `"object"`, plus `null`;
`undefined` still means "not provided". The worker's nested `workflow(nameOrRef, args)` gets the
same rule, because a child's `args` never crosses to the host.

Files: `src/workflow/runtime.ts`, `src/workflow/worker-source.ts`, `src/index.ts` — every
changed line is bracketed by the marker. The `src/index.ts` hunk is the tool-level pre-flight
that reports the same error synchronously, before a run is created. Covered by
`test/workflow-runtime.test.ts` (the predicate, the pre-worker rejection, the nested boundary)
and, for the tool-level pre-flight, by `test/workflow-tool.test.ts`.

## Divergence 7 — the workflow stall watchdog and `wf_` result lookup (`pi-packages-mol-mr91x`)

Upstream's workflow runtime has no liveness check: a child whose tool call never returns, or a
worker that stops emitting progress, leaves the run `running` forever while the orchestrator waits
on a result that can never arrive. The reported incident — a `sdd-final-review` run that died
silently — is that shape.

This fork adds a watchdog at two levels, plus the settings to tune it:

- **Per-child:** `WorkflowAgentEntry.timedOut` and a `"timed-out"` display state
  (`src/workflow/progress.ts`), surfaced as a distinct row and as a count in the completion
  notification (`src/workflow/task.ts`). A timed-out child is a failure, not a skip: no answer
  ever came, and the orchestrator has to be able to tell a degraded review from one the user
  dismissed.
- **Per-run:** a run that hears nothing from the worker for `runStallTimeoutMs` settles `failed`
  with *"Workflow stalled: no progress for 20m00s."* and the worker is terminated. The check is gated
  on **nothing being in flight** (`inflight.size === 0`): a worker awaiting a child is silent by
  design — it posts one `call` and then hears nothing until the answer — so judging silence while a
  child runs would cap every `agent()` at the run window and throw away the per-child (or per-call
  `agent({ stallTimeout })`) patience. Suspended while the run is `paused`, because a paused run
  makes no progress by design.
- **Configuration:** `workflowStallTimeoutSecs` (settings, default 600, `0` = off) is converted to
  the runtime's `stallTimeoutMs`, with the run window at twice the child window; a per-call
  `agent({ stallTimeout })` overrides both.

**`get_subagent_result` resolves `wf_…` ids.** Upstream's tool only knows agents, so the run id
`SubagentWorkflow` hands the model answered `Agent not found` — the run lives in the in-process
`workflowTasks` map, which no tool exposes, and the run's children are excluded from the agent
lookup. The tool now resolves an agent record first, and only falls into the `wf_` branch when the
string names no live agent — a caller-supplied agent `name` may itself begin with `wf_` — and
returns a status payload (`status`, elapsed, done/total, timed-out labels, and the result once the
run settles), or `No workflow run "…" in this session.` for an unknown id. The agent path is
unchanged — a non-`wf_` id resolves exactly as before — and there is deliberately no `wait: true`
mode for workflows. The tool `description`, `promptSnippet` and `agent_id` parameter doc all name
the new id form.

**Durable terminal state.** A tool-launched run persisted nothing: it lived only in the
in-process `workflowTasks` map, so a reload left `get_subagent_result` answering `No workflow
run …` and the outcome unrecoverable. A settled tool-launched run now appends the same
`subagents:workflow` entry the CLI-flag path already wrote — through one `appendWorkflowEntry`
helper both call — and that snapshot now carries the run `id` and the outcome text. `session_start`
rebuilds a terminal-snapshot map from those entries and `get_subagent_result` reads it for a run
the live map no longer has. It is a **parallel** map, not `workflowTasks`: a recovered run has no
control surface, journal or abort handle, and offering it to the fleet's pause/skip/retry keys or
to `resumeFromRunId` would promise a handle that does not exist. A run the transcript shows was
started but never settled — its tool result is the only trace, since the terminal entry is written
only on settle — is reported `status: unknown` / interrupted rather than the stale `running` the
in-memory map used to leave behind.

Files: `src/index.ts` (the `wf_` branch in `get_subagent_result`, the durability entry +
`session_start` rehydration, the setting applier, the stall-option wiring, the timed-out
surfacing) plus `src/workflow/{runtime,progress,task,entry,worker-source,tool-description}.ts`.
The new `get_subagent_result` branch carries the in-code marker. The watchdog hunks do not, and
neither do the durability helpers — `appendWorkflowEntry`, `rehydrateWorkflowRuns` and
`workflowRunStatusView` — nor the purely additive fields and settings rows: each is an additive
block that is the state of our copy rather than a small surgical edit a reader could mistake for
upstream, so marking every changed line would be noise (see the marker convention below).
Covered by `test/workflow-tool.test.ts`
(the `wf_` resolution, the unknown-id error, the unchanged agent path, the settled-run entry, the
`session_start` rehydration, the interrupted run),
`test/workflow-runtime.test.ts` (the per-child watchdog and run-level liveness),
`test/workflow-stall-wiring.test.ts` (setting → runtime seam),
`test/workflow-{progress,task,dialog,render}.test.ts` (the timed-out row; the `workflowEntryData`
`id`/`result` snapshot), and
`test/settings.test.ts` / `test/documented-defaults.test.ts` (the new default).

## In-code marker convention

Divergences 3 — the code-mode exposure/namespace/outputSchema changes from Task 6 — and 4 — Task 7's
codemode activation delta — **are** marked, because each is a small, surgical edit a future
reader could otherwise mistake for upstream behaviour. The marker is:

```ts
// LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md
```

Every changed line of such a divergence is bracketed by that comment, and the delta is
recorded in this file under its own heading. Do not reformat, rename, or "tidy"
neighbouring upstream code while marking one.
