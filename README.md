# pi-packages

Personal monorepo of [pi](https://pi.dev) extensions.

## Structure

```
packages/
└── bifrost/   – Custom provider for Bifrost AI gateway
```

## Installing an extension

Point pi at the package directory using a local path in your global settings
(`~/.pi/agent/settings.json`):

```json
{
  "packages": [
    "/path/to/pi-packages/packages/bifrost"
  ]
}
```

Or install it for a single run:

```bash
pi -e /path/to/pi-packages/packages/bifrost
```

## Adding a new extension

1. Create `packages/<name>/`
2. Add `package.json` with a `"pi"` manifest pointing at the entry file
3. Add `index.ts`

See the [pi extension docs](https://pi.dev/docs/extensions) for the full API.
