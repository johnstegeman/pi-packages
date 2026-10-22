# Tool and skill friction: seven fixes — design

**Date:** 2026-10-22
**Molecule:** `pi-packages-mol-wbq43` (`superpowers-workflow`, topic "fix the five tool/skill/extension friction findings from the 21-day pi session sweep")
**Scope:** `packages/hashline-edit`, `packages/pi-beads`, `packages/pi-superpowers-plus`

## Problem

A sweep of **1,231 session files** under `~/.pi/agent/sessions/` (21 days, 46,266 tool calls) found
friction concentrated in `edit` (13.9% of calls error), in prompt templates that bundle a direct
tool call into a `codemode` script, in `beads_*` payloads that are 21× larger than the digest the
package advertises, and in an SDD review flow that reads whole diffs into context.

**Measured failures** (errors only count `isError` tool results; §In-band failures adds the tier
below that):

| surface | calls | errors | rate | breakdown |
|---|---|---|---|---|
| `edit` | 3,285 | 458 | 13.9% | `E_STALE_ANCHOR` 241, `E_BAD_REF` 160, `E_EDIT_CONFLICT` 25, `E_NO_MATCH` 24, `E_MULTIPLE_MATCHES` 6, other 2 |
| `bash` | 29,543 | 455 | 1.5% | 180 were `timeout: command not found` (fixed outside this design by installing `timeout`), 275 otherwise |
| `codemode` | 3,763 | 82 | 2.2% | `set_phase is not defined` 54, `SyntaxError` 19, other 9 |
| `read` | 6,854 | 11 | 0.2% | 5 offset-past-EOF, 4 mis-resolved `skills/agent-templates/*`, 2 stale paths |

`E_BAD_REF` splits into three kinds, which is what makes one rule enough to handle all of it:

| kind | n | example |
|---|---|---|
| multi-op entry (one entry, two op keys) | 63 | `{replace: …, replace_text: …}` |
| malformed but self-correcting | 14 | `" 49 #Oau"`, `"562#T-x:"`, `"96#rfJ:"` |
| genuinely unusable | 83 | `"481#"`, `"1373"`, `"yRZ"`, `"1624#FZKQ"`, `"import { describe, … "` |

### In-band failures

`beads_*` reports failures as ordinary text, so they never appear as `isError`. They were counted
separately and added to this design:

| class | n | today | verdict |
|---|---|---|---|
| `cannot close blocked issue: X is blocked by [Y] (use --force to override)` | 83 | this tool cannot pass `--force`; 11 refusals were retried as-is, 4 went to `bd close --force` in bash, none took the legal path | **fixed (unit F)** |
| `unknown argument(s): …` | 23 | 18 are `typoKey` from agents probing the guard, 5 are `reason` sent to `beads_update`; no doc advertises it | not a defect |
| `bd <cmd> failed: <stderr>` | 34 | honest passthrough (F corrects the subset that advertises something unreachable) | out of scope |
| `unknown repo 'x' (known: …)` | 7 | message already lists the legal repos | not a defect |

## The rule this design holds to

Set by the human partner during brainstorming, and applied to every unit:

1. **Publish only what parses.** Every description, prompt guideline and doc example describes
   exactly the shape the code accepts.
2. **Repair only what the malformation proves.** Strip whitespace anywhere in an anchor token, drop
   one trailing `:`, and split a multi-op entry into one entry per op. Every repaired anchor is
   still hash-verified, so a repair removes noise and can never paper over staleness.
3. **Everything else fails, naming the legal form.** No hash is ever invented, and no capability is
   advertised that the tool cannot execute.

## Units

### A — anchor repair (`hashline-edit`)

`parseAnchor` (`src/hashline.ts:62`) accepts only `^([1-9][0-9]*)#([A-Za-z0-9_-]{3})$`, while `read`
emits anchors as `${padStart(line)}#${hash}:${content}` (`src/read.ts:16`). The format a model copies
back is therefore not the format the parser takes, which produced 14 failures of the shape
`" 49 #Oau"` and `"562#T-x:"`.

