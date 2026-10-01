# pi-beads: packaging completeness and the `beads_update` surface — Design

- **Date:** 2026-10-01
- **Issues:** `pi-packages-bckf` (packaged tarball omits `src/lock-retry.ts`),
  `pi-packages-5ov5` (`beads_update` silently drops fields it does not declare)
- **Molecule:** `pi-packages-mol-pd02` (brainstorming molecule, topic
  "pi-beads fixes: bckf + 5ov5")
- **Packages / areas:** `packages/pi-beads` (`package.json`, `src/index.ts`,
  `README.md`, `skills/beads/SKILL.md`, `test/`),
  `packages/pi-superpowers-plus/skills/using-superpowers/references/pi-tools.md`
- **Verified against:** pi 0.99.2, node v22.23.1, npm 10.9.8, bd 1.3.0

## Context

### 1. bckf — the published tarball omits a module the entry point imports

`packages/pi-beads/package.json`'s `files` array lists
`["src/index.ts", "src/cost-tracking.ts", "skills", "README.md", "LICENSE"]`.
`src/index.ts:36` imports `./lock-retry.ts`, which is not in that list, so a published
tarball cannot be loaded. Reproduced on this branch:

```
$ npm pack --dry-run --json     # 6 entries: LICENSE, README.md, package.json,
                                # skills/beads/SKILL.md, src/cost-tracking.ts, src/index.ts
$ npm pack --pack-destination "$T" && tar -xzf "$T"/*.tgz -C "$T/x"
$ node --input-type=module -e "await import('$T/x/package/src/index.ts')"
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/package/src/lock-retry.ts'
```

The import edge predates the transient-retry change that added retry behaviour to the file, so
the tarball has been broken since `src/lock-retry.ts` first landed — it is not a regression
from any recent change.

### 2. 5ov5 — `beads_update` silently drops fields it does not declare

`beads_update` declares twelve properties and reads only those. `beads_create` accepts `type`
and `acceptance`; `beads_update` accepts neither, and `bd update` supports both
(`bd update --help`: `-t, --type`, `--acceptance`). A caller that passes `type: "bug"` to
`beads_update` gets `✓ Updated issue: …` with every *declared* field applied and `type`
silently dropped — observed on `pi-packages-x33o` on 2026-10-01, where the bead kept
`issue_type: chore` after a re-scope the controller had already reported as done.

### 3. New: where pi itself drops the key (probe, 2026-10-01)

A throwaway extension registering a tool with
`parameters: { type: "object", properties: { foo: … }, required: ["foo"] }` was called with
`{"foo":"a","bar":"b"}` on each path:

| path | what `execute` received |
|---|---|
| direct (model → tool) | `{"foo":"a"}` — `bar` **stripped by pi before `execute`**, no error |
| direct, schema declares `additionalProperties: false` | `{"foo":"a"}` — still stripped, still no error |
| codemode nested (`tools.probe_nested({…})`) | `{"foo":"a","bar":"b"}` — **intact** |

Consequences, and the reason this design is shaped the way it is:

1. The 5ov5 repro (a codemode script) is the one path where the tool *does* see the
   undeclared key and ignores it — a guard can catch it there.
2. On the direct path the handler never sees the key, so "fail loudly on undeclared keys" is
   **not implementable inside pi-beads** for model-initiated calls, and
   `additionalProperties: false` does not change that. This is a pi-core behaviour, filed
   separately as a follow-up bead (see "Out of scope").
3. Therefore the JSON-schema surface is the *only* contract on the direct path: a field that
   is not declared is unusable, and the two surfaces (`beads_create` / `beads_update`) must
   not drift. That drift is what the parity test in Part 3 exists to prevent.

## Goal

1. `npm pack` for pi-beads contains every module its entry points import transitively, and a
   test fails the package gate if a future module is added to `src/` but left unpackable
   (bckf).
2. `beads_update` applies `type` and `acceptance`; a call carrying a key the tool will not
   apply never returns success silently on the path where the key is visible, and never
   reaches `bd` (5ov5).
