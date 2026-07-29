import assert from "node:assert/strict";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createHashlineEditTool } from "../src/edit.js";
import { computeLineHashes, formatAnchor } from "../src/hashline.js";

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "hashline-edit-test-"));
});

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

function anchorFor(content: string, lineNumber: number): string {
	const hashes = computeLineHashes(content);
	return `${lineNumber}#${hashes[lineNumber - 1]}`;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function defaultConfig() {
	return { grep: false, replaceText: true };
}

test("replace op replaces a single line by anchor", async () => {
	const filePath = join(dir, "a.ts");
	const original = 'function hello() {\n  console.log("world");\n}';
	writeFileSync(filePath, original);
	const anchor = anchorFor(original, 2);
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{
			path: filePath,
			edits: [{ replace: { pos: anchor, lines: ['  console.log("hashline");'] } }],
		},
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	assert.equal(
		readFileSync(filePath, "utf-8"),
		'function hello() {\n  console.log("hashline");\n}',
	);
});

test("replace op with end deletes a range when lines is empty", async () => {
	const filePath = join(dir, "b.ts");
	const original = "one\ntwo\nthree\nfour";
	writeFileSync(filePath, original);
	const startAnchor = anchorFor(original, 2);
	const endAnchor = anchorFor(original, 3);
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{ path: filePath, edits: [{ replace: { pos: startAnchor, end: endAnchor, lines: [] } }] },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	assert.equal(readFileSync(filePath, "utf-8"), "one\nfour");
});

test("append op inserts lines after the anchor", async () => {
	const filePath = join(dir, "c.ts");
	const original = "one\ntwo\nthree";
	writeFileSync(filePath, original);
	const anchor = anchorFor(original, 1);
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{ path: filePath, edits: [{ append: { pos: anchor, lines: ["inserted"] } }] },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	assert.equal(readFileSync(filePath, "utf-8"), "one\ninserted\ntwo\nthree");
});

test("append op with no pos appends at EOF", async () => {
	const filePath = join(dir, "d.ts");
	const original = "one\ntwo";
	writeFileSync(filePath, original);
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{ path: filePath, edits: [{ append: { lines: ["three"] } }] },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	assert.equal(readFileSync(filePath, "utf-8"), "one\ntwo\nthree");
});

test("prepend op inserts lines before the anchor", async () => {
	const filePath = join(dir, "e.ts");
	const original = "one\ntwo\nthree";
	writeFileSync(filePath, original);
	const anchor = anchorFor(original, 2);
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{ path: filePath, edits: [{ prepend: { pos: anchor, lines: ["inserted"] } }] },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	assert.equal(readFileSync(filePath, "utf-8"), "one\ninserted\ntwo\nthree");
});

test("prepend op with no pos prepends at BOF", async () => {
	const filePath = join(dir, "f.ts");
	const original = "one\ntwo";
	writeFileSync(filePath, original);
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{ path: filePath, edits: [{ prepend: { lines: ["zero"] } }] },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	assert.equal(readFileSync(filePath, "utf-8"), "zero\none\ntwo");
});

test("replace_text replaces a unique exact substring", async () => {
	const filePath = join(dir, "g.ts");
	writeFileSync(filePath, "const x = 1;\nconst y = 2;");
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{
			path: filePath,
			edits: [{ replace_text: { oldText: "const x = 1;", newText: "const x = 100;" } }],
		},
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	assert.equal(readFileSync(filePath, "utf-8"), "const x = 100;\nconst y = 2;");
});

test("replace_text rejects zero matches with E_NO_MATCH", async () => {
	const filePath = join(dir, "h.ts");
	writeFileSync(filePath, "const x = 1;");
	const tool = createHashlineEditTool(defaultConfig);
	await assert.rejects(
		() =>
			tool.execute(
				"call-1",
				{ path: filePath, edits: [{ replace_text: { oldText: "not present", newText: "y" } }] },
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
		/E_NO_MATCH/,
	);
});

test("replace_text rejects multiple matches with E_MULTIPLE_MATCHES", async () => {
	const filePath = join(dir, "i.ts");
	writeFileSync(filePath, "dup\ndup");
	const tool = createHashlineEditTool(defaultConfig);
	await assert.rejects(
		() =>
			tool.execute(
				"call-1",
				{ path: filePath, edits: [{ replace_text: { oldText: "dup", newText: "x" } }] },
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
		/E_MULTIPLE_MATCHES/,
	);
});

test("replace_text is rejected when config.replaceText is false", async () => {
	const filePath = join(dir, "j.ts");
	writeFileSync(filePath, "const x = 1;");
	const tool = createHashlineEditTool(() => ({ grep: false, replaceText: false }));
	await assert.rejects(
		() =>
			tool.execute(
				"call-1",
				{ path: filePath, edits: [{ replace_text: { oldText: "const x = 1;", newText: "y" } }] },
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
		/replace_text is disabled/i,
	);
});

test("replace_text rejects input containing pasted hashline anchors", async () => {
	const filePath = join(dir, "k.ts");
	writeFileSync(filePath, "const x = 1;");
	const tool = createHashlineEditTool(defaultConfig);
	await assert.rejects(
		() =>
			tool.execute(
				"call-1",
				{
					path: filePath,
					edits: [{ replace_text: { oldText: "const x = 1;", newText: "1#Xy_:const x = 2;" } }],
				},
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
		/E_INVALID_PATCH/,
	);
});

test("a stale anchor is rejected with E_STALE_ANCHOR and no write occurs", async () => {
	const filePath = join(dir, "l.ts");
	const original = "one\ntwo\nthree";
	writeFileSync(filePath, original);
	const tool = createHashlineEditTool(defaultConfig);
	await assert.rejects(
		() =>
			tool.execute(
				"call-1",
				{ path: filePath, edits: [{ replace: { pos: "2#zzz", lines: ["changed"] } }] },
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
		/E_STALE_ANCHOR/,
	);
	assert.equal(readFileSync(filePath, "utf-8"), original);
});

test("a malformed anchor is rejected with E_BAD_REF", async () => {
	const filePath = join(dir, "m.ts");
	writeFileSync(filePath, "one\ntwo");
	const tool = createHashlineEditTool(defaultConfig);
	await assert.rejects(
		() =>
			tool.execute(
				"call-1",
				{ path: filePath, edits: [{ replace: { pos: "not-an-anchor", lines: ["x"] } }] },
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
		/E_BAD_REF/,
	);
});

test("one invalid anchor in a batch fails the whole call with no partial write", async () => {
	const filePath = join(dir, "n.ts");
	const original = "one\ntwo\nthree";
	writeFileSync(filePath, original);
	const validAnchor = anchorFor(original, 1);
	const tool = createHashlineEditTool(defaultConfig);
	await assert.rejects(
		() =>
			tool.execute(
				"call-1",
				{
					path: filePath,
					edits: [
						{ replace: { pos: validAnchor, lines: ["ONE"] } },
						{ replace: { pos: "3#zzz", lines: ["THREE"] } },
					],
				},
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
		/E_STALE_ANCHOR/,
	);
	assert.equal(readFileSync(filePath, "utf-8"), original);
});

test("multiple edits in one call apply bottom-up without anchors shifting", async () => {
	const filePath = join(dir, "o.ts");
	const original = "one\ntwo\nthree\nfour";
	writeFileSync(filePath, original);
	const anchor2 = anchorFor(original, 2);
	const anchor4 = anchorFor(original, 4);
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{
			path: filePath,
			edits: [
				{ replace: { pos: anchor2, lines: ["TWO", "TWO-B"] } },
				{ replace: { pos: anchor4, lines: ["FOUR"] } },
			],
		},
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	assert.equal(readFileSync(filePath, "utf-8"), "one\nTWO\nTWO-B\nthree\nFOUR");
});

test("replace_text cannot be combined with another edit in the same batch", async () => {
	const filePath = join(dir, "o2.ts");
	const original = "one\ntwo\nthree";
	writeFileSync(filePath, original);
	const anchor1 = anchorFor(original, 1);
	const tool = createHashlineEditTool(defaultConfig);
	await assert.rejects(
		() =>
			tool.execute(
				"call-1",
				{
					path: filePath,
					edits: [
						{ replace: { pos: anchor1, lines: ["ONE"] } },
						{ replace_text: { oldText: "two", newText: "TWO" } },
					],
				},
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
		/E_BAD_REF/,
	);
	assert.equal(readFileSync(filePath, "utf-8"), original);
});

test("a successful edit returns fresh anchors for the changed region", async () => {
	const filePath = join(dir, "p.ts");
	const original = "one\ntwo\nthree";
	writeFileSync(filePath, original);
	const anchor = anchorFor(original, 2);
	const tool = createHashlineEditTool(defaultConfig);
	const result = await tool.execute(
		"call-1",
		{ path: filePath, edits: [{ replace: { pos: anchor, lines: ["TWO"] } }] },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	const text = textOf(result);
	assert.match(text, /Anchors/);
	assert.match(text, /#[A-Za-z0-9_-]{3}:TWO/);
});

test("edit preserves a symlink, writing through to the real target", async () => {
	const realPath = join(dir, "real-q.ts");
	const linkPath = join(dir, "link-q.ts");
	const original = "one\ntwo";
	writeFileSync(realPath, original);
	symlinkSync(realPath, linkPath);
	const anchor = anchorFor(original, 1);
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{ path: linkPath, edits: [{ replace: { pos: anchor, lines: ["ONE"] } }] },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	assert.equal(readFileSync(realPath, "utf-8"), "ONE\ntwo");
	assert.ok(lstatSync(linkPath).isSymbolicLink());
});

test("edit preserves a hard link, updating the shared inode visible from both paths", async () => {
	const originalPath = join(dir, "real-r.ts");
	const hardLinkPath = join(dir, "link-r.ts");
	const original = "one\ntwo";
	writeFileSync(originalPath, original);
	linkSync(originalPath, hardLinkPath);
	const inoBefore = statSync(originalPath).ino;
	assert.equal(statSync(hardLinkPath).ino, inoBefore);

	const anchor = anchorFor(original, 1);
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{ path: originalPath, edits: [{ replace: { pos: anchor, lines: ["ONE"] } }] },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);

	// Edited via originalPath; the change must be visible through the other hard-linked path too.
	assert.equal(readFileSync(originalPath, "utf-8"), "ONE\ntwo");
	assert.equal(readFileSync(hardLinkPath, "utf-8"), "ONE\ntwo");

	// The shared inode must be preserved, not replaced by a new file via rename.
	const inoAfter = statSync(originalPath).ino;
	assert.equal(statSync(hardLinkPath).ino, inoAfter);
	assert.equal(inoAfter, inoBefore);
});

test("a multi-op batch with a line-count shift returns anchors matching the final file content", async () => {
	const filePath = join(dir, "s.ts");
	const original = "one\ntwo\nthree\nfour\nfive";
	writeFileSync(filePath, original);
	const anchor2 = anchorFor(original, 2);
	const anchor5 = anchorFor(original, 5);
	const tool = createHashlineEditTool(defaultConfig);
	const result = await tool.execute(
		"call-1",
		{
			path: filePath,
			edits: [
				// Turns 1 line into 2, shifting every subsequent line down by one.
				{ replace: { pos: anchor2, lines: ["TWO-A", "TWO-B"] } },
				{ replace: { pos: anchor5, lines: ["FIVE"] } },
			],
		},
		undefined,
		undefined,
		{ cwd: dir } as never,
	);

	const finalContent = readFileSync(filePath, "utf-8");
	assert.equal(finalContent, "one\nTWO-A\nTWO-B\nthree\nfour\nFIVE");

	const finalLines = finalContent.split("\n");
	const finalHashes = computeLineHashes(finalContent);
	// Changed region: from the first edited line ( "TWO-A", now line 2) through the last edited
	// line ("FIVE", shifted from line 5 to line 6 by the one-line insertion above it).
	const expectedStart = 2;
	const expectedEnd = 6;
	const expectedAnchorText = finalLines
		.slice(expectedStart - 1, expectedEnd)
		.map(
			(line, i) => `${formatAnchor(expectedStart + i, finalHashes[expectedStart - 1 + i])}:${line}`,
		)
		.join("\n");

	const text = textOf(result);
	assert.match(text, new RegExp(`--- Anchors ${expectedStart}-${expectedEnd} ---`));
	assert.ok(
		text.includes(expectedAnchorText),
		`expected anchor block:\n${expectedAnchorText}\n\nactual response:\n${text}`,
	);
});

test("an edit entry with multiple op fields set is rejected with no partial write", async () => {
	const filePath = join(dir, "t.ts");
	const original = "one\ntwo\nthree";
	writeFileSync(filePath, original);
	const anchor = anchorFor(original, 1);
	const tool = createHashlineEditTool(defaultConfig);
	await assert.rejects(
		() =>
			tool.execute(
				"call-1",
				{
					path: filePath,
					edits: [
						{
							replace: { pos: anchor, lines: ["ONE"] },
							append: { pos: anchor, lines: ["INSERTED"] },
						},
					],
				},
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
		/exactly one/i,
	);
	assert.equal(readFileSync(filePath, "utf-8"), original);
});

test("an edit through the temp+rename path preserves the original file's permissions", async () => {
	const filePath = join(dir, "u.ts");
	const original = "one\ntwo\nthree";
	writeFileSync(filePath, original);
	chmodSync(filePath, 0o600);
	const anchor = anchorFor(original, 1);
	const tool = createHashlineEditTool(defaultConfig);
	await tool.execute(
		"call-1",
		{ path: filePath, edits: [{ replace: { pos: anchor, lines: ["ONE"] } }] },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	assert.equal(statSync(filePath).mode & 0o777, 0o600);
});
