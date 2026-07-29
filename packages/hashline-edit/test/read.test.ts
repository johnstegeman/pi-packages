import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createHashlineReadTool } from "../src/read.js";

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "hashline-read-test-"));
});

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

test("read formats a text file with LINE#HASH:content rows", async () => {
	const filePath = join(dir, "hello.ts");
	writeFileSync(filePath, 'function hello() {\n  console.log("world");\n}');
	const tool = createHashlineReadTool();
	const result = await tool.execute("call-1", { path: filePath }, undefined, undefined, {
		cwd: dir,
	} as never);
	const text = textOf(result);
	assert.match(text, /^1#ZsQ:function hello\(\) \{$/m);
	assert.match(text, /^2#TmR: {2}console\.log\("world"\);$/m);
	assert.match(text, /^3#M8T:\}$/m);
});

test("read pads line numbers to the width of the largest shown line number", async () => {
	const filePath = join(dir, "ten-lines.txt");
	writeFileSync(filePath, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
	const tool = createHashlineReadTool();
	const result = await tool.execute("call-1", { path: filePath }, undefined, undefined, {
		cwd: dir,
	} as never);
	const text = textOf(result);
	const firstRow = text.split("\n")[0];
	assert.match(firstRow, /^ 1#/);
	const tenthRow = text.split("\n")[9];
	assert.match(tenthRow, /^10#/);
});

test("read respects offset and limit", async () => {
	const filePath = join(dir, "many-lines.txt");
	writeFileSync(filePath, Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n"));
	const tool = createHashlineReadTool();
	const result = await tool.execute(
		"call-1",
		{ path: filePath, offset: 5, limit: 3 },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	const lines = textOf(result).split("\n").filter(Boolean);
	assert.equal(lines.length, 3);
	assert.match(lines[0], /line5$/);
	assert.match(lines[2], /line7$/);
});

test("read rejects a directory path", async () => {
	const dirPath = join(dir, "a-directory");
	mkdirSync(dirPath);
	const tool = createHashlineReadTool();
	await assert.rejects(
		() => tool.execute("call-1", { path: dirPath }, undefined, undefined, { cwd: dir } as never),
		/E_NOT_FOUND/,
	);
});

test("read rejects a missing path", async () => {
	const tool = createHashlineReadTool();
	await assert.rejects(
		() =>
			tool.execute("call-1", { path: join(dir, "does-not-exist.txt") }, undefined, undefined, {
				cwd: dir,
			} as never),
		/E_NOT_FOUND/,
	);
});

test("read passes through a PNG image as an attachment, not hashlined text", async () => {
	const filePath = join(dir, "pic.png");
	writeFileSync(
		filePath,
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]),
	);
	const tool = createHashlineReadTool();
	const result = await tool.execute("call-1", { path: filePath }, undefined, undefined, {
		cwd: dir,
	} as never);
	const hasImage = result.content.some((c) => c.type === "image");
	assert.ok(hasImage);
	const hasHashlineText = result.content.some(
		(c) => c.type === "text" && /#[A-Za-z0-9_-]{3}:/.test((c as { text: string }).text),
	);
	assert.ok(!hasHashlineText);
});
