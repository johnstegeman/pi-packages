# Hashline Mixed `replace_text` Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow non-overlapping `replace_text` operations to participate in atomic batches with anchored hashline edits while preserving pre-edit snapshot semantics.

**Architecture:** Resolve every edit against the original file snapshot. Convert `replace_text` from its current whole-file replacement into a targeted line-range replacement that preserves boundary text. Detect overlapping resolved operations before the existing bottom-up splice/write phase and report a dedicated `E_EDIT_CONFLICT` error.

**Tech Stack:** TypeScript, Node.js built-in test runner, `tsx`, TypeBox, Biome.

## Global Constraints

- All operations in one batch resolve against the original file snapshot.
- No write occurs until every operation resolves and conflict validation succeeds.
- Existing `replace`, `append`, `prepend`, and single-operation `replace_text` behavior remains compatible.
- Mixed operations must be non-overlapping; conflicts must return `E_EDIT_CONFLICT` and advise splitting the batch.
- Run package-scoped commands from `packages/hashline-edit/`.

---

### Task 1: Add failing coverage for mixed replacement and conflict semantics

**Files:**
- Modify: `packages/hashline-edit/test/edit.test.ts` near the existing `replace_text` tests and multi-op batch tests.

**Interfaces:**
- Consumes: `createHashlineEditTool`, existing `defaultConfig`, `anchorFor`, and test helpers.
- Produces: executable expectations for the resolver/application behavior implemented in Task 2.

- [ ] **Step 1: Add a failing mixed-batch test for a partial-line replacement**

Add a test shaped like this, using the file’s existing helpers and `tool.execute` calling convention:

```ts
test("replace_text combines with anchored edits atomically", async () => {
	const filePath = join(dir, "mixed.ts");
	const original = "one\ntwo target\nthree";
	writeFileSync(filePath, original);
	const anchor = anchorFor(original, 1);
	const tool = createHashlineEditTool(defaultConfig);

	await tool.execute(
		"call-1",
		{
			path: filePath,
			edits: [
				{ replace: { pos: anchor, lines: ["ONE"] } },
				{ replace_text: { oldText: "target", newText: "new" } },
			],
		},
		undefined,
		undefined,
		{ cwd: dir } as never,
	);

	assert.equal(readFileSync(filePath, "utf-8"), "ONE\ntwo new\nthree");
});
```

- [ ] **Step 2: Add failing tests for multi-line and line-count-changing `replace_text`**

Cover a match that starts or ends mid-line and a `newText` containing a newline. Assert that the unaffected prefix/suffix is retained and the final file has the expected lines.

- [ ] **Step 3: Add a failing test for multiple non-overlapping `replace_text` entries**

Submit two unique replacements in one `edits` array and assert both are present in the final file.

- [ ] **Step 4: Add a failing overlap test with no partial write**

Use two operations targeting the same line or a `replace_text` match inside a line targeted by `replace`. Assert rejection matching `/E_EDIT_CONFLICT/`, assert the message contains guidance such as `/split.*batch|separate.*call/i`, and assert the file still equals its original content.

- [ ] **Step 5: Run the focused tests and verify they fail for the current reason**

Run:

```bash
cd packages/hashline-edit && node --import tsx --test test/edit.test.ts
```

Expected: the new mixed-batch tests fail because the current implementation rejects `replace_text` batches, and the conflict test fails because `E_EDIT_CONFLICT` does not yet exist.

- [ ] **Step 6: Commit the failing tests**

```bash
git add packages/hashline-edit/test/edit.test.ts
git commit -m "test: cover mixed hashline replace_text batches"
```

---

### Task 2: Implement targeted `replace_text` resolution and conflict errors

**Files:**
- Modify: `packages/hashline-edit/src/errors.ts`
- Modify: `packages/hashline-edit/src/edit.ts` in `ResolvedOp`, `resolveEntry`, and the batch execution path.

**Interfaces:**
- Consumes: `EditEntry`, original `lines`, `fullText`, existing `ResolvedOp`, and bottom-up application.
- Produces: `E_EDIT_CONFLICT` and resolved line-range operations for all supported edit kinds.

- [ ] **Step 1: Add the new error code and constructor**

In `packages/hashline-edit/src/errors.ts`, add `"E_EDIT_CONFLICT"` to `HashlineErrorCode` and add a helper with an actionable message:

```ts
export function editConflictError(detail: string): HashlineError {
	return new HashlineError(
		"E_EDIT_CONFLICT",
		`${detail}. Split the batch into separate edit calls or revise the overlapping ranges.`,
	);
}
```

- [ ] **Step 2: Write a helper that maps a unique substring match to affected lines**

