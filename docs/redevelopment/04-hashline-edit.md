# 04 — hashline-edit: feature inventory

Source: `packages/hashline-edit/` (`src/{index,hashline,config,errors,read,edit,grep,paths}.ts`
+ 7 test suites). Design docs: `2026-07-28-hashline-edit-design.md` (original),
`2026-08-07-hashline-mixed-replace-text-design.md`, and friction units A/B/G of
`2026-10-22-tool-friction-fixes-design.md` (all driven by a measured sweep of
**1,231 sessions / 3,285 edit calls, 13.9% error rate**).

## Purpose

Overrides pi's built-in `read` and `edit` with **hash-anchored line references**:
reads emit `LINE#HASH:content`; edits reference `LINE#HASH` anchors copied from
prior read/grep output. Hashes are recomputed fresh from disk on every call — no
state, no cache, no persistence — and a stale anchor is rejected **before any
write**. Plus an **opt-in** ripgrep-backed `grep` emitting the same anchors.

Core invariants: no persistent cross-session state; no stale-anchor recovery (fail
immediately — no fuzzy match, no relocation); atomic batch (all ops resolve against
one pre-edit snapshot; any failure ⇒ no write at all); atomic on-disk writes.

## 1. Hash / anchor scheme (`src/hashline.ts`)

1. FNV-1a 32-bit hash, encoded as **3 chars × 6 bits, MSB first**, alphabet
   `A–Za–z0–9-_` (64-char URL-safe), `HASH_LENGTH = 3`, mask `0x3ffff`.
2. **Canonicalization before hashing**: strip `\r` and trailing whitespace —
   CRLF and trailing-space churn don't move anchors. Leading whitespace is *not*
   touched (indentation changes do change the hash).
3. **Context-sensitive**: line *i* hashes `prev + "\n" + curr + "\n" + next`
   (empty at boundaries). Byte-identical lines in different contexts get different
   hashes; editing line N perturbs only N−1, N, N+1 — anchors elsewhere survive.
4. **Per-file perfect hashing (collision resolution)**: assign in line order; on a
   candidate already used, rehash with `base + "\u0000" + retry` until unique.
   Every anchor within one `computeLineHashes` snapshot is unique.
5. `computeLineHashes(content)` pure, no caching; empty file → one synthetic line;
   trailing newline → extra empty final line. `formatAnchor(line, hash)` →
   `line + "#" + hash`. Golden values are pinned in tests (e.g.
   `"function hello() {\n  console.log(\"world\");\n}"` → `["ZsQ","TmR","M8T"]`,
   `""` → `["1Z1"]`, `"foo\n"` → `["o-v","mQX"]`) — these are the compatibility
   contract if the algorithm is reimplemented.

## 2. Anchor parsing — "repair only what the malformation proves"

