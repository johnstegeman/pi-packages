# CI gate hardening follow-ups — Design

- **Date:** 2026-10-01
- **Issue:** `pi-packages-mol-v6k6` (brainstorming molecule, topic "ci-gate-hardening-followups")
- **Packages / areas:** root `package.json`, `.github/workflows/ci.yml`, `AGENTS.md`,
  `packages/pi-subagents` (`src/agent-runner.ts`, `test/agent-runner.test.ts`),
  `docs/pi-subagents-local-patch.md`
- **Verified against:** pi 0.99.1 (`@earendil-works/pi-coding-agent` 0.99.1), node 22

## Context

Two follow-ups were carried out of the code-mode adoption work
(`2026-09-30-codemode-adoption-design.md`, molecule `pi-packages-mol-sjw3`) and recorded in
that molecule's ledger (`.superpowers/sdd/pi-packages-mol-sjw3/progress.md`, tasks 2 and the
final review).

### 1. The package gate's own test suite is run by nothing

**Fixed by this plan — landed in Task 1 (commits `45bf4cd`, `ce11000`).** The paragraph below
describes the gap as it stood when this design was written. Root `npm test` now runs this file
first and the `gate-selftest` CI job runs it too — see "Part 1 — wire the self-test" below.

`scripts/ci/package-gate.test.mjs` (45 tests) is invoked by neither root `npm test` nor CI:

- root `package.json` declares `"test": "node scripts/ci/package-gate.mjs --all"`;
- `.github/workflows/ci.yml` runs `node --test scripts/ci/check-deps-mirror.test.mjs` in the
  `deps-mirror` job, but no job runs the package-gate test file.

This is not theoretical. Adding the gated `codemode-bootstrap` package broke
`scripts/ci/package-gate.test.mjs:184-195`, which pins the composed gate of **every real
package**; the suite went 44/45 and only a human-run caught it. Nothing in the local or CI
path could see the failure, and no task in that molecule owned the file.

### 2. The scope veto's fail-open branch rests on a registration gate

**Fixed by this plan — landed in Task 2 (commit `5bab364`).** The paragraph below describes the
coupling as it stood when this design was written. The handler now fails closed for nested calls
while no scope is published, so the registration gate is defense in depth rather than the only
guard — see "Part 2 — harden the scope veto" below.

`createToolScopeVeto` (`packages/pi-subagents/src/agent-runner.ts:234`) is the extension
`tool_call` handler that enforces a subagent's tool scope on the **nested** path — the calls
a codemode script makes through `ctx.executeTool()`. It reads its predicate from a holder
that `installExtensionToolScope` fills in, and is a no-op while the holder is unset:

```ts
const inScope = holder.inScope;
if (!inScope) return undefined;
```

The holder is filled only by `installExtensionToolScope`, which runs only when
`!noExtensions` (`agent-runner.ts:1113`). So for `noExtensions`/`isolated` sessions the
handler is a permanent no-op, and the only thing preventing an out-of-scope nested call is
the **registration** gate: `tools:` → `allowedToolNames` filters the registry at session
construction, so `codemode` is never registered and `_getCallableTools()` never hands a
script a callable tool. That is a latent coupling — the veto's correctness depends on a
separate mechanism staying intact, with nothing asserting the dependency.

## Goal

Close both gaps:

1. Make the package gate's test suite run where a regression can be seen — locally and in CI.
2. Remove the scope veto's dependence on the registration gate: when no scope is published,
   **nested** calls fail closed, so the two layers are independent and each is pinned by a
   test.

