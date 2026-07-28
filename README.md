# pi-packages

Personal monorepo of [pi](https://pi.dev) extensions and themes.

## Packages

```
packages/
├── ayu/         – Ayu color scheme for Pi (Day, Dusk, Dark)
├── bifrost/     – Custom provider for Bifrost AI gateway
└── statusline/  – Single-line statusline footer with ayu/tokyo-night/classic presets
```

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