`parseAnchor` runs `/^([1-9][0-9]*)#([A-Za-z0-9_-]{3})$/` against a *cleaned*
token: strip **all whitespace anywhere** (covers read's padded line numbers,
`" 49#Oau"`, `"49 #Oau"`, tabs/newlines) and **exactly one trailing colon**
(read's `:` separator, `"562#T-x:"`). A doubled colon still fails. Rationale:
removing noise can't make a stale anchor valid — the hash is still verified
against the file. "No hash is ever invented." Everything else → `E_BAD_REF`
(`"481#"`, `"1373"`, `"yRZ"`, `"1624#FZKQ"` 4-char, `"0#Xy_"`/`"-1#Xy_"`).

## 3. Tool: `read` (override, label `read (hashline)`)

- Params: `path` (required), `offset?` (1-indexed), `limit?`.
- Path resolution (`src/paths.ts`): `~` expansion, absolute, cwd-relative.
- Missing file / directory → `E_NOT_FOUND` with reason. `offset` beyond EOF →
  `E_NOT_FOUND` ("offset N is beyond end of file (M lines total)").
- **Image passthrough** by magic bytes only (PNG/JPEG GIF87a/89a/WEBP signatures,
  `detectImageMimeType`) → image attachment, no hashlines. Non-image files are
  treated as utf-8 text (no other binary special-casing).
- Whole-file hash computation (context-dependent ⇒ can't hash per-slice), then
  slice `[offset-1, offset-1+limit)`. Output rows
  `${lineNumber padded to width of largest shown line}#${hash}:${line}`.

## 4. Tool: `edit` (override, label `edit (hashline)`) — the core

- Params: `path`, `edits: array<entry>`. Entry = exactly one op (multi-op entries
  are split, see §4.3):
  - `replace { pos, end?, lines }` (empty `lines` = delete range)
  - `append { pos?, lines }` (omit pos = EOF)
  - `prepend { pos?, lines }` (omit pos = BOF)
  - `replace_text { oldText, newText }`
- **promptGuidelines** (exact): pass `edits` as array not JSON string, with the
  canonical example `edits=[{"replace":{"pos":"2#TmR","lines":["  console.log('hi');"]}}]`;
  one op per entry (entries carrying several are split); overlapping ranges fail
  with `E_EDIT_CONFLICT`.
- **`prepareArguments` repairs** (framework hook, pre-validation — repeated
  defensively in `execute` since direct calls bypass it):
  1. **Stringified `edits`** → `JSON.parse`; on failure retry after escaping
     literal `\n`/`\r`/`\t` inside double-quoted string values (some models emit
     raw newlines inside stringified JSON); both failing → `E_INVALID_ARGUMENT`
     with "do not stringify" guidance; parsed-to-non-array → `E_INVALID_ARGUMENT`.
  2. **Flattened entries**, idempotently: bare-array op (`{pos, append: ["lines"]}`)
     → wrapped; entry-level `pos`/`anchor` (alias)/`end` promoted into an object
     op missing them.
  3. **Multi-op entries** split into one entry per op (2026-10-22: of 160 observed
     `E_BAD_REF`s, 63 were multi-op shapes, 39 of them `{replace, replace_text}`).
     Splitting is lossless; overlap still caught downstream.
- **Execution**: `withFileMutationQueue(path, …)` (pi's file-mutation
  serialization) → read fresh → compute lines+hashes → resolve every entry to a
  common `ResolvedOp` → `validateResolvedOps` (overlap) → apply **bottom-up**
  (sort by `startIndex` desc, `splice` on a copy) → `writeAtomic` → response
  re-computes hashes and returns a `--- Anchors A-B ---` block of **fresh anchors
  for exactly the changed region** so follow-up edits need no full re-read.
- **Anchor resolution** (`resolveAnchorToIndex`): unparsable → `E_BAD_REF`;
  line out of range → `E_STALE_ANCHOR` ("line N is out of range (file has M
  lines)"); hash mismatch → `E_STALE_ANCHOR` ("content hash does not match the
  current file"). A repaired-but-wrong-hash anchor still fails `E_STALE_ANCHOR`
  (repair can't bypass verification — pinned by test).
- **Insertion encoding**: append/prepend are replacements with
  `endIndex < startIndex` (`deleteCount = 0`).
- **`replace_text` semantics**: disabled by config → `E_INVALID_PATCH`; empty
  `oldText` rejected (no insertion semantics); **pasted-anchor-output detection**
  (`/(?:^|\n)\s*\d+#[A-Za-z0-9_-]{3}:/` against `newText`/`oldText`) →
  `E_INVALID_PATCH` ("send literal file content instead"); not found →
  `E_NO_MATCH`; overlapping-scan match count ≠ 1 → `E_MULTIPLE_MATCHES` (message
  includes the "include more surrounding lines" fix suggestion); otherwise
  converted to a line-range replacement preserving the unmatched prefix of the
  first boundary line and suffix of the last.
- **`E_EDIT_CONFLICT` overlap rules**: insertion↔insertion iff same `startIndex`;
  insertion↔replacement iff the insertion point ∈ [start, end];
  replacement↔replacement iff ranges intersect. Raised **before any write**;
  message tells the model to split the batch or revise ranges.
- **`writeAtomic`**: `realpath()` (symlink write-through, symlink preserved);
  hard-linked (`nlink > 1`) → **write in place** to preserve the shared inode
  (the one non-torn-write case — matches both reference implementations); else
  temp file `.hashline-edit-<uuid>.tmp` in the same dir, best-effort `chmod` to
  original mode, `rename` over target, cleanup on failure.

## 5. Tool: `grep` (opt-in override, label `grep (hashline)`)

- Registered only when config `grep: true` **and** `rg --version` succeeds
  (missing `rg` + flag set → silently not registered — a fallback to remove under
  the new posture; **[decide] Q2b**: hard-error or warn instead).
- Params: `pattern`, `literal?`, `path?`, `glob?`, `context?` (0–5), `limit?`
  (default 50, max 200) — hard-clamped.
- Runs `rg --json --line-number --color=never --hidden [--fixed-strings]
  [--glob G] -- <pattern> <path>` (10 MiB buffer; `--` makes leading-dash
  patterns safe; `--hidden` but `.gitignore` respected). Exit 1 → "No matches
  found".
- Output rows `relativePath:LINE#HASH:content` (context lines included, clamped),
  hashes computed per matched file (cached per call) — directly consumable by
  `edit`.

## 6. Configuration (`<agentDir>/hashline.json`, loaded once at extension load)

`{ grep: boolean (default **false**), replaceText: boolean (default **true**) }`.
Missing → defaults. Invalid JSON / non-object / wrong-typed fields → defaults **+
one-time `session_start` warning notification** (`ctx.ui.notify(warning, "warning")`).
Unknown keys silently ignored; per-field fallback for missing fields. Never
re-read mid-session.

## 7. Error taxonomy (`src/errors.ts`)

Thrown `HashlineError`s (pi renders throws as error results) with `[CODE] `-
prefixed messages: `E_STALE_ANCHOR` (with re-read hint), `E_BAD_REF`,
`E_INVALID_PATCH`, `E_INVALID_ARGUMENT`, `E_NOT_FOUND`, `E_NO_MATCH`,
`E_MULTIPLE_MATCHES` (with uniqueness fix suggestion), `E_EDIT_CONFLICT` (with
split-batch guidance). Every message names the fix, not just the failure — the
friction-sweep doctrine.

## 8. Test coverage (≈70 tests pinning all of the above)

Golden hash values (algorithm compatibility contract); anchor noise tolerance and
malformed rejection; config fallbacks+warnings; error message content; image
magic-byte detection; read formatting/padding/slicing; per-op edit semantics;
atomic-batch no-partial-write on every failure mode; bottom-up multi-edit with
line-count shifts; mixed `replace_text` + anchored edits in one batch; all
`E_EDIT_CONFLICT` shapes; fresh-anchor response block (exact `--- Anchors 2-6 ---`
recomputation); `prepareArguments` repair shapes incl. stringified edits with
literal newlines; permissions preserved through temp+rename; symlink write-through;
hard-link inode preservation; grep output/glob/limit/`.gitignore` (real `git init`
in temp dir). Tests call `tool.execute(...)` directly (why `execute` re-runs the
repair pipeline).

## 9. Packaging

`pi-hashline-edit` 0.1.0, published (not private), `pi.extensions:
["./src/index.ts"]`. Gate: `check` = `biome check . && tsc --noEmit && node --import
tsx --test test/*.test.ts` (lint + typecheck + tests in one script, so the package
gate runs it once). Peers: `@earendil-works/pi-coding-agent`, `typebox`. Dev deps
pinned (biome 2.5.3, tsx, typescript, @types/node); committed lockfile.

## 10. New-repo considerations

1. This is the **highest-fidelity port** candidate: pure, stateless, no
   cross-package coupling, exhaustive tests. The golden hash values make the
   anchor format a stable cross-session/cross-agent contract — keep the algorithm
   bit-identical if interop with existing transcripts matters, otherwise free to
   redesign.
2. Fallbacks to revisit under the no-fallback posture: silent grep non-registration
   when `rg` is missing (Q2b); grep defaulting **off** (in a codemode-heavy stack
   the declared-tool budget argument for keeping it off may no longer apply — but
   see 03 §Design context); config-warning-instead-of-fail for malformed config.
3. The `prepareArguments` repair layer is empirically grounded (13.9% error-rate
   sweep) — carry the repairs and their measured rationale, not just the code.