3. The two surfaces are documented side by side, and a test keeps that documentation in sync
   with the schemas (5ov5's AC4, made machine-checked).

No behaviour change on any path not named above: read tools keep their surfaces, no tool's
existing arguments change meaning, and no new runtime dependency is introduced.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | `files` becomes `["src", "skills", "README.md", "LICENSE"]` — a directory entry, not a second explicit filename | Matches `hashline-edit`/`statusline` (`"src"`), and removes the failure mode rather than this instance: a module added later is packed by default. `langfuse` already uses `"src/"`. |
| D2 | The packaging guard lives in **pi-beads only** (`test/packaging.test.mjs`) | The blast radius of a shared/root checker (new `scripts/ci/` script, its self-test, CI wiring) is not justified by a bug that exists in one package. `ayu`, `bifrost`, `codemode-bootstrap` and `pi-subagents` declare no `files` at all (npm packs everything), so they cannot have this defect. |
| D3 | The guard asserts against **npm's own file list** (`npm pack --dry-run --json`) rather than a hand-rolled `files`/glob matcher | A matcher reimplements the rules it is supposed to verify. `--dry-run --json` is offline, ~0.2s, and is the same packlist the publisher gets. |
| D4 | The guard has **two halves**: static import-closure vs pack list, and pack → extract → `import()` the entry point | The static half names the missing file and its importer (a fixable message); the dynamic half is the AC4 evidence and catches what the regex walk misses. Each half fails independently. |
| D5 | The guard asserts its own non-vacuity (pack list non-empty and contains `src/index.ts`; closure has ≥ 2 modules) | A regex that silently matched nothing would otherwise make the static half pass while asserting nothing. |
| D6 | Undeclared-key rejection is one **registration wrapper**, applied to the write tools, deriving accepted keys from each tool's own `parameters.properties` | Closes the class, not the instance (5ov5's own "fix options" #1), with no second list to keep in sync. Reads are excluded: they carry no write risk, so widening the behaviour change buys nothing. |
| D7 | The wrapper rejects **top-level** keys only; nested objects (a `tasks[]` item in `beads_create_list`) are out of scope | Nested item keys are a different surface with no schema to derive from; guarding them would mean a second declaration. Stated in the code comment so it is a known limit, not an oversight. |
| D8 | The rejection is a `textResult` of the form `<tool>: unknown argument(s): <keys> (accepted: <keys>)`, matching how every other pi-beads validation error surfaces, and it emits no `beads:changed` | Consistency with `title is required` / `unknown repo for id '…'`; naming the tool, the offenders and the accepted set makes it unmistakable, and no write means no emit. |
| D9 | `acceptance` is applied on `!== undefined` (empty string clears it, matching `description` in the same tool); `type` on truthiness (matching `beads_create`) | Each field keeps the semantics of its existing counterpart, so update does not become a third dialect. |
| D10 | No allowlist on `type` in `beads_update` | `beads_create` passes `type` through and lets `bd` reject junk; adding validation to update only would create the very asymmetry this design removes. |
| D11 | The create/update field sets are documented in a new README subsection and pinned by a test that reads both the README and the schemas | 5ov5's AC4 asks for the asymmetry to be visible; a doc block nothing checks is how the asymmetry returns. |
| D12 | Delivery as **two commits, one per bug**, each carrying its own tests and docs, on the existing `fix/bckf_5ov5` branch (the design spec is already committed as `6bdb20e`) | The two bugs are independent and separately revertable; the branch exists for exactly this pairing. |

## Design

### Part 1 — pack the whole `src` tree, and pin it (bckf)

`packages/pi-beads/package.json`:

- `files: ["src", "skills", "README.md", "LICENSE"]`
- `test`: append `&& node test/packaging.test.mjs`.

New `packages/pi-beads/test/packaging.test.mjs`, in the dependency-free `node:assert` style
of the rest of the suite, deriving its inputs from the manifest so it cannot drift:

- **Entry points:** `pi.extensions`, `main` and `exports` (here `./src/index.ts` and
  `./src/cost-tracking.ts`).
- **Static half:** walk the transitive relative-import graph of the entry points
  (`import … from "…"`, `export … from "…"`, bare `import "…"`, dynamic `import("…")`;
  `./`- and `../`-prefixed specifiers only — `node:` builtins and bare specifiers are not
  packaged files). Compare against the paths in `npm pack --dry-run --json`'s `files[].path`.
  A missing module fails with its import chain: `src/lock-retry.ts ← src/index.ts
  (pi.extensions[0])`.
- **Dynamic half:** `npm pack --pack-destination <tmp>` → `tar -xzf` → `import()` the
  extracted `src/index.ts` → assert the default export is the extension factory function.
- **Non-vacuity:** the pack list is non-empty and contains `src/index.ts`; the closure
  contains at least two modules.
- Temp directory removed in `finally`; `npm` and `tar` invoked via `execFileSync`, stdout
  parsed (npm warnings go to stderr).

Expected on this branch *before* the `files` change: static half reports
`src/lock-retry.ts`, dynamic half reports `ERR_MODULE_NOT_FOUND` — both observed while
writing this design. Both must be seen failing first, then pass, as the TDD evidence.

### Part 2 — `beads_update` fields and the undeclared-key guard (5ov5)

**New fields on `beads_update`** (`src/index.ts`, registration at ~`:1313`):

| field | argv | applied when |
|---|---|---|
| `type` | `--type <value>` | truthy |
| `acceptance` | `--acceptance <value>` | `!== undefined` |

Both are added to the tool's `parameters.properties` (so they exist on the direct path at
all — see Context §3) and to its description string, which currently enumerates the fields.

