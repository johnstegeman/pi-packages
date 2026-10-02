# `discoverPackages` — an unreadable manifest fails one package, not the run

- **Date:** 2026-10-02
- **Issue:** `pi-packages-1yzu` (bug, P2) — "package-gate.mjs: an unparseable package.json aborts
  the whole inventory instead of failing that one package"
- **Origin:** found by two independent reviews of `scripts/ci/package-gate.mjs` during
  `pi-packages-xh2n`, then confirmed by the final review of the `selectGate` composition work
  (`docs/superpowers/specs/2026-09-25-package-gate-select-composition-design.md`), which
  deliberately deferred it: "the unguarded `JSON.parse` in `discoverGated`. Separate bead,
  deliberately not bundled."
- **Molecule:** `pi-packages-mol-psri` (superpowers-workflow)
- **Branch:** `johnstegeman/1yzu`
- **Base:** `main` @ `5dd7c44`

## Problem

`discoverGated` reads every `packages/<name>/package.json` and parses it unguarded:

```js
// scripts/ci/package-gate.mjs:81
const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts;
```

A malformed manifest therefore throws a raw `SyntaxError` out of the `.flatMap`, aborting the
**whole inventory** rather than failing that one package. Both call sites are affected:

- `main` — the run dies before any summary table is printed.
- `runGate` — re-invokes `discoverGated` per package, so the throw escapes the per-package
  `try/catch` (which only wraps the `npm` exec) and the gate reports nothing useful.

The gate's whole purpose is to make an unrun or excluded package *visible*. Crashing the
inventory is the loudest possible failure but the least useful one: the message names no package,
suggests no fix, and takes every other package's result down with it. `AGENTS.md` states there is
no exclusion mechanism other than `QUARANTINED` and "nothing is skipped silently"; a malformed
manifest is currently the one input that violates that promise.

## Goals / non-goals

**Goals**

- One unreadable manifest produces a reported failure for **that package alone**; every other
  package's result is unaffected.
- An unreadable manifest is never silently omitted from the summary or from `--list`, in any form.
- `--list --json`, the CI matrix source, remains valid JSON that `fromJSON` can consume, while the
  broken package is still signalled and the run still fails.
- The behaviour is pinned by tests that are shown **failing** against the pre-fix code.

**Non-goals**

- Changing `selectGate` / `covers` / `isGated`, or any package's scripts or tests.
- Changing the quarantine mechanism, the summary format, or the CI workflow file.
- Removing the text-inference limitation documented in the composition spec.
- Guarding `readdirSync` on an unreadable `packages/` root. That is a repo-level failure, already
  non-zero, and has no per-package answer.

## Decisions (from brainstorming)

1. **`--list --json` stays a clean, bare JSON array of runnable names.** The broken package is
   named on **stderr** and the process exits non-zero, so CI's `gates-list` step fails loudly
   without a coordinated change to its `fromJSON` consumer. (Rejected: changing the payload shape
   to `{ runnable, errors }`.)
2. **"Unreadable" = cannot produce a usable `scripts` object**: a `readFileSync` failure, a
   `JSON.parse` failure, or valid JSON of the wrong shape (top-level non-object, or `scripts`
   present but not an object). A directory with **no** `package.json` stays a non-package and is
   still skipped — `ayu` has a manifest and simply declares no `test` script, so nothing real
   depends on the no-manifest path.
3. **A broken manifest is uniformly a FAIL, exit 1**, everywhere: `--all`, a named invocation, and
   both `--list` forms. Exit 2 stays reserved for genuine usage errors (no arguments, an unknown
   *name*, bad flags). One rule, no special-casing.
4. **Rendering:** plain `--list` prints `FAIL <name>  <error>` among the package lines; `--all`
   shows the error in the summary table's detail column **and** the usual
   `--- <name> output tail ---` block. This reuses the existing table/tail machinery rather than
   inventing a third presentation.
