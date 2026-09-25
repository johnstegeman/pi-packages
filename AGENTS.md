# AGENTS.md

Guidance for AI coding agents working in this repo.

## Repo layout

```
packages/
├── ayu/         – Ayu color scheme for Pi (Day, Dusk, Dark)
├── bifrost/     – Custom provider for Bifrost AI gateway
├── hashline-edit/ – Hash-anchored read/edit tool override, with opt-in grep
├── langfuse/    – Langfuse observability with Superpowers phase metadata
├── statusline/  – Single-line statusline footer with ayu/tokyo-night/classic presets
├── pi-beads/    – Fork of abix5/pi-beads (beads_* tools), wisp (--ephemeral) support
├── pi-subagents/  – Squashed git subtree of tintinweb/pi-subagents; upstream-tracked (do not hand-edit); synced nightly via .github/workflows/sync-pi-subagents.yml (opens a review PR). Manual sync: `git subtree pull --prefix packages/pi-subagents <url> master --squash`. The bot branch is persistent and never force-pushed; see .github/workflows/ci.yml for the manifest/dep-mirror/typecheck gate on PRs to main.
└── pi-superpowers-plus/ – Vendored Superpowers skills + set_phase + beads-molecule-widget extensions + agent templates
```

This is a monorepo of independent pi extensions/themes. Each package under
`packages/<name>/` has its own `package.json`, scripts, and tests. Run
package-scoped commands from inside that package's directory unless a root
script exists.

## Running tests

- **Everything, the way CI runs it:** `npm test` at the repo root. It runs
  `scripts/ci/package-gate.mjs --all`, the same script the `package-gates` CI job runs per
  package.
- **One package:** `node scripts/ci/package-gate.mjs <package>` (e.g. `... pi-beads`).
- **The inventory:** `node scripts/ci/package-gate.mjs --list` shows which gate each package
  runs; `--list --json` is what CI uses to build its matrix.

For each package the gate composes **each declared `check` / `typecheck` / `test` script, at
least once** — in the order `typecheck`, then lint/`check`, then tests. So a step can run twice: the
gate deliberately errs toward repeating a step rather than skipping one. The rule only knows those
three script names and infers coverage from script text, so it misses a standalone script nothing
references and can be fooled by a script that merely mentions an invocation (see the gate spec's
"Residual limitation"). Concretely,
`pi-superpowers-plus` runs `npm run check && npm test` (its `check` is lint-only, and its `test`
also lints — the lint runs twice, which is harmless), while `hashline-edit`, `statusline` and
`pi-subagents` run `npm run check`.

Installs are deterministic: every package has a committed `package-lock.json` and the gate
installs with `npm ci`, never a floating `npm install`. Add `npm ci` after changing a
package's dependencies and commit the updated lockfile.

The repo pins **node 22** in `mise.toml`, matching every CI job that installs a toolchain. If your
default `node` differs, run the gate under the pin (`mise exec node@22 -- npm test`) — node 20 in
particular cannot strip TypeScript or satisfy the installed `undici`, and fails five of the seven
suites for reasons that have nothing to do with the change you are testing.

A package that cannot pass yet is listed in the `QUARANTINED` constant in
`scripts/ci/package-gate.mjs` with a reason and a bead id. It then reports as `SKIPPED` in
every run and drops out of the CI matrix. There is no other exclusion mechanism, and nothing
is skipped silently.

### Never run `npx biome`

Use the package's installed binary — `./node_modules/.bin/biome`, `npm run check`, or
`npm test`. `npx biome` does **not** use the pinned devDependency: with no local
`node_modules` it resolves whatever cached copy is in `~/.npm/_npx/`, and several stale
versions sit there (`2.3.15`, `2.5.11`, `2.5.12` were all present at once). Those versions
disagree with the pinned one about formatting *and* rule severity.

This is not theoretical: on PR #62 a branch was reported as lint-clean by **four separate
task reviews plus the session controller**, all of which ran `npx biome check .`. The repo's
real gate — `biome check .` from the installed `node_modules`, as `npm test` runs it —
reported 4 errors (3 formatting, plus `noAssignInExpressions`) that had already been pushed.
Run `npm test` at the root, or install first and use the local binary.

### Sync-loop + dep-mirror checks (root)

The sync simulation and dep-mirror gate are root-level scripts. `npm test` (above) covers the
packages; these are separate and still run directly (they are also CI jobs):

```bash
npm install --no-save semver@^7 --prefix /tmp/depsmirror --silent
bash scripts/sim/simulate-sync.sh
NODE_PATH=/tmp/depsmirror/node_modules node scripts/ci/check-deps-mirror.mjs
NODE_PATH=/tmp/depsmirror/node_modules node --test scripts/ci/check-deps-mirror.test.mjs
```

### Statusline settings file isolation

The statusline extension persists its segment-visibility / icon settings to
`<getAgentDir()>/pi-statusline.json` (see `packages/statusline/src/settings.ts`),
which defaults to the real `~/.pi/agent/pi-statusline.json` on the machine
running the code. `packages/statusline/test/statusline.test.ts` isolates the
whole suite from this by pointing `PI_CODING_AGENT_DIR` at a temp directory
for the duration of the test run (see the top-level `before`/`after` hooks),
so the tests no longer read or mutate your real `pi-statusline.json`. No
manual renaming of any file is required to run the statusline tests.

## Adding a new package

1. Create `packages/<name>/`
2. Add `package.json` with a `"pi"` manifest pointing at the entry file(s)
3. Add your extension (`index.ts`) or theme/skill files
4. Register the new resources in the root `package.json` under
   `pi.extensions`, `pi.themes`, `pi.skills`, or `pi.prompts`

See the [pi packages docs](https://pi.dev/docs/packages) for the full API.
