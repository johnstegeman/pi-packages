# Hashline Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `packages/hashline-edit/` — a pi extension overriding `read`/`edit` with hash-anchored line references (`LINE#HASH:content`), plus an opt-in ripgrep-backed `grep` tool.

**Architecture:** A modular `src/` package: `hashline.ts` (pure hashing/anchor parsing, no I/O), `errors.ts` (typed error codes), `config.ts` (loads `~/.pi/agent/hashline.json`), and three tool modules (`read.ts`, `edit.ts`, `grep.ts`) that each build a `ToolDefinition` object, wired up in `index.ts`. No caching or persistence anywhere — every call re-reads the file from disk and recomputes hashes fresh.

**Tech Stack:** TypeScript (ES2022, NodeNext modules), `@earendil-works/pi-coding-agent` (peer dep, pinned `0.80.3` in devDependencies), `node --test` + `tsx` for tests, `tsc --noEmit` for typecheck, Biome for lint/format — mirrors `packages/statusline` exactly.

**Spec:** `docs/superpowers/specs/2026-07-28-hashline-edit-design.md`

## Global Constraints

- Hash length is fixed at 3 characters. No config knob for this.
- Hash alphabet is URL-safe base64: `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_` (64 chars, indices 0-63).
- Hash function is FNV-1a 32-bit (offset basis `0x811c9dc5`, prime `0x01000193`), applied to the UTF-8 bytes of the hash input string, then the low 18 bits (`hash & 0x3ffff`) are encoded as 3 base64-alphabet characters, most-significant 6 bits first.
- Hash input per line `i` (0-indexed) is `` `${prev}\n${curr}\n${next}` `` where `curr` is the canonicalized line at index `i`, `prev` is the canonicalized line at `i-1` (or `""` if `i === 0`), `next` is the canonicalized line at `i+1` (or `""` if `i` is the last line). Canonicalization: strip `\r`, then strip trailing whitespace (`line.replace(/\s+$/, "")`).
- Collision resolution: hashes are assigned in line order (index 0 first). If retry 0's hash already appears in the `used` set for this file, retry with input `` `${prev}\n${curr}\n${next}\u0000${retry}` `` for `retry = 1, 2, 3, ...` until unique.
- Anchor wire format: `LINE#HASH` (e.g. `"9#Xy_"`). In `read`/`grep` output, each row is `LINE#HASH:content` with `LINE` left-padded with spaces to the width of the largest line number in the current output slice.
- Empty file (content `""`, which splits to `[""]`) is treated as one line, same as any single-empty-line file — no special case needed beyond what `computeLineHashes("")` naturally produces (see Task 1).
- No persistent state, no caching, no stale-anchor recovery. Every `read`/`edit`/`grep` call reads the file fresh and recomputes hashes fresh.
- Config file: `~/.pi/agent/hashline.json` (resolved via `getAgentDir()` from `@earendil-works/pi-coding-agent`), shape `{ "grep"?: boolean, "replaceText"?: boolean }`, defaults `{ grep: false, replaceText: true }`.
- Package name: `pi-hashline-edit`, directory `packages/hashline-edit/`.
- All imports of `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are peer dependencies (`"*"` range), never bundled.
- `@earendil-works/pi-coding-agent`'s package `exports` map only exposes its top-level entry point — internal modules (`utils/mime.ts`, `core/tools/path-utils.ts`) are not importable. Path resolution and image-format sniffing must be self-implemented in this package (Tasks 3 and 6 respectively).
- ESM relative imports use explicit `.js` extensions in source `.ts` files (NodeNext module resolution requires this), matching `packages/statusline`'s style.
- Indent with tabs, double quotes, semicolons always — match `packages/statusline/biome.json` exactly.
- Commit after each task.

---

## Task 1: Scaffold package + hashing core

**Files:**
- Create: `packages/hashline-edit/package.json`
- Create: `packages/hashline-edit/tsconfig.json`
- Create: `packages/hashline-edit/biome.json`
- Create: `packages/hashline-edit/.gitignore`
- Create: `packages/hashline-edit/LICENSE`
- Create: `packages/hashline-edit/src/hashline.ts`
- Test: `packages/hashline-edit/test/hashline.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3-5):
  ```ts
  export function computeLineHashes(content: string): string[];
  export function formatAnchor(line: number, hash: string): string; // "9#Xy_"
  export function parseAnchor(anchor: string): { line: number; hash: string } | null;
  ```
  `computeLineHashes` splits `content` on `"\n"` (so a file `"a\nb"` has 2 lines, and `"a\nb\n"` has 3 lines — the trailing empty string after the final `\n` counts as its own line, matching `String.split("\n")` semantics exactly with no special-casing). Returns one hash string per resulting element, in order, using the algorithm in Global Constraints.

- [ ] **Step 1: Create package scaffold files**

`packages/hashline-edit/package.json`:
```json
{
	"name": "pi-hashline-edit",
	"version": "0.1.0",
	"description": "Hash-anchored read/edit tool override for the Pi coding agent.",
	"type": "module",
	"license": "MIT",
	"private": false,
	"keywords": ["pi-package", "pi-extension", "hashline", "edit", "read"],
	"files": ["src", "README.md", "LICENSE"],
	"pi": {
		"extensions": ["./src/index.ts"]
	},
	"scripts": {
		"check": "biome check . && npm run typecheck && npm test",
		"format": "biome check --write .",
		"test": "node --import tsx --test test/*.test.ts",
		"typecheck": "tsc --noEmit"
	},
	"peerDependencies": {
		"@earendil-works/pi-coding-agent": "*"
	},
	"devDependencies": {
		"@biomejs/biome": "2.5.3",
		"@earendil-works/pi-coding-agent": "0.80.3",
		"@types/node": "26.1.1",
		"tsx": "4.20.6",
		"typescript": "6.0.3"
	},
	"repository": {
		"type": "git",
		"url": "git+https://github.com/johnstegeman/pi-packages.git"
	},
	"publishConfig": {
		"access": "public"
	}
}
```