In `packages/hashline-edit/src/edit.ts`, keep the existing exact-match and pasted-anchor checks. After finding `firstIndex`, calculate `matchEnd = firstIndex + oldText.length` and derive the starting and ending line indices from newline boundaries in the original `fullText`.

Construct the replacement text for the affected range as:

```ts
const lineStart = fullText.lastIndexOf("\n", firstIndex - 1) + 1;
const afterMatch = fullText.slice(matchEnd);
const nextNewline = afterMatch.indexOf("\n");
const suffix = nextNewline === -1 ? afterMatch : afterMatch.slice(0, nextNewline);
const prefix = fullText.slice(lineStart, firstIndex);
const replacementLines = (prefix + newText + suffix).split("\n");
```

Use a precise calculation for `startIndex` and `endIndex` based on the number of newlines before `firstIndex` and before `matchEnd`. Handle a match ending exactly at a newline without accidentally including the following line’s content; add tests for boundary cases if the initial focused tests expose an off-by-one issue.

Return:

```ts
return {
	kind: "replace",
	startIndex,
	endIndex,
	lines: replacementLines,
};
```

This replaces only the affected original lines and preserves all text outside the match.

- [ ] **Step 3: Remove the whole-file replacement behavior and batch guard**

Delete the `replace_text` return that currently uses `startIndex: 0`, `endIndex: lines.length - 1`, and the entire `replaceTextCount` / `"(batch)"` rejection block. Keep the normal `entries.map(resolveEntry)` and bottom-up application flow.

- [ ] **Step 4: Add resolved-operation overlap validation**

After resolving entries and before sorting/applying, validate the ranges. Treat ordinary replacements as inclusive spans. Treat append/prepend as insertion points. Reject:

- intersecting replacement spans;
- an insertion point inside a replacement’s affected boundary;
- two insertions at the same point.

Use `editConflictError(...)` and include operation indexes and/or line ranges in the detail. Do not write before this check.

- [ ] **Step 5: Run focused tests and fix implementation defects**

Run:

```bash
cd packages/hashline-edit && node --import tsx --test test/edit.test.ts
```

Expected: all edit tests pass, including mixed batches, multi-line replacements, non-overlapping multiple replacements, and `E_EDIT_CONFLICT` behavior.

- [ ] **Step 6: Run type checking and formatting checks**

```bash
cd packages/hashline-edit && npm run typecheck && npx biome check src test
```

Fix any type or formatting errors without changing the specified semantics.

- [ ] **Step 7: Commit the implementation**

```bash
git add packages/hashline-edit/src/errors.ts packages/hashline-edit/src/edit.ts packages/hashline-edit/test/edit.test.ts
git commit -m "feat: support mixed hashline replace_text batches"
```

---

### Task 3: Update agent-facing documentation and run the package suite

**Files:**
- Modify: `packages/hashline-edit/src/edit.ts` tool `description` and `promptGuidelines` if needed.
- Modify: `packages/hashline-edit/README.md` operation table and batching guidance.

**Interfaces:**
- Consumes: the implemented mixed-batch behavior and `E_EDIT_CONFLICT` recovery message.
- Produces: accurate instructions for agents and users.

- [ ] **Step 1: Update the tool description**

Remove the sentence that says `replace_text` must be the only entry in `edits[]`. State instead that all operations are resolved against the same pre-edit snapshot, are applied atomically, and must not overlap.

Use wording equivalent to:

```text
Ops: replace, append, prepend, replace_text. All operations are resolved against the current file snapshot and applied atomically; replace_text may be combined with other non-overlapping edits.
```

- [ ] **Step 2: Update the README**

Change the `replace_text` row to say it may be combined with other operations when resolved ranges do not overlap. Document that overlapping batches return `E_EDIT_CONFLICT` and should be split into separate calls.

- [ ] **Step 3: Run the complete package checks**

```bash
cd packages/hashline-edit && npm test
cd packages/hashline-edit && npm run check
```

Expected: all tests, type checks, and Biome checks pass.

- [ ] **Step 4: Review the final diff for scope and documentation accuracy**

```bash
git diff HEAD~2..HEAD -- packages/hashline-edit docs/superpowers/specs/2026-08-07-hashline-mixed-replace-text-design.md
git status --short
```

Confirm that only the planned package files and committed design/test changes are included. Do not add the pre-existing untracked `.pi/` directory.

- [ ] **Step 5: Commit documentation changes**

```bash
git add packages/hashline-edit/src/edit.ts packages/hashline-edit/README.md
git commit -m "docs: describe mixed hashline edit batches"
```

---

## Verification

After all tasks:

```bash
cd packages/hashline-edit && npm run check
```

The final implementation is complete when mixed non-overlapping batches pass, overlapping batches return `E_EDIT_CONFLICT` with split-batch guidance and no write, all existing tests pass, and the tool description/README no longer instruct agents to submit `replace_text` alone.