**After:** `parseAnchor` strips all whitespace within the token and one trailing `:`, then requires
`digits#3chars`. `" 49 #Oau"` → `{line: 49, hash: "Oau"}`; then the existing hash comparison in
`resolveAnchorToIndex` decides whether the edit proceeds. Nothing else is tolerated: `"481#"` (no
hash), `"1624#FZKQ"` (4 characters), `"1373"`, `"yRZ"` and pasted source text still fail, with the
reason string extended to name the legal form (`LINE#HASH`, three characters).

**Tests** (in `test/hashline.test.ts` and `test/edit.test.ts`), named after the observed inputs: a
padded anchor and a colon-suffixed anchor parse and edit successfully; a padded anchor whose hash is
wrong still returns `E_STALE_ANCHOR` (proving the repair does not bypass verification); `"481#"`,
`"1624#FZKQ"` and `"1373"` return `E_BAD_REF`.

### B — multi-op entries (`hashline-edit`)

`resolveEntry` (`src/edit.ts:314-322`) throws when one entry carries two op keys, but the tool
description (`src/edit.ts:428`) said `replace_text` "may be combined with other non-overlapping
edits", and `test/edit.test.ts:413` pins the *array*-level combination. Models read the sentence as
permission for the one-entry shape: 63 failures, 39 of them `{replace, replace_text}`. The tool
advertised something it could not do.

**After:** both halves. `normalizeEditEntry` (`src/edit.ts:168`) — which already repairs bare-array
ops and promoted anchor keys — returns one entry per op, and both call sites flat-map it. The result
is semantically identical because every op is resolved against the same pre-edit snapshot and all
pairs go through `validateResolvedOps`; genuinely overlapping ranges still return
`E_EDIT_CONFLICT`, which is the honest answer. The description is rewritten to state what the tool
does: one operation per entry, several ops in one entry are split, overlapping ranges conflict.

**Tests:** `{replace, replace_text}` in one entry applies both edits atomically (the 39-case shape);
`{append, replace}` in one entry applies both; two ops in one entry whose ranges overlap returns
`E_EDIT_CONFLICT` with no write; the existing array-level tests at `:413-500` keep passing unchanged.

### C — prompts (`pi-superpowers-plus`)

`set_phase` is a direct tool. Three SDD prompt templates introduce it in prose and immediately switch
to "from a codemode script", and the model merges the call into the script — 54 `ReferenceError: set_phase
is not defined` failures, 39 of them in task-reviewers.

| file | change |
|---|---|
| `skills/subagent-driven-development/task-reviewer-prompt.md:22` | name `set_phase` as a direct tool call, state that it is **not** part of the codemode script, and separate it visually from the script paragraph |
| `skills/subagent-driven-development/re-review-prompt.md:19` | same |
| `skills/subagent-driven-development/implementer-prompt.md:41` | same |
| `agent-templates/verifier.md` | add the "Reaching beads tools" note the other templates carry (verifiers shelled out to `bd` 90 times in the window) |
| `skills/requesting-code-review/code-reviewer.md`, `task-reviewer-prompt.md` | one clause where the `agent-templates/…` link appears: that directory is at the package root, not under `skills/` |

**Constraint:** `test/skills-contract.test.mjs:57` requires each of the three templates to emit
`set_phase({ phase: "development" })`, and `:232`/`:256` require the beads guardrail variant per
audience. This is rewording around those literals, not removal.

**Tests:** the contract suite is the test; no new assertion is needed beyond keeping it green.

### D — list results are an index (`pi-beads`)

Every read returns `jsonResult(text, structuredContent)` (`src/index.ts:959`). The compact half is
`fmtRows` (`:724`) — one line per issue. Codemode resolves `tools.beads_list(…)` to the structured
half, which carries each issue's **full `description`**: measured on the same four ready issues,
9,460 chars structured versus 446 chars compact (**21.2×**), with description 80% of the payload.
Over the window, list-family reads returned 342 codemode results / 424,869 tokens, and 45 results
were truncated (largest 49,300 tokens), after which **45 of 45** agents left the tool for bash, the
spill file, or `bd` itself.

The package has no direct surface — every `beads_*` tool is `codemode`/`deferred` — so "compact
output" was advertised on a surface that never delivered it.

**After:** `beads_ready`, `beads_list`, `beads_stale` and `beads_deps` omit `description` from their
structured payloads (index semantics); `beads_show` keeps the body and remains the way to read one.
`README.md` and `skills/beads/SKILL.md`'s table say so, and the tool descriptions say "index (use
`beads_show` for the body)". No new arguments, no new surface.