**The guard** — one helper next to the `TOOL` map:

```ts
const WRITE_TOOLS = new Set<string>([
  TOOL.create, TOOL.createList, TOOL.update, TOOL.close, TOOL.dep, TOOL.undep,
  TOOL.comment, TOOL.reopen, TOOL.promote, TOOL.gateCreate, TOOL.gateResolve, TOOL.molPour,
]);

const guardUnknownKeys = (def) => ({ ...def, async execute(id, params) { /* reject, else delegate */ } });
```

- Declared keys are `Object.keys(def.parameters?.properties ?? {})`; if a definition declares
  no properties the wrapper is a pass-through.
- Unknown top-level keys ⇒ return before the tool body runs, so no `bd` invocation and no
  `beads:changed` emit:
  `beads_update: unknown argument(s): typoKey (accepted: id, status, priority, title, parent, notes, appendNotes, addLabels, removeLabels, claim, setMetadata, description, type, acceptance)`
- Applied by wrapping each write tool's registration: `pi.registerTool(guardUnknownKeys({ … }))`.
  Reads are untouched.
- The comment above `guardUnknownKeys` carries the Context §3 probe table and states the two
  limits (direct path unreachable; nested `tasks[]` items unguarded), so a later reader
  cannot mistake it for dead code and delete it.

### Part 3 — docs side by side, and the drift guards

- `packages/pi-beads/README.md`: new subsection **"`beads_create` vs `beads_update` fields"**
  with one row per tool enumerating every declared field, plus the create-only set
  (`repo`, `design`, `ephemeral`) and a one-line reason the two must not drift (an undeclared
  field is unusable on the direct path). The existing tool-table rows (`:133` create, `:135`
  update) gain `type`/`acceptance` and stay prose.
- `packages/pi-beads/skills/beads/SKILL.md:58`: the `beads_update({…})` signature line gains
  `type?` and `acceptance?`, so it reads directly under create's `:56`.
- `packages/pi-superpowers-plus/skills/using-superpowers/references/pi-tools.md`: one bullet
  beside the beads tool list — pi strips arguments a tool does not declare before the tool
  runs on the model path, so an undeclared field is a silent no-op there and the surface is
  the only contract.
- **Drift guards** (both in `test/tool-surface.test.mjs`, no new script):
  - `test/tool-surface.test.mjs`: the new README field table must name every property declared
    in `beads_create`'s and `beads_update`'s schemas, and must not list a create-only field on
    the update row. (Same regex-over-names technique the file already uses for tool names.)
  - `test/tool-surface.test.mjs`: every property of `beads_create` must appear in
    `beads_update` or in an explicit `CREATE_ONLY` set — the class of bug 5ov5 reports, not
    just today's instance. Both structural checks live in this file: it is already the suite
    that reads `src/index.ts` alongside the docs, and neither check touches `bd`.

