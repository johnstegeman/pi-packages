# Statusline Ayu Preset — Design

**Date:** 2026-07-28
**Status:** Approved (pending user review of this spec)
**Scope:** Copy `pi-inline-statusline` (v0.17.1, upstream `LuckyYunPeng/pi-inline-statusline`) into the monorepo as `packages/statusline/` and add a third self-contained preset, `ayu`, baked to Ayu Dark colors and set as the default preset.

---

## Goal

Bring the single-line statusline extension into this monorepo alongside `bifrost` and `ayu`, and add an `ayu` preset that visually matches the monorepo's existing Ayu Dark pi theme. The `ayu` preset becomes the default for everyone who installs the monorepo; `tokyo-night` and `classic` remain selectable via `PI_STATUSLINE_PRESET`.

## Non-Goals

- No theme-aware (semantic-color) preset. The `ayu` preset is self-contained with hardcoded hexes, exactly like `tokyo-night`. It does not read the active pi `Theme`.
- No new palette/density/separator options. Those remain hardcoded defaults.
- No changes to segment definitions, segment selection, the `/statusline` command, git-status logic, extension-status rendering, or settings file format.
- No upstream contribution back to `LuckyYunPeng/pi-inline-statusline`. This is a monorepo-local fork.

## Context

`pi-inline-statusline` ships two presets that differ structurally:

- **`tokyo-night`** (upstream default) — self-contained: hardcoded truecolor hexes, `░▒▓` lead + `` powerline blocks. Ignores the active pi theme. Five blocks in fixed order: `header → directory → git → runtime → meter`.
- **`classic`** — theme-aware: calls `theme.fg("accent", …)` etc., so it adapts to whatever pi theme is active. `•` separators. A `palette` field rotates which semantic `ThemeColor` each segment uses, but `palette` is a hardcoded default (not user-selectable).

Only `preset` is user-selectable, via env var `PI_STATUSLINE_PRESET`. Palette/density/separator are hardcoded defaults. Segments and extension-status icons persist in `~/.pi/agent/pi-statusline.json`.

This design adds a third preset, `ayu`, modeled on `tokyo-night` (the "Mirror + recolor" option the user chose): identical block architecture and glyphs, only the color constant changes. Ayu Dark hexes are taken from the monorepo's own `packages/ayu/themes/ayu-dark.json` so the statusline and the ayu pi theme share the same source colors.

## Architecture

The `ayu` preset reuses tokyo-night's block architecture with no logic changes — only the color constant and its derived separator color differ. The shared block concept already exists: every `RenderSegment` carries a `block: TokyoNightBlockName` field, and `tokyo-night.ts` groups segments by that field in a fixed order. Renaming `TokyoNightBlockName` → `BlockName` makes the shared concept neutral without changing any behavior.

### Ayu Dark → block color mapping

Mirroring tokyo-night's structure: two bright blocks (colored background, page-bg foreground) followed by three dim blocks (dark background, accent/blue foreground), dimmest last.

| Element | tokyo-night | ayu (new) | Ayu source (ayu-dark.json) |
|---|---|---|---|
| lead `░▒▓` | `#a3aed2` | `#ffb454` | `vars.accent` |
| header bg / fg | `#a3aed2` / `#090c0c` | `#ffb454` / `#0a0e14` | `vars.accent` / `export.pageBg` |
| directory bg / fg | `#769ff0` / `#e3e5e5` | `#39bae6` / `#0a0e14` | `vars.blue` / `export.pageBg` |
| git bg / fg | `#394260` / `#769ff0` | `#212b3d` / `#39bae6` | `vars.border` / `vars.blue` |
| runtime bg / fg | `#212736` / `#769ff0` | `#131721` / `#ffb454` | `vars.borderMuted` / `vars.accent` |
| meter bg / fg | `#1d2230` / `#a0a9cb` | `#0d1017` / `#68718a` | `export.cardBg` / `vars.dimGray` |
| extension separator | `#394260` | `#212b3d` | `vars.border` |

Same block order (`header → directory → git → runtime → meter`), same `░▒▓` lead, same `` powerline joins.

## Components / Changes

### New file: `packages/statusline/presets/ayu.ts`