**Tests:** `test/tool-surface.test.mjs` (and a focused test in `pi-beads.test.mjs`) assert that no
`description` key appears in list-family payloads and that `beads_show` still returns one.

### E — bounded diff reads (`pi-superpowers-plus`)

`requesting-code-review/code-reviewer.md` and `subagent-driven-development/task-reviewer-prompt.md`
both instruct "read the diff file once … the full diff with surrounding context". Reads of
`.superpowers/sdd/**` totalled **1,051 reads / 27.2M chars (~6.8M tokens)**, and **87 results exceeded
60k chars**, holding 3.07M of those tokens; the largest single result was **709,822 chars (~177k
tokens)**. (Exact duplicate re-reads measured 0 — those are *paged* reads of one large file.)

**After:** the three templates say: check the package's line count first; when it exceeds 600 lines,
read the stat summary and then 400-line slices, and never re-read a slice. Total diff volume is unchanged —
the win is that no single result blows the context window, and the stat summary is seen first.

**Tests:** contract suite stays green; the instruction is prose, not code.

### F — a close refusal states what is legal (`pi-beads`)

`beads_close` declares `ids, reason, continue, suggestNext, claimNext, noAuto` (`src/index.ts:1636`)
and relays bd's stderr verbatim, so a blocked close returns
`cannot close blocked issue: X is blocked by [Y] (use --force to override)` — advertising a flag this
tool cannot pass. 83 refusals; what agents did next:

| next | n |
|---|---|
| retried the same close | 11 |
| `beads_list` / `beads_undep` then dropped it | 4 |
| `bd close --force` via bash | 4 |

`beads_gate_resolve`'s own description already promises this failure will not happen ("so
dependents' later `beads_close` never fails with 'blocked by open issues'") — the remedy exists, it
is just not named where the refusal lands.

**After:** `beads_close` recognises the blocked-close case and answers with the blocker ids plus the
legal moves — close or `beads_undep` the blocker when the dependency was wrong, `beads_gate_resolve`
when the blocker is a gate — and drops the `--force` hint it cannot honour. **No `force` parameter
is added**: force-closing a molecule step breaks the gate chain the workflow depends on, and four
agents already tried it blind.

**Tests:** a close of a bead blocked by an open bead returns the blocker id and the three moves, and
contains no `--force`; an unblocked close is unchanged.

### G — `E_MULTIPLE_MATCHES` names the fix (`hashline-edit`)

6 failures. `src/errors.ts:57` says "must match exactly once" but not how to get there.

**After:** the message adds "include more surrounding lines to make it unique".

## Verification

- `npm test` at the repo root (the package gate: `hashline-edit`, `pi-beads`, `pi-superpowers-plus`).
- Each unit lands a failing test first, named after a real observed input from the sweep.
- One commit per package; `npm ci` and a committed lockfile untouched (no dependency changes).

## Risks

| risk | mitigation |
|---|---|
| A repair accepts something ambiguous and edits the wrong line | the hash still has to match; a repaired-but-wrong anchor returns `E_STALE_ANCHOR` (tested) |
| B changes the error a malformed batch produces | only multi-op entries change path; overlap still `E_EDIT_CONFLICT`; existing 30-odd edit tests unchanged |
| D removes a field a consumer reads | the field is `description` on *list* results; `beads_show` is the documented body path, and the change is stated in README plus the skill table |
| C/E break the skills contract suite | both are prose edits constrained by `skills-contract.test.mjs`; the suite is run per commit |
| F hides a genuine bd error | only the blocked-close shape is rewritten; every other failure keeps the passthrough |

## Non-goals

- **Fresh anchors in `E_STALE_ANCHOR`** (241 failures stay failures). Handing back a current hash
  would let an edit land on content the model never read, which is the one thing the hash exists to
  prevent.
- **A `force` parameter on `beads_close`** — see F.
- **Compacting `beads_mol_show` / `beads_mol_current`** (99,031 / 44,295 chars): a deliberate full
  dump of one molecule, called twice in three weeks.
- **TypeScript in `codemode`** (19 `SyntaxError`s): would need overriding pi's own `codemode`
  description, and the tool already says "Run JavaScript".
- **`timeout`** — resolved by installing `timeout` on this machine, outside the repo.