Both changes must leave the existing behaviour of every other path untouched, and neither
may introduce a new required CI job that can flake or drift.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | The self-test runs in **both** root `npm test` and CI | Matches the `deps-mirror` precedent (that job runs a root `scripts/ci/` script *and* its `node --test` sibling) and AGENTS.md's "everything, the way CI runs it" promise. Catches the regression before a PR *and* at PR time. |
| D2 | CI gets a **dedicated** `gate-selftest` job, not a step folded into `gates-list` or `manifest` | Keeps the inventory job single-purpose (a self-test failure must not mask the `--list --json` output the matrix consumes), and avoids `manifest`'s preinstalled node 20 contradicting the repo's node-22 pin. |
| D3 | The fail-closed default lives **inside the handler** (unset branch), not as an explicitly published deny-all scope | See "Alternatives considered". It is the smallest change, and it preserves the incidental direct-path coverage this handler already provides. |
| D4 | The fail-closed branch is scoped to **nested calls** (`event.parentToolCallId` present) | pi installs `agent.beforeToolCall = (ctx) => this._beforeToolCall(ctx)`, and that dispatcher emits `tool_call` handlers for **direct** calls too. A blanket deny-all would freeze every tool call in every `noExtensions` session — the exact over-blocking the final review warned against. |
| D5 | Both layers are pinned by **unit** tests through the existing mock-loader harness; no new e2e | The mock loader cannot run `extensionFactories`, so the registration pin is an allowlist assertion, and "no callable nested path" is proven by the *combination* (allowlist excludes codemode + unset scope fails closed). The existing `test/e2e/codemode-nested-scope.e2e.test.ts` already pins that this handler is the only call-time gate on the nested path, so no new e2e machinery is warranted. |
| D6 | Delivery as **two commits, one PR**, on `fix/0.99-upgrade` | Commit 1 (wiring) is independently revertable if the self-test ever proves noisy; commit 2 (hardening) is a behaviour change in a security-adjacent path and deserves its own revert point. |

## Design

### Part 1 — wire the self-test (commit 1)

**`package.json`** — the self-test runs first, because a broken selection rule would make the
gate results that follow misleading:

```json
"scripts": { "test": "node --test scripts/ci/package-gate.test.mjs && node scripts/ci/package-gate.mjs --all" }
```

No new named script. The file is dependency-free (`node --test` is builtin), so `npm test`
keeps working with no root `node_modules` — a property the original gate spec calls out and
which is re-verified.

**`.github/workflows/ci.yml`** — a new job, placed directly after `deps-mirror` (its
structural sibling), before `workflow-lint`:

```yaml
  gate-selftest:
    name: Package gate self-test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Run the package-gate test suite
        run: node --test scripts/ci/package-gate.test.mjs
```

No `cache: npm` — there is nothing to install. Node 22 matches `mise.toml` and every other
job. `manifest`, `deps-mirror`, `workflow-lint`, `gates-list` and `package-gates` are
untouched.

**`AGENTS.md` → "Running tests"** — three edits:

- The first bullet becomes: `npm test` runs the gate **self-test** and then
  `scripts/ci/package-gate.mjs --all`, the same script the `package-gates` CI job runs per
  package.
- A new bullet: **the gate's own tests** — `node --test scripts/ci/package-gate.test.mjs`
  (also the `gate-selftest` CI job).
- A sentence naming what the self-test buys: it pins the composed gate of **every real
  package** (`selectGate: the real package manifests select the recorded composed gate`), so
  adding or re-gating a package fails it — exactly the `codemode-bootstrap` regression that
  slipped through because nothing ran the file.

**Doc correction** — `docs/superpowers/specs/2026-09-25-package-gate-enforcement-design.md:359`
describes the file as "`node --test`, **no installs**, no network". The pure-function tests are
install-free, but the process-level CLI tests run `npm ci` in a scratch repo against a
dependency-free lockfile. That line is corrected, and the section records where the file now
runs.

### Part 2 — harden the scope veto (commit 2)

**The handler** (`createToolScopeVeto`, `agent-runner.ts:239-247`). Only the unset-scope
branch changes:

