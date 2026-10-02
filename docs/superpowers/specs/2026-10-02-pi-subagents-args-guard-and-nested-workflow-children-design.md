# Guard the workflow `args` boundary, settle the `allowed_subagents` claim, silence the Vite warning

Molecule: `pi-packages-mol-qcaz` · Beads: `pi-packages-x33o` (P2, bug) and `pi-packages-u340` (P3, chore) ·
Single PR, branch `johnstegeman/x33o-u340` · Base `5dc3e05`

Date: 2026-10-02 · Status: approved design (`review.verdict=done` on `pi-packages-mol-0zz3`)

## Problem

Two independent defects, both in `packages/pi-subagents` and both with acceptance criteria already
written on their beads.

**x33o item 1 — a malformed top-level `args` fails late and blames the wrong thing.** The
`SubagentWorkflow` tool description tells callers to pass the value itself, not a JSON-encoded
string (`src/workflow/tool-description.ts:86`), but nothing enforces it. A caller that passes
`args: '{"base":"c311606"}'` gets `typeof args === "string"` inside the realm, every `args.x` is
`undefined`, and the run dies at the return marshal with:

```
Cannot pass undefined across the workflow VM boundary (at the workflow result.base).
```

— an error that names the *result* for an *input* problem, after the worker has already started.

**x33o item 2 — the docs and the code disagree about workflow children.** `pi-superpowers-plus`
documents, as verified fact, that a `SubagentWorkflow`-spawned agent carries no `nestedRuntime`, so
`allowed_subagents` is inert inside a workflow (`README.md:230-234`, `CHANGELOG.md` under
`[Unreleased]`). The code says the opposite. It matters because both reviewer templates declare
`allowed_subagents: Explore` (`agent-templates/code-reviewer.md:4`,
`agent-templates/task-reviewer.md:4`) and both are dispatched from workflows
(`final-review.js:188`, `fix-loop.js:141`, `wave-parallel.js:182`).

**u340 — a pre-existing Vite warning pollutes the gate.** `cd packages/pi-subagents && npm run check`
prints, on every run:

```
(!) Your Vite config uses features that are unsupported by `configLoader: 'native'` …
  - ESM syntax in a file loaded as CommonJS (vitest.config.ts:1:1). Use a `.mjs` extension …
```

`vitest.config.ts` uses ESM (`import { defineConfig } from "vitest/config"`) while
`packages/pi-subagents/package.json` has no top-level `"type": "module"`, so Vite loads the config as
CommonJS. Unrelated to any given change, but the review rubric treats non-pristine test output as a
finding, so every task review in this package pays for it.

## Evidence

**Item 1.** The boundary is *not* unchecked — it is checked with a rule that permits the misuse.
`runWorkflow` already runs `assertBoundarySafe(options.args, "args")` (`runtime.ts:588`), but its
`walk()` returns early for `typeof value === "string" || typeof value === "boolean"`
(`runtime.ts:340`) and special-cases `undefined` at path `"args"` (`runtime.ts:346`). So a string is
transported happily and fails later, in the script, as described above.

There is also a placement precedent in the tool itself: `index.ts:2527` pre-parses `meta`
synchronously and returns a tool error, with the comment *"a bad `meta` is an authoring error the
model can fix immediately, and reporting it as a background run that failed a second later would
just cost a turn."* `args` gets no such pre-flight.

Reproduced on the bead with workflow probes `wf_3d2018250bec` (object input) and `wf_9271ae9e071a`
(string input).

**Item 2.** The workflow path reaches the same nested-tool injection as a direct dispatch:

| Hop | Site | What it does |
|---|---|---|
| Host spawns | `workflow/host.ts:294` `manager.spawnAndWait(...)` | no `depth`, and `isolated` never set (it passes `request.isolation` → `isolation`, the worktree mode, at `:331`) |
| Manager records | `agent-manager.ts:539` | `depth: options.depth ?? 1` → 1 |
| Manager builds run options | `agent-manager.ts:800` | `nestedRuntime: { … }`, unconditionally |
| Runner decides | `agent-runner.ts:952` | `agentConfig?.allowedSubagents && nestedRuntime && !options.isolated` → **true** |
| Cap | `nested-tools.ts:45` | `maxSubagentDepth = 2`, so depth 1 < 2 |

