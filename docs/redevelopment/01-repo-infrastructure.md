# 01 — Repo-level infrastructure inventory

Root-level features of the current monorepo that are candidates to carry into the
new repo (or consciously drop). These exist outside any single package.

## 1. Packaging & registration

1. **Root `pi` manifest** (`package.json` → `pi` field) registers every resource:
   - `pi.extensions`: one entry per extension entry file. Notable: pi-beads registers
     **two** files (`src/index.ts` and `src/cost-tracking.ts` — cost tracking is a
     separately-registered extension in the same package); pi-superpowers-plus
     registers a **directory** (`extensions/`).
   - `pi.themes`, `pi.skills` (directories: `pi-beads/skills`,
     `pi-superpowers-plus/skills`), `pi.prompts`.
2. **Each package is independently installable**: own `package.json`, own committed
   `package-lock.json`, own scripts. A subdirectory install (`pi install <path>`)
   must keep working for single-package use.
3. **Peer dependencies** declared at root: `@earendil-works/pi-coding-agent`,
   `pi-ai`, `pi-tui`, `@sinclair/typebox`/`typebox` — the extension API surface.
   Runtime deps of vendored packages (croner, nanoid, …) mirrored at root (see §3).
4. **Install story** (README): `pi install git:github.com/johnstegeman/pi-packages`,
   `-e` for single run, `@tag` pinning, local-path installs, subdirectory installs.

## 2. Package gate (`scripts/ci/package-gate.mjs` + `package-gate.test.mjs`)

A meta-CI that guarantees no package's declared lint/typecheck/test suite can go
unrun. Features, precisely:

1. **Auto-discovery**: every directory under `packages/` with a `package.json` is
   inventory-scanned. A package "is gated" iff it declares a non-empty `test` script.
2. **Gate composition rule** (`selectGate`): for each gated package, compose the
   declared `check` / `typecheck` / `test` scripts so each runs **at least once**, in
   order typecheck → check → tests. Running a step twice is deliberate (errs toward
   repetition over skipping). Only exception: `typecheck` is dropped when `check` or
   `test` already invokes it (detected by script-text matching `npm <target>` /
   `npm run <target>` with a negative lookahead so `test:coverage` doesn't count).
   Documented residual limitation: coverage is inferred from script text, so a
   standalone script nothing references is missed, and a script that merely
   *mentions* an invocation can suppress a step.
3. **Execution**: per package, `npm ci --no-audit --no-fund` (committed lockfile,
   never a floating install, **never `npx`** — the `npx biome` false-green incident
   on PR #62 is the canonical cautionary tale, recorded in AGENTS.md) then the
   composed gate, via `execFileSync` (no shell), 64 MB output buffer, last-25-line
   output tail on failure.
4. **Quarantine** (`QUARANTINED` constant): a package that can't pass yet is listed
   with a reason AND a bead id; reported as SKIPPED on every run; an entry naming a
   non-gated package emits a rot warning so the list can't silently rot. Unreadable
   manifest ⇒ the package FAILs alone (never aborts the scan, never silently
   omitted).
5. **CLI surface**: `--all`, `<package>`, `--list [--json]` (bare JSON array on
   stdout for CI's `fromJSON()`; failures named on stderr; exit codes 0/1/2 for
   pass/fail/usage).
6. **Self-test suite** (`package-gate.test.mjs`) pins the composed gate of **every
   real package** — adding a package with a `test` script, or changing a gate, fails
   the self-test (the `codemode-bootstrap` regression this was built to catch).

## 3. Dep-mirror gate (`scripts/ci/check-deps-mirror.mjs` + test)

Pi loads extensions from the repo root, so the **root** `package.json` must install
what a vendored package's code imports. The gate checks every runtime dependency of
`packages/pi-subagents` exists in root `dependencies` with a semver-intersecting
range. Runs in CI with a throwaway `semver` install under `/tmp/depsmirror` +
`NODE_PATH` (exit code 2 with a helpful message when semver isn't resolvable).
Currently hardcodes pi-subagents; a new repo should generalize or drop it depending
on Q4 (monorepo shape).

## 4. CI (`.github/workflows/ci.yml`)

Five jobs: (1) **manifest** — root manifest parses and every registered
extensions/themes/skills/prompts path exists; (2) **deps-mirror**; (3)
**gate-selftest** (node 22); (4) **workflow-lint** — actionlint, pinned v1.7.12,
checksum-verified download; (5) **package-gates** — matrix built from
`--list --json`, per-package `npm ci` + gate, `fail-fast: false`, npm caching keyed
on the package's lockfile. Concurrency group with cancel-in-progress; least
privilege (`permissions: contents: read`).

## 5. Toolchain & hygiene

1. **Node 22 pinned** via `mise.toml` (all CI jobs match). Node 20 cannot strip TS
   or satisfy installed `undici` — documented in AGENTS.md.
2. **`.gitignore` policy**: root lockfile ignored, per-package lockfiles **not**
   (`!packages/*/package-lock.json`); `.worktrees/`, `.superpowers/`, beads/Dolt
   artifacts (`.dolt/`, `*.db`, `.beads-credential-key`, `.beads/proxieddb/`,
   `.beads/interactions.jsonl`).
3. **AGENTS.md as doctrine**: repo layout, test-running rules, the never-`npx-biome`
   rule, per-package quirks (e.g. statusline test isolation via
   `PI_CODING_AGENT_DIR`), new-package checklist.
4. **Design docs**: `docs/superpowers/specs/` and `plans/` hold ~90 dated design
   specs — the full decision history. Post beads-as-persistence-layer, plan files
   were retired in favor of beads molecules; specs remain as diffable prose files
   (see 07 §formula). Root docs also: `beads-dolt-server.md` (opt-in shared Dolt
   server for multi-worktree write contention),
   `pi-extension-args-contract.md` (tool-args strictness contract — read before
   designing any new tool), `pi-subagents-local-patch.md` (fork divergences).
5. **Fixtures**: `scripts/fixtures/workspace-key-vectors.json` — shared test vectors
   for workspace-key derivation (path → stable key), consumed by pi-beads and the
   molecule-widget tests.

## 6. Beads workspace conventions (environment, not code)

1. Umbrella model: `bd repo list` maps multiple project repos into one tracker;
   issue ids are namespaced per repo (e.g. `pi-packages-*`); the pi-beads tools
   auto-route writes to the owning repo by id prefix (see 05).
2. Embedded Dolt by default; exclusive-lock contention across worktrees is a known
   operational property (docs + widget backoff behavior exist); opt-in shared Dolt
   server documented.
3. `bd init --skip-hooks` — no git hooks; `.beads/` is not committed.
