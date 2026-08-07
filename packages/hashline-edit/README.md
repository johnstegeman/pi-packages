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
| `replace_text` | `oldText`, `newText` | Exact-substring replace. Fails unless `oldText` matches exactly once. May be combined with other operations when the resolved ranges do not overlap. |

All operations in a batch are resolved against the same pre-edit file snapshot and applied atomically. Replacement ranges and insertion points must not overlap. An overlapping batch fails with `[E_EDIT_CONFLICT]`; split it into separate edit calls or revise the overlapping ranges.

If any anchor in a batch is stale (line moved, content changed, or the file was modified
since the last `read`), the entire call fails with `[E_STALE_ANCHOR]` and no write occurs —
call `read` again for fresh anchors. A successful edit returns fresh anchors for the
changed region so you can make a follow-up edit without a full re-read.

> **Pass `edits` as an array of objects, not a JSON string.** Some models occasionally
> stringify the `edits` parameter instead of passing a structured array. The tool will
> attempt to parse a stringified `edits` transparently (including handling literal newlines
> inside string values), but this is a fallback — always prefer passing a real array. If
> parsing fails, the error `[E_INVALID_ARGUMENT]` is returned with guidance to resend
> the array directly.

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
