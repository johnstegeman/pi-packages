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
`exposure` / `namespace` / `outputSchema` / `structuredOutput` — all of which landed in
0.99.0, the same release that added `codemode`. There is no intermediate version to pin.

The port is:

- **devDependencies** at `0.99.1`; **peer ranges** at `>=0.99.0`.
- **`src/mention-clone.ts`** adapted to the split extension context and the read-only
  agent system prompt (see the file's own comments).
- **Test harness** adapted to the provider-facing `TranscriptContext` introduced in
  0.86.0: a faux responder now reads tools and prompt through `getCurrentTools()` /
  `getCurrentSystemPrompt()` instead of the removed `Context.tools` /
  `Context.systemPrompt` fields.
- **`test/e2e/usage-reaches-session-stats.e2e.test.ts`** updated for pi's
  projection-based context-usage estimate.

This divergence carries **no** `LOCAL PATCH` markers. We own the file outright, so the
port is simply the state of our copy — not a patch applied on top of somebody else's.

### Known gap in the port: the mention clone's transcript seeding

`src/mention-clone.ts` seeds its throwaway session by writing to
`session.agent.state.messages` (the conversation) and to the leading transcript
system message (the live prompt). Both writes are **discarded** at 0.99.1: since
0.87.0 the `SessionManager` is canonical for an `AgentSession`'s provider context,
and the session refreshes `state.messages` from its own projection before the turn.
A spawned mention therefore runs with no conversation and the prompt rebuilt from
cwd/agentDir — the opposite of what the module exists to do.

The two typecheck errors this file raised are fixed (the field is read-only, and the
tool context was split), and the writes are still expressed through the supported
transcript shape — but making them *take effect* needs the clone to seed through the
`SessionManager` (and to carry the parent's prompt via the loader or
`before_agent_start`) rather than by mutating agent state. That is a behaviour-affecting
redesign, not a mechanical port, and it is deliberately not attempted here; no test
covers it today.


## In-code marker convention

Later divergences — the code-mode exposure/namespace/outputSchema changes from Tasks 6
and 7 — **are** marked, because they are small, surgical edits a future reader could
otherwise mistake for upstream behaviour:

```ts
// LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md
```

Every changed line of such a divergence is bracketed by that comment, and the delta is
recorded in this file under its own heading. Do not reformat, rename, or "tidy"
neighbouring upstream code while marking one.
