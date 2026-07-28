# Statusline Ayu Preset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy `pi-inline-statusline` v0.17.1 into the monorepo as `packages/statusline/` and add a third self-contained preset `ayu` (Ayu Dark hexes, mirror of tokyo-night's block architecture), set as the default preset.

**Architecture:** The `ayu` preset is a structural twin of `tokyo-night.ts` — same `░▒▓`/`` block architecture, only the `AYU_COLORS` constant differs. The shared block-name type is renamed `TokyoNightBlockName` → `BlockName`. Two dispatch sites (`renderSegments` switch in `src/render.ts`, `extensionStatusSeparator` in `src/extension-status.ts`) gain an `ayu` branch. `DEFAULT_PRESET` flips from `"tokyo-night"` to `"ayu"`.

**Tech Stack:** TypeScript (ES2022, NodeNext modules), `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` (peer deps, resolved via pi's bundled core), `node --test` + `tsx` for tests, `tsc --noEmit` for typecheck, `biome` for lint.

**Spec:** `docs/superpowers/specs/2026-07-28-statusline-ayu-preset-design.md`

## Global Constraints

- Upstream source is the shallow clone at `/tmp/pi-inline-statusline-inspect/` (v0.17.1, commit `8ee7033`). Copy from there.
- All new code uses `@earendil-works/*` imports (the upstream already does — no import rewrites needed).
- ESM relative imports use `.js` extensions (e.g. `./ansi.js`) — match the existing style in `tokyo-night.ts`.
- Indent with tabs (match upstream `biome.json` and existing files).
- The `ayu` preset is self-contained: hardcoded hexes, does NOT read the active pi `Theme`. The `_theme` param on `ayuExtensionSeparator` is intentionally unused (mirrors `tokyoNightExtensionSeparator`).
- Ayu Dark hexes come from `packages/ayu/themes/ayu-dark.json` in this monorepo. Exact values (verified):
  - `vars.accent` = `#ffb454`, `vars.blue` = `#39bae6`, `vars.border` = `#212b3d`, `vars.borderMuted` = `#131721`, `vars.dimGray` = `#68718a`
  - `export.pageBg` = `#0a0e14`, `export.cardBg` = `#0d1017`
- All commands run from `packages/statusline/` unless noted. Root repo is at `/Users/jstegeman/orca/workspaces/pi-packages/consolidation`.
- Commit after each task. Branch is `johnstegeman/consolidation` (already current — do NOT create a new branch).

---

## Task 1: Copy upstream package into the monorepo

**Files:**
- Create: `packages/statusline/` (entire directory tree from upstream, minus `package-lock.json` and `.git/`)

**Interfaces:**
- Consumes: upstream source at `/tmp/pi-inline-statusline-inspect/`
- Produces: a loadable `packages/statusline/` package whose `pi.extensions` entry `./src/statusline.ts` resolves. No behavior change yet — this is a verbatim copy.

- [ ] **Step 1: Copy the upstream tree, excluding `package-lock.json` and `.git/`**

Run from repo root:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
rsync -a --exclude='package-lock.json' --exclude='.git' --exclude='node_modules' \
  /tmp/pi-inline-statusline-inspect/ packages/statusline/
```

- [ ] **Step 2: Verify the copy is complete and clean**

Run:

```bash
ls packages/statusline/
# Expect: LICENSE  README.md  README.zh-CN.md  biome.json  package.json  presets  src  test  tsconfig.json
ls packages/statusline/presets/
# Expect: ansi.ts  classic.ts  tokyo-night.ts  types.ts
ls packages/statusline/src/
# Expect: extension-status.ts  git-status.ts  render.ts  settings.ts  statusline.ts
ls packages/statusline/test/
# Expect: statusline.test.ts  support.ts
test ! -e packages/statusline/package-lock.json && echo "no lockfile (correct)"
```

Expected: all listings match; "no lockfile (correct)" printed.

- [ ] **Step 3: Register the extension in the root `package.json`**

Modify `/Users/jstegeman/orca/workspaces/pi-packages/consolidation/package.json`. The current `pi.extensions` array (line 12) is `["./packages/bifrost/index.ts"]`. Replace it with:

```json
    "extensions": [
      "./packages/bifrost/index.ts",
      "./packages/statusline/src/statusline.ts"
    ],
```

- [ ] **Step 4: Update the root `README.md` package list**

Modify `/Users/jstegeman/orca/workspaces/pi-packages/consolidation/README.md` lines 8-11. The current block is:

```
packages/
├── ayu/       – Ayu color scheme for Pi (Day, Dusk, Dark)
└── bifrost/   – Custom provider for Bifrost AI gateway
```

Replace with (note the trailing comma on `bifrost` now):

```
packages/
├── ayu/         – Ayu color scheme for Pi (Day, Dusk, Dark)
├── bifrost/     – Custom provider for Bifrost AI gateway
└── statusline/  – Single-line statusline footer with ayu/tokyo-night/classic presets
```

- [ ] **Step 5: Verify the extension loads in pi**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
pi --no-session -p "statusline extension loaded" 2>&1 | grep -i "statusline\|extension" | head
```

Expected: startup output shows `pi-inline-statusline` (or `statusline`) in the loaded extensions list with no load error. (If pi can't resolve the path, fix the `pi.extensions` entry before proceeding — the path is relative to repo root.)

- [ ] **Step 6: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
git add packages/statusline package.json README.md
git commit -m "feat(statusline): copy pi-inline-statusline v0.17.1 into monorepo"
```

---

## Task 2: Rename `TokyoNightBlockName` → `BlockName`

**Files:**
- Modify: `packages/statusline/presets/types.ts:19,38`
- Modify: `packages/statusline/presets/tokyo-night.ts:4,6-8,26,64,65,78,86`
- Modify: `packages/statusline/src/render.ts:17`

**Interfaces:**
- Consumes: none (first task to touch these files).
- Produces: `export type BlockName = "header" | "directory" | "git" | "runtime" | "meter"` in `presets/types.ts`; `RenderSegment.block: BlockName`. Later tasks import `BlockName` (not `TokyoNightBlockName`).

No behavior change. Mechanical rename to make the block concept neutral before `ayu.ts` reuses it.

- [ ] **Step 1: Rename in `presets/types.ts`**

Modify `packages/statusline/presets/types.ts`:

Line 19 — change:
```ts
export type TokyoNightBlockName = "header" | "directory" | "git" | "runtime" | "meter";
```
to:
```ts
export type BlockName = "header" | "directory" | "git" | "runtime" | "meter";
```

Line 38 — change:
```ts
	block: TokyoNightBlockName;
```
to:
```ts
	block: BlockName;
```

- [ ] **Step 2: Rename in `presets/tokyo-night.ts`**

Modify `packages/statusline/presets/tokyo-night.ts`:

Line 4 — change:
```ts
import type { RenderSegment, TokyoNightBlockName } from "./types.js";
```
to:
```ts
import type { BlockName, RenderSegment } from "./types.js";
```

Lines 6-8 — change the interface name and field type:
```ts
interface TokyoNightBlock {
	name: TokyoNightBlockName;
	segments: RenderSegment[];
}
```
to:
```ts
interface Block {
	name: BlockName;
	segments: RenderSegment[];
}
```

Line 26 — change:
```ts
const TOKYO_NIGHT_BLOCK_ORDER: TokyoNightBlockName[] = [
```
to:
```ts
const TOKYO_NIGHT_BLOCK_ORDER: BlockName[] = [
```

Line 64 — change:
```ts
function groupTokyoNightBlocks(segments: RenderSegment[]): TokyoNightBlock[] {
```
to:
```ts
function groupTokyoNightBlocks(segments: RenderSegment[]): Block[] {
```

Line 65 — change:
```ts
	const blocksByName = new Map<TokyoNightBlockName, RenderSegment[]>();
```
to:
```ts
	const blocksByName = new Map<BlockName, RenderSegment[]>();
```

Line 78 — change:
```ts
function formatTokyoNightBlockText(block: TokyoNightBlock): string {
```
to:
```ts
function formatTokyoNightBlockText(block: Block): string {
```

Line 86 — change:
```ts
function getTokyoNightBlockColors(block: TokyoNightBlockName): BlockColors {
```
to:
```ts
function getTokyoNightBlockColors(block: BlockName): BlockColors {
```

- [ ] **Step 3: Rename the import in `src/render.ts`**

Modify `packages/statusline/src/render.ts` line 17 — change:
```ts
	TokyoNightBlockName,
```
to:
```ts
	BlockName,
```

(This is inside the `import type { PaletteName, RenderSegment, SegmentName, StatuslineConfig, TokyoNightBlockName } from "../presets/types.js";` block. `BlockName` is not otherwise referenced in `render.ts`, so the import is now type-only and unused until Task 4 — but `tsc` with `strict` does not error on unused type imports. If a later typecheck flags it, Task 4 re-adds usage. Keep the import; it's correct for the final state.)

- [ ] **Step 4: Verify the rename compiles**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation/packages/statusline
npm install
npm run typecheck
```

Expected: `tsc --noEmit` passes with no errors. (If `npm install` fails because `@earendil-works/pi-coding-agent@0.80.3` / `pi-tui@0.80.3` devDeps can't resolve, that's fine for typecheck purposes — `skipLibCheck: true` is set and the peer types resolve through the global pi. If typecheck still fails on missing core types, run `npx tsc --noEmit` after ensuring the global pi's node_modules is discoverable; the upstream `tsconfig.json` already targets NodeNext. Do NOT proceed until typecheck is green.)

- [ ] **Step 5: Run the existing test suite to confirm no behavior change**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation/packages/statusline
npm test
```

Expected: all tests pass (same as upstream — this is a pure rename).

- [ ] **Step 6: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
git add packages/statusline/presets/types.ts packages/statusline/presets/tokyo-night.ts packages/statusline/src/render.ts
git commit -m "refactor(statusline): rename TokyoNightBlockName to BlockName"
```

---

## Task 3: Add `presets/ayu.ts`

**Files:**
- Create: `packages/statusline/presets/ayu.ts`

**Interfaces:**
- Consumes: `BlockName`, `RenderSegment` from `./types.js` (produced in Task 2); `ansiFg`, `ansiStyle` from `./ansi.js`; `truncateToWidth` from `@earendil-works/pi-tui`; `Theme` from `@earendil-works/pi-coding-agent`.
- Produces: `renderAyuStatusline(width: number, segments: RenderSegment[]): string`, `renderAyuSegments(segments: RenderSegment[]): string`, `ayuExtensionSeparator(_theme: Theme): string`. Task 4 imports these.

Structural twin of `tokyo-night.ts` with `AYU_COLORS` swapped in. Same block order, same glyphs, same logic.

- [ ] **Step 1: Write `presets/ayu.ts`**

Create `packages/statusline/presets/ayu.ts` with this exact content:

```ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ansiFg, ansiStyle } from "./ansi.js";
import type { BlockName, RenderSegment } from "./types.js";

interface Block {
	name: BlockName;
	segments: RenderSegment[];
}

interface BlockColors {
	fg: string;
	bg: string;
}

const AYU_COLORS = {
	lead: "#ffb454",
	header: { fg: "#0a0e14", bg: "#ffb454" },
	directory: { fg: "#0a0e14", bg: "#39bae6" },
	git: { fg: "#39bae6", bg: "#212b3d" },
	runtime: { fg: "#ffb454", bg: "#131721" },
	meter: { fg: "#68718a", bg: "#0d1017" },
	extensionSeparator: "#212b3d",
} as const satisfies Record<string, string | BlockColors>;

const AYU_BLOCK_ORDER: BlockName[] = [
	"header",
	"directory",
	"git",
	"runtime",
	"meter",
];

export function renderAyuStatusline(width: number, segments: RenderSegment[]): string {
	return truncateToWidth(renderAyuSegments(segments), width, "");
}

export function renderAyuSegments(segments: RenderSegment[]): string {
	return joinAyuSegments(segments);
}

export function ayuExtensionSeparator(_theme: Theme): string {
	return ansiFg(AYU_COLORS.extensionSeparator, " • ");
}

function joinAyuSegments(segments: RenderSegment[]): string {
	const blocks = groupAyuBlocks(segments);
	let line = ansiFg(AYU_COLORS.lead, "░▒▓");

	for (const [index, block] of blocks.entries()) {
		const colors = getAyuBlockColors(block.name);
		const previous =
			index === 0 ? undefined : getAyuBlockColors(blocks[index - 1]?.name ?? "header");
		if (previous) line += ansiStyle("", { fg: previous.bg, bg: colors.bg });
		line += ansiStyle(formatAyuBlockText(block), colors);
	}

	const lastBlock = blocks.at(-1);
	if (lastBlock) line += ansiFg(getAyuBlockColors(lastBlock.name).bg, "");

	return line;
}

function groupAyuBlocks(segments: RenderSegment[]): Block[] {
	const blocksByName = new Map<BlockName, RenderSegment[]>();
	for (const segment of segments) {
		const blockSegments = blocksByName.get(segment.block) ?? [];
		blockSegments.push(segment);
		blocksByName.set(segment.block, blockSegments);
	}

	return AYU_BLOCK_ORDER.flatMap((name) => {
		const blockSegments = blocksByName.get(name);
		return blockSegments ? [{ name, segments: blockSegments }] : [];
	});
}

function formatAyuBlockText(block: Block): string {
	return ` ${block.segments.map(formatAyuSegmentText).join(" ")}`;
}

function formatAyuSegmentText(segment: RenderSegment): string {
	return segment.emphasis ? `\u001b[1m${segment.text}\u001b[22m` : segment.text;
}

function getAyuBlockColors(block: BlockName): BlockColors {
	return AYU_COLORS[block];
}
```

Note the two intentional differences from `tokyo-night.ts`: (1) `AYU_COLORS` values per the spec's color table; (2) the block-order/color constant names use `AYU_*`. Everything else (the `""` powerline glyph, the `░▒▓` lead, the `join`/`group`/`format` logic) is identical.

- [ ] **Step 2: Verify it typechecks**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation/packages/statusline
npm run typecheck
```

Expected: passes. `AYU_COLORS` is `as const satisfies Record<string, string | BlockColors>`, so `AYU_COLORS[block]` returns `string | BlockColors` — but `getAyuBlockColors` annotates its return as `BlockColors`, and every block key (`header`/`directory`/`git`/`runtime`/`meter`) maps to a `BlockColors` value, so the indexed access typechecks. (This mirrors `tokyo-night.ts` exactly, which compiles the same way.)

- [ ] **Step 3: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
git add packages/statusline/presets/ayu.ts
git commit -m "feat(statusline): add ayu preset (Ayu Dark, mirror of tokyo-night)"
```

---

## Task 4: Wire the `ayu` preset into dispatch sites

**Files:**
- Modify: `packages/statusline/presets/types.ts:18`
- Modify: `packages/statusline/src/render.ts:11,138-143`
- Modify: `packages/statusline/src/extension-status.ts:7,33-37`

**Interfaces:**
- Consumes: `renderAyuSegments` from `../presets/ayu.js` (Task 3), `ayuExtensionSeparator` from `../presets/ayu.js` (Task 3), `StatuslinePresetName` (extended here).
- Produces: `StatuslinePresetName` now includes `"ayu"`; both dispatch switches handle it. The preset is selectable but not yet default (Task 5 flips the default).

- [ ] **Step 1: Extend `StatuslinePresetName`**

Modify `packages/statusline/presets/types.ts` line 18 — change:
```ts
export type StatuslinePresetName = "classic" | "tokyo-night";
```
to:
```ts
export type StatuslinePresetName = "classic" | "tokyo-night" | "ayu";
```

- [ ] **Step 2: Add the `ayu` import and case in `src/render.ts`**

Modify `packages/statusline/src/render.ts`:

After line 11 (`import { renderTokyoNightSegments } from "../presets/tokyo-night.js";`), add:
```ts
import { renderAyuSegments } from "../presets/ayu.js";
```

In the `renderSegments` switch (lines 138-143), add the `ayu` case. The switch becomes:
```ts
function renderSegments(segments: RenderSegment[], theme: Theme, config: StatuslineConfig): string {
	switch (config.preset) {
		case "classic":
			return renderClassicSegments(segments, theme, config);
		case "tokyo-night":
			return renderTokyoNightSegments(segments);
		case "ayu":
			return renderAyuSegments(segments);
	}
}
```

- [ ] **Step 3: Add the `ayu` import and branch in `src/extension-status.ts`**

Modify `packages/statusline/src/extension-status.ts`:

After line 7 (`import { tokyoNightExtensionSeparator } from "../presets/tokyo-night.js";`), add:
```ts
import { ayuExtensionSeparator } from "../presets/ayu.js";
```

Replace the `extensionStatusSeparator` function (lines 33-37) — currently a ternary:
```ts
function extensionStatusSeparator(presetName: StatuslinePresetName, theme: Theme): string {
	return presetName === "classic"
		? classicExtensionSeparator(theme)
		: tokyoNightExtensionSeparator(theme);
}
```
with a three-way switch:
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

- [ ] **Step 4: Typecheck (exhaustiveness is now enforced)**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation/packages/statusline
npm run typecheck
```

Expected: passes. If either switch is missing the `ayu` case, `tsc` fails (the function has no `default` and must return `string` for every union member). This is the type-level guarantee the spec relies on.

- [ ] **Step 5: Run tests (still green — preset not yet selected by default)**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation/packages/statusline
npm test
```

Expected: all pass. `DEFAULT_PRESET` is still `"tokyo-night"`, so existing tests render via tokyo-night as before.

- [ ] **Step 6: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
git add packages/statusline/presets/types.ts packages/statusline/src/render.ts packages/statusline/src/extension-status.ts
git commit -m "feat(statusline): wire ayu preset into render and separator dispatch"
```

---

## Task 5: Flip `DEFAULT_PRESET` to `"ayu"` and extend the env validator

**Files:**
- Modify: `packages/statusline/src/settings.ts:19,248`

**Interfaces:**
- Consumes: `StatuslinePresetName` (now includes `"ayu"` from Task 4).
- Produces: `DEFAULT_PRESET = "ayu"`; `readStatuslinePreset()` accepts `"ayu"` as a valid env value and returns `"ayu"` for unset/invalid env. This makes ayu the default for every install.

- [ ] **Step 1: Flip `DEFAULT_PRESET`**

Modify `packages/statusline/src/settings.ts` line 19 — change:
```ts
const DEFAULT_PRESET: StatuslinePresetName = "tokyo-night";
```
to:
```ts
const DEFAULT_PRESET: StatuslinePresetName = "ayu";
```

- [ ] **Step 2: Extend `readStatuslinePreset`**

Modify `packages/statusline/src/settings.ts` line 248 — change:
```ts
	return value === "classic" || value === "tokyo-night" ? value : DEFAULT_PRESET;
```
to:
```ts
	return value === "classic" || value === "tokyo-night" || value === "ayu" ? value : DEFAULT_PRESET;
```

- [ ] **Step 3: Typecheck**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation/packages/statusline
npm run typecheck
```

Expected: passes.

- [ ] **Step 4: Run tests (confirm they still pass with ayu as default)**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation/packages/statusline
npm test
```

Expected: all pass. The existing `footer.render()` tests use a color-stripping mock theme and assert on preset-independent emoji/segment text (`🕒`, `⚡`, `🚀`, `tok 0`, `$0.000`). With `DEFAULT_PRESET` now `"ayu"`, those renders route through `renderAyuSegments` instead of `renderTokyoNightSegments`, but the asserted substrings are identical across presets — so the tests pass unchanged. This is free coverage that ayu doesn't break basic rendering.

- [ ] **Step 5: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
git add packages/statusline/src/settings.ts
git commit -m "feat(statusline): default to ayu preset; accept PI_STATUSLINE_PRESET=ayu"
```

---

## Task 6: Add structural + preset-selection tests for `ayu`

**Files:**
- Modify: `packages/statusline/test/statusline.test.ts` (append new tests)

**Interfaces:**
- Consumes: `renderAyuStatusline`, `renderAyuSegments`, `ayuExtensionSeparator` from `../presets/ayu.js` (Task 3); `visibleWidth` from `@earendil-works/pi-tui` (already imported in the test file, line 15); `createMockPi`, `createMockContext` from `./support.js` (already imported); `statusline` from `../src/statusline.js` (already imported).
- Produces: three new `test(...)` blocks verifying ayu render structure, the separator color, and env-driven preset selection.

The upstream test file has zero preset-specific render tests and never imports the preset renderers directly. These are net-new.

- [ ] **Step 1: Add the ayu render + separator structural test**

In `packages/statusline/test/statusline.test.ts`, add a new import after the existing `import { visibleWidth } from "@earendil-works/pi-tui";` (line 15):

```ts
import { ayuExtensionSeparator, renderAyuSegments, renderAyuStatusline } from "../presets/ayu.js";
```

Then append this test at the end of the file:

```ts
test("ayu preset renders the ░▒▓ lead,  powerline joins, and block text in Ayu Dark colors", () => {
	const segments: RenderSegment[] = [
		{ name: "brand", text: "π", color: "accent", block: "header", emphasis: true },
		{ name: "model", text: "🤖 sonnet", color: "accent", block: "header" },
		{ name: "cwd", text: "📁 repo", color: "accent", block: "directory" },
		{ name: "branch", text: "🌿 main", color: "accent", block: "git" },
		{ name: "tools", text: "⚙ read", color: "accent", block: "runtime" },
		{ name: "cost", text: "💸 $0.001", color: "accent", block: "meter" },
	];

	const rendered = renderAyuSegments(segments);

	// Lead glyph in Ayu accent (#ffb454).
	assert.match(rendered, /░▒▓/u);
	assert.ok(rendered.includes("\u001b[38;2;255;180;84m"), "lead uses Ayu accent #ffb454");

	//  powerline separator between blocks.
	assert.ok(rendered.includes(""), "powerline  glyph present between blocks");

	// Header block text and directory block text appear.
	assert.ok(rendered.includes("π"));
	assert.ok(rendered.includes("🤖 sonnet"));
	assert.ok(rendered.includes("📁 repo"));

	// Directory block bg is Ayu blue (#39bae6).
	assert.ok(
		rendered.includes("\u001b[48;2;57;186;230m"),
		"directory block bg uses Ayu blue #39bae6",
	);
});

test("ayu render truncates to the requested width", () => {
	const segments: RenderSegment[] = [
		{ name: "brand", text: "π", color: "accent", block: "header", emphasis: true },
		{ name: "model", text: "🤖 a-very-long-model-name-that-exceeds-width", color: "accent", block: "header" },
	];

	const rendered = renderAyuStatusline(20, segments);
	assert.ok(visibleWidth(rendered) <= 20, `width ${visibleWidth(rendered)} <= 20`);
});

test("ayuExtensionSeparator returns • colored with the Ayu border hex", () => {
	const theme = { fg: (_c: string, t: string) => t } as never;
	const sep = ayuExtensionSeparator(theme);

	assert.ok(sep.includes(" • "), "separator text is • surrounded by spaces");
	// #212b3d -> RGB 33,43,61 -> ANSI truecolor fg code 38;2;33;43;61
	assert.ok(
		sep.includes("\u001b[38;2;33;43;61m"),
		"separator color is Ayu border #212b3d",
	);
});
```

The `RenderSegment` type is needed for the array annotations. Add it to the existing type import from `../src/statusline.js` — but `RenderSegment` is not re-exported from `statusline.js`. Instead import it from the presets types module. Add after the `ayu` import:

```ts
import type { RenderSegment } from "../presets/types.js";
```

- [ ] **Step 2: Add the env-driven preset-selection test**

Append this test (behavioral — sets `PI_STATUSLINE_PRESET`, renders via the mock footer, asserts the output shape):

```ts
test("preset selection honors PI_STATUSLINE_PRESET and defaults to ayu", async () => {
	const previousPreset = process.env.PI_STATUSLINE_PRESET;
	const mock = createMockPi();
	(mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => ({
		stdout: "## main\n",
		stderr: "",
		code: 0,
		killed: false,
	});

	const renderForPreset = async (preset: string | undefined) => {
		if (preset === undefined) delete process.env.PI_STATUSLINE_PRESET;
		else process.env.PI_STATUSLINE_PRESET = preset;

		statusline(mock.pi);
		const context = createMockContext({ mode: "tui" });
		await emit(mock.events, "session_start", {}, context.ctx);

		const footerFactory = context.footer as (
			tui: { requestRender(): void },
			theme: { fg(_color: string, text: string): string; bold(text: string): string },
			footerData: {
				getGitBranch(): string | null;
				getExtensionStatuses(): ReadonlyMap<string, string>;
				onBranchChange(callback: () => void): () => void;
			},
		) => { render(width: number): string[]; dispose(): void };
		const footer = footerFactory(
			{ requestRender() {} },
			{ fg: (_color, text) => text, bold: (text) => text },
			{
				getGitBranch: () => "main",
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => undefined,
			},
		);
		const out = footer.render(200).join("\n");
		footer.dispose();
		return out;
	};

	try {
		// Unset env -> ayu (default) -> powerline lead present.
		const ayuDefault = await renderForPreset(undefined);
		assert.match(ayuDefault, /░▒▓/u);

		// Explicit ayu -> same.
		const ayuExplicit = await renderForPreset("ayu");
		assert.match(ayuExplicit, /░▒▓/u);

		// Explicit tokyo-night -> powerline lead present (tokyo-night also uses ░▒▓).
		const tokyo = await renderForPreset("tokyo-night");
		assert.match(tokyo, /░▒▓/u);

		// classic -> no powerline lead; uses • separators.
		const classic = await renderForPreset("classic");
		assert.equal(classic.includes("░▒▓"), false);
		assert.ok(classic.includes("•"));

		// Invalid value -> falls back to ayu default.
		const garbage = await renderForPreset("garbage");
		assert.match(garbage, /░▒▓/u);
	} finally {
		if (previousPreset === undefined) delete process.env.PI_STATUSLINE_PRESET;
		else process.env.PI_STATUSLINE_PRESET = previousPreset;
	}
});
```

Note: `ExecResult` is already defined as a local type at the top of the test file (line 52: `type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };`). The `emit` helper is already defined (line 44). Reuse them — do not redefine.

- [ ] **Step 3: Run the full test suite**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation/packages/statusline
npm test
```

Expected: all tests pass, including the four new ones. If a structural assertion fails (e.g. an ANSI code doesn't match), debug by printing the rendered string — the hex→RGB math is: `#ffb454` = 255,180,84; `#39bae6` = 57,186,230; `#212b3d` = 33,43,61. Double-check against `AYU_COLORS` in `presets/ayu.ts`.

- [ ] **Step 4: Typecheck**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation/packages/statusline
npm run typecheck
```

Expected: passes (the `tsconfig.json` `include` covers `test/**/*.ts`).

- [ ] **Step 5: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
git add packages/statusline/test/statusline.test.ts
git commit -m "test(statusline): add ayu render, separator, and preset-selection tests"
```

---

## Task 7: Update the subpackage `README.md` Presets section

**Files:**
- Modify: `packages/statusline/README.md:71-83`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Rewrite the Presets section**

Modify `packages/statusline/README.md`. Replace lines 71-83 (the `## Presets` section through the "Unset or invalid values fall back" line) with:

````markdown
## Presets

`pi-inline-statusline` supports presets through the `PI_STATUSLINE_PRESET` environment variable:

```bash
PI_STATUSLINE_PRESET=ayu pi
PI_STATUSLINE_PRESET=tokyo-night pi
PI_STATUSLINE_PRESET=classic pi
```

Supported presets:

- `ayu` — the default, an Ayu Dark color scheme using `░▒▓` / `` powerline blocks. Colors are drawn from this monorepo's `ayu` theme (Ayu Dark variant). Self-contained: it does not read the active pi theme.
- `tokyo-night` — inspired by the [Starship Tokyo Night preset](https://starship.rs/presets/tokyo-night), using `░▒▓` / `` powerline blocks and the Tokyo Night color ramp.
- `classic` — a compact Pi-themed statusline with left-aligned `•` separators. This is the only preset that reads the active pi theme's semantic colors.

Unset or invalid values fall back to `ayu`. All presets keep the same emoji-labeled information.
````

(Keep the existing `## Extension Status Icons` section that follows unchanged.)

- [ ] **Step 2: Commit**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
git add packages/statusline/README.md
git commit -m "docs(statusline): document ayu preset as the default"
```

---

## Task 8: Manual smoke test

**Files:** none (verification only).

- [ ] **Step 1: Smoke test the default (ayu) preset**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
unset PI_STATUSLINE_PRESET
pi
```

Expected: the footer statusline renders with Ayu Dark colors — orange/accent lead `░▒▓`, an orange header block, a blue directory block, then dark git/runtime/meter blocks joined by `` powerline glyphs. Exit pi (`Ctrl+C` or `/quit`).

- [ ] **Step 2: Smoke test `tokyo-night` still renders**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
PI_STATUSLINE_PRESET=tokyo-night pi
```

Expected: footer renders in the original Tokyo Night colors (purple-ish lead/blocks). Exit pi.

- [ ] **Step 3: Smoke test `classic` still renders**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation
PI_STATUSLINE_PRESET=classic pi
```

Expected: footer renders with `•` separators, colors from the active pi theme. Exit pi.

- [ ] **Step 4: Final verification — full test + typecheck**

Run:

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/consolidation/packages/statusline
npm run typecheck && npm test
```

Expected: both green. The monorepo consolidation is complete.
