# pi-packages

Personal monorepo of [pi](https://pi.dev) extensions and themes.

## Packages

```
packages/
├── ayu/            – Ayu color scheme for Pi (Day, Dusk, Dark)
├── bifrost/        – Custom provider for Bifrost AI gateway
├── hashline-edit/  – Hash-anchored read/edit tool override, with opt-in grep
├── langfuse/       – Langfuse observability with Superpowers phase metadata
├── statusline/     – Single-line statusline footer with ayu/tokyo-night/classic presets
├── pi-beads/       – Fork of abix5/pi-beads (beads_* tools) with wisp (--ephemeral) support in beads_create
├── pi-subagents/  – vendored fork via squashed git subtree of tintinweb/pi-subagents (auto-synced nightly via PR)
└── pi-superpowers-plus/ – Vendored Superpowers workflow skills + set_phase/beads-molecule-widget extensions + agent templates
```

packages/pi-superpowers-plus/ is a vendored copy of the Superpowers workflow skills,
the `set_phase` extension, and the `beads-molecule-widget` extension (now integrated
here) with the standalone repo deprecated — the whole monorepo install
(`pi install git:github.com/johnstegeman/pi-packages`) provides both the extensions and
the full Superpowers skill set.

## Upstream-tracked subtree: pi-subagents

`packages/pi-subagents/` is a squashed [git subtree](https://git-scm.com/book/en/v2/Git-Tools-Subtree-Merging)
of `tintinweb/pi-subagents` (branch `master`). It is **upstream-tracked — do not hand-edit
files inside it**; local edits will conflict with the next sync.

A nightly GitHub Action (`.github/workflows/sync-pi-subagents.yml`, 04:00 UTC + manual
`workflow_dispatch`) runs `git subtree pull` on a `bot/update-pi-subagents` branch and opens a
review PR when upstream changes. Merge it to accept the update. No changes are ever pushed to
`main` or auto-merged.

## Install from GitHub

Install the full collection (all extensions + themes) from GitHub:

```bash
pi install git:github.com/johnstegeman/pi-packages
```

Or install for a single run only:

```bash
pi -e git:github.com/johnstegeman/pi-packages
```

Pin to a specific tag or commit:

```bash
pi install git:github.com/johnstegeman/pi-packages@v0.1.0
```

### Install only one package

If you only want one of the packages, point pi at its subdirectory using a local path:

```bash
pi install /path/to/pi-packages/packages/ayu
pi install /path/to/pi-packages/packages/bifrost
pi install /path/to/pi-packages/packages/langfuse
```

## Install from a local clone

```bash
pi install ./  # from inside the repo root
```

## Adding a new package

1. Create `packages/<name>/`
2. Add `package.json` with a `"pi"` manifest pointing at the entry file(s)
3. Add your extension (`index.ts`) or theme/skill files
4. Register the new resources in the root `package.json` under `pi.extensions`, `pi.themes`, `pi.skills`, or `pi.prompts`

See the [pi packages docs](https://pi.dev/docs/packages) for the full API.
