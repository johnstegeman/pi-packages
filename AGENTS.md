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

- Per-package tests: `cd packages/<name> && npm test`
- Statusline tests: `cd packages/statusline && npm test`
- Langfuse tests: `cd packages/langfuse && npm install` once for runtime dependencies, then `npm test`; the root workspace does not install those dependencies.
- pi-beads has no automated tests (widget tests removed).

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
