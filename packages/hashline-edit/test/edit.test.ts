import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createHashlineEditTool } from "../src/edit.js";
import { computeLineHashes } from "../src/hashline.js";

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
