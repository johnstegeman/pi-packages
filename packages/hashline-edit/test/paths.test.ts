import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectImageMimeType, resolvePathArg } from "../src/paths.js";

test("resolvePathArg resolves relative paths against cwd", () => {
	assert.equal(resolvePathArg("foo/bar.ts", "/repo"), path.resolve("/repo/foo/bar.ts"));
});

test("resolvePathArg passes through absolute paths", () => {
	assert.equal(resolvePathArg("/abs/path.ts", "/repo"), path.resolve("/abs/path.ts"));
});

test("resolvePathArg expands a leading ~", () => {
	const result = resolvePathArg("~/notes.txt", "/repo");
	assert.equal(result, path.join(os.homedir(), "notes.txt"));
});

test("detectImageMimeType recognizes PNG magic bytes", () => {
	const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
	assert.equal(detectImageMimeType(buf), "image/png");
});

test("detectImageMimeType recognizes JPEG magic bytes", () => {
	const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
	assert.equal(detectImageMimeType(buf), "image/jpeg");
});

test("detectImageMimeType recognizes GIF87a and GIF89a magic bytes", () => {
	assert.equal(detectImageMimeType(Buffer.from("GIF87a" + "\0\0\0\0")), "image/gif");
	assert.equal(detectImageMimeType(Buffer.from("GIF89a" + "\0\0\0\0")), "image/gif");
});

test("detectImageMimeType recognizes WEBP magic bytes", () => {
	const buf = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
	assert.equal(detectImageMimeType(buf), "image/webp");
});

test("detectImageMimeType returns null for non-image content", () => {
	assert.equal(detectImageMimeType(Buffer.from("plain text content")), null);
});

test("detectImageMimeType returns null for a too-short buffer", () => {
	assert.equal(detectImageMimeType(Buffer.from([0x89, 0x50])), null);
});
