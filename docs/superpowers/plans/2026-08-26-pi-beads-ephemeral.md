# pi-beads Ephemeral (Wisp) Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor `abix5/pi-beads` into this monorepo as `packages/pi-beads/` and extend its `beads_create` tool with an `ephemeral` parameter that passes `--ephemeral` to `bd create`, creating wisps.

**Architecture:** Copy the upstream extension source verbatim into a new `packages/pi-beads/` package (owned by this repo, no upstream sync link), register its extension + bundled `beads` skill in the root `pi` manifest, then make a minimal in-place edit to the `beads_create` tool: one new boolean/`"true"` parameter and one `args.push("--ephemeral")` line. Docs (bundled SKILL.md, root README/AGENTS) are updated to reflect the new capability.

**Tech Stack:** TypeScript extension for pi (`pi.registerTool`), `node:test` for the vendored widget tests, `bd` CLI 1.2.2 (the `--ephemeral` flag is already available), plain markdown for the bundled skill.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-26-pi-beads-ephemeral-design.md`:

- Vendored fork (approach A): code is copied into the monorepo and owned by it; no upstream sync link.
- Vendored `package.json` keeps the `@abix5/pi-beads` name; its `pi.extensions` / `pi.skills` manifest is retained so a standalone path install (`pi install ./packages/pi-beads`) works.
- Root `package.json` `pi` manifest additions: `extensions` += `"./packages/pi-beads/src/index.ts"`; add new key `"skills": ["./packages/pi-beads/skills"]`.
- `ephemeral` behavior: `true` or the string `"true"` → pass `--ephemeral`; anything falsy/absent → no flag. No flag value is rejected.
- Out of scope: `--wisp-type`, `--estimate`, TTL options, and any read/list/show behavior changes.
- Keep everything else in `beads_create` unchanged (repo routing, other flags, `afterWrite`).
- Do not commit `node_modules/`, `package-lock.json`, `*.js.map`, or `dist/` (root `.gitignore` already ignores them; the vendored clone has none).

---

### Task 1: Vendor pi-beads upstream and register it in the root manifest

**Files:**
- Create: `packages/pi-beads/` (full tree cloned from upstream, `.git` removed)
- Modify: `package.json` (root, `pi` manifest)

**Interfaces:**
- Consumes: nothing.
- Produces: `packages/pi-beads/src/index.ts` (the extension entry loaded by pi), `packages/pi-beads/skills/beads/SKILL.md` (bundled skill), and `packages/pi-beads/package.json` whose `"pi"` manifest is `{"extensions": ["./src/index.ts"], "skills": ["./skills"]}` (used by later tasks' standalone installs). Root `package.json` `pi.extensions` and `pi.skills` now reference the vendored package.

- [ ] **Step 1: Clone upstream into the package directory**

Run from the repo root:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/add-wisps
git clone --depth 1 https://github.com/abix5/pi-beads.git packages/pi-beads
```

Expected: a shallow clone appears at `packages/pi-beads/`.

- [ ] **Step 2: Strip the vendored git history so the monorepo owns the code**

```bash
rm -rf packages/pi-beads/.git
```

- [ ] **Step 3: Verify the vendored tree**

```bash
cd packages/pi-beads && find . -type f | sort
```

Expected files: `LICENSE`, `Makefile`, `README.md`, `SPEC-ui.md`, `package.json`, `scripts/widget-shots.mjs`, `skills/beads/SKILL.md`, `src/index.ts`, `src/widget-lines.mjs`, `src/widget-lines.test.mjs`, `docs/assets/*.png`, `docs/shots.tape`, `.gitignore`. Confirm **no** `node_modules/` and **no** `package-lock.json` are present (they would still be git-ignored by the root `.gitignore`, but should not have been created).

- [ ] **Step 4: Register the extension and skill in the root `pi` manifest**

Edit `/Users/jstegeman/orca/workspaces/pi-packages/add-wisps/package.json` so the `"pi"` block reads exactly:

```json
  "pi": {
    "extensions": [
      "./packages/bifrost/index.ts",
      "./packages/statusline/src/statusline.ts",
      "./packages/hashline-edit/src/index.ts",
      "./packages/langfuse/index.ts",
      "./packages/pi-beads/src/index.ts"
    ],
    "themes": ["./packages/ayu/themes"],
    "skills": ["./packages/pi-beads/skills"]
  }
```

- [ ] **Step 5: Run the vendored package tests**

```bash
cd packages/pi-beads && npm test
```

