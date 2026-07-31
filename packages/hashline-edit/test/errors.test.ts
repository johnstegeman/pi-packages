import assert from "node:assert/strict";
import test from "node:test";
import {
	badRefError,
	HashlineError,
	invalidArgumentError,
	invalidPatchError,
	multipleMatchesError,
	noMatchError,
	notFoundError,
	staleAnchorError,
} from "../src/errors.js";

test("staleAnchorError carries E_STALE_ANCHOR code and a re-read hint", () => {
	const err = staleAnchorError("9#Xy_", "hash mismatch");
	assert.ok(err instanceof HashlineError);
	assert.equal(err.code, "E_STALE_ANCHOR");
	assert.match(err.message, /^\[E_STALE_ANCHOR\]/);
	assert.match(err.message, /9#Xy_/);
	assert.match(err.message, /re-read|read again|call read/i);
});

test("badRefError carries E_BAD_REF code", () => {
	const err = badRefError("bogus", "does not parse as LINE#HASH");
	assert.equal(err.code, "E_BAD_REF");
	assert.match(err.message, /^\[E_BAD_REF\]/);
	assert.match(err.message, /bogus/);
});

test("invalidPatchError carries E_INVALID_PATCH code", () => {
	const err = invalidPatchError("looks like pasted anchor output");
	assert.equal(err.code, "E_INVALID_PATCH");
	assert.match(err.message, /^\[E_INVALID_PATCH\]/);
});

test("notFoundError carries E_NOT_FOUND code", () => {
	const err = notFoundError("/tmp/missing.txt", "no such file");
	assert.equal(err.code, "E_NOT_FOUND");
	assert.match(err.message, /^\[E_NOT_FOUND\]/);
	assert.match(err.message, /\/tmp\/missing\.txt/);
});

test("noMatchError carries E_NO_MATCH code", () => {
	const err = noMatchError("needle");
	assert.equal(err.code, "E_NO_MATCH");
	assert.match(err.message, /^\[E_NO_MATCH\]/);
});

test("multipleMatchesError carries E_MULTIPLE_MATCHES code and count", () => {
	const err = multipleMatchesError("needle", 3);
	assert.equal(err.code, "E_MULTIPLE_MATCHES");
	assert.match(err.message, /^\[E_MULTIPLE_MATCHES\]/);
	assert.match(err.message, /3/);
});

test("invalidArgumentError carries E_INVALID_ARGUMENT code", () => {
	const err = invalidArgumentError("edits was passed as a JSON string");
	assert.ok(err instanceof HashlineError);
	assert.equal(err.code, "E_INVALID_ARGUMENT");
	assert.match(err.message, /^\[E_INVALID_ARGUMENT\]/);
	assert.match(err.message, /JSON string/);
});
