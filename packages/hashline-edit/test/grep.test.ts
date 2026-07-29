import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createHashlineGrepTool, isRipgrepAvailable } from "../src/grep.js";

let dir: string;
let rgAvailable = false;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "hashline-grep-test-"));
	try {
		execFileSync("rg", ["--version"], { stdio: "ignore" });
		rgAvailable = true;
	} catch {
		rgAvailable = false;
	}
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

test("isRipgrepAvailable reflects whether rg is on PATH", async () => {
	assert.equal(await isRipgrepAvailable(), rgAvailable);
});

test("grep returns LINE#HASH:content anchors for matches", { skip: !rgAvailable }, async () => {
	writeFileSync(join(dir, "needle.ts"), "const findMe = 1;\nconst other = 2;\nconst findMe2 = 3;");
	const tool = createHashlineGrepTool();
	const result = await tool.execute(
		"call-1",
		{ pattern: "findMe", path: dir },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	const text = textOf(result);
	assert.match(text, /needle\.ts:1#[A-Za-z0-9_-]{3}:const findMe = 1;/);
	assert.match(text, /needle\.ts:3#[A-Za-z0-9_-]{3}:const findMe2 = 3;/);
});

test("grep supports literal string matching", { skip: !rgAvailable }, async () => {
	writeFileSync(join(dir, "literal.ts"), "a.b.c\naXbXc");
	const tool = createHashlineGrepTool();
	const result = await tool.execute(
		"call-1",
		{ pattern: "a.b.c", path: dir, literal: true },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	const text = textOf(result);
	assert.match(text, /literal\.ts:1#/);
	assert.ok(!text.includes("literal.ts:2#"));
});

test("grep respects the glob filter", { skip: !rgAvailable }, async () => {
	writeFileSync(join(dir, "match.ts"), "target");
	writeFileSync(join(dir, "match.md"), "target");
	const tool = createHashlineGrepTool();
	const result = await tool.execute(
		"call-1",
		{ pattern: "target", path: dir, glob: "*.ts" },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	const text = textOf(result);
	assert.match(text, /match\.ts/);
	assert.ok(!text.includes("match.md"));
});

test("grep respects the limit parameter", { skip: !rgAvailable }, async () => {
	writeFileSync(join(dir, "many.ts"), Array.from({ length: 10 }, () => "target").join("\n"));
	const tool = createHashlineGrepTool();
	const result = await tool.execute(
		"call-1",
		{ pattern: "target", path: dir, limit: 3 },
		undefined,
		undefined,
		{ cwd: dir } as never,
	);
	const matchCount = (textOf(result).match(/target/g) ?? []).length;
	assert.ok(matchCount <= 3);
});

test("grep respects .gitignore", { skip: !rgAvailable }, async () => {
	const repoDir = join(dir, "repo");
	mkdirSync(repoDir);
	execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
	writeFileSync(join(repoDir, ".gitignore"), "ignored.ts\n");
	writeFileSync(join(repoDir, "ignored.ts"), "target");
	writeFileSync(join(repoDir, "visible.ts"), "target");
	const tool = createHashlineGrepTool();
	const result = await tool.execute(
		"call-1",
		{ pattern: "target", path: repoDir },
		undefined,
		undefined,
		{ cwd: repoDir } as never,
	);
	const text = textOf(result);
	assert.match(text, /visible\.ts/);
	assert.ok(!text.includes("ignored.ts"));
});
