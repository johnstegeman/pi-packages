# pi-superpowers-plus Vendor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor the user's own `pi-superpowers-plus` package — the full tracked tree (13 superpowers skills, the `set_phase` extension, the newer `beads-molecule-widget` extension, agent templates, docs, formulas, banners, and all metadata) — into this monorepo as `packages/pi-superpowers-plus/`, register it in the root manifest, and document it. The standalone repo is then deprecated: one `pi install git:...pi-packages` delivers the entire superpowers setup (self-contained: `pi-beads` + `pi-subagents` dependencies are already in this monorepo).

**Architecture:** A one-shot vendored copy (NOT a subtree, NOT an auto-synced package — the origin repo is being deprecated, so there is no upstream to follow; this matches the existing `pi-beads` convention). Content is a faithful copy of the origin repo's canonical `main` (origin `58795ca`) via `git archive` (guarantees committed content only; `node_modules` is untracked and drops out automatically) into `packages/pi-superpowers-plus/`. The nested `package.json` is a copy of origin's manifest with exactly two overrides — `repository` and `homepage` point at this monorepo; `author` attribution is preserved. Root `package.json` registers the extension directory and skills directory. This fold-in happens on the SAME branch (`johnstegeman/fold-in-subagents`) before the final whole-branch review, so one final review + one PR covers both fold-ins.

**Tech Stack:** `git archive` + `tar` for provenance-sound copying, JSON manifest editing, Markdown docs.

## Global Constraints

- Vendor from `git -C <src> archive origin/main`, where `<src>` = `/Users/jstegeman/.pi/agent/git/github.com/johnstegeman/pi-superpowers-plus`. The local working tree there is 28 commits STALE — never copy from the working tree or from `HEAD`; always `origin/main` (pinned SHA `58795ca`).
- **Vendor EVERYTHING tracked on `origin/main`** (approved; supersedes an earlier lean-content idea): all 124 tracked files — `skills/` (13 dirs), `extensions/` (4 files: `set-phase.ts` AND `beads-molecule-widget.ts`/`.mjs`/`.test.mjs`), `agent-templates/`, `docs/`, `formulas/`, `banner.jpg`, `banner-plus.jpg`, `CHANGELOG.md`, `ROADMAP.md`, `CONTRIBUTING.md`, `biome.json`, `package-lock.json`, `.github/`, `.gitignore`, `README.md`, `LICENSE`, `package.json`. Nothing tracked is excluded.
- `node_modules` is NOT tracked and must NOT appear (verify its absence after extraction). No nested `.git` either.
- Do **not modify** vendored content inside `packages/pi-superpowers-plus/` except `package.json` — everything else is a verbatim snapshot.
- `packages/pi-superpowers-plus/package.json` = origin's manifest with EXACTLY two overrides: `repository` → `https://github.com/johnstegeman/pi-packages.git` and `homepage` → `https://github.com/johnstegeman/pi-packages#readme`. Preserve `name`, `version`, `description`, `author`, `license`, `keywords`, `files`, `scripts`, `devDependencies`, `peerDependencies`, and the `"pi"` block (`extensions: ["./extensions"]`, `skills: ["skills"]`) verbatim.
- Root `package.json` additions: `pi.extensions` += `"./packages/pi-superpowers-plus/extensions"`; `pi.skills` += `"./packages/pi-superpowers-plus/skills"` (keep the existing `"./packages/pi-beads/skills"` entry).
- The extension directory is registered as a whole (`./extensions`), so both `set-phase.ts` and `beads-molecule-widget.ts` load automatically. The monorepo already satisfies the package's deps: root `dependencies` has `typebox` (from the pi-subagents plan, Task 2) and root `peerDependencies` has `@earendil-works/pi-coding-agent`. No new deps are added.
- Work on branch `johnstegeman/fold-in-subagents`; default branch of the repo is `main`.

---

### Task 1: Vendor pi-superpowers-plus into packages/

Copies the entire tracked tree of the origin repo's `main` into `packages/pi-superpowers-plus/` and repoints its manifest metadata.