5. **Approach: the error lives on the discovered entry** (the bead's suggested shape), refined so
   there is a single manifest-reading seam. `discoverGated` is renamed **`discoverPackages`** and
   returns a union. (Rejected: `discoverGated` returning `{ gated, errors }`, which rewrites every
   existing assertion; and a second `discoverBroken` scan, which reads every manifest twice and can
   drift from the first.)

## Design

### 1. One scan, one inventory shape

`discoverPackages(packagesDir)` walks `packages/*` exactly as today — directories only, sorted,
no-manifest directories skipped — and returns a **union**:

```js
{ name, dir, gate }                 // manifest readable and the package is gated
{ name, dir, gate: null, error }    // manifest unreadable (read / parse / shape)
```

Ungated packages still yield nothing, so on a healthy tree the union contains only gated entries.
That is what keeps the rename a pure rename for the two array-shaped existing tests: for healthy
fixtures, `discoverPackages(dir).map((p) => p.name)` and the real-manifest
`Object.fromEntries(discoverPackages(PACKAGES_DIR).map((pkg) => [pkg.name, pkg.gate]))` drift guard
produce exactly what `discoverGated` did.

A helper `readManifest(dir)` performs read + parse + shape check and throws one **normalized,
single-line** `Error`; `discoverPackages` wraps that per directory in `try/catch`, so a
per-package problem can never escape the scan. The message is whitespace-collapsed because it
lands in a table column:

| failure | message |
|---|---|
| `readFileSync` throws | `cannot read package.json: <code> <message>` |
| `JSON.parse` throws | `package.json is not valid JSON: <SyntaxError message>` |
| parsed value is `null`, an array, or not an object | `package.json is not an object` |
| `scripts` present but not an object | `package.json "scripts" is not an object` |

Only three files reference `discoverGated`: the script, its test, and the historical composition
spec (which is a record and is not edited).

**Why the union rather than a parallel errors list:** `planRun`, `summarize`, `main` and `runGate`
all consume the same inventory, so "is this package runnable?" is answered in exactly one place,
and a broken package cannot be dropped by a consumer that forgot to consult a second list. The one
wart — `discoverPackages` returning two shapes — is confined to `gate === null` checks at those
four consumers.

### 2. Behaviour per entry point

`main` builds `inventory = discoverPackages(packagesDir)` and
`planRun(inventory, quarantined)` once.

`planRun` returns `{ runnable, skipped, errored, rotWarnings }`: `runnable` stays a name list,
`errored` is `[{ name, error }]`. **Errored entries are never quarantinable** — a broken manifest
is always a FAIL — and the rot-warning name set stays gated-only, so a `QUARANTINED` entry naming a
broken package correctly warns as rot instead of silencing it.

| mode | stdout | stderr | exit |
|---|---|---|---|
| `--list` | `name  gate` / `SKIPPED name  reason` / `FAIL name  error` for every inventory entry | rot warnings | 1 if any errored, else 0 |
| `--list --json` | `JSON.stringify(runnable)` — still a bare array | `FAIL name  error` per errored entry, then rot warnings | 1 if any errored, else 0 |
| `--all` | summary table; errored entries are `FAIL` rows | `--- name output tail ---` blocks (the error text for errored entries) + rot warnings | 1 if any FAIL |
| `<name>` | as `--all`, for that one package | same | 1 if that package errored or failed |

The named-invocation validation loop (`package-gate.mjs:182-186`) already accepts any name present
in the inventory, so `package-gate.mjs broken` reaches `runGate`. What changes is the *quality* of
that failure: today the whole run dies during discovery, and once the scan stops throwing but
before `runGate` is fixed, `runGate` would pass a `null` gate to `gateSteps`, whose `String(null)`
becomes the command `null`. With a lockfile present the `npm ci` step succeeds and the spawn's
`ENOENT` lands on the *thrown* error rather than on stdout/stderr, so the reported tail is
**empty** — a FAIL that names no cause; in a package with no lockfile, `npm ci` fails first and
the tail is npm's `EUSAGE` error instead. Either way the tail never names the real problem. After
this change it reports `FAIL` with the parse error. A name in no part of the inventory is still
`unknown package` → exit 2.

### 3. `runGate` and `summarize`

- **`runGate(name)`** looks the name up in `discoverPackages(packagesDir)`. Not found →
  `FAIL no gate for package` (unchanged). Found with `error` → `{ name, status: 'FAIL',
  gate: null, ms: 0, output: error }`, with **nothing executed** (no `npm ci`). Otherwise
  unchanged.
- **`summarize`** already drives off `result.status`, so errored entries become `FAIL` rows with
  no structural change. The one edit is the detail column: `SKIPPED → reason`, otherwise
  `gate ?? error ?? ''`, so the parse error appears in the table as well as in the output tail.

### 4. Tests and RED evidence

**Harness extension.** `scratchPackages`, `gatedPackages` and the process-level `scratchRepo`
currently write `JSON.stringify(...)`, so no existing fixture can express a malformed file. Add one
shared sentinel, `rawManifest(text)` → `{ raw: text }` (with `isRaw(value)`), which each helper
writes **verbatim**; `null` still means "no manifest at all", and anything else is stringified as
today. A sentinel rather than a bare string, because `gatedPackages`' existing values *are* strings
(a test-script name), so "string means raw" would collide there. `scratchRepo` and `gatedPackages`
write **no lockfile** for a raw manifest, so a regression that let `npm ci` run would fail with
npm's error instead of the parse error the assertions look for.

**New tests, mapped to the acceptance criteria:**

- `discoverPackages`: malformed manifest alone → one entry with `gate: null` and an `error`, no
  throw; malformed *alongside* healthy packages → the healthy entries are unchanged and still
  sorted; valid-JSON-wrong-shape (`[]`, `null`, `{"scripts":"x"}`) → errored, not dropped; a
  no-manifest directory and an ungated directory still yield nothing.
- `planRun`: errored entries land in `errored`, never in `runnable`, even when their name is in the
  injected quarantine map — and that map entry then reports as rot.
- `summarize`: an errored `FAIL` row renders the error in the detail column and counts toward
  `failed`.
- `runGate`: a broken package returns `FAIL` with the parse error as `output`.
- `main --list` (direct call, injected quarantine seam): stdout has `FAIL broken <error>` **and**
  the healthy line; exit 1.
- `main --list --json`: stdout parses as exactly `["alpha"]` — broken excluded, still valid JSON —
  stderr names the broken package, exit 1.
- `main --all`: healthy package `PASS`, broken package `FAIL`, exit 1, error in the output tail.
- `main broken` (named): `FAIL`, exit 1, with the parse error in the output tail — not the empty
  tail (lockfile present) or the `npm ci` `EUSAGE` tail (no lockfile) that a `null` gate reaching
  the runner produces.
- Process-level (`scratchRepo` + `runCli`): a truncated manifest beside a healthy package —
  `--all` exits 1 with the healthy package still `PASS`, and `--list --json` output still parses.
  `runCli` gains `stdout` / `stderr` fields (keeping the historical merged `out` the existing
  assertions use), so the JSON payload is asserted independently of the stderr signal.
- The `scratchRepo` / `gatedPackages` fixtures write **no lockfile** for a broken package, so a
  regression that let `npm ci` run would fail with npm's error rather than the parse error the
  assertions look for.

**RED evidence is required**, following the convention set by the composition spec: the new tests
are first run against the pre-fix `discoverGated` and shown failing with the raw `SyntaxError`
escaping the scan. Without that they prove only that they pass, not that they detect the bug.

### 5. CI behaviour change (intended)

`gates-list` runs `node scripts/ci/package-gate.mjs --list --json` and feeds the output to
`fromJSON`. A malformed manifest now makes that step exit 1 with the broken package named on
stderr, instead of dying with a stack trace before any job output. The workflow file itself is
unchanged.

### 6. Documentation

- `package-gate.mjs:69-70` (the "Auto-discovery" comment) gains a sentence describing the union and
  the `error` field, and that an unreadable manifest fails that package alone.
- `AGENTS.md`'s package-gate paragraph gains a clause noting that a malformed manifest is reported
  as a failure for that package rather than aborting the inventory — keeping its "nothing is
  skipped silently" claim true.

## Acceptance criteria mapping

| AC (`pi-packages-1yzu`) | Satisfied by |
|---|---|
| A malformed `package.json` produces a `FAIL` entry naming the package and the parse error, and does not abort the run | §1 union + per-directory `try/catch`; §2 table; tests for `discoverPackages`, `runGate`, `main --all` |
| Every other package's result is unaffected | malformed-alongside-healthy `discoverPackages` test; process-level `--all` test with a healthy `PASS` |
| An unreadable manifest is never silently omitted from the summary or from `--list` | `FAIL` rows in `summarize`; `FAIL` line in plain `--list`; stderr line in `--list --json` |
| Unit tests cover malformed alone, malformed alongside healthy, and `--list --json` not silently dropping it | §4 test list, including the process-level CLI test |
| `node --test scripts/ci/package-gate.test.mjs` passes | verification plan |

Additional criteria this design adds:

- the new tests are shown **failing** against the pre-fix code (RED), so they are proven to detect
  the bug;
- `--list --json` output is asserted to remain parseable JSON while still failing the run;
- the `discoverGated` → `discoverPackages` rename leaves the existing array-shaped and
  real-manifest drift-guard assertions literally unchanged.

## Verification plan

Performed in the `verify` step with fresh evidence, not inherited from the implementation:

1. `node --test scripts/ci/package-gate.test.mjs` under node 22 — the full suite.
2. The **RED** half: the new tests run against the pre-fix scan, showing the raw `SyntaxError`.
3. `mise exec node@22 -- node scripts/ci/package-gate.mjs --list` and `--list --json` against a
   throwaway clone with one truncated manifest: exit 1, broken package named, healthy packages
   still listed, JSON still parseable.
4. `mise exec node@22 -- node scripts/ci/package-gate.mjs --all` on the real tree — 8/8 PASS,
   exit 0, no behaviour change for a healthy repo.
5. CI green on the PR, including the `gates-list` and `package-gates` jobs.
6. `actionlint` still clean (the workflow is untouched).

## Files touched

- `scripts/ci/package-gate.mjs` (the scan, `planRun`, `main`, `runGate`, `summarize` detail column)
- `scripts/ci/package-gate.test.mjs` (harness extension, new tests, `discoverPackages` rename)
- `AGENTS.md` (one clause in the package-gate paragraph)
- `docs/superpowers/specs/2026-10-02-package-gate-unreadable-manifest-design.md` (this file)

## Residual limitations

- A package whose manifest is *readable but nonsense in a way the shape check cannot see* — e.g.
  `{"scripts": {"test": 42}}` — is still treated as ungated and skipped, exactly as before. The
  shape check deliberately covers only the container levels (`package.json` and `scripts`), because
  `isGated` already treats a non-string `test` as ungated.
- The error text is `JSON.parse`'s own message, normalized to one line. It names the position, not
  the fix.
- An unreadable `packages/` root still aborts the process; it has no per-package answer and is out
  of scope.
