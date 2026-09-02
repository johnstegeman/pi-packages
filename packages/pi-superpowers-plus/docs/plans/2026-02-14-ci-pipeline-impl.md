# CI Pipeline Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add GitHub Actions CI (lint + test) and publish workflows, with Biome as the linter/formatter.

**Architecture:** Biome dev dependency with a `biome.json` config enforcing recommended lint rules and 2-space formatting. Two GitHub Actions workflows: `ci.yml` (push/PR to main → biome check + vitest) and `publish.yml` (tag push → test + npm publish). One-time Biome auto-fix commit to normalize existing code.

**Tech Stack:** Biome 2.x, GitHub Actions, Node 22, Vitest 4.x, npm

---

## Phase 1: Biome Setup & Codebase Cleanup

### Task 1: Install Biome

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `package-lock.json` (auto-updated by npm)

**Step 1: Install Biome as a dev dependency**

Run:
```bash
npm install --save-dev @biomejs/biome
```

**Step 2: Verify installation**

Run:
```bash
npx biome --version
```
Expected: Prints a version like `2.x.x`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add biome as dev dependency"
```

---

### Task 2: Add Biome config

**Files:**
- Create: `biome.json`

**Step 1: Create `biome.json`**

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

**Step 2: Dry-run Biome to see what it would change**

Run:
```bash
npx biome check .
```
Expected: Output listing lint warnings and formatting issues. Non-zero exit code.

**Step 3: Commit config only (not fixes yet)**

```bash
git add biome.json
git commit -m "chore: add biome.json config"
```

---

### Task 3: Run Biome auto-fix and review

**Files:**
- Modify: all `.ts` files under `extensions/` and `tests/` (auto-formatted)
- Modify: `vitest.config.ts` (auto-formatted)

**Step 1: Run Biome auto-fix**

Run:
```bash
npx biome check --write .
```
Expected: Reports files changed. Some lint errors may remain if they can't be auto-fixed.

**Step 2: Check for remaining lint errors**

Run:
```bash
npx biome check .
```
Expected: Clean (exit 0). If not, read the errors and fix manually — most likely `noExplicitAny` or similar. If a rule is too noisy, suppress it in `biome.json` under `linter.rules` (e.g. `"suspicious": { "noExplicitAny": "off" }`), then re-run `npx biome check --write .`.

**Step 3: Run tests to ensure nothing broke**

Run:
```bash
npx vitest run
```
Expected: 274 tests pass (35 files), same as before.

**Step 4: Commit the cleanup**

```bash
git add -A
git commit -m "style: format codebase with biome"
```

---

## Phase 2: GitHub Actions Workflows

### Task 4: Add CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Create the CI workflow file**

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

**Step 2: Validate YAML syntax**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo "YAML valid"
```
Expected: `YAML valid`

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add CI workflow (lint + test)"
```

---

### Task 5: Add publish workflow

**Files:**
- Create: `.github/workflows/publish.yml`

**Step 1: Create the publish workflow file**

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

**Step 2: Validate YAML syntax**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/publish.yml'))" && echo "YAML valid"
```
Expected: `YAML valid`

**Step 3: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: add publish workflow (tag-triggered npm publish)"
```

---

### Task 6: Add npm scripts and final verification

**Files:**
- Modify: `package.json` (scripts section)

**Step 1: Add `lint` and `check` scripts to `package.json`**

In the `"scripts"` section, add two entries so it becomes:

```json
"scripts": {
  "test": "vitest run",
  "lint": "biome check .",
  "check": "biome check . && vitest run"
}
```

**Step 2: Verify `npm run lint` works**

Run:
```bash
npm run lint
```
Expected: Exit 0, clean output.

**Step 3: Verify `npm run check` works**

Run:
```bash
npm run check
```
Expected: Biome passes, then 274 tests pass. Exit 0.

**Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add lint and check npm scripts"
```

---

## Post-Implementation Notes

### Manual setup required (not part of this plan)
- Add `NPM_TOKEN` secret to the GitHub repo settings (Settings → Secrets → Actions → New repository secret)

### Verifying CI works
After merging this branch to `main`, the CI workflow should trigger automatically. Verify it passes in the Actions tab.
