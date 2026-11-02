# 03 — codemode-bootstrap: feature inventory

Source: `packages/codemode-bootstrap/` (3 code files, ~31 lines of extension code).
Design doc: `docs/superpowers/specs/2026-09-30-codemode-adoption-design.md`.

## Purpose

pi (0.99+) registers its built-in `codemode` tool (a JS sandbox that calls other
tools — see the codemode tool available in this very session) **inactive** by
default: it is activated only by an MCP server with codemode exposure or via
`defaultTools`/`--tools`. This repo ships many tools with
`exposure: "codemode"`/`"deferred"` (all `pi-beads` tools, `get_subagent_result`,
`steer_subagent`, `SubagentWorkflow`) that are reachable **only** through codemode.
The extension makes every session self-guarantee codemode without user config.

## Capabilities

1. **One extension point**: `pi.on?.("session_start", activate)` — optional-chained
   so a `pi` object with no `on` still loads.
2. On `session_start`, with all calls optional-chained:
   - `pi.getAllTools?.()` → registered tool names; if `"codemode"` is not among
     them → no-op (host disabled it, e.g. `-ne`/`-ne`-style extension sets that omit
     `builtin:codemode`).
   - `pi.getActiveTools?.()` → if `"codemode"` already active → no-op (idempotent,
     including across repeated `session_start`).
   - `pi.setActiveTools?.([...active, "codemode"])` — **append only**, never removes
     or reorders anything.
3. **Total failure tolerance**: the whole body is wrapped in a bare
   `try { … } catch {}`. Rationale: `getAllTools`/`setActiveTools` throw only in a
   host that loads extension definitions without binding a session
   (`discoverAndLoadExtensions` before `core.bindCore`). "Not being able to check is
   not a reason to fail."
4. `pi` parameter typed `any` (not `ExtensionAPI`) — deliberate, so the extension
   loads even where the typed API isn't available.

## Test coverage (9 pinned behaviors)

Hand-rolled mock-`pi` harness (no framework, plain `node:assert`): registers the
handler; activates when registered+inactive; no-op when already active; no-op when
not registered; never removes/reorders (`["bash","read"]` →
`["bash","read","codemode"]`); idempotent across repeated starts; no-op (no calls,
list unchanged) when any tool API throws; no-op when tool APIs are missing entirely;
exit-code-1 failure summary on assertion failure. Test imports the TS source
directly (`import("../index.ts")` → needs node ≥ 22.6 type stripping).

## Packaging

`pi-codemode-bootstrap` 0.1.0, `engines.node >= 22.6.0`, `pi.extensions:
["./index.ts"]`, single `test` script (gate runs just the test), peer dep
`@earendil-works/pi-coding-agent`. Root registration: **first** entry in root
`pi.extensions` (ordering matters: it activates codemode for everything loaded
after).

## Design context a re-implementation must know (from the adoption spec)

1. **Stage A adopted**: `codemode.mode: "on"`; heavy tools moved to
   codemode/deferred exposure; measured net saving ≈ **6,200 est. tokens/session**
   (~8,400 removed, ~1,254 codemode declaration, ~95/tool `declare const tools`
   samples on remaining tools).
2. **Stage B (`codemode.mode: "only"`) evaluated, NOT adopted** (2026-10-05,
   go-with-mitigations not taken). Unmitigated risk: `Agent` silently dropped from
   the 3000-token `inlineBudget` listing (no namespace ⇒ no "(some tools not
   listed)" marker). Mitigation `pi-packages-graey` was built, measured, reverted.
3. **Deliberate non-goals**: no non-codemode fallback for moved tools (a tool may
   be *unreachable* when codemode is off — accepted); `hashline-edit`'s read/edit
   and `set_phase` stay `direct` (hashline-edit **is** the file I/O path);
   `Agent` stays `direct` (behavioral-prose description); `tool_search` not
   enabled; `codemode.inlineBudget` (default 3000) not raised.
4. **Subagent-side activation** lives in pi-subagents (`agent-runner.ts`):
   `extensionFactories: [createCodemodeExtension()]` + local-patch fixes (the
   `<inline:*>` exemption in `extensionsOverride`, `"codemode"` in
   `readmitToolNames`) + a nested tool-scope veto as an extension `tool_call`
   handler gating `ctx.executeTool()` nested calls (Divergence 4).
   `noExtensions`/`isolated` subagents get no codemode — accepted.

## New-repo considerations

- **[decide] Q7**: if the new stack assumes a pi version where codemode is reliably
  active (or is activated via settings/MCP as standard practice), this extension
  becomes trivial or unnecessary. If kept, it is a ~30-line port with the exact
  "adds-only, idempotent, fail-open" semantics above.
- Its no-fallback inversion: today it fail-opens (silently no-ops). A hard-stack
  repo might instead **warn loudly** when codemode is registered-but-inactive and
  activation failed — or even fail the session — since every beads tool depends on
  it. **[decide] Q2a.**
- Keep the root-manifest ordering rule (register the activator first) if the
  monorepo shape survives (Q4).
