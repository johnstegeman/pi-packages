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
├── pi-subagents/  – Vendored fork of tintinweb/pi-subagents (owned here; patched locally)
└── pi-superpowers-plus/ – Vendored Superpowers workflow skills + set_phase/beads-molecule-widget extensions + agent templates
```

packages/pi-superpowers-plus/ is a vendored copy of the Superpowers workflow skills,
the `set_phase` extension, and the `beads-molecule-widget` extension (now integrated
here) with the standalone repo deprecated — the whole monorepo install
(`pi install git:github.com/johnstegeman/pi-packages`) provides both the extensions and
the full Superpowers skill set.

## Vendored fork: pi-subagents

`packages/pi-subagents/` is a fork of `tintinweb/pi-subagents` (branch `master`) that this
repo owns and edits directly. There is no upstream sync and no subtree merge: changes are
made in-tree like any other package here. The divergences from upstream are recorded in
[`docs/pi-subagents-local-patch.md`](docs/pi-subagents-local-patch.md).

A CI workflow (`.github/workflows/ci.yml`, on any PR to `main` and push to `main`) validates
the root manifest, enforces that the package's runtime dependencies are mirrored in root
`package.json` with a compatible range, and runs the package's full gate (`npm run check`:
lint, `tsc --noEmit`, and the vitest suite) through the package-gate matrix.

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