Expected: 2 passing tests (from `src/widget-lines.test.mjs`, `node --test`).

- [ ] **Step 6: Confirm the root manifest parses**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/add-wisps && node -e "const p=require('./package.json'); console.log(p.pi.extensions.includes('./packages/pi-beads/src/index.ts'), JSON.stringify(p.pi.skills))"
```

Expected first value: `true` (extension registered). Expected second value:
`["./packages/pi-beads/skills"]` (skills key added).


- [ ] **Step 7: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/add-wisps
git add packages/pi-beads package.json
git commit -m "feat(pi-beads): vendor abix5/pi-beads and register extension + skill"
```

---

### Task 2: Add the `ephemeral` parameter to `beads_create`

**Files:**
- Modify: `packages/pi-beads/src/index.ts` — the `beads_create` tool: parameters block (upstream line ~750, the `design` property) and arg builder (upstream line ~776, the `if (params.design) ...` line)

**Interfaces:**
- Consumes: the vendored `src/index.ts` from Task 1 (unchanged otherwise).
- Produces: a `beads_create` tool whose accepted params now include `ephemeral` (boolean or string `"true"`/`"false"`); when truthy, the constructed `bd create` argv contains `--ephemeral`. Later tasks (Task 3) document this param in the bundled skill.

The `beads_create` registration opens with:

```ts
  pi.registerTool({
    name: TOOL.create,
    label: "Beads create",
    description: "Create a beads issue in the OWNING repo. Pass `repo` (folder name or id prefix) to choose the project; if omitted, the repo containing the session cwd is used. Returns the new id. Use BEFORE starting non-trivial work.",
```

- [ ] **Step 1: Add the `ephemeral` property to the create tool's `parameters.properties`**

In `packages/pi-beads/src/index.ts`, inside the `beads_create` tool, in the `parameters.properties` object, directly after the `design` property (the line `design: { type: "string", description: "Optional design notes" },`) and before the closing `},` of `properties`, insert exactly:

```ts
        ephemeral: {
          type: "boolean",
          description:
            "Create as an ephemeral bead (wisp) by passing --ephemeral to bd create. Wisps stay out of federation sync and can be purged with `bd mol wisp gc` / `bd purge --force` once closed. Boolean true or the string \"true\" both work.",
        },
```

- [ ] **Step 2: Wire the flag into the arg builder**

In the same tool's `execute`, directly after the existing line `if (params.design) args.push("--design", String(params.design));`, insert exactly:

```ts
      if (params.ephemeral === true || params.ephemeral === "true")
        args.push("--ephemeral");
```

No other lines in the tool change.

- [ ] **Step 3: Static verification of both edits**

```bash
cd packages/pi-beads && grep -n "ephemeral" src/index.ts
```

Expected — exactly two new hits, one in the properties block and one in the arg builder:

```text
<line>:        ephemeral: {
<line>:      if (params.ephemeral === true || params.ephemeral === "true")
```

```bash
cd packages/pi-beads && node --input-type=module -e "import('node:child_process').then(({execFileSync}) => { const s = execFileSync('bd',['create','wisp smoke','--ephemeral','--dry-run'],{encoding:'utf8'}); console.log(s.slice(0,400)); })"
```

Expected: `bd` prints its dry-run/preview of an ephemeral issue (no real issue created). This confirms the installed `bd` 1.2.2 accepts the exact flag the extension will pass.

- [ ] **Step 4: Commit the code change**


```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/add-wisps
git add packages/pi-beads/src/index.ts
git commit -m "feat(pi-beads): add ephemeral param to beads_create for wisps"
```

---

### Task 3: Document `ephemeral` in the bundled `beads` SKILL.md

**Files:**
- Modify: `packages/pi-beads/skills/beads/SKILL.md` — the write-tools table row for `beads_create` (line ~45) and the "Typical flows" → "Capture new work" section (line ~85)
**Interfaces:**
- Consumes: the `ephemeral` param introduced in Task 2.
- Produces: skill documentation that tells agents when/how to use `ephemeral` and what a wisp is. No code consumes this; it is read by agents.

- [ ] **Step 1: Add `ephemeral?` to the `beads_create` row in the write-tools table**

Replace the existing row:

```markdown
| `beads_create({ title, repo?, type?, priority?, description?, parent?, labels?, notes?, design? })` | create in the owning repo; `parent` must be in the same repo |
```

with:

```markdown
| `beads_create({ title, repo?, type?, priority?, description?, parent?, labels?, notes?, design?, ephemeral? })` | create in the owning repo; `parent` must be in the same repo; `ephemeral: true` (or `"true"`) passes `--ephemeral`, creating a wisp |
```