### Part 4 — tests (behaviour)

In `test/pi-beads.test.mjs`, using the existing fake-`bd` fixture (argv is asserted, no real
`bd` is touched):

1. `beads_update` argv plumbing: `{ id, type: "bug", acceptance: "…" }` →
   `update <id> --type bug --acceptance …`, exactly one `bd` invocation, exactly one
   `beads:changed` emit.
2. Guard fires: one case on `beads_update` (`typoKey`) and one on a second
   write tool (`beads_close` with `reson`) — error names the offending key, lists the accepted
   set, **zero** `bd` invocations, zero emits. The second case proves the wrapper is generic
   rather than a hand-written check in one tool.
3. The guard runs before the tool's own validation: a call with an unknown key *and* a missing
   required field reports the unknown key (and still never reaches `bd`).

## Alternatives considered

- **Root-level packaging check for every package with a `files` array.**
  Rejected: the class is not demonstrated anywhere but pi-beads, and the change would add a
  `scripts/ci/` script, its self-test and CI wiring for one package's bug.
- **Add only the missing filename to `files`.** Rejected (D1): fixes today's instance and
  leaves the next `src/*.ts` file with the same fate.
- **`beads_update` gains `type`/`acceptance` with no guard.** Rejected: a
  typo'd key from a codemode script still returns success silently, which is the reported
  failure mode with a different field name.
- **Single source of truth for the whole tool surface:** one table the
  schemas, the guard and the docs all read. Rejected for this change: it touches all 23
  registrations and the docs pipeline, and the parity test in Part 3 already catches the drift
  class at a fraction of the diff.
- **Throwing instead of returning an error text** (D8). Rejected: pi-beads surfaces every
  validation error as a `textResult`; a lone throw would be the inconsistency.
- **Guarding all 23 tools, reads included.** Rejected: no write risk on reads,
  so it widens a behaviour change for uniformity alone.

## Risks

| Risk | Mitigation |
|---|---|
| The wrapper rejects a legitimate extra key some caller passes today | The probe shows the nested path delivers exactly what the script passes and the direct path strips everything undeclared, so no legitimate caller can be passing one. The full suite runs against the fixture on every write path. |
| `npm pack --dry-run --json`'s shape changes across npm majors | The static half asserts the list is non-empty and contains `src/index.ts`; the dynamic half does not depend on the JSON shape at all, so a shape change cannot silently pass the guard. |
| The regex import walk misses an edge (e.g. a computed specifier) | The dynamic half loads the extracted entry point, which fails on a genuinely missing module regardless of how the walk classified it. |
| A `npm pack` invocation in the test suite slows the gate or needs the network | Measured ~0.2s dry-run and ~0.4s real pack on this tree, no dependencies to resolve, no network. |
| The README-names test becomes a wording trap | It matches property *names* only, exactly as the file already matches tool names, and its failure message lists the schema's property names, so keeping the row in sync is mechanical. |

## Verification

- `npm test` at the repo root (node 22 via mise) — runs the package gate self-test and every
  package gate, including pi-beads' new `test/packaging.test.mjs`.
- `node scripts/ci/package-gate.mjs pi-beads` for the package in isolation.
- TDD evidence, recorded in the plan's ledger (`.superpowers/sdd/<mol>/progress.md`):
  before the `files` change; the guard tests red before `guardUnknownKeys`; `beads_update`
  `--type`/`--acceptance` argv test red before the two fields exist.
- `npm pack --dry-run --json` on the finished tree lists `src/lock-retry.ts`, and the
  extracted tarball's entry point imports cleanly (the dynamic half, run by hand once).
- The bckf/5ov5 acceptance criteria are checked off one by one at close time, with the
  amended AC1 wording for 5ov5 (scoped to the nested path, per Context §3) shown to the user
  before the bead is edited.

## Files

