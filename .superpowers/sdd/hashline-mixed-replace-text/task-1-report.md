# Task 1 Report

## Status

DONE_WITH_CONCERNS

## Commits

- `481ade872a21a3d6f79ae543bbdb046902238bca` — `test: cover mixed hashline replace_text batches`
- `eb3615d20bdeb721c55257271f7c94aea2d1331a` — revised the multi-line `replace_text` regression coverage to use a mixed anchored + `replace_text` batch.

## Fix round 1 changes

- Updated `mixed replace_text preserves partial-line context across a multi-line replacement` so it includes a non-overlapping anchored replacement in the same `edits` array.
- Retained assertions for partial-line prefix/suffix preservation and line-count increase.
- The focused test now exercises behavior unavailable before implementation rather than passing as a standalone `replace_text` operation.
- No production code was modified.

## Tests run

Command:

```bash
cd packages/hashline-edit && node --import tsx --test test/edit.test.ts
```

Output summary: 36 tests total; 32 passed and 4 failed. The four expected red tests are mixed anchored + `replace_text`, mixed multi-line/line-count-changing partial-line replacement, multiple non-overlapping `replace_text` operations, and overlapping mixed edits requiring `E_EDIT_CONFLICT`. The first three fail with the current `E_BAD_REF` batch restriction (`replace_text cannot be combined with other edits in the same call`); the overlap test receives that same current restriction before conflict detection. The test runner also emits Node's existing `module.register()` deprecation warning.

`git diff --check` passed.

## Concerns

- The brief path requested by the task was absent; the brief was found under the dated `2026-08-07-hashline-mixed-replace-text` directory, while this report remains at the exact report path requested.
- The focused suite is intentionally red until the Task 2 production implementation lands.