```ts
pi.on("tool_call", (event) => {
  const inScope = holder.inScope;
  if (!inScope) {
    // No scope published means this session skipped installExtensionToolScope —
    // exactly noExtensions/isolated. Fail CLOSED for nested (script) calls, so the
    // registration gate is no longer the only thing standing between a script and an
    // out-of-scope tool. Direct calls must stay allowed: pi's own beforeToolCall
    // dispatcher emits this handler for them too, and blocking there would freeze
    // every noExtensions session. Unset is transient for extension sessions (no
    // prompt runs before the scope is installed) and permanent for noExtensions.
    if (!event.parentToolCallId) return undefined;
    return { block: true, reason: `Tool "${event.toolName}" is not available to this subagent.` };
  }
  if (inScope().has(event.toolName)) return undefined;
  return { block: true, reason: `Tool "${event.toolName}" is not available to this subagent.` };
});
```

The set-scope path is byte-for-byte unchanged, so the incidental direct-path coverage this
handler already provides is preserved.

**The two comments that currently justify the fail-open** — both stop asserting the
registration gate is the sole guard:

- `createToolScopeVeto`'s doc (`:225-231`): "Until it does, the handler is a no-op: no prompt
  can run before the scope is installed, and the `noExtensions` sessions that never install
  one are gated at registration by `excludeTools`" becomes the new invariant — unset is
  transient *or* permanent, nested calls fail closed, direct calls pass.
- `installExtensionToolScope`'s doc (`:282-283`): "Only meaningful when extensions are
  loaded — under `noExtensions`/`isolated` the static `allowedToolNames` allowlist already
  gates the registry itself" gains the second layer: the veto's unset-scope branch now fails
  closed for nested calls, so the registry gate is defense-in-depth rather than load-bearing.

**Tests** (`packages/pi-subagents/test/agent-runner.test.ts`, unit, run by the package gate's
`vitest run`):

- **The fail-closed branch.** Run `runAgent(..., { isolated: true })`, take
  `lastLoaderOpts().extensionFactories`, find the entry named `"subagent-tool-scope"`, call
  its `factory` with a fake `pi` that captures the `tool_call` handler, then assert:
  - `handler({ toolName: "codemode", parentToolCallId: "p1" })` → `{ block: true }` with the
    "not available to this subagent" reason;
  - `handler({ toolName: "read" })` → `undefined` — the direct-call guard that keeps the
    change from freezing `noExtensions` sessions.

  Same technique as the existing "passes the codemode extension factory to the subagent
  session loader" test: observe the loader's real constructor options, never source text.
- **The registration layer.** Extend the existing `isolated keeps the static allowlist` test
  with an explicit `expect(createAgentSession.mock.calls[0][0].tools).not.toContain("codemode")`
  beside the existing `toEqual(["read"])`, so the allowlist pin is stated rather than implied.
- **RED check.** Before the fix, the nested assertion returns `undefined` (no block). The
  RED run is captured, so the test is proven to fail for the right reason.

**Prose** — `docs/pi-subagents-local-patch.md` Divergence 4. The clause "until then it is a
no-op (no prompt can run before the scope is installed, and `noExtensions` sessions are gated
at registration by `excludeTools`)" is rewritten to describe the nested fail-closed default
and to demote the registration gate to defense-in-depth. A repo-wide grep for other copies of
that claim runs before finishing.

## Alternatives considered

**Explicitly publish a deny-all scope for `noExtensions`** (the final review's literal
suggestion). Set `toolScopeVeto.inScope = () => new Set()` in the `if (noExtensions)` branch.
Rejected as stated: the handler fires for direct calls too, so a blanket deny-all freezes
every tool call in every `noExtensions` session. Making it safe requires additionally gating
the whole handler on `parentToolCallId`, which *drops* the incidental direct-path coverage on
extension sessions, and leaves a publish-without-the-guard trap for the next reader. More
code than the chosen design for the same guarantee.

**Publish the real allowlist for `noExtensions`** (`inScope = () => new Set(sessionTools)`),
making the predicate uniformly "the truth" and deleting the unset state. Rejected: the
predicate would also have to admit `customTools` (`nestedTools`, `structuredTools`), which are
not in `sessionTools`; get that wrong and the handler blocks `StructuredOutput` and
nested-delegation tools in every `noExtensions` session. A live-regression risk in a
security-adjacent path, and it duplicates the allowlist the registry already enforces.

