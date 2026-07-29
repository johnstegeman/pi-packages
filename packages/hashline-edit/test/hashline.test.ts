import assert from "node:assert/strict";
import test from "node:test";
import { computeLineHashes, formatAnchor, parseAnchor } from "../src/hashline.js";

test("computeLineHashes is deterministic for a simple multi-line file", () => {
	const content = 'function hello() {\n  console.log("world");\n}';
	const hashes = computeLineHashes(content);
	assert.deepEqual(hashes, ["ZsQ", "TmR", "M8T"]);
});

test("computeLineHashes treats an empty file as one line", () => {
	const hashes = computeLineHashes("");
	assert.deepEqual(hashes, ["1Z1"]);
});

test("computeLineHashes counts a trailing newline as an extra empty line", () => {
	const hashes = computeLineHashes("foo\n");
	assert.deepEqual(hashes, ["o-v", "mQX"]);
});

test("computeLineHashes ignores trailing whitespace differences", () => {
	const a = computeLineHashes("x\ny\nz");
	const b = computeLineHashes("x\ny  \nz");
	assert.deepEqual(a, b);
	assert.deepEqual(a, ["98i", "HqO", "xJe"]);
});

test("computeLineHashes gives identical line content different hashes in different contexts", () => {
	const c1 = computeLineHashes("a\nSAME\nb");
	const c2 = computeLineHashes("x\nSAME\ny");
	assert.notEqual(c1[1], c2[1]);
	assert.deepEqual(c1, ["-LE", "Mrw", "ugb"]);
	assert.deepEqual(c2, ["_B5", "tII", "MMs"]);
});

test("computeLineHashes resolves collisions among duplicate lines with identical context", () => {
	// Every interior line is "", so prev/curr/next are identical for lines 1-3;
	// without collision resolution these would all hash the same.
	const hashes = computeLineHashes(["", "", "", "", ""].join("\n"));
	assert.deepEqual(hashes, ["1Z1", "B06", "Bun", "BoU", "BiB"]);
	assert.equal(new Set(hashes).size, hashes.length);
});

test("computeLineHashes resolves collisions among duplicate non-empty lines", () => {
	const hashes = computeLineHashes(["import a", "}", "}", "}", "done"].join("\n"));
	assert.deepEqual(hashes, ["YzG", "Qez", "ZSk", "e49", "EXs"]);
	assert.equal(new Set(hashes).size, hashes.length);
});

test("formatAnchor and parseAnchor round-trip", () => {
	assert.equal(formatAnchor(9, "Xy_"), "9#Xy_");
	assert.deepEqual(parseAnchor("9#Xy_"), { line: 9, hash: "Xy_" });
});

test("parseAnchor rejects malformed anchors", () => {
	assert.equal(parseAnchor("bad"), null);
	assert.equal(parseAnchor("9#"), null);
	assert.equal(parseAnchor("#Xy_"), null);
	assert.equal(parseAnchor("9#Xy_extra"), null);
	assert.equal(parseAnchor("0#Xy_"), null);
	assert.equal(parseAnchor("-1#Xy_"), null);
});
