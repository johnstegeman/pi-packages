# Hashline Edit: Mixed `replace_text` Batches

## Problem

The hashline edit extension currently rejects any batch containing `replace_text` together with another edit. The restriction exists because `replace_text` is resolved as a whole-file replacement, while anchored operations are resolved as line ranges and applied bottom-up. If combined, the whole-file replacement can overwrite the other edits.

This causes agents to receive an avoidable `E_BAD_REF` error when a valid set of independent changes is submitted in one atomic call.

## Goals

- Allow `replace_text` to be combined with `replace`, `append`, and `prepend` in one edit call.
- Preserve the existing same-snapshot semantics: every operation is resolved against the original file content before any operation is applied.
- Preserve atomicity: no file write occurs if any operation fails to resolve or if the batch conflicts.
- Handle partial-line, multi-line, and line-count-changing substring replacements.
- Give callers a distinct, actionable error when resolved operations overlap.
- Update tool-facing documentation so agents no longer believe `replace_text` must be submitted alone.

## Non-goals

- Do not change the ordering semantics of existing anchored batches.
- Do not make later operations observe earlier operations in the same array.
- Do not redesign the edit engine around character-offset operations.
- Do not silently choose a winner when two operations target overlapping content.

## Design

### Snapshot and resolution

The tool will continue to read the file once, compute its original lines and hashes, and resolve the entire batch against that immutable snapshot.

Each operation will resolve to a common line-range replacement representation:

- `replace`: its existing anchored start/end range and replacement lines.
- `append` / `prepend`: their existing insertion ranges and replacement lines.
- `replace_text`: the unique `oldText` match is located in the original full text. The implementation determines the first and last affected line, preserves the unmatched prefix of the first boundary line and suffix of the last boundary line, inserts `newText`, and splits the result into replacement lines.

For example, replacing a substring in:

```text
alpha
before target after
omega
```

with `new\nvalue` produces a line-range replacement equivalent to:

```text
before new
value after
```

The resulting operation can participate in the existing bottom-up line-splice algorithm without clobbering unrelated edits.

### Application

After all operations resolve successfully:

1. Detect overlapping resolved ranges.
2. Reject a conflicting batch before writing.
3. Sort non-overlapping operations from highest starting line to lowest.
4. Apply them to a copy of the original lines.
5. Write the resulting file atomically.
6. Return fresh anchors for the actual changed region.

This preserves the existing behavior in which edits from one read snapshot can be batched safely even when higher edits change the line count.

### Conflicts and errors

Add `E_EDIT_CONFLICT` to the hashline error taxonomy. It is distinct from `E_BAD_REF`:

- `E_BAD_REF`: an individual operation or anchor is structurally invalid.
- `E_STALE_ANCHOR`: an anchor no longer matches the file.
- `E_EDIT_CONFLICT`: individually valid operations overlap after resolution and cannot safely be applied together.

The conflict error should identify the conflicting operation/range where practical and explicitly advise the caller to split the batch into separate calls or revise the ranges. The conflict must be raised before any write, leaving the file unchanged.

For conflict detection, a replacement spanning lines `start..end` conflicts with any other replacement whose span intersects it. An insertion conflicts with a replacement when its insertion point falls inside that replacement's affected boundary, and two insertions at the same point conflict because their ordering would otherwise be implicit. Insertions at distinct points and replacements with no intersecting insertion point or line span remain batch-compatible.

Existing `replace_text` behavior remains unchanged for:

- `E_NO_MATCH` when `oldText` is absent;
- `E_MULTIPLE_MATCHES` when `oldText` is not unique;
- `E_INVALID_PATCH` for pasted hashline output;
- configuration rejection when `replaceText` is disabled.

### Documentation

Update the tool description and prompt guidance in `packages/hashline-edit/src/edit.ts` to remove the claim that `replace_text` must be the only batch entry.

Update `packages/hashline-edit/README.md` to state that `replace_text` is batch-compatible, subject to non-overlapping resolved ranges and the normal atomic validation rules.

## Testing

Update `packages/hashline-edit/test/edit.test.ts` to cover:

- an anchored edit combined with a single-line `replace_text`;
- mixed edits on different lines, including line-count shifts;
- partial-line replacements preserving prefix and suffix text;
- multi-line `oldText` and/or `newText`;
- multiple non-overlapping `replace_text` operations;
- overlapping mixed operations returning `E_EDIT_CONFLICT`, with no write;
- the existing exact-match, no-match, multiple-match, disabled-config, pasted-anchor, atomicity, and fresh-anchor behavior.

## Acceptance criteria

- A valid batch containing non-overlapping anchored and `replace_text` operations succeeds in one call.
- All operations are resolved against the pre-edit snapshot.
- Any resolution failure or overlap produces an error before writing.
- Overlap errors use `E_EDIT_CONFLICT` and tell the caller how to recover.
- Existing single-operation behavior and anchored batch behavior remain compatible.
- Tests and user-facing documentation accurately describe the new behavior.