**Files:**
- Create: `packages/pi-superpowers-plus/**` — the full tracked tree of origin `main` (124 files, all verbatim)
- Create (authored): `packages/pi-superpowers-plus/package.json` (origin's manifest with `repository`/`homepage` overridden)

**Interfaces:**
- Consumes: the origin clone at `/Users/jstegeman/.pi/agent/git/github.com/johnstegeman/pi-superpowers-plus` (ref `origin/main`, SHA `58795ca`).
- Produces: the package directory consumed by Task 2 (root manifest registration) and Task 3 (docs).

- [ ] **Step 1: Confirm source and destination state**

```bash
SRC=/Users/jstegeman/.pi/agent/git/github.com/johnstegeman/pi-superpowers-plus
git -C "$SRC" rev-parse origin/main          # expect 58795ca (or note any newer SHA + date)
git rev-parse --abbrev-ref HEAD               # expect johnstegeman/fold-in-subagents
git status --porcelain                        # clean
```

Expected: `origin/main` at `58795ca`; local branch `johnstegeman/fold-in-subagents`; clean tree. If `origin/main` is a NEWER SHA (someone pushed since), continue — record the actual SHA and its `git log -1 --format='%h %ad %s'` in the report; the copy must come from the fetched `origin/main`, never `HEAD`/working tree.

- [ ] **Step 2: Extract the full tracked tree from origin/main**

```bash
SRC=/Users/jstegeman/.pi/agent/git/github.com/johnstegeman/pi-superpowers-plus
mkdir -p packages/pi-superpowers-plus
git -C "$SRC" archive origin/main | tar -x -C packages/pi-superpowers-plus
```

Expected: exit 0. `packages/pi-superpowers-plus/` now contains the full tracked tree: `skills/` (13 dirs), `extensions/` (4 files — `set-phase.ts` AND `beads-molecule-widget.ts`/`.mjs`/`.test.mjs`), `agent-templates/` (4), `docs/`, `formulas/`, `banner.jpg`, `banner-plus.jpg`, `CHANGELOG.md`, `ROADMAP.md`, `CONTRIBUTING.md`, `biome.json`, `package-lock.json`, `.github/`, `.gitignore`, `README.md`, `LICENSE`, `package.json`. Confirm `node_modules` and `.git` are ABSENT.

- [ ] **Step 3: Read the origin manifest**

```bash
SRC=/Users/jstegeman/.pi/agent/git/github.com/johnstegeman/pi-superpowers-plus
git -C "$SRC" show origin/main:package.json
```

This is the manifest you will copy (with the two overrides).

- [ ] **Step 4: Author `packages/pi-superpowers-plus/package.json`**

Copy origin's manifest verbatim and apply EXACTLY two changes:
- `repository.url` → `https://github.com/johnstegeman/pi-packages.git`
- `homepage` → `https://github.com/johnstegeman/pi-packages#readme`

Everything else stays byte-for-byte: `name`, `version`, `description`, `keywords`, `author`, `license`, `files`, `scripts`, `devDependencies`, `peerDependencies`, and the `"pi"` block (`"extensions": ["./extensions"]`, `"skills": ["skills"]`).

Do NOT "clean up" the manifest, drop `files`/`scripts`/`devDependencies`, or reformat it.

- [ ] **Step 5: Verify**

```bash
python3 -m json.tool packages/pi-superpowers-plus/package.json >/dev/null && echo "valid JSON"
grep -q '"pi-superpowers-plus"' packages/pi-superpowers-plus/package.json && echo "name preserved"
grep -q 'pi-packages.git' packages/pi-superpowers-plus/package.json && echo "repository overridden"
ls packages/pi-superpowers-plus/extensions        # expect beads-molecule-widget.mjs/.test.mjs/.ts set-phase.ts
grep -q "set_phase" packages/pi-superpowers-plus/extensions/set-phase.ts && echo "set_phase present"
grep -q "beads-molecule-widget" packages/pi-superpowers-plus/extensions/beads-molecule-widget.ts && echo "widget present"
echo "skills dirs: $(ls packages/pi-superpowers-plus/skills | wc -l | tr -d ' ')"   # expect 13
test ! -e packages/pi-superpowers-plus/node_modules && echo "node_modules absent (good)"
ls packages/pi-superpowers-plus                     # full top-level listing
```

Expected: "valid JSON"; "name preserved"; "repository overridden"; the 4 extension files; "set_phase present"; "widget present"; `13`; "node_modules absent (good)"; a listing with all the tracked top-level entries and nothing else.

- [ ] **Step 6: Commit**

```bash
git add packages/pi-superpowers-plus
git commit -m "chore: vendor pi-superpowers-plus (skills, set-phase + beads-molecule-widget extensions, agent templates, docs) into packages/"
```

Expected: commit succeeds; `git status --porcelain` clean; the commit contains ONLY the new `packages/pi-superpowers-plus/**` files.

---

### Task 2: Register pi-superpowers-plus in the root manifest

Wires the vendored package into the installable collection.

**Files:**
- Modify: `package.json` (root) — `pi.extensions` and `pi.skills`

**Interfaces:**
- Consumes: `packages/pi-superpowers-plus/extensions` and `packages/pi-superpowers-plus/skills` (from Task 1).
- Produces: a root manifest that loads the superpowers skills + `set_phase` + `beads-molecule-widget` (the `./extensions` registration loads the whole dir) along with the existing packages; used by pi at install/run time.

- [ ] **Step 1: Add the extension directory to `pi.extensions`**

In root `package.json`, the `"extensions"` array currently ends with `"./packages/pi-subagents/src/index.ts"`. Append `"./packages/pi-superpowers-plus/extensions"` as the new last element (keep all existing entries byte-for-byte).

- [ ] **Step 2: Add the skills directory to `pi.skills`**

The root `"skills"` array is currently `["./packages/pi-beads/skills"]`. Add `"./packages/pi-superpowers-plus/skills"` as the second element (keep `pi-beads/skills`).

- [ ] **Step 3: Verify**

```bash
python3 -m json.tool package.json >/dev/null && echo "valid JSON"
grep -c '"\./packages/pi-superpowers-plus/extensions"' package.json        # expect 1
grep -c '"\./packages/pi-superpowers-plus/skills"' package.json             # expect 1
test -d packages/pi-superpowers-plus/extensions && test -d packages/pi-superpowers-plus/skills && echo "dirs exist"
grep -n 'pi-superpowers-plus' package.json
```

Expected: "valid JSON"; `1`; `1`; "dirs exist"; the two registrations visible.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: register pi-superpowers-plus skills and extensions in root manifest"
```

Expected: commit succeeds; only root `package.json` staged.

---

### Task 3: Docs + end-to-end verification

Documents the new package and verifies the whole change set (both fold-ins) is coherent.

**Files:**
- Modify: `README.md`, `AGENTS.md`

**Interfaces:**
- Consumes: the registered package (Task 2).
- Produces: accurate docs and a verified, ready-to-push branch.

- [ ] **Step 1: Add pi-superpowers-plus to the README package list**

In the `README.md` packages tree (currently ending with `└── pi-subagents/ ...`), add a new final line for pi-superpowers-plus and swap the glyph on the pi-subagents line:

```text
├── pi-subagents/      – Squashed git subtree of tintinweb/pi-subagents (auto-synced nightly via PR)
└── pi-superpowers-plus/ – Vendored Superpowers workflow skills + set_phase/beads-molecule-widget extensions + agent templates
```

Take the EXACT current `pi-subagents/` line as-is and change its leading `└──` to `├──`; the new pi-superpowers-plus line gets `└──` (exactly one `└──`, on the final line).

- [ ] **Step 2: Add a one-line README note**

In the existing "Upstream-tracked subtree: pi-subagents" section (or directly under the package list), add:

```markdown
`packages/pi-superpowers-plus/` is a vendored copy of the Superpowers workflow skills,
the `set_phase` extension, and the `beads-molecule-widget` extension (now integrated
here) with the standalone repo deprecated — the whole monorepo install
(`pi install git:github.com/johnstegeman/pi-packages`) provides both the extensions and
the full Superpowers skill set.
```

Adjust to fit the file's existing style; do not restructure existing sections.

- [ ] **Step 3: Add the package to the AGENTS.md layout**

In the `AGENTS.md` `packages/` tree (currently ending with `└── pi-subagents/`), apply the same glyph swap and add:

```markdown
└── pi-superpowers-plus/ – Vendored Superpowers skills + set_phase + beads-molecule-widget extensions + agent templates
```

(with the existing pi-subagents line's `└──` changed to `├──`).

- [ ] **Step 4: Verify the doc edits**

```bash
grep -n "pi-superpowers-plus" README.md AGENTS.md
grep -c '└──' README.md        # expect 1 (the final tree line)
grep -c '└──' AGENTS.md        # expect 1
```

Expected: each grep shows the new lines; each file has exactly one `└──`.

- [ ] **Step 5: End-to-end verification**

```bash
git status --porcelain                             # clean
git log --oneline -12
echo "vendored skills dirs: $(ls packages/pi-superpowers-plus/skills | wc -l | tr -d ' ')"
test -f packages/pi-superpowers-plus/extensions/set-phase.ts && echo "set-phase OK"
test -f packages/pi-superpowers-plus/extensions/beads-molecule-widget.ts && echo "widget OK"
python3 -m json.tool package.json >/dev/null && python3 -m json.tool packages/pi-superpowers-plus/package.json >/dev/null && echo "both manifests valid"
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/sync-pi-subagents.yml'); puts 'workflow YAML still valid'"
```

Expected: clean; the commit list shows the pi-subagents work (design/plan + 8 task commits) plus this plan's Tasks 1/2/3 commits; 13 vendored skill dirs; set-phase OK; widget OK; both manifests valid; workflow YAML unchanged and valid.

- [ ] **Step 6: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document vendored pi-superpowers-plus package in README and AGENTS"
```

Expected: commit succeeds; clean tree.

---

## Verification

- [ ] `packages/pi-superpowers-plus/` contains the full 124-file tracked tree (skills/, extensions/ incl. `beads-molecule-widget`, agent-templates/, docs/, formulas/, banners, all top-level files); no `node_modules`, no nested `.git`.
- [ ] Vendored content untouched; nested `package.json` valid with origin's `name`/`version`/`author`/`peerDependencies`/`scripts`/`files`/`pi` preserved and `repository`/`homepage` overridden to this monorepo.
- [ ] Root manifest registers `./packages/pi-superpowers-plus/extensions` and `./packages/pi-superpowers-plus/skills`; valid JSON.
- [ ] README + AGENTS list the package; each tree has exactly one `└──`.
- [ ] Working tree clean on `johnstegeman/fold-in-subagents`; both fold-ins committed.

## Notes

- **Why vendored, not subtree/synced:** the origin repo is being deprecated by the user, so there is no live upstream to follow; this matches the existing `pi-beads` (plain vendored copy) convention, unlike `pi-subagents` (upstream-tracked subtree with nightly sync).
- **Scope = everything (approved):** the full tracked tree is vendored, including `docs/`, `formulas/`, banners, `CHANGELOG.md`/`ROADMAP.md`, `biome.json`, `package-lock.json`, and `.github/`. The nested `.github/` is inert (GitHub Actions only reads the repo-root `.github/workflows/`); it is kept for faithful provenance. `node_modules` was never tracked and does not land.
- **Dependency satisfaction:** the skills consume `beads_*` tools (provided by `packages/pi-beads`) and `Agent`/`SubagentWorkflow` (provided by `packages/pi-subagents`) — all in this monorepo. `set-phase.ts` and `beads-molecule-widget.ts` import `@earendil-works/pi-coding-agent` (+ `typebox` for set-phase), already declared at the monorepo root. A single `pi install` is therefore self-contained.
- **Manual follow-up (outside this repo, like pi-subagents):** remove the standalone `pi-superpowers-plus` source from the user's global pi config so skills/extensions load once (from the monorepo).
- **Out of scope:** editing vendored content; a sync workflow (none needed for a deprecated, one-shot copy).