`packages/hashline-edit/tsconfig.json`:
```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"strict": true,
		"noEmit": true,
		"skipLibCheck": true
	},
	"include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`packages/hashline-edit/biome.json`:
```json
{
	"$schema": "https://biomejs.dev/schemas/2.5.3/schema.json",
	"vcs": {
		"enabled": true,
		"clientKind": "git",
		"useIgnoreFile": true
	},
	"files": {
		"includes": ["**", "!package-lock.json"]
	},
	"formatter": {
		"enabled": true,
		"indentStyle": "tab",
		"lineWidth": 100
	},
	"linter": {
		"enabled": true,
		"rules": {
			"preset": "recommended"
		}
	},
	"javascript": {
		"formatter": {
			"quoteStyle": "double",
			"semicolons": "always"
		}
	}
}
```

`packages/hashline-edit/.gitignore`:
```
node_modules/
coverage/
*.log
*.tgz
.DS_Store
package-lock.json
```

`packages/hashline-edit/LICENSE` — copy the exact MIT license text from `packages/statusline/LICENSE`, changing only the copyright line to `Copyright (c) 2026 johnstegeman`.

- [ ] **Step 2: Write the failing test for `computeLineHashes`**

Create `packages/hashline-edit/test/hashline.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/hashline-edit && npm install && node --import tsx --test test/hashline.test.ts`
Expected: FAIL — `src/hashline.ts` does not exist yet (module not found).

- [ ] **Step 4: Implement `src/hashline.ts`**

```ts
const HASH_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HASH_LENGTH = 3;
const HASH_MASK = 0x3ffff; // 18 bits = 3 chars * 6 bits

function fnv1a32(bytes: Uint8Array): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		hash ^= bytes[i];
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function encodeHash(value: number): string {
	let v = value & HASH_MASK;
	let out = "";
	for (let i = 0; i < HASH_LENGTH; i++) {
		out = HASH_ALPHABET[v & 0x3f] + out;
		v >>>= 6;
	}
	return out;
}

function canonicalizeLine(line: string): string {
	return line.replace(/\r/g, "").replace(/\s+$/, "");
}

function hashForLine(prev: string, curr: string, next: string, retry: number): string {
	const base = `${prev}\n${curr}\n${next}`;
	const input = retry === 0 ? base : `${base}\u0000${retry}`;
	const bytes = new TextEncoder().encode(input);
	return encodeHash(fnv1a32(bytes));
}

/** Compute one 3-character content hash per line, fresh, with no caching. */
export function computeLineHashes(content: string): string[] {
	const rawLines = content.split("\n");
	const lines = rawLines.map(canonicalizeLine);
	const used = new Set<string>();
	const hashes: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const prev = i > 0 ? lines[i - 1] : "";
		const curr = lines[i];
		const next = i < lines.length - 1 ? lines[i + 1] : "";
		let retry = 0;
		let hash = hashForLine(prev, curr, next, retry);
		while (used.has(hash)) {
			retry++;
			hash = hashForLine(prev, curr, next, retry);
		}
		used.add(hash);
		hashes.push(hash);
	}
	return hashes;
}

/** Format a line number and hash as the wire-format anchor string, e.g. "9#Xy_". */
export function formatAnchor(line: number, hash: string): string {
	return `${line}#${hash}`;
}

const ANCHOR_PATTERN = /^([1-9][0-9]*)#([A-Za-z0-9_-]{3})$/;

