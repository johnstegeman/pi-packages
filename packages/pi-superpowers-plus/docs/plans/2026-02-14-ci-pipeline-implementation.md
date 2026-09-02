# CI Pipeline Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add Biome linting/formatting and GitHub Actions CI (test + lint on push/PR, npm publish on tag).

**Architecture:** Three-phase setup: (1) add Biome with config and clean up existing code, (2) add CI workflow for tests + lint, (3) add publish workflow for tag-triggered npm releases. No `tsc` type checking — deferred to a future milestone.

**Tech Stack:** Biome 2.x, GitHub Actions, Node 22, vitest, npm

**Design doc:** `docs/plans/2026-02-14-ci-pipeline-design.md`

---

## Phase 1: Biome Setup & Codebase Cleanup

### Task 1: Install Biome and add config

**Files:**
- Modify: `package.json` (add dev dependency + scripts)
- Create: `biome.json`

**Step 1: Install Biome**

Run:
```bash
npm install --save-dev @biomejs/biome
```

**Step 2: Create `biome.json`**

Create `biome.json` at repo root:

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

**Step 3: Add convenience scripts to `package.json`**

Add to `"scripts"`:
```json
"lint": "biome check .",
"check": "biome check . && vitest run"
```

**Step 4: Commit**

```bash
git add package.json package-lock.json biome.json
git commit -m "chore: add Biome as dev dependency with config"
```

---

### Task 2: Run Biome auto-fix on codebase

**Files:**
- Modify: all `.ts` files in `extensions/` and `tests/` (formatting normalization)

**Step 1: Run Biome auto-fix**

Run:
```bash
npx biome check --write .
```

Review the output. This will:
- Normalize the 2 tab-indented files (`extensions/subagent/index.ts` and one other) to 2-space indentation
- Apply consistent formatting across all TypeScript files

**Step 2: Check for remaining lint errors**

Run:
```bash
npx biome check .
```

If there are lint errors that couldn't be auto-fixed, review each one and fix manually. These are typically:
- Unused imports
- Unnecessary type assertions
- Suspicious comparisons

Fix each error in the affected file. Do not suppress rules globally — fix the code or add inline `// biome-ignore` comments with a reason if the code is intentional.

**Step 3: Run tests to make sure formatting changes didn't break anything**

Run:
```bash
npx vitest run
```

Expected: All 274 tests pass.

**Step 4: Commit**

```bash
git add -A
git commit -m "style: format codebase with Biome"
```

---

## Phase 2: CI Workflow

### Task 3: Add CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Create the workflow file**

Create `.github/workflows/ci.yml`:

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

**Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add CI workflow (lint + tests on push/PR)"
```

---

## Phase 3: Publish Workflow

### Task 4: Add publish workflow

**Files:**
- Create: `.github/workflows/publish.yml`

**Step 1: Create the workflow file**

Create `.github/workflows/publish.yml`:

```yaml
name: Publish

on:
  push:
    tags: ["v*"]

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

**Step 2: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: add publish workflow (npm publish on v* tag)"
```

---

## Phase 4: Verification

### Task 5: Final verification

**Step 1: Run lint**

```bash
npx biome check .
```

Expected: No errors.

**Step 2: Run tests**

```bash
npx vitest run
```

Expected: All tests pass.

**Step 3: Verify workflow files are valid YAML**

```bash
cat .github/workflows/ci.yml | head -5
cat .github/workflows/publish.yml | head -5
```

Expected: Clean YAML, no syntax errors.

**Step 4: Push branch and verify CI runs**

```bash
git push origin feat/ci-pipeline
```

Then open a PR against `main` on GitHub and verify the CI workflow triggers and passes.

---

## Manual Follow-Up (Not Automatable)

After merging:
1. Add `NPM_TOKEN` secret to GitHub repo settings:
   - Go to repo → Settings → Secrets and variables → Actions
   - Add `NPM_TOKEN` with a valid npm access token for the `coctostan` account
2. Test the publish workflow by tagging a release:
   ```bash
   git tag v0.2.0
   git push --tags
   ```
