# CI Pipeline Design

**Date:** 2026-02-14
**Roadmap item:** v0.2.0 — CI Pipeline
**Status:** Ready for implementation

## Overview

Three GitHub Actions workflows with a Biome linter/formatter prerequisite. No `tsc --noEmit` type checking (deferred — no tsconfig, peer deps make CI type checking awkward).

## Decisions

- **Node 22 LTS only** — single version, no matrix
- **Biome moderate** — recommended lint rules + formatting, initial cleanup pass
- **Tag-triggered publish** — push `v*` tag to publish to npm
- **Spaces (2-wide)** — matches 53/55 existing files; Biome normalizes the 2 tab-indented files

## Workflows

### `ci.yml` — Tests & Lint

Runs on push to `main` and PRs targeting `main`.

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx biome check .
      - run: npx vitest run
```

Single job, Biome first (fail fast on formatting), then tests.

### `publish.yml` — npm Publish

Runs when a `v*` tag is pushed.

```yaml
name: Publish
on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npx vitest run
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Tests re-run as a safety gate. No Biome check (CI already passed on the commit). Requires `NPM_TOKEN` secret in repo settings.

## Biome Setup

### `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0/schema.json",
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 120
  },
  "linter": {
    "rules": {
      "recommended": true
    }
  },
  "files": {
    "ignore": ["node_modules", "docs", "*.md", "*.json"]
  }
}
```

### package.json scripts

```json
{
  "lint": "biome check .",
  "check": "biome check . && vitest run"
}
```

## Implementation Order

1. Generate `package-lock.json` (`npm install`, commit lockfile)
2. Add Biome as dev dependency (`npm install --save-dev @biomejs/biome`)
3. Add `biome.json` config
4. Run initial Biome cleanup (`npx biome check --write .`), manually review lint errors
5. Commit cleanup as single "format codebase with Biome" commit
6. Add `ci.yml` workflow
7. Add `publish.yml` workflow
8. Add `lint` and `check` scripts to `package.json`

### Manual setup (not automatable)

- Add `NPM_TOKEN` secret to GitHub repo settings
