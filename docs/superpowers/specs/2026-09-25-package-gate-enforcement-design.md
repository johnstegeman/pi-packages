# Package gate enforcement — design

- **Date:** 2026-09-25
- **Issue:** `pi-packages-xh2n` (bug, P2) — "Package lint/test gates are not enforced: `npx biome` picks a stale cached binary and CI runs no package suite"
- **Origin:** found while finishing `pi-packages-33j5` (PR #62, merged)
- **Molecule:** `pi-packages-mol-7w6w` (superpowers-workflow)
- **Branch:** continues on `johnstegeman/pi-packages-33j5` (decision 1) — follow-up PR from the same ref

## Problem

Two compounding gaps let a branch look verified while its real gate was never exercised.

### Gap 1 — `npx biome` is not the repo's pinned linter

`packages/pi-superpowers-plus`'s `test` script begins with a bare `biome check .`, which resolves
the package-local binary from `node_modules/.bin` (devDependency `@biomejs/biome: ^2.3.15`; `npm ci`
installs **2.5.6**). In a fresh worktree `node_modules` is absent, and `npx biome check .` then
resolves a **different** biome — several stale versions are cached under `~/.npm/_npx/`:

```
~/.npm/_npx/020777643902a758/node_modules/.bin/biome -> 2.5.12
~/.npm/_npx/2bcb10ab1c993e02/node_modules/.bin/biome -> 2.3.15
~/.npm/_npx/3ee0a145073be872/node_modules/.bin/biome -> 2.5.11
```

Those versions disagree with the pinned one about formatting and rule severity, so `npx biome check .`
reported **exit 0 / "clean"** while the repo's real gate reported **4 errors**:

- baseline `main` @ `4f89545`: exit 0, 18 warnings
- branch as reviewed: 4 errors, 19 warnings
  - `format`: `extensions/molecule-contention-gate.mjs`, `extensions/beads-molecule-widget-controller.mjs`, `test/beads-molecule-widget-controller.test.mjs`
  - `lint/suspicious/noAssignInExpressions` at `extensions/beads-molecule-widget-controller.mjs:245` (plus `lint/complexity/noCommaOperator` from the same expression)

**Four task reviews plus the controller's own verification step all recorded `npx biome check .` as
clean** — the false green propagated to every reviewer because all of them ran the same wrong command.
It was caught only when the finish step ran the literal `npm test` after `npm ci`.

### Gap 2 — CI runs no package suite

`.github/workflows/ci.yml` has five jobs: `manifest`, `deps-mirror`, `subtree-smoke`
(`packages/pi-subagents` `npm ci` + typecheck), `sim`, `workflow-lint`. **None runs `npm test` for
any `packages/*`.** Nothing in CI would ever have caught those 4 errors, and the PR's green checks
say nothing about the lint/test state of any package.

### Inventory (verified)

| package | `test` | `check` | `lint` | `typecheck` | lockfile | devDependencies |
|---|---|---|---|---|---|---|
| `ayu` | — | — | — | — | no | — |
| `bifrost` | yes | — | — | — | **no** | tsx, pi-coding-agent, pi-ai, @types/node |
| `hashline-edit` | yes | yes | — | yes | **no** | tsx, biome 2.5.3, pi-coding-agent, typebox, typescript, @types/node |
| `langfuse` | yes | — | — | yes | **no** | tsx, typescript |
| `pi-beads` | yes | — | — | — | **no** | **none** |
| `pi-subagents` | yes | yes | yes | yes | yes | vitest, biome ^2.4.14, pi-*, typescript |
| `pi-superpowers-plus` | yes | yes | yes | — | yes | biome ^2.3.15 |
| `statusline` | yes | yes | — | yes | **no** | tsx, biome 2.5.3, pi-coding-agent, pi-tui, typescript, @types/node |

Exact strongest-gate scripts:

```
hashline-edit        check = biome check . && npm run typecheck && npm test
statusline           check = biome check . && npm run typecheck && npm test
pi-subagents         check = npm run lint && npm run typecheck && npm run test
pi-superpowers-plus  check = biome check .        <-- lint only, does NOT run tests
                     test  = biome check . && <16 node suites>
```

Note: **every package that declares `@biomejs/biome` actually uses it** (`hashline-edit` and
`statusline` via `check`, `pi-subagents` via `lint`, `pi-superpowers-plus` via `test`). There is no
dead biome dependency to remove; the versions are declared at three different levels (2.5.3,
^2.4.14, ^2.3.15).

Other facts that shape the design:

- Before this change, root `package.json` has **no** `scripts`, **no** `devDependencies`, **no** `workspaces`, **no** lockfile.
- `.gitignore:2` is `package-lock.json` and (verified with `--no-index`) it **does** ignore new
  package lockfiles at any depth. The two tracked lockfiles survive only because gitignore does not
  apply to already-tracked files — they were committed in the original vendoring commits.
- Installs are heavy: `packages/pi-subagents/node_modules` is **357 MB**, `pi-superpowers-plus` is **233 MB**.
- `packages/pi-beads`'s suite declares no dependencies and passes with no install at all.
- `packages/pi-subagents` is an upstream git subtree — AGENTS.md: **do not hand-edit**.

## Goals / non-goals

**Goals**

- Every package's real gate runs on **every** PR, using that package's **installed** binaries.
- The gate is **deterministic**: `npm ci` from a committed lockfile, never a floating install.
- The gate is **discoverable and runnable locally with one command that matches CI** — the direct
  antidote to Gap 1, which was fundamentally "the command people typed was not the command CI runs."
- The inventory is **code**: testable, auto-discovering, and impossible to shrink silently.
- Document the `npx biome` trap where a person will actually read it.

**Non-goals**

- Retrofitting `setup-node` onto the four older CI jobs (unrelated drift).
- Unifying the three declared biome versions across packages.
- Generating a lockfile or gate for `ayu` (theme only: no tests, no dependencies).
- Any edit inside `packages/pi-subagents/` (upstream subtree, synced nightly).
- Changing what any package's own tests assert.
- Making the root a workspace/hoisted monorepo — the packages stay independent.

## Decisions (from brainstorming)

1. **Branch:** continue on `johnstegeman/pi-packages-33j5`; open a follow-up PR from the same ref
   (the user's explicit instruction, in preference to cutting a fresh branch).
2. **Coverage:** all packages with a `test` script (7), staged — measure first, then enforce green
   suites and fix-or-quarantine red ones.
3. **Determinism:** commit lockfiles for all seven so every install is `npm ci`.
4. **Per-package gate:** the **strongest gate each package offers** — `check` › `typecheck && test` › `test`.
5. **Shape:** a matrix CI job plus a shared, tested selection script (Approach C).
6. **Matrix source:** dynamic — derived from the script's `--list --json`, so the list cannot drift.
7. **Local/CI parity:** add a `mise.toml` pinning node 20 (what CI uses), and document it.

## Design

### 1. `scripts/ci/package-gate.mjs` (new)

Sibling to the existing `scripts/ci/check-deps-mirror.mjs`, which already establishes the house
pattern: a root script under `scripts/ci/` with a `node --test` sibling test file.

**CLI**

```
node scripts/ci/package-gate.mjs <package>   # one package — the CI matrix targets this
node scripts/ci/package-gate.mjs --all       # every gated package, sequentially — root `npm test`
node scripts/ci/package-gate.mjs --list      # print the inventory (name -> selected command); no execution
node scripts/ci/package-gate.mjs --list --json   # JSON array of gated package names; consumed by the workflow
```

Exit 0 iff every **selected** package passed. `--list` always exits 0.

**Discovery — automatic, so the list cannot rot**

Read `packages/*/package.json` (sorted). A package is **gated** iff it declares a non-empty
`scripts.test`. `ayu` drops out by rule, not by a hardcoded skip; a new package with tests is picked
up with no edit to this file.

**Gate selection — derived from the package's own scripts, never a hand-maintained table**

```
if (!scripts.test)                                                   -> not gated
else if (covers(check, "test") && (!scripts.typecheck || covers(check, "typecheck")))
                                                                     -> npm run check
else if (scripts.typecheck)                                          -> npm run typecheck && npm test
else                                                                 -> npm test
```

`covers(script, "x")` = the script's text references `x` (`npm x` / `npm run x`).

Both clauses are load-bearing. The first closes a **weakening**: a naive "prefer `check`" would drop
`pi-superpowers-plus` to `biome check .` only, silently not running its 16 suites. The second closes a
**skipping** hole in the first draft of this rule: a `check` that runs the tests but not the
typecheck, in a package that *does* declare `typecheck`, would otherwise skip type checking entirely.
Neither case exists in today's inventory, so both are pinned by unit tests rather than left to luck.
Resulting selection:

| package | selected gate |
|---|---|
| `hashline-edit` | `npm run check` (lint + typecheck + tests) |
| `statusline` | `npm run check` |
| `pi-subagents` | `npm run check` |
| `langfuse` | `npm run typecheck && npm test` |
| `pi-superpowers-plus` | `npm test` (lint + all 16 suites) |
| `bifrost` | `npm test` |
| `pi-beads` | `npm test` |

**Execution**

`npm ci` (all seven have committed lockfiles — see Design §3) then the selected command, both in the package
directory. Exit code and the tail of the output are captured per package. An install failure is a
**failure**, never a skip.

**Output**

A summary table printed always — including on early failure — one line per package: `PASS` / `FAIL` /
`SKIPPED`, the selected command, and the duration. On failure the failing package's output tail is
echoed. A non-zero exit is never swallowed.

**Quarantine — explicit, loud, and greppable**

```js
const QUARANTINED = {
  // "<package>": "<why> - bead: <id>",
};
```

Quarantined packages report `SKIPPED` with their reason on **every** run and are excluded from the
exit-code calculation. An entry naming a package that no longer exists, or that is no longer gated,
produces a **warning** so the list cannot rot either. A package is therefore never dropped silently:
exclusion costs a line in this constant (visible in the diff) plus a line in every run's log.

**Structure for testability**

Discovery, selection, and the exit/table decision are exported pure functions; the runner that shells
out to `npm` is thin. Nothing in the module calls `npx`.

### 2. `.github/workflows/ci.yml` — new `package-gates` jobs

```yaml
  gates-list:
    name: Package gate inventory
    runs-on: ubuntu-latest
    outputs:
      packages: ${{ steps.list.outputs.packages }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - id: list
        run: echo "packages=$(node scripts/ci/package-gate.mjs --list --json)" >> "$GITHUB_OUTPUT"

  package-gates:
    name: Package gate (${{ matrix.package }})
    needs: gates-list
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        package: ${{ fromJSON(needs.gates-list.outputs.packages) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: packages/${{ matrix.package }}/package-lock.json
      - run: node scripts/ci/package-gate.mjs ${{ matrix.package }}
```

- `fail-fast: false` so one red package does not cancel the others; the whole picture arrives in one run.
- Each package is its own check in the PR UI — the failure signal a single serial job cannot give.
- The matrix derives from the script, so CI cannot run a different set than the script's inventory and
  quarantined packages never enter the matrix (the `gates-list` log shows why).
- `node-version: 20`, matching the existing `subtree-smoke` job. The four older jobs are left alone.

### 3. Lockfiles — five new files

`npm install --package-lock-only` in `bifrost`, `hashline-edit`, `langfuse`, `pi-beads`, `statusline`
(resolves and pins the tree **without** materialising a 200 MB `node_modules`), then commit each.
`pi-beads` declares no dependencies, so its lockfile is empty by design — it still gets one so
`npm ci` behaves uniformly. `pi-subagents`'s lockfile is upstream's and is **not** touched.

### 4. `.gitignore`

Append a negation so package lockfiles become committable while the root lockfile stays ignored:

```gitignore
package-lock.json
!packages/*/package-lock.json
```

### 5. Root `package.json`

Add the repo's first root script:

```json
"scripts": { "test": "node scripts/ci/package-gate.mjs --all" }
```

No root lockfile or dependencies are required for that. This is Gap 1's fix in practice: `npm test`
at the root now runs the real gates with the installed binaries, so there is one obvious command that
matches CI.

### 6. `mise.toml` (new, root)

```toml
[tools]
node = "20"
```

CI pins node 20; this machine runs node 26, and the suites have only ever been exercised on 26. Without
this, a local pass is not evidence for the CI job. CI is unaffected (it uses `actions/setup-node`).
*This is the one item added on the strength of a conditional offer — it pins the dev node version for
the whole repo, so veto it here if you'd rather keep node 26 locally and rely on the first CI run as
the measurement.*

### 7. `AGENTS.md`

Rewrite "Running tests": root `npm test` as the default; `node scripts/ci/package-gate.mjs <package>`
for one package; keep the statusline `PI_CODING_AGENT_DIR` isolation note and the per-package
sync-loop/dep-mirror commands. Add the explicit warning with its evidence: **never `npx biome` — it
resolves a stale cached version from `~/.npm/_npx/` instead of the package's pinned binary and reports
a false green** (four reviews and the controller were all fooled by it in PR #62). Note that lockfiles
are committed and `npm ci` is expected in each package.

## Measurement and staged enforcement

The first deliverable after the code lands is a real `--all` run producing the inventory for all seven,
**under node 20** so the result predicts CI. Then per package:

- **green** → enforced;
- **red** → fixed in this change, **or** added to `QUARANTINED` with a reason and a filed bead.

No third option and no silent omission. If node 20 cannot be provisioned locally, the plan records
that explicitly and the first CI run is the measurement for any suite that differs — a node-26 pass is
never presented as evidence for a node-20 job.

## Tests

**New — `scripts/ci/package-gate.test.mjs`** (`node --test`, no installs, no network) covering the
exported pure functions:

| case | assertion |
|---|---|
| discovery | a package with a `test` script is gated; one without is not (`ayu`); ordering is sorted/stable |
| selection: `check` covers `test` | `npm run check` (`hashline-edit`, `statusline`, `pi-subagents` shapes) |
| selection: `check` does **not** cover `test` | `npm test` — the `pi-superpowers-plus` shape; the regression that would drop 16 suites |
| selection: `check` covers `test` but **not** `typecheck`, and a `typecheck` script exists | `npm run typecheck && npm test` — the latent hole closed by the rule's second clause |
| selection: `typecheck` without `check` | `npm run typecheck && npm test` (`langfuse` shape) |
| selection: bare | `npm test` (`bifrost`, `pi-beads` shapes) |
| quarantine | a quarantined package reports `SKIPPED` with its reason and does not affect the exit code |
| quarantine rot | an entry naming a non-existent or non-gated package produces a warning |
| `--list --json` | emits a JSON array of package names — the contract the workflow's `fromJSON` consumes |
| exit semantics | all pass → 0; any fail → non-zero; pass + skip → 0 |
| no `npx` | the module source contains no `npx` invocation |

**End-to-end proof that the job goes red** (the issue's explicit AC) — after the jobs land on this
branch: push a deliberately broken lint change to one gated package, observe `package-gates` go **red
for that package only** while the other six stay green, then revert. Two extra commits on the PR; the
final head is content-identical to the pre-break state. Local script tests cannot prove the *workflow*
is wired correctly, so this is demonstrated rather than assumed.

**Also verified before the PR**

- `actionlint .github/workflows/*.yml` clean (the `workflow-lint` job gates this workflow edit).
- The four existing CI jobs still pass locally — especially `manifest`, since root `package.json`
  gains a `scripts` block.
- Root `npm test` works with no root `node_modules`, since it is the documented entry point.

## Acceptance criteria mapping

| AC (`pi-packages-xh2n`) | Satisfied by |
|---|---|
| A CI job runs the `test` script of every package that declares one, with that package's installed dependencies, failing on non-zero | `package-gates` matrix + `scripts/ci/package-gate.mjs`; stronger-than-`test` gates per decision 4 |
| Verified by a deliberately broken lint/format change: the job goes red (and a clean branch stays green) | push-break-revert end-to-end proof above |
| `AGENTS.md` documents that gates must run the installed binary, not `npx biome`, and why | §7 |
| No regression to the existing five CI jobs; `actionlint` still passes | local runs of all four pre-existing jobs + `actionlint` |

Additional criteria this design adds beyond the original AC (they follow from decisions 2, 3 and 5):

- every install in the gate is `npm ci` from a committed lockfile (no floating versions);
- the gated set is derived from `packages/*/package.json`, and a quarantine listing a non-existent or
  non-gated package warns rather than silently passing;
- `pi-superpowers-plus` runs `npm test`, not `npm run check` (asserted by a unit test);
- local and CI share one entry point.

## Files touched

- `scripts/ci/package-gate.mjs` (new)
- `scripts/ci/package-gate.test.mjs` (new)
- `.github/workflows/ci.yml` (`gates-list` + `package-gates` jobs)
- `.gitignore` (lockfile negation)
- `package.json` (root `scripts.test`)
- `mise.toml` (new — node 20)
- `AGENTS.md` (Running tests)
- `packages/{bifrost,hashline-edit,langfuse,pi-beads,statusline}/package-lock.json` (new)
- possibly `QUARANTINED` entries + filed beads, if the measurement finds a red suite