| File | Change |
|---|---|
| `packages/pi-beads/package.json` | `files` → `["src", …]`; `test` gains the packaging test |
| `packages/pi-beads/test/packaging.test.mjs` | new — static closure + dynamic load + non-vacuity |
| `packages/pi-beads/src/index.ts` | `guardUnknownKeys` + `WRITE_TOOLS`; write-tool registrations wrapped; `beads_update` gains `type`/`acceptance` |
| `packages/pi-beads/test/pi-beads.test.mjs` | argv plumbing for the new fields; guard fires (two tools); guard precedes validation |
| `packages/pi-beads/test/tool-surface.test.mjs` | README field-table ↔ schema assertions; create/update parity + `CREATE_ONLY` |
| `packages/pi-beads/README.md` | field-table subsection; tool rows gain `type`/`acceptance` |
| `packages/pi-beads/skills/beads/SKILL.md` | `beads_update` signature line |
| `packages/pi-superpowers-plus/…/pi-tools.md` | one bullet on undeclared-arg stripping |

## Out of scope

- **Fixing pi-core's stripping** (Context §3). Filed as its own bead (`discovered-from`
  5ov5) with the probe evidence and the two candidate resolutions — reject unknown keys, or
  honour `additionalProperties: false` — because it affects every pi extension, not pi-beads.
- Guarding nested keys inside `beads_create_list`'s `tasks[]` items (D7).
- `files` arrays in other packages, and a repo-wide packaging check (D2).
- Widening either surface beyond `type`/`acceptance` (e.g. `estimate`, `assignee`, `design`
  on update): a separate decision, not a by-product of this fix.

## Errata (2026-10-01, post-implementation)

**Context §3's conclusion is wrong, and so is the D6/D7 rationale that rested on it: "the
direct path cannot reach the guard".** The probe recorded in §3 measured the *provider*, not
pi. The shipped pi 0.99.2 bundle shows pi does not filter tool arguments at all:

```js
function validateToolArguments(tool, toolCall) {
  const args = structuredClone(toolCall.arguments);
  normalizeOptionalNulls(args, tool.parameters);   // declared keys only
  exports_value.Convert(tool.parameters, args);
  const validator2 = getValidator(tool.parameters);
  ...
  if (validator2.Check(args)) return args;          // returned UNCHANGED
}
```

Nothing deletes an undeclared key, and both paths run through that function: the direct path
via `prepareToolCall`, and the codemode nested path via
`NestedToolCallRunner._executeNestedToolCall` -> `runToolCall` -> `prepareToolCall`. What kept
the extra key out of the probe was provider-side strict sampling: `convertResponsesTools`
computes `const defaultStrict = options?.strict === undefined ? false : options.strict;`, and
`makeStrictJsonSchema` is what sets `additionalProperties = false` on the schema sent to the
provider (`resolveJsonSchemaStrictSampling` only returns true for a strict-capable model).
The probe's "stripping" was therefore a provider artifact, not a pi behaviour.

Consequences for what shipped:

- **The guard covers both paths.** §3's "not implementable inside pi-beads for
  model-initiated calls" is superseded, as is the D6/D7 premise that the direct path cannot
  reach the guard, and the risk-table row that leaned on the probe. The guard is still
  load-bearing - it is the only thing that makes an undeclared key loud - but its blast radius
  includes the direct path on any provider/model that does not honour strict tool sampling,
  and on those the change turns a silent-partial-success write into an error tool result.
- **`additionalProperties: false` is not what makes pi reject.** It is what pi *asks the
  provider for*, and that request defaults off, so whether a direct call carries an undeclared
  key depends on the provider and model.
- **The four prose copies of the false premise were corrected** in the follow-up fix commit:
  the `WRITE_TOOLS` comment in `packages/pi-beads/src/index.ts`, the field-table prose in
  `packages/pi-beads/README.md`, the bullet in
  `packages/pi-superpowers-plus/skills/using-superpowers/references/pi-tools.md`, and this
  section. The original Context §3 text above is left unchanged as the record.
- **The "Out of scope" item "Fixing pi-core's stripping"** describes no pi-core behaviour:
  there is nothing in pi to fix. That follow-up bead should be re-scoped to the
  provider-side strict-sampling default.

Two related corrections landed in the same commit: `WRITE_TOOLS` now includes `beads_ready`
(it mutates with `claim: true`) and the comment records why `beads_memories` is deliberately
still excluded, and the guard wrapper forwards the whole `execute(toolCallId, params, signal,
onUpdate, ctx)` argument list instead of truncating it to two.