/** Parse a "LINE#HASH" anchor string. Returns null if malformed. */
export function parseAnchor(anchor: string): { line: number; hash: string } | null {
	const match = ANCHOR_PATTERN.exec(anchor);
	if (!match) return null;
	return { line: Number(match[1]), hash: match[2] };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/hashline-edit && node --import tsx --test test/hashline.test.ts`
Expected: PASS, all 9 tests green.

- [ ] **Step 6: Typecheck and lint**

Run: `cd packages/hashline-edit && npm run typecheck && npx biome check .`
Expected: both pass with no errors. Fix any formatting biome flags (run `npx biome check --write .` if needed) before committing.

- [ ] **Step 7: Commit**

`packages/hashline-edit/.gitignore` already excludes `package-lock.json` (matching `packages/statusline`, which has no committed lockfile), so `npm install` in Step 3 will not get committed:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/hashline-edit
git add packages/hashline-edit/package.json packages/hashline-edit/tsconfig.json \
  packages/hashline-edit/biome.json packages/hashline-edit/.gitignore \
  packages/hashline-edit/LICENSE packages/hashline-edit/src/hashline.ts \
  packages/hashline-edit/test/hashline.test.ts
git commit -m "feat(hashline-edit): scaffold package and add hashing core"
```

---

## Task 2: Error taxonomy

**Files:**
- Create: `packages/hashline-edit/src/errors.ts`
- Test: `packages/hashline-edit/test/errors.test.ts`

**Interfaces:**
- Consumes: nothing (no dependencies on other modules).
- Produces (consumed by Tasks 3-5):
  ```ts
  export type HashlineErrorCode =
    | "E_STALE_ANCHOR"
    | "E_BAD_REF"
    | "E_INVALID_PATCH"
    | "E_NOT_FOUND"
    | "E_NO_MATCH"
    | "E_MULTIPLE_MATCHES";
  export class HashlineError extends Error {
    readonly code: HashlineErrorCode;
    constructor(code: HashlineErrorCode, message: string);
  }
  export function staleAnchorError(anchor: string, reason: string): HashlineError;
  export function badRefError(anchor: string, reason: string): HashlineError;
  export function invalidPatchError(detail: string): HashlineError;
  export function notFoundError(path: string, reason: string): HashlineError;
  export function noMatchError(oldText: string): HashlineError;
  export function multipleMatchesError(oldText: string, count: number): HashlineError;
  ```
  Every error's `.message` starts with `"[${code}] "` so tool-result text is greppable, e.g. `"[E_STALE_ANCHOR] Anchor 9#Xy_ ..."`.

- [ ] **Step 1: Write the failing test**

Create `packages/hashline-edit/test/errors.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
	badRefError,
	HashlineError,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hashline-edit && node --import tsx --test test/errors.test.ts`
Expected: FAIL — `src/errors.ts` does not exist.

- [ ] **Step 3: Implement `src/errors.ts`**

```ts
export type HashlineErrorCode =
	| "E_STALE_ANCHOR"
	| "E_BAD_REF"
	| "E_INVALID_PATCH"
	| "E_NOT_FOUND"
	| "E_NO_MATCH"
	| "E_MULTIPLE_MATCHES";

export class HashlineError extends Error {
	readonly code: HashlineErrorCode;
	constructor(code: HashlineErrorCode, message: string) {
		super(`[${code}] ${message}`);
		this.code = code;
		this.name = "HashlineError";
	}
}

export function staleAnchorError(anchor: string, reason: string): HashlineError {
	return new HashlineError(
		"E_STALE_ANCHOR",
		`Anchor ${anchor} is stale (${reason}). Call read again to get fresh anchors, then retry.`,
	);
}

export function badRefError(anchor: string, reason: string): HashlineError {
	return new HashlineError("E_BAD_REF", `Anchor "${anchor}" is invalid: ${reason}.`);
}

export function invalidPatchError(detail: string): HashlineError {
	return new HashlineError("E_INVALID_PATCH", `Replacement text is invalid: ${detail}.`);
}

export function notFoundError(path: string, reason: string): HashlineError {
	return new HashlineError("E_NOT_FOUND", `Could not access "${path}": ${reason}.`);
}

export function noMatchError(oldText: string): HashlineError {
	return new HashlineError(
		"E_NO_MATCH",
		`oldText ${JSON.stringify(oldText)} was not found in the file.`,
	);
}

export function multipleMatchesError(oldText: string, count: number): HashlineError {
	return new HashlineError(
		"E_MULTIPLE_MATCHES",
		`oldText ${JSON.stringify(oldText)} matched ${count} times; it must match exactly once.`,
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hashline-edit && node --import tsx --test test/errors.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/hashline-edit && npm run typecheck && npx biome check .`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/hashline-edit
git add packages/hashline-edit/src/errors.ts packages/hashline-edit/test/errors.test.ts
git commit -m "feat(hashline-edit): add typed error taxonomy"
```

---

## Task 3: Path resolution + image detection helper

**Files:**
- Create: `packages/hashline-edit/src/paths.ts`
- Test: `packages/hashline-edit/test/paths.test.ts`

**Interfaces:**
- Consumes: nothing new (Node built-ins only).
- Produces (consumed by Tasks 5, 6, 8):
  ```ts
  export function resolvePathArg(rawPath: string, cwd: string): string;
  export type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  export function detectImageMimeType(buffer: Buffer): SupportedImageMimeType | null;
  ```
  `resolvePathArg` handles `~` expansion (home-dir prefix) and resolves relative paths against `cwd`; absolute paths pass through `path.resolve` unchanged. `detectImageMimeType` sniffs magic bytes only (no file extension check) — callers decide whether to also consult the extension.

- [ ] **Step 1: Write the failing test**

Create `packages/hashline-edit/test/paths.test.ts`:

```ts
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
	const buf = Buffer.concat([
		Buffer.from("RIFF"),
		Buffer.from([0, 0, 0, 0]),
		Buffer.from("WEBP"),
	]);
	assert.equal(detectImageMimeType(buf), "image/webp");
});

test("detectImageMimeType returns null for non-image content", () => {
	assert.equal(detectImageMimeType(Buffer.from("plain text content")), null);
});

