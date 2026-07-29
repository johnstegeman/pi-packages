# Hashline Edit — Design

**Date:** 2026-07-28
**Status:** Approved (pending user review of this spec)
**Scope:** New package `packages/hashline-edit/` — a pi extension that overrides the built-in `read` and `edit` tools with hash-anchored line references, plus an opt-in ripgrep-backed `grep` tool.

---

## Goal

Add a `pi-hashline-edit` package to this monorepo, giving `read`/`edit` verifiable per-line content anchors so edits are never silently applied to the wrong (stale) line. Modeled closely on [RimuruW/pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit), scoped down to exactly `read` + `edit` + optional `grep` — no structural maps, no `ls`/`find`/`write`/`ast_search`/bash-output compression (that broader scope belongs to a different tool, e.g. `pi-hashline-readmap`).

## Non-Goals

- No persistent cross-session or cross-edit hash store (unlike YuGiMob's SQLite-backed fork). Hashes are recomputed fresh from disk on every `read`/`edit`/`grep` call.
- No stale-anchor recovery/3-way-merge. A hash mismatch fails immediately with a re-read instruction — no silent relocation, no fuzzy matching.
- No `ls`, `find`, `write`, `ast_search`, `nu`, or bash-output compression tools.
- No configurable hash length. Fixed at 3 characters.
- No auto-read-after-edit toggle. `edit` returns fresh anchors for the changed region only (see Section 4), not a full-file re-read.
- No image handling changes — images (JPEG/PNG/GIF/WebP) are passed through to pi's stock image reader exactly as the built-in `read` does.

## Context

This monorepo (`pi-packages`) currently hosts three independent pi packages — `bifrost` (provider), `statusline` (footer extension), `ayu` (theme) — each with its own `package.json`, registered in the root manifest's `pi.extensions`/`pi.themes`. `statusline` is the closest structural precedent: a `src/`-organized TypeScript package with its own `tsconfig.json`, `biome.json`, and `node --test` + `tsx` test suite.

Four external reference projects were reviewed:

- **RimuruW/pi-hashline-edit** — replaces `read`+`edit` with `LINE#HASH:` anchors (2-char hash, pure content hash), ops `replace`/`append`/`prepend`/`replace_text`, optional `grep` (off by default, needs ripgrep), config at `~/.pi/agent/hashline.json`, fails immediately on stale anchors, returns fresh anchors for the changed region after a successful edit. **This is the primary model for this design.**
- **YuGiMob/pi-hashline-edit-pro** — fork adding 3-char hashes with collision resolution, a persistent SQLite hash store, bulk/flat edit modes, auto-read toggle. We adopt the 3-char + collision-resolution idea but explicitly reject the persistent store and toggles (non-goals above).
- **coctostan/pi-hashline-readmap** — much broader toolkit (`read`/`edit`/`grep`/`ls`/`find`/`write`/`ast_search`/`nu`/bash compression). Out of scope; informed the empty-file and atomic-write handling details only.
- **@oh-my-pi/hashline** — the underlying line-anchored patch *language* library (`SWAP`/`DEL`/`INS` grammar, pluggable `Filesystem`/`SnapshotStore`). Origin of the hashline concept; not directly reused since we're building a self-contained pi extension rather than a general-purpose patch library.

## Architecture

```
packages/hashline-edit/
├── package.json          # name: pi-hashline-edit, pi manifest → ["./src/index.ts"]
├── tsconfig.json          # mirrors packages/statusline (ES2022, NodeNext, strict)
├── biome.json             # mirrors packages/statusline (tabs, double quotes, recommended preset)
├── README.md
├── LICENSE                # MIT
├── .gitignore
├── src/
│   ├── hashline.ts        # line hashing (context-based, 3-char, collision resolution) + anchor parsing
│   ├── config.ts          # ~/.pi/agent/hashline.json loading (grep, replaceText)
│   ├── errors.ts          # typed error codes + message builders
│   ├── read.ts            # `read` tool implementation
│   ├── edit.ts             # `edit` tool implementation (replace/append/prepend/replace_text)
│   ├── grep.ts             # `grep` tool implementation (ripgrep-backed, opt-in)
│   └── index.ts            # registers read/edit/grep with the ExtensionAPI
└── test/
    ├── hashline.test.ts
    ├── read.test.ts
    ├── edit.test.ts
    ├── grep.test.ts
    └── support.ts          # shared test helpers (temp dirs, mock pi/ctx)
```

Each module has one responsibility, is independently unit-testable, and the tool files (`read.ts`/`edit.ts`/`grep.ts`) depend on `hashline.ts`, `config.ts`, and `errors.ts` but not on each other.

## Components

### `src/hashline.ts` — Hashing

Exports `computeLineHashes(content: string): string[]`, a pure function returning one 3-character hash per line, with no caching or persistence — recomputed fresh on every call.

- **Line normalization before hashing:** strip `\r`, trim trailing whitespace per line. This prevents insignificant whitespace-only changes (e.g. editor-save trailing-space churn) from changing anchors, without requiring any persisted state.
- **Context-sensitive input:** line `i`'s hash input is `prev + "\n" + curr + "\n" + next`, where `prev`/`next` are empty string at file boundaries. This means two byte-identical lines in different surrounding contexts get different hashes, and editing line N only changes the hash *inputs* for lines N−1, N, N+1 — hashes for lines elsewhere in the file are unaffected by an edit, without needing any persisted store.
- **Hash function:** a small embedded pure-JS 32-bit non-cryptographic hash (FNV-1a), reduced to 3 characters over a 64-character URL-safe base64 alphabet (`A-Za-z0-9-_`), giving 262,144 possible values before collision handling.
- **Collision resolution ("perfect hashing" within a file):** hashes are assigned in line order; if a line's computed hash matches one already assigned earlier in the same `computeLineHashes` call, the hash input is perturbed (append a retry counter) and rehashed until unique. Every anchor returned for a single file read is therefore guaranteed unique for that snapshot of the file.
- **Empty file:** a file with zero lines is treated as having one synthetic empty line (line `1`, hash of empty context), so `append`/`prepend`/`replace` have an anchor to target.

Also exports an anchor-format helper: `parseAnchor(anchor: string): { line: number; hash: string } | null` for strings like `"9#Xy_"`, and `formatAnchor(line, hash): string`.

### `src/config.ts` — Configuration

Loads `~/.pi/agent/hashline.json` once at extension load, via `getAgentDir()` from `@earendil-works/pi-coding-agent` (same mechanism `packages/statusline` uses to locate its own settings file).

```ts
interface HashlineConfig {
  grep: boolean;        // default false — register the grep tool
  replaceText: boolean; // default true — allow the replace_text edit op
}
```

- Missing file → defaults.
- Invalid JSON or invalid field values → defaults, plus a one-time warning notification via the extension's UI API.
- Read once per session; not re-read mid-session (matches RimuruW).

### `src/errors.ts` — Error Taxonomy

A small set of typed error codes, each with a message-building helper, used consistently across `read`/`edit`/`grep`:

| Code | Meaning |
|---|---|
| `E_STALE_ANCHOR` | Supplied anchor's line/hash doesn't match the file's current content. |
| `E_BAD_REF` | Anchor string doesn't parse as `LINE#HASH`, or `end` precedes `pos` in a `replace`. |
| `E_INVALID_PATCH` | `replace_text` new/old text looks like pasted `LINE#HASH:` tool output rather than literal file content. |
| `E_NOT_FOUND` | Path doesn't exist, or is a directory where a file was expected. |
| `E_NO_MATCH` / `E_MULTIPLE_MATCHES` | `replace_text`'s `oldText` matched zero times or more than once. |

Errors are returned as tool-result text (not thrown session-ending exceptions), so the model receives a recoverable message and can retry (e.g. re-`read` on `E_STALE_ANCHOR`).

### `src/read.ts` — `read` Tool

Overrides the built-in `read`. Parameters: `path` (required), `offset`, `limit` — same shape as stock `read`.

- Images (jpg/jpeg/png/gif/webp, by extension or magic-byte sniffing) delegate to pi's stock image handling and return image attachments — not hashlined text.
- Directories and binary files: rejected with `E_NOT_FOUND`-style descriptive error, matching stock `read` behavior.
- Text files: read fresh from disk, hashes computed via `hashline.ts`, output formatted one row per line:

  ```
  LINE#HASH:content
  ```

  `LINE` is 1-indexed and left-padded to align within the current output slice (based on the max line number being shown, not the whole file). `HASH` is the 3-char hash. Example:

  ```
   8#a1B:function hello() {
   9#Xy_:  console.log("world");
  10#Q3z:}
  ```

- Respects `offset`/`limit` identically to the stock tool, including truncation-notice behavior for large files.

### `src/edit.ts` — `edit` Tool

Overrides the built-in `edit`. Parameters: `path` (required), `edits` (array, required), each entry exactly one of:

| Op | Fields | Behavior |
|---|---|---|
| `replace` | `pos` (anchor, required), `end` (anchor, optional), `lines` (string[]) | Replace line `pos` through `end` inclusive with `lines`. Single line if `end` omitted. `lines: []` deletes the range. |
| `append` | `pos` (anchor, optional), `lines` (string[]) | Insert `lines` after `pos`. Omit `pos` to append at EOF. |
| `prepend` | `pos` (anchor, optional), `lines` (string[]) | Insert `lines` before `pos`. Omit `pos` to prepend at BOF. |
| `replace_text` | `oldText` (string), `newText` (string) | Exact-substring replace across the whole file. Fails (`E_NO_MATCH`/`E_MULTIPLE_MATCHES`) if `oldText` doesn't match exactly once. Disabled (rejected as unsupported) when config `replaceText: false`. |

**Validation and apply flow, per `edit` call:**

1. Read the file fresh from disk; compute hashes via `hashline.ts`.
2. For every entry in `edits`, resolve and validate its anchor(s) (`pos`/`end`) against the freshly computed hashes:
   - Malformed anchor string → `E_BAD_REF`.
   - Line number out of range, or hash mismatch at that line → `E_STALE_ANCHOR`. The error message names the specific anchor and instructs the model to `read` again for fresh anchors.
   - `end` (if present) resolves to a line before `pos` → `E_BAD_REF`.
3. If any entry fails validation, the **entire call fails** — no partial application. This is checked before any file mutation.
4. If all anchors validate, edits apply **bottom-up** (highest starting line number first), so earlier (lower-line) edits in the same batch aren't affected by line-count shifts from later (higher-line) edits already applied.
5. `replace_text` strictness: before applying, `oldText`/`newText` are checked for content that looks like pasted `LINE#HASH:` anchors or diff markers (`+`/`-` prefixed rows matching the hashline format); if detected, reject with `E_INVALID_PATCH` rather than write literal anchor text into the file.
6. Write atomically: temp file created in the same directory, then renamed over the target.
   - Symlinked targets: written through to the real target; the symlink itself is preserved.
   - Hard-linked targets (`nlink > 1`): updated in place (not via temp+rename) to preserve the shared inode — the one case that isn't torn-write atomic, matching both reference implementations' documented behavior.
   - File permissions are preserved for existing files; new files get the OS/umask default (not applicable here since `edit` only targets existing files — file creation is out of scope, matching "no `write` tool").
7. On success, recompute hashes for the **changed region only** (the post-edit line range affected by the edits, expanded by any line-count shift) and return both a short confirmation (lines added/removed) and a `--- Anchors A-B ---` block of fresh `LINE#HASH:content` rows for that region, enabling immediate follow-up edits without a full re-read.

### `src/grep.ts` — `grep` Tool (opt-in)

Registered only when config `grep: true` **and** `rg` is resolvable on `PATH` at extension load. If the config flag is set but `rg` is missing, the tool is not registered (no error thrown at startup — silently unavailable, consistent with "opt-in, needs ripgrep").

Parameters:

| Param | Default | Meaning |
|---|---|---|
| `pattern` | required | Regex by default. |
| `literal` | `false` | Treat `pattern` as a fixed string. |
| `path` | cwd | Scope the search. |
| `glob` | — | Filename filter. |
| `context` | `0` | Surrounding lines (0–5). |
| `limit` | `50` | Max matches returned (max `200`). |

- Shells out to `rg`, respecting `.gitignore` (ripgrep default).
- For each matched file, reads it fresh and computes hashes via `hashline.ts`; output rows use the same `LINE#HASH:content` format as `read`, so results can be passed directly into `edit`'s `pos`/`end` anchors without an intervening `read` call.

### `src/index.ts` — Registration

```ts
export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  pi.registerTool({ name: "read", ... });
  pi.registerTool({ name: "edit", ... });
  if (config.grep && ripgrepAvailable()) {
    pi.registerTool({ name: "grep", ... });
  }
}
```

## Data Flow

1. **Read:** model calls `read({ path })` → `src/read.ts` reads file → `hashline.ts` computes per-line hashes fresh → formatted `LINE#HASH:content` output returned to model.
2. **Edit:** model copies an anchor from a prior `read`/`grep` output → calls `edit({ path, edits: [...] })` → `src/edit.ts` re-reads the file fresh, recomputes hashes, validates every anchor in the batch against that fresh snapshot → applies bottom-up → writes atomically → recomputes hashes for the changed region only → returns confirmation + fresh anchors for that region.
3. **Grep (if enabled):** model calls `grep({ pattern, ... })` → `src/grep.ts` shells out to `rg` → for each match's file, `hashline.ts` computes hashes fresh → anchored match rows returned, directly consumable by a following `edit` call.

No state is shared between calls; every tool invocation independently reads-and-hashes from disk at call time.

## Error Handling

- All errors from `read`/`edit`/`grep` are returned as tool-result text describing the failure and (for `E_STALE_ANCHOR`) instructing the model to re-`read`. No partial edits are ever applied — `edit` validates the full batch before writing anything.
- Config parse errors (`~/.pi/agent/hashline.json`) fall back to defaults with a one-time session-start warning; they do not block extension load.
- Missing `rg` on `PATH` when `grep: true` is configured: `grep` tool simply isn't registered; no warning needed since ripgrep absence isn't a user misconfiguration in most environments (matches RimuruW's silent-unavailability behavior).
- Filesystem errors during atomic write (permission denied, disk full, etc.) propagate as a generic tool error with the underlying message; no special taxonomy entry since these aren't hashline-specific failure modes.

## Testing

Following TDD, tests are written before each module's implementation, using `node --test` + `tsx`, mirroring `packages/statusline`'s tooling exactly (`biome.json`, `tsconfig.json` shape, `npm test` = `node --import tsx --test test/*.test.ts`).

- **`test/hashline.test.ts`** — hashing determinism (same input → same output), context-sensitivity (identical lines in different surrounding context get different hashes), collision resolution (forcing a collision and confirming a unique hash is produced), empty-file synthetic-line case, whitespace-normalization (trailing whitespace / `\r` differences don't change the hash).
- **`test/read.test.ts`** — offset/limit behavior, directory rejection, binary-file rejection, image-file passthrough (attachment, not hashlined text), anchor format/padding correctness.
- **`test/edit.test.ts`** — each of the four ops individually; stale-anchor rejection (`E_STALE_ANCHOR`) with no partial writes; malformed-anchor rejection (`E_BAD_REF`); bottom-up multi-edit batch application producing the expected final file; atomic write via temp+rename; symlink-preservation case; hard-link in-place-update case; `replace_text` exact-match/zero-match/multiple-match cases; `replace_text` rejection of pasted-anchor content (`E_INVALID_PATCH`); `replace_text` disablement when `replaceText: false`; post-edit fresh-anchor response shape.
- **`test/grep.test.ts`** — tool not registered when `grep: false` or `rg` missing; pattern and `literal` matching; `context`/`limit`/`glob`/`path` parameter behavior; anchor output format matching `read`'s format; `.gitignore` respected.
- **`test/support.ts`** — shared helpers: temp directory creation/cleanup, a minimal mock `ExtensionAPI`/tool-execution context sufficient to invoke tool `execute` functions directly in tests (mirroring `packages/statusline/test/support.ts`'s `createMockPi`/`createMockContext` pattern).

Also run: `npm run typecheck` (`tsc --noEmit`) and Biome lint/format checks, matching `packages/statusline`'s `npm run check` composite script.

## Monorepo Integration

1. Create `packages/hashline-edit/` with the structure above.
2. `package.json`:
   ```json
   {
     "name": "pi-hashline-edit",
     "version": "0.1.0",
     "description": "Hash-anchored read/edit tool override for the Pi coding agent.",
     "license": "MIT",
     "keywords": ["pi-package", "pi-extension", "hashline", "edit", "read"],
     "pi": { "extensions": ["./src/index.ts"] },
     "peerDependencies": {
       "@earendil-works/pi-coding-agent": "*",
       "@earendil-works/pi-ai": "*"
     },
     "devDependencies": {
       "@biomejs/biome": "2.5.3",
       "@earendil-works/pi-coding-agent": "0.80.3",
       "@types/node": "26.1.1",
       "tsx": "4.20.6",
       "typescript": "6.0.3"
     },
     "scripts": {
       "check": "biome check . && npm run typecheck && npm test",
       "format": "biome check --write .",
       "test": "node --import tsx --test test/*.test.ts",
       "typecheck": "tsc --noEmit"
     }
   }
   ```
3. Register in root `package.json`:
   ```jsonc
   "pi": {
     "extensions": [
       "./packages/bifrost/index.ts",
       "./packages/statusline/src/statusline.ts",
       "./packages/hashline-edit/src/index.ts"
     ],
     "themes": ["./packages/ayu/themes"]
   }
   ```
4. Update root `README.md` package list to add a `hashline-edit/` bullet.
5. Add `packages/hashline-edit/README.md` describing installation, the `LINE#HASH` format, the four edit ops, config file shape, and the opt-in `grep` tool — following the documentation style of the RimuruW upstream README (adapted to drop the removed features: no `hashLength` config, no stale-anchor-recovery language).

## Open Questions

None — all decisions confirmed through the brainstorming dialogue:

- Scope: `read`/`edit` + opt-in `grep` only, no broader toolkit.
- Hashing: 3-char, fixed (no config), URL-safe base64 alphabet, context-sensitive (prev+curr+next), collision-resolved per file, recomputed fresh every call (no persistence).
- Anchor format: `LINE#HASH:content` (RimuruW-style).
- Stale anchors: fail immediately, no recovery/merge.
- Edit ops: `replace`/`append`/`prepend`/`replace_text` (RimuruW's table).
- Post-edit response: fresh anchors for the changed region only (RimuruW's "chained edits"), no full-file auto-read toggle.
- `grep`: included, opt-in via config, ripgrep-backed.
- Config: `~/.pi/agent/hashline.json` with `{ grep, replaceText }`.
- Package name/location: `packages/hashline-edit/`, npm name `pi-hashline-edit`.
- Code structure: modular `src/` layout + typed error taxonomy (Approach 3).
- Dev tooling: mirrors `packages/statusline` (`node --test` + `tsx`, Biome, `tsconfig.json` shape).

## Implementation Order

1. Scaffold `packages/hashline-edit/` (`package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `LICENSE`).
2. `src/errors.ts` — error taxonomy (no dependencies).
3. `src/hashline.ts` + `test/hashline.test.ts` — hashing core, TDD.
4. `src/config.ts` — config loading (no test file needed beyond what `read`/`edit`/`grep` tests exercise indirectly, or a small dedicated test if warranted during implementation).
5. `test/support.ts` — shared test helpers.
6. `src/read.ts` + `test/read.test.ts` — TDD.
7. `src/edit.ts` + `test/edit.test.ts` — TDD.
8. `src/grep.ts` + `test/grep.test.ts` — TDD.
9. `src/index.ts` — wire up registration.
10. `packages/hashline-edit/README.md`.
11. Register in root `package.json` `pi.extensions`; update root `README.md`.
12. Run `npm run check` in the subpackage; manual smoke test in a pi session (read a file, edit via anchor, confirm stale-anchor rejection, confirm grep opt-in behavior).
