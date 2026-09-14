# Bifrost config secret persistence hardening (0644 → 0600)

**Bead:** `pi-packages-3iej.3` — Harden bifrost config secret persistence (0644 → 0600); finish `pi-packages-i8o5`
**Parent epic:** `pi-packages-3iej` (Superpowers stack remediation, task 3 / finding H1)
**Related:** `pi-packages-i8o5` (secrets leak guardrails)
**Molecule:** `pi-packages-mol-hv4e` (superpowers-workflow)
**Date:** 2026-09-14

## Problem

`packages/bifrost/index.ts` persists the gateway `virtualKey` to
`~/.pi/agent/bifrost-config.json`. `saveConfig()` calls
`fs.writeFileSync(path, json, "utf8")` with **no `mode`**, so the file is created
with umask defaults — `0644`, world-readable — exposing the virtual key to any
local user or process and to backups/sync. The real file on the developer's
machine was observed at `0644`.

`packages/langfuse/src/config.ts:57-62` already establishes the correct pattern
in this repo: create the parent dir `0o700`, write `0o600`, and `chmodSync`
`0o600` so an already-existing file is corrected too.

## Scope

This spec covers the concrete H1 fix only:

- secure the write path in `packages/bifrost/index.ts`;
- self-heal a pre-existing world-readable config on load;
- add a regression test asserting the mode.

Explicitly **out of scope** (remaining `pi-packages-i8o5` workstream, tracked
separately so this change does not duplicate it): gitleaks/trufflehog config and
CI secret-scan job, full git-history secret sweep and key rotation, repo-wide
key-write audit beyond bifrost, and the `AGENTS.md`/README secret-policy
documentation.

## Decisions

1. **File-only hardening; the shared directory is never chmod'd.**
   `saveConfig` creates the parent directory with `mode: 0o700` only when it is
   missing (so a freshly created `~/.pi/agent` is private), but does **not**
   `chmod` an already-existing directory. `~/.pi/agent` is shared with pi's own
   `auth.json` and session state; tightening it is a separate, broader decision.
2. **Self-heal on load, code only.** `loadConfig` repairs an existing file's mode
   to `0600`. No one-time manual `chmod` of the real config is performed as part
   of this change; the next bifrost extension load repairs it.
3. **Injectable path, mirroring langfuse.** Both functions take an optional path
   parameter defaulting to `CONFIG_PATH`, and are exported, so the mode is
   directly testable against a temp directory without touching global state or
   the real config.

## Behavior & API surface

`packages/bifrost/index.ts` keeps its default extension export unchanged. Two
existing internal functions gain an optional path parameter and become named
exports:

```ts
export function loadConfig(configPath?: string): BifrostConfig
export function saveConfig(updates: BifrostConfig, configPath?: string): void
```

Both default to the existing `CONFIG_PATH`. The parameter is named `configPath`,
not `path`, because the module already imports `* as path from "node:path"` — a
parameter named `path` would shadow the module and break `path.dirname`.

- **`saveConfig`.** Merges `updates` over any existing file, then persists with
  `0644 → 0600`.
- **`loadConfig`.** Reads and merges as today (env vars win over file values),
  and additionally best-effort repairs an existing file's mode to `0600`. A
  missing file or a chmod failure never breaks config loading.
- No other semantics change.

## Implementation

In `saveConfig`:

```ts
export function saveConfig(updates: BifrostConfig, configPath: string = CONFIG_PATH): void {
  let existing: BifrostConfig = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, "utf8")) as BifrostConfig;
  } catch {
    // No existing file – start fresh.
  }

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...existing, ...updates }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    // writeFileSync's mode only applies when the file is created; an
    // already-existing file keeps its old mode, so correct it explicitly.
    fs.chmodSync(configPath, 0o600);
  } catch (err) {
    console.error("[pi-bifrost] Failed to save config:", err);
  }
}
```

In `loadConfig`, add the self-heal in its **own** `try`/`catch`, deliberately
separate from the parse:

```ts
try {
  fs.chmodSync(configPath, 0o600);
} catch {
  // File absent or not chmod-able; best-effort only.
}
```

Rationale for the separate `try`:

1. If the chmod lived inside the parse `try`, a chmod failure (read-only
   filesystem, permissions) would be caught and the **already-parsed** config
   would be discarded, silently falling back to env/empty.
2. A bare `chmodSync` on a missing path throws `ENOENT`, which the catch
   absorbs, so no `existsSync` + chmod race is needed.

A chmod failure is never fatal to loading.

## Tests

Add `packages/bifrost/test/config.test.ts`, using the same `node --test` +
`../index.ts` import style as the existing suites. Cases:

1. **Fresh save is private** — `saveConfig({gatewayUrl, virtualKey}, join(tmp, "nested", "config.json"))`;
   assert `statSync(file).mode & 0o777 === 0o600` and that the auto-created
   `nested` dir has no group/other bits (`mode & 0o077 === 0`).
2. **Existing 0644 file self-heals on load** — pre-write a `0644` file
   (`writeFileSync(f, json)` default mode), call `loadConfig(f)`, assert returned
   values are intact and the file is now `0o600`.
3. **Existing 0644 file is corrected on save** — pre-write `0644`,
   `saveConfig({virtualKey: "new"}, f)`, assert mode `0o600` and that the
   pre-existing `gatewayUrl` was merged (not clobbered).
4. **Existing directory is not chmod'd** — create a `0755` temp dir, save into
   it, assert the dir mode is unchanged.
5. **Missing file is a no-op** — `loadConfig` on a nonexistent path returns `{}`
   (env unset) and does not create the file.
6. **Env precedence preserved** — set `BIFROST_GATEWAY_URL` /
   `BIFROST_VIRTUAL_KEY` and confirm they beat file values.

Note: importing `../index.ts` only evaluates module-level constants and function
definitions — the default extension export is not invoked on import — so tests
have no side effects.

## Verification

`cd packages/bifrost && npm test` must pass: the new `config.test.ts` plus the
existing `phase-tracker` and `to-provider-model` suites. No CI-file changes and
no manual `chmod` of the real config, per the scope decisions above.

## Acceptance

Bifrost's config file is `0600` after a write; a regression test asserts the
mode; an existing world-readable config is repaired on next load; the shared
`~/.pi/agent` directory is left untouched.