test("detectImageMimeType returns null for a too-short buffer", () => {
	assert.equal(detectImageMimeType(Buffer.from([0x89, 0x50])), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hashline-edit && node --import tsx --test test/paths.test.ts`
Expected: FAIL — `src/paths.ts` does not exist.

- [ ] **Step 3: Implement `src/paths.ts`**

```ts
import os from "node:os";
import path from "node:path";

/** Resolve a CLI/tool path argument against cwd, expanding a leading ~. */
export function resolvePathArg(rawPath: string, cwd: string): string {
	if (rawPath === "~" || rawPath.startsWith("~/")) {
		const rest = rawPath.slice(1).replace(/^\/+/, "");
		return path.resolve(os.homedir(), rest);
	}
	if (path.isAbsolute(rawPath)) {
		return path.resolve(rawPath);
	}
	return path.resolve(cwd, rawPath);
}

export type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Sniff magic bytes for jpg/png/gif/webp. Returns null for anything else or too-short input. */
export function detectImageMimeType(buffer: Buffer): SupportedImageMimeType | null {
	if (buffer.length < 12) return null;
	if (
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47 &&
		buffer[4] === 0x0d &&
		buffer[5] === 0x0a &&
		buffer[6] === 0x1a &&
		buffer[7] === 0x0a
	) {
		return "image/png";
	}
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return "image/jpeg";
	}
	const header6 = buffer.subarray(0, 6).toString("ascii");
	if (header6 === "GIF87a" || header6 === "GIF89a") {
		return "image/gif";
	}
	if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
		return "image/webp";
	}
	return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hashline-edit && node --import tsx --test test/paths.test.ts`
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/hashline-edit && npm run typecheck && npx biome check .`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/hashline-edit
git add packages/hashline-edit/src/paths.ts packages/hashline-edit/test/paths.test.ts
git commit -m "feat(hashline-edit): add path resolution and image sniffing helpers"
```

---

## Task 4: Config loading

**Files:**
- Create: `packages/hashline-edit/src/config.ts`
- Test: `packages/hashline-edit/test/config.test.ts`

**Interfaces:**
- Consumes: `getAgentDir` from `@earendil-works/pi-coding-agent`.
- Produces (consumed by Tasks 5-8):
  ```ts
  export interface HashlineConfig {
    grep: boolean;
    replaceText: boolean;
  }
  export function loadConfig(agentDir?: string): { config: HashlineConfig; warning?: string };
  ```
  `agentDir` is an optional override (used by tests to avoid touching the real `~/.pi/agent/`); when omitted, `loadConfig` calls `getAgentDir()` itself. Reads `<agentDir>/hashline.json`. Missing file → defaults, no warning. Invalid JSON or wrong-typed fields → defaults plus a one-line `warning` string; unrecognized extra keys are ignored without a warning.

- [ ] **Step 1: Write the failing test**

Create `packages/hashline-edit/test/config.test.ts`:

```ts
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
	writeFileSync(join(extraDir, "hashline.json"), JSON.stringify({ grep: true, somethingElse: 123 }));
	const { config, warning } = loadConfig(extraDir);
	assert.deepEqual(config, { grep: true, replaceText: true });
	assert.equal(warning, undefined);
	rmSync(extraDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hashline-edit && node --import tsx --test test/config.test.ts`
Expected: FAIL — `src/config.ts` does not exist.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE_NAME = "hashline.json";

export interface HashlineConfig {
	grep: boolean;
	replaceText: boolean;
}

const DEFAULT_CONFIG: HashlineConfig = { grep: false, replaceText: true };

export function loadConfig(agentDir?: string): { config: HashlineConfig; warning?: string } {
	const dir = agentDir ?? getAgentDir();
	const filePath = join(dir, CONFIG_FILE_NAME);
	if (!existsSync(filePath)) {
		return { config: { ...DEFAULT_CONFIG } };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return {
			config: { ...DEFAULT_CONFIG },
			warning: `${CONFIG_FILE_NAME} is invalid JSON and was ignored; using defaults.`,
		};
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			config: { ...DEFAULT_CONFIG },
			warning: `${CONFIG_FILE_NAME} is invalid (expected an object) and was ignored; using defaults.`,
		};
	}
	const obj = raw as Record<string, unknown>;
	const grepValid = obj.grep === undefined || typeof obj.grep === "boolean";
	const replaceTextValid = obj.replaceText === undefined || typeof obj.replaceText === "boolean";
	if (!grepValid || !replaceTextValid) {
		return {
			config: { ...DEFAULT_CONFIG },
			warning: `${CONFIG_FILE_NAME} has invalid field types and was ignored; using defaults.`,
		};
	}
	return {
		config: {
			grep: typeof obj.grep === "boolean" ? obj.grep : DEFAULT_CONFIG.grep,
			replaceText: typeof obj.replaceText === "boolean" ? obj.replaceText : DEFAULT_CONFIG.replaceText,
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hashline-edit && node --import tsx --test test/config.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/hashline-edit && npm run typecheck && npx biome check .`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/hashline-edit
git add packages/hashline-edit/src/config.ts packages/hashline-edit/test/config.test.ts
git commit -m "feat(hashline-edit): add config loading for ~/.pi/agent/hashline.json"
```

---

## Task 5: `read` tool

**Files:**
- Create: `packages/hashline-edit/src/read.ts`
- Test: `packages/hashline-edit/test/read.test.ts`

**Interfaces:**
- Consumes: `computeLineHashes`, `formatAnchor` from `./hashline.js`; `resolvePathArg`, `detectImageMimeType` from `./paths.js`; `notFoundError` from `./errors.js`; `ToolDefinition`, `AgentToolResult` types from `@earendil-works/pi-coding-agent`.
- Produces (consumed by Task 8):
  ```ts
  export function createHashlineReadTool(): ToolDefinition;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/hashline-edit/test/read.test.ts`:

```ts
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
	assert.match(text, /^2#TmR:  console\.log\("world"\);$/m);
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
			tool.execute(
				"call-1",
				{ path: join(dir, "does-not-exist.txt") },
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hashline-edit && node --import tsx --test test/read.test.ts`
Expected: FAIL — `src/read.ts` does not exist.

- [ ] **Step 3: Implement `src/read.ts`**

```ts
import { readFile, stat } from "node:fs/promises";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { notFoundError } from "./errors.js";
import { computeLineHashes } from "./hashline.js";
import { detectImageMimeType, resolvePathArg } from "./paths.js";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

function formatHashlineRows(lines: string[], hashes: string[], startLine: number): string {
	const endLine = startLine + lines.length - 1;
	const width = String(endLine).length;
	return lines
		.map((line, i) => {
			const lineNumber = String(startLine + i).padStart(width, " ");
			return `${lineNumber}#${hashes[i]}:${line}`;
		})
		.join("\n");
}

export function createHashlineReadTool(): ToolDefinition<typeof readSchema, undefined> {
	return {
		name: "read",
		label: "read (hashline)",
		description:
			"Read a file's contents with hash-anchored line numbers (LINE#HASH:content). Use the anchors with edit to make precise, verified changes. Supports text files and images (jpg, png, gif, webp).",
		parameters: readSchema,
		async execute(_toolCallId, { path, offset, limit }, _signal, _onUpdate, ctx) {
			const absolutePath = resolvePathArg(path, ctx.cwd);
			let stats: Awaited<ReturnType<typeof stat>>;
			try {
				stats = await stat(absolutePath);
			} catch {
				throw notFoundError(path, "file does not exist");
			}
			if (stats.isDirectory()) {
				throw notFoundError(path, "path is a directory, not a file");
			}
			const buffer = await readFile(absolutePath);
			const mimeType = detectImageMimeType(buffer);
			if (mimeType) {
				const content: AgentToolResult<undefined>["content"] = [
					{ type: "text", text: `Read image file [${mimeType}]` },
					{ type: "image", data: buffer.toString("base64"), mimeType },
				];
				return { content, details: undefined };
			}
			const text = buffer.toString("utf-8");
			const allLines = text.split("\n");
			const allHashes = computeLineHashes(text);
			const startIndex = offset ? Math.max(0, offset - 1) : 0;
			if (startIndex >= allLines.length) {
				throw notFoundError(path, `offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}
			const endIndex = limit !== undefined ? Math.min(startIndex + limit, allLines.length) : allLines.length;
			const shownLines = allLines.slice(startIndex, endIndex);
			const shownHashes = allHashes.slice(startIndex, endIndex);
			const outputText = formatHashlineRows(shownLines, shownHashes, startIndex + 1);
			return {
				content: [{ type: "text", text: outputText }],
				details: undefined,
			};
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hashline-edit && node --import tsx --test test/read.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/hashline-edit && npm run typecheck && npx biome check .`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/hashline-edit
git add packages/hashline-edit/src/read.ts packages/hashline-edit/test/read.test.ts
git commit -m "feat(hashline-edit): add hash-anchored read tool"
```

---

## Task 6: `edit` tool

**Files:**
- Create: `packages/hashline-edit/src/edit.ts`
- Test: `packages/hashline-edit/test/edit.test.ts`

**Interfaces:**
- Consumes: `computeLineHashes`, `formatAnchor`, `parseAnchor` from `./hashline.js`; `staleAnchorError`, `badRefError`, `invalidPatchError`, `notFoundError`, `noMatchError`, `multipleMatchesError` from `./errors.js`; `resolvePathArg` from `./paths.js`; `HashlineConfig` from `./config.js`; `withFileMutationQueue` from `@earendil-works/pi-coding-agent`.
- Produces (consumed by Task 8):
  ```ts
  export function createHashlineEditTool(getConfig: () => HashlineConfig): ToolDefinition;
  ```
  `getConfig` is a thunk (not a plain value) so the tool always sees the config loaded once at extension startup, passed in by `index.ts` (Task 8).

  **Constraint:** a single `edit` call's `edits` array may contain any number of `replace`/`append`/`prepend` entries combined together, but a `replace_text` entry must be the only entry in the array (rejected with `E_BAD_REF` otherwise). This is because `replace_text` is resolved against the whole original file, while `replace`/`append`/`prepend` are resolved as line-index ranges applied bottom-up in the same call — mixing the two apply strategies in one batch would corrupt line indices.

- [ ] **Step 1: Write the failing test**

Create `packages/hashline-edit/test/edit.test.ts`:

```ts
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
		{ path: filePath, edits: [{ replace: { pos: anchor, lines: ['  console.log("hashline");'] } }] },
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
		{ path: filePath, edits: [{ replace_text: { oldText: "const x = 1;", newText: "const x = 100;" } }] },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hashline-edit && node --import tsx --test test/edit.test.ts`
Expected: FAIL — `src/edit.ts` does not exist.

- [ ] **Step 3: Implement `src/edit.ts`**

```ts
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { type ToolDefinition, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HashlineConfig } from "./config.js";
import {
	badRefError,
	invalidPatchError,
	multipleMatchesError,
	noMatchError,
	notFoundError,
	staleAnchorError,
} from "./errors.js";
import { computeLineHashes, formatAnchor, parseAnchor } from "./hashline.js";
import { resolvePathArg } from "./paths.js";

const replaceOpSchema = Type.Object({
	pos: Type.String({ description: "Start anchor LINE#HASH." }),
	end: Type.Optional(Type.String({ description: "End anchor LINE#HASH (inclusive). Omit for a single line." })),
	lines: Type.Array(Type.String(), { description: "Replacement lines. Empty array deletes the range." }),
});
const appendOpSchema = Type.Object({
	pos: Type.Optional(Type.String({ description: "Anchor LINE#HASH to insert after. Omit to append at EOF." })),
	lines: Type.Array(Type.String()),
});
const prependOpSchema = Type.Object({
	pos: Type.Optional(Type.String({ description: "Anchor LINE#HASH to insert before. Omit to prepend at BOF." })),
	lines: Type.Array(Type.String()),
});
const replaceTextOpSchema = Type.Object({
	oldText: Type.String({ description: "Exact substring to replace. Must match exactly once." }),
	newText: Type.String(),
});

const editEntrySchema = Type.Object({
	replace: Type.Optional(replaceOpSchema),
	append: Type.Optional(appendOpSchema),
	prepend: Type.Optional(prependOpSchema),
	replace_text: Type.Optional(replaceTextOpSchema),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(editEntrySchema, { description: "One or more hash-anchored edits, applied atomically." }),
});

type EditEntry = {
	replace?: { pos: string; end?: string; lines: string[] };
	append?: { pos?: string; lines: string[] };
	prepend?: { pos?: string; lines: string[] };
	replace_text?: { oldText: string; newText: string };
};

const HASHLINE_ANCHOR_PATTERN = /(?:^|\n)\s*\d+#[A-Za-z0-9_-]{3}:/;

function looksLikePastedAnchorOutput(text: string): boolean {
	return HASHLINE_ANCHOR_PATTERN.test(text);
}

function resolveAnchorToIndex(anchor: string, lines: string[], hashes: string[]): number {
	const parsed = parseAnchor(anchor);
	if (!parsed) throw badRefError(anchor, "does not parse as LINE#HASH");
	const index = parsed.line - 1;
	if (index < 0 || index >= lines.length) {
		throw staleAnchorError(anchor, `line ${parsed.line} is out of range (file has ${lines.length} lines)`);
	}
	if (hashes[index] !== parsed.hash) {
		throw staleAnchorError(anchor, "content hash does not match the current file");
	}
	return index;
}

interface ResolvedOp {
	kind: "replace";
	startIndex: number;
	endIndex: number;
	lines: string[];
}

function resolveEntry(entry: EditEntry, lines: string[], hashes: string[], config: HashlineConfig): ResolvedOp {
	if (entry.replace) {
		const startIndex = resolveAnchorToIndex(entry.replace.pos, lines, hashes);
		const endIndex = entry.replace.end ? resolveAnchorToIndex(entry.replace.end, lines, hashes) : startIndex;
		if (endIndex < startIndex) {
			throw badRefError(entry.replace.end ?? entry.replace.pos, "end anchor resolves before pos anchor");
		}
		return { kind: "replace", startIndex, endIndex, lines: entry.replace.lines };
	}
	if (entry.append) {
		const startIndex = entry.append.pos !== undefined ? resolveAnchorToIndex(entry.append.pos, lines, hashes) : lines.length - 1;
		return { kind: "replace", startIndex: startIndex + 1, endIndex: startIndex, lines: entry.append.lines };
	}
	if (entry.prepend) {
		const startIndex = entry.prepend.pos !== undefined ? resolveAnchorToIndex(entry.prepend.pos, lines, hashes) : 0;
		return { kind: "replace", startIndex, endIndex: startIndex - 1, lines: entry.prepend.lines };
	}
	if (entry.replace_text) {
		if (!config.replaceText) {
			throw invalidPatchError("replace_text is disabled by config (replaceText: false)");
		}
		const { oldText, newText } = entry.replace_text;
		if (looksLikePastedAnchorOutput(newText) || looksLikePastedAnchorOutput(oldText)) {
			throw invalidPatchError("input looks like pasted LINE#HASH: tool output; send literal file content instead");
		}
		const fullText = lines.join("\n");
		const firstIndex = fullText.indexOf(oldText);
		if (firstIndex === -1) throw noMatchError(oldText);
		const secondIndex = fullText.indexOf(oldText, firstIndex + oldText.length);
		if (secondIndex !== -1) {
			let count = 0;
			let cursor = 0;
			while (true) {
				const found = fullText.indexOf(oldText, cursor);
				if (found === -1) break;
				count++;
				cursor = found + oldText.length;
			}
			throw multipleMatchesError(oldText, count);
		}
		const before = fullText.slice(0, firstIndex);
		const after = fullText.slice(firstIndex + oldText.length);
		const newFullText = before + newText + after;
		const newLines = newFullText.split("\n");
		// Represent as a whole-file replace so the generic apply step below handles it uniformly.
		return { kind: "replace", startIndex: 0, endIndex: lines.length - 1, lines: newLines };
	}
	throw badRefError("(missing)", "edit entry must specify exactly one of replace, append, prepend, replace_text");
}

async function writeAtomic(absolutePath: string, content: string): Promise<void> {
	const realPath = await realpath(absolutePath).catch(() => absolutePath);
	const stats = await stat(realPath).catch(() => undefined);
	if (stats && stats.nlink > 1) {
		// Hard-linked: update in place to preserve the shared inode.
		await writeFile(realPath, content, "utf-8");
		return;
	}
	const dir = dirname(realPath);
	const tempPath = join(dir, `.hashline-edit-${randomUUID()}.tmp`);
	await writeFile(tempPath, content, "utf-8");
	try {
		await rename(tempPath, realPath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

export function createHashlineEditTool(getConfig: () => HashlineConfig): ToolDefinition<typeof editSchema, undefined> {
	return {
		name: "edit",
		label: "edit (hashline)",
		description:
			"Edit a file using hash-anchored line references (from a prior read/grep). Ops: replace, append, prepend, replace_text. All anchors are validated against the current file content before any write occurs. replace_text must be the only entry in edits[] when used; it cannot be combined with other ops in the same call.",
		parameters: editSchema,
		async execute(_toolCallId, { path, edits }, _signal, _onUpdate, ctx) {
			const absolutePath = resolvePathArg(path, ctx.cwd);
			return withFileMutationQueue(absolutePath, async () => {
				let buffer: Buffer;
				try {
					buffer = await readFile(absolutePath);
				} catch {
					throw notFoundError(path, "file does not exist or is not readable");
				}
				const originalText = buffer.toString("utf-8");
				const lines = originalText.split("\n");
				const hashes = computeLineHashes(originalText);
				const config = getConfig();

				// replace_text is modeled as a whole-file replace computed from the original content;
				// combining it with other ops in the same batch (or more than one replace_text) would
				// apply against stale line indices once the bottom-up loop starts mutating newLines.
				const entries = edits as EditEntry[];
				const replaceTextCount = entries.filter((entry) => entry.replace_text).length;
				if (replaceTextCount > 0 && entries.length > 1) {
					throw badRefError("(batch)", "replace_text cannot be combined with other edits in the same call; send it alone");
				}

				// Resolve and validate every entry against the same pre-edit snapshot before any write.
				const resolvedOps = entries.map((entry) => resolveEntry(entry, lines, hashes, config));

				// Apply bottom-up (highest startIndex first) so earlier edits are unaffected by later ones.
				const sortedOps = [...resolvedOps].sort((a, b) => b.startIndex - a.startIndex);
				let newLines = [...lines];
				for (const op of sortedOps) {
					const deleteCount = Math.max(0, op.endIndex - op.startIndex + 1);
					newLines.splice(op.startIndex, deleteCount, ...op.lines);
				}
				const newText = newLines.join("\n");

				await writeAtomic(absolutePath, newText);

				const addedLines = newLines.length - lines.length;
				const changeStart = Math.min(...resolvedOps.map((op) => op.startIndex));
				const changeEndInOld = Math.max(...resolvedOps.map((op) => op.endIndex));
				const shiftedEnd = changeEndInOld + addedLines;
				const finalHashes = computeLineHashes(newText);
				const regionStart = Math.max(0, changeStart);
				const regionEnd = Math.min(newLines.length - 1, Math.max(shiftedEnd, changeStart));
				const anchorLines = newLines.slice(regionStart, regionEnd + 1);
				const anchorHashes = finalHashes.slice(regionStart, regionEnd + 1);
				const anchorText = anchorLines
					.map((line, i) => `${formatAnchor(regionStart + i + 1, anchorHashes[i])}:${line}`)
					.join("\n");

				const summary = `Successfully applied ${edits.length} edit(s) to ${path}. Lines: ${lines.length} -> ${newLines.length}.`;
				return {
					content: [
						{
							type: "text",
							text: `${summary}\n\n--- Anchors ${regionStart + 1}-${regionEnd + 1} ---\n${anchorText}`,
						},
					],
					details: undefined,
				};
			});
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hashline-edit && node --import tsx --test test/edit.test.ts`
Expected: PASS, all 17 tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/hashline-edit && npm run typecheck && npx biome check .`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/hashline-edit
git add packages/hashline-edit/src/edit.ts packages/hashline-edit/test/edit.test.ts
git commit -m "feat(hashline-edit): add hash-anchored edit tool"
```

---

## Task 7: `grep` tool (opt-in)

**Files:**
- Create: `packages/hashline-edit/src/grep.ts`
- Test: `packages/hashline-edit/test/grep.test.ts`

**Interfaces:**
- Consumes: `computeLineHashes`, `formatAnchor` from `./hashline.js`; `resolvePathArg` from `./paths.js`; `notFoundError` from `./errors.js`; Node's `child_process.spawn` for shelling out to `rg`.
- Produces (consumed by Task 8):
  ```ts
  export function isRipgrepAvailable(): Promise<boolean>;
  export function createHashlineGrepTool(): ToolDefinition;
  ```
  `isRipgrepAvailable` checks `rg --version` exits 0. `createHashlineGrepTool` is only registered by `index.ts` (Task 8) when both `config.grep === true` and `isRipgrepAvailable()` resolves `true`.

- [ ] **Step 1: Write the failing test**

Create `packages/hashline-edit/test/grep.test.ts`:

```ts
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
	writeFileSync(join(dir, "needle.ts"), 'const findMe = 1;\nconst other = 2;\nconst findMe2 = 3;');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hashline-edit && node --import tsx --test test/grep.test.ts`
Expected: FAIL — `src/grep.ts` does not exist.

- [ ] **Step 3: Implement `src/grep.ts`**

```ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computeLineHashes, formatAnchor } from "./hashline.js";
import { resolvePathArg } from "./paths.js";

const execFileAsync = promisify(execFile);

export async function isRipgrepAvailable(): Promise<boolean> {
	try {
		await execFileAsync("rg", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex by default)." }),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a fixed string. Default: false." })),
	path: Type.Optional(Type.String({ description: "Directory or file to search. Default: cwd." })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob, e.g. '*.ts'." })),
	context: Type.Optional(Type.Number({ description: "Lines of context before/after each match (0-5). Default: 0." })),
	limit: Type.Optional(Type.Number({ description: "Max matches to return (default 50, max 200)." })),
});

interface RgMatch {
	path: string;
	lineNumber: number;
}

async function runRipgrep(args: string[], cwd: string): Promise<RgMatch[]> {
	let stdout: string;
	try {
		const result = await execFileAsync("rg", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
		stdout = result.stdout;
	} catch (error) {
		const execError = error as { code?: number; stdout?: string };
		if (execError.code === 1) return []; // no matches
		throw error;
	}
	const matches: RgMatch[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event: { type: string; data?: { path?: { text?: string }; line_number?: number } };
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "match" && event.data?.path?.text && typeof event.data.line_number === "number") {
			matches.push({ path: event.data.path.text, lineNumber: event.data.line_number });
		}
	}
	return matches;
}

export function createHashlineGrepTool(): ToolDefinition<typeof grepSchema, undefined> {
	return {
		name: "grep",
		label: "grep (hashline)",
		description:
			"Search file contents with ripgrep, returning LINE#HASH:content anchors usable directly in edit. Respects .gitignore.",
		parameters: grepSchema,
		async execute(_toolCallId, { pattern, literal, path, glob, context, limit }, _signal, _onUpdate, ctx) {
			const searchPath = path ? resolvePathArg(path, ctx.cwd) : ctx.cwd;
			const effectiveLimit = Math.min(200, Math.max(1, limit ?? 50));
			const effectiveContext = Math.min(5, Math.max(0, context ?? 0));
			const args = ["--json", "--line-number", "--color=never", "--hidden"];
			if (literal) args.push("--fixed-strings");
			if (glob) args.push("--glob", glob);
			args.push("--", pattern, searchPath);

			const matches = await runRipgrep(args, ctx.cwd);
			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			}
			const limited = matches.slice(0, effectiveLimit);

			const fileCache = new Map<string, { lines: string[]; hashes: string[] }>();
			const rows: string[] = [];
			for (const match of limited) {
				let fileData = fileCache.get(match.path);
				if (!fileData) {
					const text = await readFile(match.path, "utf-8");
					fileData = { lines: text.split("\n"), hashes: computeLineHashes(text) };
					fileCache.set(match.path, fileData);
				}
				const displayPath = relative(searchPath, match.path) || match.path;
				const start = Math.max(1, match.lineNumber - effectiveContext);
				const end = Math.min(fileData.lines.length, match.lineNumber + effectiveContext);
				for (let lineNumber = start; lineNumber <= end; lineNumber++) {
					const idx = lineNumber - 1;
					const anchor = formatAnchor(lineNumber, fileData.hashes[idx]);
					rows.push(`${displayPath}:${anchor}:${fileData.lines[idx]}`);
				}
			}
			return { content: [{ type: "text", text: rows.join("\n") }], details: undefined };
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hashline-edit && node --import tsx --test test/grep.test.ts`
Expected: PASS (ripgrep-dependent tests run if `rg` is on `PATH` — it is, per the user's environment; the `{ skip: !rgAvailable }` guard is a safety net for other machines/CI).

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/hashline-edit && npm run typecheck && npx biome check .`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/hashline-edit
git add packages/hashline-edit/src/grep.ts packages/hashline-edit/test/grep.test.ts
git commit -m "feat(hashline-edit): add opt-in ripgrep-backed grep tool"
```

---

## Task 8: Wire up extension registration + monorepo integration

**Files:**
- Create: `packages/hashline-edit/src/index.ts`
- Create: `packages/hashline-edit/README.md`
- Modify: `package.json` (repo root)
- Modify: `README.md` (repo root)

**Interfaces:**
- Consumes: `createHashlineReadTool` (Task 5), `createHashlineEditTool` (Task 6), `createHashlineGrepTool`/`isRipgrepAvailable` (Task 7), `loadConfig` (Task 4). All are already-implemented, tested modules — this task only wires them together; it adds no new hashing/edit logic and needs no dedicated unit test beyond a manual smoke test.

- [ ] **Step 1: Implement `src/index.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { createHashlineEditTool } from "./edit.js";
import { createHashlineGrepTool, isRipgrepAvailable } from "./grep.js";
import { createHashlineReadTool } from "./read.js";

export default async function (pi: ExtensionAPI) {
	const { config, warning } = loadConfig();

	pi.registerTool(createHashlineReadTool());
	pi.registerTool(createHashlineEditTool(() => config));

	if (config.grep && (await isRipgrepAvailable())) {
		pi.registerTool(createHashlineGrepTool());
	}

	if (warning) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(warning, "warning");
		});
	}
}
```

- [ ] **Step 2: Write `packages/hashline-edit/README.md`**

```markdown
# pi-hashline-edit

Hash-anchored `read`/`edit` tool override for the [pi coding agent](https://pi.dev), with
an opt-in ripgrep-backed `grep` tool. Every line gets a short content hash, so edits carry
verifiable references instead of raw text — stale anchors are rejected before they touch
the file.

## Installation

```bash
pi install npm:pi-hashline-edit
```

Or from this monorepo checkout:

```bash
pi install /path/to/pi-packages/packages/hashline-edit
```

## How it works

### `read`

Every line is returned with a `LINE#HASH:` prefix:

```text
 1#ZsQ:function hello() {
 2#TmR:  console.log("world");
 3#M8T:}
```

`HASH` is a 3-character hash (URL-safe base64 alphabet) computed from the line's content
plus its immediate neighbors, so identical lines in different contexts get different
hashes, and an edit to one line does not disturb anchors for unrelated lines elsewhere in
the file. Hashes are recomputed fresh on every call — nothing is cached or persisted.

Images (jpg, png, gif, webp) are detected by magic bytes and returned as attachments, not
hashlined text.

### `edit`

Reference `LINE#HASH` anchors copied from a prior `read` (or `grep`) call:

```json
{
  "path": "src/main.ts",
  "edits": [
    { "replace": { "pos": "2#TmR", "lines": ["  console.log(\"hashline\");"] } }
  ]
}
```

| Op | Fields | Behavior |
|---|---|---|
| `replace` | `pos` (required), `end` (optional), `lines` | Replace `pos` through `end` inclusive. Single line if `end` omitted. Empty `lines` deletes the range. |
| `append` | `pos` (optional), `lines` | Insert after `pos`. Omit `pos` to append at EOF. |
| `prepend` | `pos` (optional), `lines` | Insert before `pos`. Omit `pos` to prepend at BOF. |
| `replace_text` | `oldText`, `newText` | Exact-substring replace. Fails unless `oldText` matches exactly once. Must be the only entry in `edits[]` when used — it cannot be combined with other ops in the same call. |

If any anchor in a batch is stale (line moved, content changed, or the file was modified
since the last `read`), the entire call fails with `[E_STALE_ANCHOR]` and no write occurs —
call `read` again for fresh anchors. A successful edit returns fresh anchors for the
changed region so you can make a follow-up edit without a full re-read.

### `grep` (opt-in)

Off by default. Enable in `~/.pi/agent/hashline.json`:

```json
{ "grep": true }
```

Requires `rg` (ripgrep) on `PATH`. Returns the same `LINE#HASH:content` anchors as `read`,
usable directly in a following `edit` call.

## Configuration

`~/.pi/agent/hashline.json` (optional):

```json
{
  "grep": false,
  "replaceText": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `grep` | `false` | Register the `grep` tool (also requires ripgrep on `PATH`). |
| `replaceText` | `true` | Allow the `replace_text` edit op. Set `false` to enforce anchor-only edits. |

Missing file → defaults. Invalid file → defaults, plus a one-time startup warning.

## Design

- No persistent cross-session state. Every `read`/`edit`/`grep` call reads the file fresh
  from disk and recomputes hashes fresh.
- No stale-anchor recovery. A mismatch fails immediately with a re-read instruction — no
  silent relocation, no fuzzy matching.
- Atomic writes: temp file in the same directory, then rename. Symlinks are written
  through to their real target and preserved. Hard-linked files are updated in place to
  keep the shared inode.

## License

MIT
```

- [ ] **Step 3: Register the extension in the root `package.json`**

Modify `/Users/jstegeman/orca/workspaces/pi-packages/hashline-edit/package.json`. Find:

```json
    "extensions": [
      "./packages/bifrost/index.ts",
      "./packages/statusline/src/statusline.ts"
    ],
```

Replace with:

```json
    "extensions": [
      "./packages/bifrost/index.ts",
      "./packages/statusline/src/statusline.ts",
      "./packages/hashline-edit/src/index.ts"
    ],
```

- [ ] **Step 4: Update the root `README.md` package list**

Modify `/Users/jstegeman/orca/workspaces/pi-packages/hashline-edit/README.md`. Find the packages tree block (currently listing `ayu`, `bifrost`, `statusline`) and add a fourth entry:

```
packages/
├── ayu/            – Ayu color scheme for Pi (Day, Dusk, Dark)
├── bifrost/        – Custom provider for Bifrost AI gateway
├── hashline-edit/  – Hash-anchored read/edit tool override, with opt-in grep
└── statusline/     – Single-line statusline footer with ayu/tokyo-night/classic presets
```

Adjust alignment/spacing to match whatever the existing block's exact formatting is (read the file first to match column widths).

- [ ] **Step 5: Full package check**

Run: `cd packages/hashline-edit && npm run check`
Expected: `biome check .`, `tsc --noEmit`, and `node --import tsx --test test/*.test.ts` (all ~40+ tests across 6 test files) all pass.

- [ ] **Step 6: Manual smoke test in a pi session**

Run:
```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/hashline-edit
pi install ./
```
Then start a pi session in this repo and verify:
1. `read` on any file shows `LINE#HASH:content` rows.
2. Copy an anchor and call `edit` with a `replace` op — confirm the line changes and fresh anchors are returned.
3. Call `edit` again with a deliberately wrong hash on the same anchor — confirm `[E_STALE_ANCHOR]` and no file change.
4. Confirm `grep` is NOT available (config default `grep: false`). Then create `~/.pi/agent/hashline.json` with `{"grep": true}`, start a fresh session, and confirm `grep` IS available and returns anchored results.

Report back what you observed; this is a manual gate before committing, not an automated step.

- [ ] **Step 7: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/hashline-edit
git add packages/hashline-edit/src/index.ts packages/hashline-edit/README.md package.json README.md
git commit -m "feat(hashline-edit): wire up extension registration and register in monorepo"
```

---

## Final Verification

After Task 8, run from the repo root:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/hashline-edit/packages/hashline-edit
npm run check
```

Expected: all green — Biome, typecheck, and the full test suite (`hashline.test.ts`,
`errors.test.ts`, `paths.test.ts`, `config.test.ts`, `read.test.ts`, `edit.test.ts`,
`grep.test.ts`).