**Fold the self-test into the `gates-list` job.** Rejected: the job's name would then
under-describe it, and a self-test failure would mask the inventory output the matrix needs.

**Add a real-loader e2e for the unset branch.** Rejected: a `noExtensions` session cannot
register codemode, so the nested path cannot be driven by a real script; the test would have
to emit the `tool_call` event against a real session's runner by hand — a weaker and more
coupling-prone proof than the existing e2e, for more machinery.

## Risks

| # | Risk | Assessment |
|---|---|---|
| R1 | Over-blocking: the fail-closed branch refuses a legitimate nested call | Low. In a `noExtensions` session nothing legitimate nests: codemode is not registered, and `customTools` (`nestedTools`, `structuredTools`) are invoked directly, not through `ctx.executeTool()`. The new unit test pins that direct calls still pass. |
| R2 | `event.parentToolCallId` is dropped by a future pi, so nested calls look direct | Accepted and recorded. pi 0.99.1 documents the field on the `tool_call` event (`types.d.ts:892`, "Set when another tool (for example a codemode script) issued this call"). A unit test with a hand-built event cannot detect a pi change. If it disappeared, the branch would degrade to **today's behaviour** (registration gate only) — not to something worse. The peer range is `>=0.99.0`. |
| R3 | The self-test's process-level CLI tests run `npm ci` in scratch repos, adding time or network need to root `npm test` | Measured: ~1.7s for the whole 45-test suite locally, against a dependency-free lockfile (`minimalLock`), so no registry access. |
| R4 | `npm test` no longer means "run the gates" and nothing else | Intended, and documented: the AGENTS.md bullet is rewritten to say what `npm test` composes. |
| R5 | The self-test's real-package gate map is drift-prone by design (it must be updated when a package is added) | That is the point — it is the assertion that caught the `codemode-bootstrap` regression. AGENTS.md now names the failure mode so the fix is obvious. |
| R6 | A new CI job adds a required-check surface | `gate-selftest` is dependency-free and deterministic; it needs no cache and no install. |

## Verification

1. `node --test scripts/ci/package-gate.test.mjs` → 45/45, and the new pi-subagents tests
   RED before commit 2's fix and GREEN after.
2. `node scripts/ci/package-gate.mjs pi-subagents` → `npm ci` + `npm run check`
   (biome + `tsc --noEmit` + `vitest run`).
3. Root `npm test` → self-test, then all 8 packages PASS.
4. Root `npm test` still works with no root `node_modules`.
5. `actionlint .github/workflows/*.yml` → exit 0.
6. `node scripts/ci/package-gate.mjs --list` → 8 packages, unchanged.

## Files

- `package.json` (root `test` script)
- `.github/workflows/ci.yml` (`gate-selftest` job)
- `AGENTS.md` ("Running tests")
- `docs/superpowers/specs/2026-09-25-package-gate-enforcement-design.md` (Tests section: where
  the file runs, and the "no installs" correction)
- `packages/pi-subagents/src/agent-runner.ts` (handler + two doc comments)
- `packages/pi-subagents/test/agent-runner.test.ts` (fail-closed branch + registration pin)
- `docs/pi-subagents-local-patch.md` (Divergence 4 prose)
- `docs/superpowers/specs/2026-10-01-ci-gate-hardening-followups-design.md` (this file)

## Out of scope

- Branch-protection / required-check configuration (not expressible in the repo).
- The two other out-of-scope observations from that final review (two prose files that mention
  beads tools without the pi-tools note) — unrelated to these follow-ups.
- Any change to the gate's selection rule or `QUARANTINED` mechanism.
- The `sync-pi-subagents.yml` open risk flagged at that molecule's finish (a separate,
  human-authority decision).