`pi-subagents/test/` covers direct dispatch (`subagents-nested-print-mode-e2e.test.ts`,
`nested-tools.test.ts`, `nested-delegation-e2e.test.ts`) and the depth cap, but nothing covers a
workflow-dispatched agent either way.

**u340.** Only one reference to the file name exists in the repo — `.npmignore:27`. `tsconfig.json`
includes `src/**/*.ts` only, `biome.json` includes `src`+`test` only, no CI job names the config
file, and the string `configLoader` appears nowhere outside the warning itself.

## Decisions

1. **Item 1: enforce the shape at all three boundaries** — the tool call, `runWorkflow`, and the
   nested `workflow()` call. The tool call gives the model a synchronous, same-turn error (the
   `meta` precedent); the runtime rule means no future caller can regress it; the nested rule closes
   the same hole in the child-args boundary.
2. **Item 2: the code is right, the docs are wrong.** Workflow children *do* receive nested tools.
   The claim was a misreading of `agent-manager.ts:800` ("the sole construction site") as if the
   workflow path did not go through it. Rejected alternative: making workflows genuinely
   fail-closed, which would need new plumbing (`isolated` is unusable — it means "no extension tools
   at all") and would make the shipped reviewer templates weaker inside workflows than outside them.
3. **Item 2 documentation scope: correct the claim *and* document the capability where workflow
   authors read it**, with the accounting caveat. Rejected: leaving `final-review.js`/`fix-loop.js`
   prompts untouched *and* unmentioned (the capability would stay incidental), and changing the SDD
   prompts to rely on nested delegation (a separate decision about what SDD workflows cost).
4. **u340: rename to `vitest.config.mts`.** Rejected: adding a top-level `"type": "module"`, which
   changes module resolution for every file in a package that ships CJS output.
5. **One spec and one plan for both beads.** u340 is a one-task chore; it does not need its own
   molecule.

## Design

### §1 — the `args` shape guard

One predicate, exported from `src/workflow/runtime.ts`:

```ts
export function assertWorkflowArgs(args: unknown): void {
  if (args === undefined) return;
  if (args === null || typeof args !== "object") {
    const kind = args === null ? "null" : typeof args;
    throw new WorkflowRuntimeError(
      "Workflow `args` must be an object or an array, not " + kind + "." +
        (kind === "string" ? " Pass the value itself, not a JSON-encoded string." : ""),
    );
  }
}
```

- Arrays pass (`typeof [] === "object"`); `args: ["a.ts", "b.ts"]` is documented and used.
- `undefined` stays "not provided" (`runtime.ts:346` already special-cases it).
- `null` is **rejected**, so "must be an object or an array" is exceptionless. Omitting the field is
  the documented way to say "none".
- Non-plain objects (`Map`, `Date`) and non-finite numbers keep their existing `assertBoundarySafe`
  messages; that walk still runs.

Applied at three sites:

1. **`runWorkflow`, immediately before `assertBoundarySafe(options.args, "args")` (`runtime.ts:588`)** —
   the runtime-level rule. Cheapest check first, clearest message first.
2. **`SubagentWorkflow.execute` (`src/index.ts`), after the `resumeFromRunId` check and before
   `resolveWorkflowScript`** — returns `textResult(message)`, importing the same exported
   predicate. No duplicated rule. Ordering is fixed so a bad resume id still reports itself first.
3. **The worker's nested `workflow(nameOrRef, args)` (`worker-source.ts:648`), before the existing
   `checkBoundary`** — same rule, message labelled with the child:
   `workflow("audit") args must be an object or an array, not a string.` This has to be worker-side:
   nested child args never cross to the host. The worker copy throws a plain `Error` —
   `WorkflowRuntimeError` does not exist inside the worker source string, exactly as `checkBoundary`
   already throws a plain `Error` there. `checkBoundary` is unchanged for everything else.

**Deliberately not added:** a copy of the guard inside the worker's top-level `main()`. The runtime
rejects before the worker is constructed, so it would be unreachable code.

**Documenting the asymmetry.** The worker's boundary helpers carry a comment recording that
top-level `args` is the one value checked *host-side, before the worker exists*, and why — so the
next reader of `checkBoundary` does not re-open the question the bead's last acceptance criterion
raises.

**Unchanged:** `walk()`'s rules, nested-`args` transport, and every object/array payload. The bead's
object-input probe keeps passing.

### §2 — settling the `allowed_subagents` contradiction

No production behaviour changes; the false claim, its history, and a test.

**2a. The e2e that settles it** — a new case in `test/e2e/workflow.e2e.test.ts`, using the harness
already there:

- `workflowProject()` cwd (workflows enabled), plus
  `writeAgents(cwd, { "recursive-reviewer": "allowed_subagents: Explore\n" })` and
  `beforeRun: () => registerAgents(loadCustomAgents(cwd))` — the recipe
  `subagents-nested-print-mode-e2e.test.ts` already uses.
- The parent scripts a `SubagentWorkflow` call whose script runs
  `await agent("NESTED-TOOLS-PROBE", { agentType: "recursive-reviewer" })`.
- The faux `respond` records `getCurrentTools(context.messages)` for the child whose prompt carries
  the marker, and the test asserts `Agent`, `get_subagent_result`, `steer_subagent` are present.
- Settling reuses the file's existing `waitFor(...)` + `run.manager?.waitForAll()` pattern.

This proves the whole disputed chain rather than re-asserting a reading of `host.ts`, and it goes red
if anyone ever makes workflow children fail-closed — the behaviour becomes a pinned contract instead
of an accident.

**2b. `pi-superpowers-plus/README.md:230-234`** — replace the false paragraph with the true one: the
workflow host spawns through the manager, so a `SubagentWorkflow`-spawned agent whose type declares
`allowed_subagents` receives nested tools exactly as a directly dispatched one does (naming the
`final-review.js` / `fix-loop.js` / `wave-parallel.js` dispatch sites and citing the new e2e), then
the caveat: the difference is **accounting, not capability** — a workflow counts the agents its
*script* launches, so grandchildren a child spawns sit outside the run's `agentCount` and its cap and
do not appear in its progress tree; nested spend still rolls into the child's totals, so per-review
cost attribution is unchanged. The `(verified by code trace, l8x9.11)` citation goes.

**2c. `pi-superpowers-plus/CHANGELOG.md`** — the false claim is in the *Unreleased* section
(lines 10-42), so both bullets (`task-reviewer`, `code-reviewer`) are corrected in place rather than
contradicted by a later entry.

**2d. Documenting the capability for workflow authors** — a passage under
`pi-subagents/docs/workflows.md` → `### Limits and caps` (line 291), and one line in the
`SubagentWorkflow` section of `pi-subagents/README.md`, both stating that a workflow-dispatched agent
whose type declares `allowed_subagents` can delegate and that those grandchildren are outside the
run's count, cap and progress tree.

**2e. Documenting the `args` rule** — `docs/workflows.md` lines 144, 225 and 278, `README.md:430` and
the schema description at `index.ts:2456` all say "must be JSON-shaped"; each becomes "must be an
object or an array", with the string case named as rejected. `tool-description.ts:86` keeps its
warning and gains one clause saying the runtime rejects a string. `workflow-tool-description.test.ts`
derives its expectations from source rather than restating prose, so these edits are safe.

### §3 — u340, the vitest config warning

- `git mv packages/pi-subagents/vitest.config.ts packages/pi-subagents/vitest.config.mts`
- `.npmignore:27`: `vitest.config.ts` → `vitest.config.mts`
- Nothing else. The config body is unchanged; `.mts` makes Vite load it as ESM natively.

## Acceptance criteria

`pi-packages-x33o`:

| Criterion | Satisfied by |
|---|---|
| A non-object (or JSON-string) top-level `args` is rejected before the script runs, with an error naming the argument | §1 sites 1 and 2; tests in `workflow-runtime.test.ts` and `workflow-tool.test.ts` |
| An object passed as `args` still arrives as an object with every key intact | §1 changes no object/array path; the existing "passes args through verbatim" test (`workflow-runtime.test.ts:129`) keeps passing |
| One focused test asserts whether a workflow-dispatched agent whose type declares `allowed_subagents` receives nested `Agent`/`get_subagent_result`/`steer_subagent` | §2a |
| Whichever of the code or `pi-superpowers-plus/README.md:233` is wrong is corrected, so the two agree | §2b, §2c |
| The `checkBoundary` asymmetry is closed or documented | §1 site 3 closes the nested half; §1's doc comment records that top-level `args` is now shape-checked host-side, before the worker exists |

`pi-packages-u340`:

| Criterion | Satisfied by |
|---|---|
| `npm run check` completes with no Vite `configLoader` warning | §3 |
| vitest still loads the config and the suite is unchanged | §3; suite totals recorded before and after the rename commit must be identical |
| `npm run check` still exits 0 (biome + tsc --noEmit + vitest) | §3 |

## Verification

In order, on this branch:

1. `cd packages/pi-subagents && npm ci` (`node_modules` is absent; node 22.23.1 matches `mise.toml`).
2. `npm run check` in `pi-subagents` — pristine: no Vite warning, exit 0, vitest totals recorded
   before and after the u340 commit on their own (that commit must not move them; §1/§2 add tests of
   their own).
3. From the repo root: `node scripts/ci/package-gate.mjs pi-subagents` and
   `node scripts/ci/package-gate.mjs pi-superpowers-plus`, then the CI-equivalent `npm test`.
4. Each acceptance criterion above mapped one-to-one in the final report, including the ones settled
   by recording a decision rather than by code.

## Bookkeeping

- `docs/pi-subagents-local-patch.md` — new **Divergence 6 — the `args` shape guard**, listing
  `src/workflow/runtime.ts` and `src/workflow/worker-source.ts`, with the established
  `// LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md` marker bracketing every
  changed line, and a "Covered by" line naming the three test files.
- `packages/pi-subagents/CHANGELOG.md` — `[Unreleased] → ### Fixed` entry citing `pi-packages-x33o`.
- No dependency changes, so no lockfile churn; nothing is version-bumped — `[Unreleased]` is the
  vehicle in both packages.
- Both beads closed at the finish step with the criteria they satisfy.

## Out of scope

- `pi-packages-jnr7.2` — `fix-loop.js`'s stale re-review head (same package family, different failure
  mode; it lives on the SDD epic `pi-packages-jnr7`).
- Changing the SDD prompts to lean on nested delegation.
- Any change to `maxSubagentDepth`, `isolated`, the workflow agent cap, or the run's accounting.
- Renaming or restructuring anything else in the workflow worker/realm.

## Risks

| Risk | Mitigation |
|---|---|
| Rejecting `null` breaks a caller that emits `args: null` to mean "none" | `undefined`/omitting is the documented spelling; the error is immediate, names `args`, and is trivially fixed. Called out here so the decision is reviewable |
| The new e2e is flaky (real sessions, timing) | It reuses the file's existing `waitFor` + `waitForAll` settling pattern, the faux model, and a per-test timeout |
| The e2e could pass for the wrong reason if the child never runs | The assertion is on the *child's* observed tool set, which only exists once the child has a session |
| Doc edits drift from behaviour again | §2a pins the capability; §2b/§2d no longer assert a code-trace claim |
| Renaming the config file breaks a tool that hardcodes the name | Exhaustive grep found `.npmignore` as the only reference |
