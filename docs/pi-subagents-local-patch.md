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

### The mention clone's transcript seeding

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

Covered now by `test/mention-clone.test.ts` (reads the projection the session
hands the provider, not the module's own writes) and
`test/e2e/mention-clone-seeding.e2e.test.ts` (a real `AgentSession` driven
through a faux provider, asserting on the transcript the provider was actually
handed).


## In-code marker convention

Divergences 3 and 4 — the code-mode exposure/namespace/outputSchema changes from Tasks 6
and 7 — **are** marked, because they are small, surgical edits a future reader could
otherwise mistake for upstream behaviour:

```ts
// LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md
```

Every changed line of such a divergence is bracketed by that comment, and the delta is
recorded in this file under its own heading. Do not reformat, rename, or "tidy"
neighbouring upstream code while marking one.