- [ ] **Step 2: Add a wisp example under "Typical flows"**

In the `**Capture new work in the right project / epic**` block, after the existing `beads_create({...})` code fence, append:

```markdown
**One-off / ephemeral (wisp)**
```
beads_create({
  repo: "main-orchestrator",
  title: "Release check QA pass",
  type: "task",
  ephemeral: true,
})
```
`ephemeral: true` passes `--ephemeral`, creating a **wisp** — a real bead that
stays out of federation sync and is purged wholesale once closed (`bd mol wisp gc`
or `bd purge --force`). Promote one to permanent with `bd mol squash <id>`.
```

- [ ] **Step 3: Verify the skill reads correctly**

```bash
cd packages/pi-beads && grep -n "ephemeral" skills/beads/SKILL.md
```

Expected: two hits — the table row and the wisp example.

- [ ] **Step 4: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/add-wisps
git add packages/pi-beads/skills/beads/SKILL.md
git commit -m "docs(pi-beads): document ephemeral/wisp support in beads skill"
```

---

### Task 4: List `pi-beads` in the root README and AGENTS

**Files:**
- Modify: `README.md` (root, packages tree), `AGENTS.md` (root, repo layout + running-tests)

**Interfaces:**
- Consumes: nothing from earlier tasks (docs-only).
- Produces: updated project docs consistent with the new package.

- [ ] **Step 1: Add `pi-beads` to the README packages tree**

In `/Users/jstegeman/orca/workspaces/pi-packages/add-wisps/README.md`, change the tree so `statusline` gains a `├──` prefix and `pi-beads` becomes the new last entry:

```text
packages/
├── ayu/            – Ayu color scheme for Pi (Day, Dusk, Dark)
├── bifrost/        – Custom provider for Bifrost AI gateway
├── hashline-edit/  – Hash-anchored read/edit tool override, with opt-in grep
├── langfuse/       – Langfuse observability with Superpowers phase metadata
├── statusline/     – Single-line statusline footer with ayu/tokyo-night/classic presets
└── pi-beads/       – Fork of abix5/pi-beads (beads_* tools) with wisp (--ephemeral) support in beads_create
```

- [ ] **Step 2: Update AGENTS.md repo layout and running-tests**

In `/Users/jstegeman/orca/workspaces/pi-packages/add-wisps/AGENTS.md`:

(a) Change the `packages/` tree so `pi-beads` is the last entry:

```text
packages/
├── ayu/         – Ayu color scheme for Pi (Day, Dusk, Dark)
├── bifrost/     – Custom provider for Bifrost AI gateway
├── hashline-edit/ – Hash-anchored read/edit tool override, with opt-in grep
├── langfuse/    – Langfuse observability with Superpowers phase metadata
├── statusline/  – Single-line statusline footer with ayu/tokyo-night/classic presets
└── pi-beads/    – Fork of abix5/pi-beads (beads_* tools), wisp (--ephemeral) support
```

(b) In the "Running tests" section, append after the langfuse line:

```text
- pi-beads tests: `cd packages/pi-beads && npm test`
```

- [ ] **Step 3: Verify**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/add-wisps && grep -rn "pi-beads" README.md AGENTS.md
```

Expected: `pi-beads` appears in both files.

- [ ] **Step 4: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/add-wisps
git add README.md AGENTS.md
git commit -m "docs: list pi-beads package in README and AGENTS"
```

---

## Verification

Run the full package check and confirm the extension loads end-to-end:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/add-wisps/packages/pi-beads && npm test
# then from a pi session that loads this repo/package (user has installed from git, npm: @abix5/pi-beads removed):
#   beads_create({ repo, title: "smoke wisp", ephemeral: true })  → returns an id
#   bd mol wisp list                                              → the newly created issue is a wisp
#   beads_update({ id, status: "closed" }); then bd mol wisp gc / bd purge --force (or delete the issue)
```

## Summary

This plan vendors upstream pi-beads as a faithfully-copied `packages/pi-beads/` package (Task 1), adds the `ephemeral` parameter to `beads_create` with a single `--ephemeral` flag push (Task 2), documents the capability in the bundled skill (Task 3), and updates the root project docs (Task 4). Tasks 1 and 2 are code + tests; Tasks 3 and 4 are documentation. The wisp smoke test on a live `bd` 1.2.2 remains a mandatory manual verification because the extension shells out to `bd` and is not unit-harnessed.
