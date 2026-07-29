import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { loadConfig } from "../src/config.js";

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "hashline-config-test-"));
});

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("loadConfig returns defaults when the file is missing", () => {
	const missingDir = join(dir, "does-not-exist");
	const { config, warning } = loadConfig(missingDir);
	assert.deepEqual(config, { grep: false, replaceText: true });
	assert.equal(warning, undefined);
});

test("loadConfig reads valid grep/replaceText values", () => {
	writeFileSync(join(dir, "hashline.json"), JSON.stringify({ grep: true, replaceText: false }));
	const { config, warning } = loadConfig(dir);
	assert.deepEqual(config, { grep: true, replaceText: false });
	assert.equal(warning, undefined);
});

test("loadConfig falls back to defaults with a warning on invalid JSON", () => {
	const invalidDir = mkdtempSync(join(tmpdir(), "hashline-config-invalid-"));
	writeFileSync(join(invalidDir, "hashline.json"), "{ not valid json");
	const { config, warning } = loadConfig(invalidDir);
	assert.deepEqual(config, { grep: false, replaceText: true });
	assert.match(warning ?? "", /invalid/i);
	rmSync(invalidDir, { recursive: true, force: true });
});

test("loadConfig falls back to defaults with a warning on wrong-typed fields", () => {
	const wrongTypeDir = mkdtempSync(join(tmpdir(), "hashline-config-wrongtype-"));
	writeFileSync(join(wrongTypeDir, "hashline.json"), JSON.stringify({ grep: "yes" }));
	const { config, warning } = loadConfig(wrongTypeDir);
	assert.deepEqual(config, { grep: false, replaceText: true });
	assert.match(warning ?? "", /invalid/i);
	rmSync(wrongTypeDir, { recursive: true, force: true });
});

test("loadConfig ignores unrecognized extra keys without a warning", () => {
	const extraDir = mkdtempSync(join(tmpdir(), "hashline-config-extra-"));
	writeFileSync(
		join(extraDir, "hashline.json"),
		JSON.stringify({ grep: true, somethingElse: 123 }),
	);
	const { config, warning } = loadConfig(extraDir);
	assert.deepEqual(config, { grep: true, replaceText: true });
	assert.equal(warning, undefined);
	rmSync(extraDir, { recursive: true, force: true });
});
