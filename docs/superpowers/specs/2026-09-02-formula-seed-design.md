# Design: Auto-seed the superpowers-workflow formula to global `~/.beads/formulas` (R2a)

Date: 2026-09-02 · Source: learnings bead `pi-packages-pin` (R2a) + backlog bead `pi-packages-fak` · Molecule: `pi-packages-mol-va3`.

## Goal

Remove the "superpowers workflow formula missing → manual per-project copy" friction. The
pi-superpowers-plus package auto-seeds its bundled `superpowers-workflow.formula.toml` into the
**user-level** `~/.beads/formulas/` as a symlink that stays current with the installed package, so
every beads project on the machine finds it with zero per-project setup. A documented one-line
fallback covers non-pi installs.

## Context

- The bundled formula is `packages/pi-superpowers-plus/formulas/superpowers-workflow.formula.toml`
  (`id = "superpowers-workflow"`, `version = 1`, semantic step ids, human gates).
- Today (`using-superpowers/SKILL.md:33-39`) users are told to copy it per-project into the
  project's `.beads/formulas/` — the friction R2a removes.
- `bd formula` search paths (in order): (1) `<resolved-beads-dir>/formulas/`, (2)
  `<checkout-root>/.beads/formulas/`, (3) `~/.beads/formulas/` (user — outside any repo), (4)
  `$GT_ROOT/.beads/formulas/`. `~/.beads` already exists here but has no `formulas/` yet. One
  user-level copy therefore serves all projects.
- pi has **no install-time hook**; but an extension factory that returns a `Promise` is awaited
  before `session_start` (extensions.md:181), so seeding at extension load is available and
  effective before the first `bd formula list`. Extensions are auto-discovered from the package's
  `pi.extensions = ["./extensions"]` (no manifest change needed) and can use node `fs`/`os`
  directly.

## Decision

### 1. Seeding logic — `extensions/formula-seed.mjs` (pure, node-testable)

`seedFormula(sourcePath, targetDir)` returns `{ action, target }`, never throws (any unexpected
error → `{ action: "skipped-error" }`). Branch matrix:

1. `mkdir -p targetDir` (idempotent); on ENOTDIR/EACCES → `{ action: "skipped-unwritable" }`.
2. **Target absent** → `fs.symlink(sourcePath, targetPath)` → `{ action: "linked" }`.
3. **Target is a symlink**:
   - resolves to the bundled source → `{ action: "already-linked" }` (no-op; `pi update` keeps it
     current automatically, since the symlink points at the live bundled file).
   - dangling (readlink ok, target file gone) → recreate → `{ action: "relinked" }`.
   - points elsewhere (foreign symlink) → leave → `{ action: "skipped-foreign" }`.
4. **Target is a regular file** (user hand-placed a formula) → **never touch** →
   `{ action: "skipped-user-file" }` (that file already beats the global path for every project).

### 2. Extension entry — `extensions/formula-seed.ts` (thin)

- Resolve the bundled formula path via `import.meta.url` → `../formulas/superpowers-workflow.formula.toml`.
- Compute target dir `path.join(os.homedir(), ".beads", "formulas")`.
- If the source exists, call `seedFormula(source, targetDir)` inside try/catch (a failing seed is a
  no-op, never a startup error); log a single notice only when an action actually changed
  something (`linked`/`relinked`), so the user can see it happened. Factory returns (runs before
  `session_start` when it returns a resolved promise, or synchronously — both supported).

### 3. Skill text — modify `using-superpowers/SKILL.md` (lines 33–39)

Replace the manual per-project copy step with: the pi-superpowers-plus package auto-seeds the
formula globally at `~/.beads/formulas/superpowers-workflow.formula.toml` (a symlink into the
installed package, re-created on load if dangling); a hand-placed file there — or a per-project
copy in `.beads/formulas/` — overrides it (higher search precedence); verify with
`bd formula list | grep superpowers-workflow`. Fallback one-liner for non-pi installs:

```bash
mkdir -p ~/.beads/formulas && \
ln -sf <installed-package>/formulas/superpowers-workflow.formula.toml ~/.beads/formulas/
```

(`<installed-package>` = wherever pi-superpowers-plus is loaded from; use `cp` if symlinks are
unavailable.)

### 4. Tests — `extensions/formula-seed.test.mjs`

`node:test` suite covering the full branch matrix against temp dirs: linked when absent; no-op
when our symlink already resolves to the source; relinked when dangling; skipped-foreign for a
symlink pointing elsewhere; skipped-user-file for a regular file; skipped-unwritable/graceless on
a read-only/absent-parent target; and the "source missing → no-op" path.

## Files

- Create: `packages/pi-superpowers-plus/extensions/formula-seed.ts`
- Create: `packages/pi-superpowers-plus/extensions/formula-seed.mjs`
- Create: `packages/pi-superpowers-plus/extensions/formula-seed.test.mjs`
- Modify: `packages/pi-superpowers-plus/skills/using-superpowers/SKILL.md` (formula section)

## Error handling / verification

- Seeding never fails pi startup: every fs path is guarded; unexpected errors map to
  skipped actions.
- A user-customized formula (regular file or higher-precedence project copy) is never modified.
- Verify: `node --test packages/pi-superpowers-plus/extensions/formula-seed.test.mjs` green;
  interactive — `bd formula list` in any beads project shows `superpowers-workflow` sourced from
  `~/.beads/formulas/` after pi loads the package; a hand-placed file at the target is left
  untouched.

## Scope

- **In:** the three extension files + the `using-superpowers` skill text.
- **Out:** the existing per-project copy in this repo (left in place — valid precedence); any
  bd-side search-path changes (tracked by `pi-packages-826`); changes to other packages.

## Risks

- Symlink target stability: the installed package path must stay valid across `pi update`; if a
  path change ever breaks the link, the extension detects the dangling symlink on next load and
  re-creates it (self-healing).
- Non-Unix filesystems without symlink support would need the `cp` fallback; noted in the skill
  text.
