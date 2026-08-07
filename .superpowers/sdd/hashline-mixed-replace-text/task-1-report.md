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

## Fix round 2 changes

- Changed the anchored operation in `mixed replace_text preserves partial-line context across a multi-line replacement` from line 2 to the final line, outside the two-line `replace_text` match.
- Updated the anchored replacement and final expected content to use `FINAL`.
- Preserved the partial-line prefix/suffix assertions and the line-count increase assertion.
- No production code was modified.

## Tests run

Command:

```bash
cd packages/hashline-edit && node --import tsx --test test/edit.test.ts
```

Output summary after the fix: 36 tests total; 32 passed and 4 failed. The mixed multi-line/line-count-changing test still fails with the current `E_BAD_REF` batch restriction (`replace_text cannot be combined with other edits in the same call`), confirming it remains a meaningful red test while using a genuinely non-overlapping anchor. The other three expected red tests are mixed anchored + `replace_text`, multiple non-overlapping `replace_text` operations, and overlapping mixed edits requiring `E_EDIT_CONFLICT`; the overlap test receives the same current batch restriction before conflict detection. The test runner also emits Node's existing `module.register()` deprecation warning.

`git diff --check` passed.

## Concerns

- The brief path requested by the task was absent; the brief was found under the dated `2026-08-07-hashline-mixed-replace-text` directory, while this report remains at the exact report path requested.
- The focused suite is intentionally red until the Task 2 production implementation lands.