Structural twin of `presets/tokyo-night.ts`. Contains:

- `interface BlockColors { fg: string; bg: string }` — duplicated locally in `ayu.ts`, matching tokyo-night.ts which keeps its own private `BlockColors`. The interface is two trivial fields; duplicating it keeps each preset file self-contained (the existing style) and avoids a shared-types coupling. (If a later preset wants it shared, hoist to `types.ts` then — not now.)
- `interface Block { name: BlockName; segments: RenderSegment[] }`.
- `AYU_COLORS` — `as const satisfies Record<string, string | BlockColors>` with the seven entries from the table above (`lead`, `header`, `directory`, `git`, `runtime`, `meter`, `extensionSeparator`).
- `AYU_BLOCK_ORDER: BlockName[] = ["header", "directory", "git", "runtime", "meter"]`.
- Exports `renderAyuStatusline`, `renderAyuSegments`, `ayuExtensionSeparator`, mirroring tokyo-night's exported surface so the call sites can dispatch symmetrically.
- Internal `groupAyuBlocks` / `joinAyuSegments` / `formatAyuBlockText` / `formatAyuSegmentText` / `getAyuBlockColors` — identical logic to tokyo-night's equivalents, only the color constant and (optional) interface name change.

### Rename: `TokyoNightBlockName` → `BlockName`

The block architecture is now shared by `tokyo-night` and `ayu`, so the type name should be neutral. This is a mechanical rename, contained to:

- `presets/types.ts`: `export type TokyoNightBlockName = ...` → `export type BlockName = ...`; `RenderSegment.block: BlockName`.
- `presets/tokyo-night.ts`: update the import; rename the internal `TokyoNightBlock` interface → `Block` for consistency (it's private, zero external impact); update `TOKYO_NIGHT_BLOCK_ORDER`'s type annotation to `BlockName[]`.
- `src/render.ts`: the `TokyoNightBlockName` import in the type-only import list → `BlockName`.

No behavior change.

### Edit: `presets/types.ts`

`StatuslinePresetName` gains `"ayu"`:

```ts
export type StatuslinePresetName = "classic" | "tokyo-night" | "ayu";
```

### Edit: `src/render.ts`

Import `renderAyuSegments` from `../presets/ayu.js`, and extend the `renderSegments` switch:

```ts
switch (config.preset) {
    case "classic":
        return renderClassicSegments(segments, theme, config);
    case "tokyo-night":
        return renderTokyoNightSegments(segments);
    case "ayu":
        return renderAyuSegments(segments);
}
```

No `default` needed — the existing switch has no `default` branch and relies on union exhaustiveness; `StatuslinePresetName` is now a three-member union, so adding the `case "ayu"` is required for `tsc` (a missing case makes the function's implicit return type fail).

### Edit: `src/extension-status.ts`

Import `ayuExtensionSeparator` from `../presets/ayu.js`. The `extensionStatusSeparator` switch currently collapses to a tokyo-night/classic binary; extend it to three branches:

```ts
function extensionStatusSeparator(presetName: StatuslinePresetName, theme: Theme): string {
    switch (presetName) {
        case "classic":
            return classicExtensionSeparator(theme);
        case "tokyo-night":
            return tokyoNightExtensionSeparator(theme);
        case "ayu":
            return ayuExtensionSeparator(theme);
    }
}
```

(The current code is a ternary; it must become a switch or equivalent three-way branch. `ayuExtensionSeparator(_theme)` returns `ansiFg(AYU_COLORS.extensionSeparator, " • ")`, mirroring tokyo-night's separator.)

### Edit: `src/settings.ts`

Two changes in the preset-selection code:

- `DEFAULT_PRESET: StatuslinePresetName = "ayu"` (was `"tokyo-night"`).
- `readStatuslinePreset` validator adds the `ayu` value:

```ts
function readStatuslinePreset(): StatuslinePresetName {
    const value = process.env.PI_STATUSLINE_PRESET?.trim().toLowerCase();
    return value === "classic" || value === "tokyo-night" || value === "ayu" ? value : DEFAULT_PRESET;
}
```

This makes `ayu` the default for every install (unsetting or sending an invalid `PI_STATUSLINE_PRESET` now lands on `ayu`), while existing users who explicitly set `PI_STATUSLINE_PRESET=tokyo-night` keep their choice.

### Monorepo integration

1. Copy the upstream package into `packages/statusline/`, preserving `src/`, `presets/`, `test/`, `tsconfig.json`, `biome.json`, `README.md`, `README.zh-CN.md`, `LICENSE`. Drop `package-lock.json` (the monorepo has none for the other packages; peer deps resolve through pi's bundled core).
2. Edit `packages/statusline/package.json`:
   - `"name": "pi-inline-statusline"` (keep the npm name — it identifies the extension) or rename to `"pi-statusline"` for consistency with the directory. **Decision: keep `"pi-inline-statusline"` to preserve identity and avoid implying a new npm package.**
   - Keep `"version": "0.17.1"` as the fork baseline (bump on release if published).
   - Keep `"pi": { "extensions": ["./src/statusline.ts"] }` — paths are relative to the subpackage root and resolve correctly.
   - Keep `peerDependencies` (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, both `"*"`) — already on the current fork; no import rewrites needed.
   - Decide on `devDependencies`/`scripts` (`biome`, `tsx`, `typescript`, `vitest`-via-`node --test`): keep for local typecheck/test of the statusline code, OR drop for consistency with the minimal `bifrost`/`ayu` package.jsons. **Decision: keep them so the statusline's own test suite stays runnable from the subpackage.** (Hoisting to the root is out of scope — not worth adding a root toolchain for one package.)
3. Register the extension in the root `package.json` `pi.extensions` array:

```jsonc
"pi": {
    "extensions": [
        "./packages/bifrost/index.ts",
        "./packages/statusline/src/statusline.ts"
    ],
    "themes": ["./packages/ayu/themes"]
}
```

4. Update the root `README.md` package list to include `statusline/`.

### Documentation: `packages/statusline/README.md`

Update the Presets section to describe `ayu` as the default and list it alongside `tokyo-night` and `classic`. Note that the `ayu` preset uses Ayu Dark hexes drawn from this monorepo's `ayu` theme, and that it is self-contained (does not read the active pi theme). Keep the existing tokyo-night/classic descriptions intact.

## Data Flow

Unchanged from upstream. At `session_start` / `session_tree`, `installFooter(ctx)` registers a footer renderer with `ctx.ui.setFooter`. Each render tick calls `renderStatusline(width, ctx, footerData, theme, config, runtime)`, which builds `RenderSegment[]` (segments carry a `block: BlockName`), then `renderSegments` dispatches on `config.preset`:

- `"ayu"` → `renderAyuSegments(segments)` → `joinAyuSegments` → groups by `BlockName` in `AYU_BLOCK_ORDER`, paints each block from `AYU_COLORS`, joins with `` powerline glyphs, prepends the `░▒▓` lead, appends a closing ``.

The extension-status line is rendered separately via `renderExtensionStatusline` and merged with `mergeStatuslineLines`, using `extensionStatusSeparator(config.preset, theme)` as the join — which now dispatches to `ayuExtensionSeparator` for the `ayu` preset.

`config.preset` is resolved once at extension load in `createDefaultConfig()` via `readStatuslinePreset()`, which reads `PI_STATUSLINE_PRESET` (defaulting to `"ayu"`). It is not re-read mid-session.

## Error Handling

- `PI_STATUSLINE_PRESET` with an unrecognized value falls back to `DEFAULT_PRESET` (`"ayu"`) — same behavior as today, just a different default. No new error path.
- All preset renderers share the existing width-truncation (`truncateToWidth`) and empty-segment guards in `renderStatusline` / `wrapStatuslineSegments`. No new guard needed for `ayu`; it reuses tokyo-night's structure verbatim.
- If `AYU_COLORS` is malformed (it won't be — `as const satisfies`), TypeScript fails at build. Runtime has no color validation.

## Testing

- **Existing render tests already cover ayu for free (preset-agnostic).** `test/statusline.test.ts` has no tokyo-night-specific render test — its `footer.render()` tests use a color-stripping mock theme `{ fg: (_color, text) => text }` and assert only on preset-independent content (emoji/segment text like `🕒`, `⚡`, `🚀`, `ctx ?`, `tok 0`, `$0.000`). Because that mock theme only affects the `classic` preset (the only one that calls `theme.fg`), and segment *text* is identical across presets, these tests pass unchanged once `DEFAULT_PRESET` flips to `"ayu"` — they automatically re-exercise `renderAyuSegments` instead of `renderTokyoNightSegments`. This is free smoke coverage that ayu doesn't break basic rendering; no edit to those tests is needed.
- **Add net-new structural tests for `ayu`** (there are no preset-specific structural tests today to adapt). Add a focused test for `renderAyuSegments` / `renderAyuStatusline` covering: (a) a known segment list produces output containing the `░▒▓` lead, a `` powerline separator, and the expected header/directory text; (b) `visibleWidth` of the result fits a given width after `renderAyuStatusline(width, …)` truncation; (c) `ayuExtensionSeparator(_theme)` returns ` • ` colored with the Ayu border hex (`#212b3d`) — assert the ANSI truecolor sequence for that hex is present. Mirror the import style already used in the test file (`import { visibleWidth } from "@earendil-works/pi-tui"`).
- **Preset-selection test (behavioral, via env).** `readStatuslinePreset` and `DEFAULT_PRESET` are *not exported* from `src/settings.ts`, so they cannot be unit-tested directly without adding test-only exports. Prefer a behavioral test that sets `process.env.PI_STATUSLINE_PRESET` (and restores it in a `finally`), instantiates `statusline(mockPi)`, renders the footer, and asserts the output shape matches the selected preset: the `░▒▓` lead for `ayu`/`tokyo-night` vs `•` separators for `classic`. Cases: unset env → ayu (default); `"ayu"`; `"tokyo-night"`; `"classic"`; `"garbage"` → ayu (fallback). This avoids adding exports purely for tests. (If the implementer prefers a pure unit test, export `readStatuslinePreset` — but that is a production-code change for testability and should be called out in the plan.)
- **Typecheck:** `tsc --noEmit` from the subpackage must pass after the `TokyoNightBlockName` → `BlockName` rename and the new `ayu.ts`. Exhaustiveness of the `renderSegments` and `extensionStatusSeparator` switches is enforced by the union type — a missing `ayu` case fails the build.
- **Manual smoke test:** load the monorepo in pi with no `PI_STATUSLINE_PRESET` set and confirm the footer renders in Ayu Dark colors; set `PI_STATUSLINE_PRESET=tokyo-night` and `=classic` to confirm both still render.

## Open Questions

None — all decisions confirmed:
- Preset kind: self-contained, hardcoded Ayu Dark hexes (bake in dark only).
- Visual identity: mirror tokyo-night's block architecture, recolored.
- Default: `ayu` for everyone; `tokyo-night`/`classic` retained via env var.
- Directory name: `packages/statusline/`.
- Package name in subpackage `package.json`: keep `pi-inline-statusline`.
- Dev tooling in subpackage: keep (so its test suite stays runnable).

## Implementation Order

1. Copy upstream package into `packages/statusline/`; drop `package-lock.json`; verify `pi.extensions` path resolves and the extension loads unchanged.
2. Rename `TokyoNightBlockName` → `BlockName` across `presets/types.ts`, `presets/tokyo-night.ts`, `src/render.ts`; typecheck.
3. Add `presets/ayu.ts` (twin of `tokyo-night.ts` with `AYU_COLORS`); typecheck.
4. Extend `StatuslinePresetName` with `"ayu"`; wire `renderSegments` switch and `extensionStatusSeparator`; typecheck.
5. Flip `DEFAULT_PRESET` to `"ayu"` and extend `readStatuslinePreset`; typecheck + preset-selection behavioral test (env-driven, see Testing).
6. Add `ayu` render/separator tests; run `npm test` + `npm run typecheck` in the subpackage.
7. Register `./packages/statusline/src/statusline.ts` in root `package.json` `pi.extensions`; update root `README.md`.
8. Manual smoke test: default (ayu) + `PI_STATUSLINE_PRESET=tokyo-night` + `=classic`.
