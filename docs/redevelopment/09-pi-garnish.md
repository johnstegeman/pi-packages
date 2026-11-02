# 09 — pi-garnish: feature inventory (ayu + statusline)

Source: `packages/ayu/` (pi-ayu 0.1.0 — pure data, three JSON theme files) and
`packages/statusline/` (pi-inline-statusline 0.17.1, forked from upstream;
README.zh-CN.md is the upstream translation). Destination repo:
**pi-garnish** — https://github.com/johnstegeman/pi-garnish. Port posture:
**ayu as-is 100%; statusline as-is except jj support** (Part 3).

## 1. ayu — ports byte-for-byte

The entire package is `package.json` + README + `themes/{ayu-day,ayu-dusk,
ayu-dark}.json`. No source, tests, or lockfile. `pi.themes: ["./themes"]`
(directory manifest — pi loads every `*.json`). Theme ids `ayu-day` /
`ayu-dusk` / `ayu-dark` (referenced by user settings `{"theme": "ayu-dark"}`).

**Theme file format** (validated against pi's theme-schema): `$schema`,
`name`, `vars` (named hex colors + one indirection: `"muted": "dimGray"` —
the only non-hex value), `colors` (semantic map; each value is a var name or
literal hex; **keys and var-references are identical across all three
variants** — only the literal syntax hexes differ), `export` (three extra
hexes: `pageBg`, `cardBg`, `infoBg`).

- Var palettes per variant are recorded in full in the exploration output
  (accent `#ff9940`/`#ffb454`/`#ffb454`, blue `#55b4d4`/`#39bae6`/`#39bae6`,
  text `#5c6166`/`#bfccdc`/`#bfccdc`, borders/selected/message/tool
  backgrounds per variant, …) — the port copies the three JSON files
  verbatim, so the values travel with the files.
- Literal syntax colors (`syntaxComment/Keyword/Function/Variable/String/
  Number/Type/Operator/Punctuation`) differ per variant.
- **Dusk vs Dark are near-twins**: only `name`, `customMsgBg`, `cyan`,
  `selectedBg`, `toolPendingBg`, `toolSuccessBg`, `userMsgBg`, `border`,
  `borderMuted`, and the three `export` hexes differ; all syntax colors are
  identical. (Useful when adding a future variant.)

**ayu ↔ statusline coupling**: no runtime coupling — the statusline's `ayu`
preset hardcodes Ayu Dark hexes and does not read the pi theme. The
deliberate mapping (from the 2026-07-28 design spec) to carry into
pi-garnish's docs since both halves now share a repo:
lead `░▒▓` = accent `#ffb454`; header fg/bg = `export.pageBg`/`accent`;
directory = `pageBg`/`blue #39bae6`; git = `blue`/`border #212b3d`; runtime =
`accent`/`borderMuted #131721`; meter = `dimGray #68718a`/`cardBg #0d1017`;
extension separator = `border #212b3d`.

## 2. statusline — everything except the git parts

### Extension points (exact)

Entry `export default function statusline(pi: ExtensionAPI)`; uses
`pi.registerCommand("statusline", …)`; `pi.on` for `session_start` (settings
notice, `pi.getThinkingLevel()`, installFooter), `session_tree`,
`session_shutdown` (generation bump, teardown, footer/status cleared),
`model_select`, `thinking_level_select`, `agent_start`/`agent_end`,
`turn_start`/`turn_end`, `message_update` (TTFT on
text/thinking/toolcall deltas), `tool_execution_start`/`end`;
`pi.exec(command, args, {cwd, timeout})` — the only spawn path (git);
`pi.getThinkingLevel()` (session_start only — not at load, test-pinned);
`ctx.ui.setFooter(factory)` (`{dispose, invalidate, render(width): string[]}`;
subscribes `footerData.onBranchChange`; starts the clock),
`ctx.ui.setStatus("statusline", …)`, `ctx.ui.notify`,
`ctx.ui.custom` (segment selector built from pi-tui `Container`/`Text`/
`SettingsList`), `ctx.mode` ("tui" vs "print" — git refresh + selector are
TUI-only), `ctx.cwd`, `ctx.model?.id`, `ctx.getContextUsage()`,
`ctx.sessionManager.getBranch()`;
`FooterDataProvider` (`getGitBranch()`, `getExtensionStatuses()`,
`onBranchChange`); theme API `theme.fg(color, text)` / `theme.bold`;
pi-tui utils `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`;
`getAgentDir()`.

### Segments (exact text/format)

Blocks `header | directory | git | runtime | meter`. `brand` → `π`
(accent, bold). `model` → `🤖 <shortenModel>` (strip before last `/`,
`^claude-`, `^gpt-`→`gpt `, `-20\d{6}$`, `-latest$`). `thinking` →
`🧠 <level>` (per-level theme colors). `cwd` → `📁 <basename>`. `branch` →
`formatGitBranchText(...)` — **the jj-sensitive segment**. `tools` →
priority `⚙ <name>×N` / `⚙ <name>+<extra>` → `💭 thinking` → `✅
<lastCompletedTool>` → `💤 idle`. `context` → `🪟 ctx ?` (dim) or `🪟 ctx
N%` (≥90 error, ≥70 warning, else success). `tokens` → `🔢 tok 0` or `🔢
↑<in> ↓<out>` (session-branch usage totals; formatCount: <10k → `X.Xk`,
<1M → `Xk`, else `X.Xm`). `cost` → `💸 $X.XX` (2dp ≥$1 else 3dp). `time` →
`🕒 HH:MM` local. `turn` → `🔁 #N` (**hidden by default**). `ttft` → `⚡
TTFT Xms/X.Xs`. `speed` → `🚀 X.Xtok/s` (output tokens / time-since-first-token).

Palettes (rotating per segment): `ocean`, `sunset`, `forest`, `candy`
(**hardcoded default**), `neon`, `mono`. Hardcoded defaults: `density
"compact"`, `separator "dot"`, `showLabels false` — only `preset` (env) and
`segments` + `extensionStatusIcons` (settings file) are user-controllable.

**Canonical order** `ALL_SEGMENTS = [brand, model, thinking, cwd, branch,
tools, context, tokens, cost, time, ttft, speed, turn]`;
**DEFAULT_SEGMENTS = all except `turn`**.

### Presets

- **`ayu` (default)** — blocks rendered in fixed order with lead `░▒▓`
  (`#ffb454`), per-block `ansiStyle` fg/bg, rounded powerline joins
  `\ue0b4` (fg = prev bg, bg = next bg), trailing `\ue0b4`. Exact hexes in
  §1's mapping table.
- **`tokyo-night`** — identical architecture; lead `#a3aed2`, header
  `#090c0c`/`#a3aed2`, directory `#e3e5e5`/`#769ff0`, git
  `#769ff0`/`#394260`, runtime `#769ff0`/`#212736`, meter
  `#a0a9cb`/`#1d2230`, separator `#394260`.
- **`classic`** — the only theme-aware preset (`theme.fg`/`theme.bold`;
  mono-palette special case); separators `dot " • "` / `bar " │ "` /
  `powerline "  "` / `round " ❯ "` / `none " "`; `cozy` density pads.
- `presets/ansi.ts`: truecolor `ansiStyle`/`ansiFg` (38;2/48;2 SGR).
- **Preset selection: env `PI_STATUSLINE_PRESET` only** (classic |
  tokyo-night | ayu; anything else → `ayu`). Read once at load; never
  persisted.

### `/statusline` command

No args → interactive segment selector (TUI-only; `SettingsList` with
enabled/disabled items + Reset defaults; `"/statusline requires TUI mode"`
otherwise). `list` → `✓`/`  ` per segment. `reset` → removes the `segments`
key. `on|off <segment>` → unknown-segment warning
(`Unknown segment "<name>". Run /statusline list to see all segments.`),
persist + notify, save-failure error string. Argument completions for both
positions.

### Settings model (`<getAgentDir()>/pi-statusline.json`)

Schema: `{ extensionStatusIcons?: {<key>: <icon, "" suppresses>},
segments?: [...] }`. Unknown keys **preserved** on write (test-pinned).
Invalid file → defaults + queued notice (warned at next session_start).
Segments normalized: filter valid, dedupe, **reorder to canonical order**.
**Atomic writes** (temp `wx` + rename + cleanup). Read once at load; written
only by the command. **Legacy migration** from `pi-statusline-settings.json`
(atomic install via temp+`linkSync`, identity check, re-read verification,
elaborate concurrency handling, failure notices). Live file on this machine
hides `time`/`ttft`/`speed`.

### Git status logic (the port target — current state)

- Command: `pi.exec("git", ["--no-optional-locks", "status",
  "--porcelain=v1", "--branch", "--untracked-files=normal"], {cwd, timeout:
  3000})` → undefined on non-zero/killed/timeout.
- `GitStatusSummary = {ahead, behind, staged, modified, untracked,
  conflicts}`. Porcelain parsing: `## ` header → ahead/behind regexes;
  `??` → untracked; conflicts `(D,D)|(A,A)|U*` (precedence over counters);
  staged = any non-blank/non-`?`/non-`!` index code; modified = same for the
  worktree column (deleted counts as "modified" — `~` documented as
  "modified or deleted"). Detached HEAD → no tracking line → ahead/behind 0
  (branch string is pi core's). Renames/copies count as staged only.
- `formatGitStatusSummary`: tokens `⇡ ahead, ⇣ behind, + staged, ~ modified,
  ? untracked, ! conflicts`, compact `Intl.NumberFormat`, empty when clean.
- `formatGitBranchText`: `null` → `🌿 no-git`; else `🌿 <branch>` + tokens +
  optional ` (<pr-link>)` — the PR link is the raw OSC 8 hyperlink extracted
  from the `github-pr` extension status (`prLinkFromStatuses` skips
  non-linked states like `PR gh missing`).
- **Refresh/lifecycle state machine (VCS-agnostic — reuse for jj)**: git is
  **never invoked during render** (test-pinned); 30 s interval clock;
  250 ms event debounce on `agent_end`/`turn_end`/`tool_execution_end`;
  branch-change → clear + immediate refresh; guards: `sessionGeneration`
  (stale installs ignored), monotonic `gitStatusRequestId` (latest wins),
  `activeGitStatusTarget` (TUI only), single-flight + pending queue;
  `gitStatusSummaryEqual` change-gating; footer `dispose()` full teardown.

### Extension-status pipeline

Sources: `footerData.getExtensionStatuses()` + FS scans of global/project
`settings.json` `packages` arrays. Duplicate-extension detection (same
package from >1 source → ⚠️ `dup <names>`). Status text simplification
(`ready`→`✓`, `missing`→`✗`, trailing `(...)` removed), color rules
(warning/error words → `warning`; `codex` → accent; ready/active words →
`success`; else muted), **cap 5 visible statuses**. Icon resolution order:
configured key (exact, `""` suppresses) → package-derived aliases
(`@vendor/pi-foo` → npm/pi/base/foo forms; ambiguous bases get no aliases)
→ leading emoji from the status text → defaults map (chrome-devtools 🌐,
codex-usage 📊, caffeinate 💊, firecrawl 🔥, github-pr 🔎, goal 🎯, lsp 🧰,
plan-mode 📝, pisync 🔄, subagents 🧑‍🤝‍🤝‍🤝… per the source; port verbatim)
→ `🔌`. `statusline` and `github-pr` keys excluded from the row (PR renders
inline in branch).

### Rendering/width

`wrapStatuslineSegments`: greedy fill, **segments never split across
lines**, single too-wide segment truncated with empty-string ellipsis (no
`…`); `mergeStatuslineLines`: extension line appended inline with `" • "` if
it fits, else rows below; extension text wraps via `wrapTextWithAnsi`.

### Packaging & tests

`pi-inline-statusline` 0.17.1 (upstream npm identity — rename for pi-garnish
is fine; the settings-file name is independent of the package name); gate =
`check` (biome + tsc + node --test); peers pi-coding-agent + **pi-tui**;
committed lockfile; ESM `.js`-suffix imports (NodeNext). Test suite
(~1,084 lines) pins everything above; **isolation**: the whole suite points
`PI_CODING_AGENT_DIR` at a temp dir via before/after hooks (a documented
repo invariant — the developer's real `pi-statusline.json` must never be
touched). Mocks: `createMockPi`/`createMockContext` + manual event emission.

## 3. jj gap analysis (the deliberate delta)

**Only the `branch` segment and its inputs are jj-sensitive** — everything
else is VCS-agnostic. Three concrete breaks under colocated jj (verified by
the 02 §6 live probe):

1. **Dirty counters dead**: autosnapshot absorbs working-copy changes into
   `@`, so `git status --porcelain` reports clean (briefly *staged*
   snapshot-vs-HEAD diffs while pending, then clean). `+ ~ ? !` never light
   up. jj has no "untracked" bucket at all (untracked-not-ignored absorbed
   into `@`; gitignored invisible) — closest concept: changed files in `@`
   vs `@-`.
2. **Branch display wrong after jj commits**: `footerData.getGitBranch()`
   is pi-core-provided and breaks when HEAD detaches (probe #6). **Decision
   (2026-11-02): don't show a branch/bookmark name at all — display the
   workspace/worktree name** (the checkout directory's basename,
   VCS-agnostic, zero commands). In the worktrunk layout the worktree name
   *is* the branch name by convention (`worktree-path = {{ repo_path }}/../{{
   branch | sanitize }}`), and under the jj hybrid the bookmark carries the
   same name — so the label stays truthful in every mode with no jj/git
   parsing. Bonus: the name doubles as the **bookmark selector** for
   ahead/behind (break #3) — the revset `<name>@origin..<name>` needs no
   bookmark discovery. Note the label then matches the `cwd` segment's
   basename (already redundant today in wt-managed repos, where dir name ==
   branch) — users hide one of the two, or the segments merge.
3. **Ahead/behind wrong**: no upstream tracking pair once HEAD detaches →
   silently 0. Correct quantity: **bookmark vs its remote target**
   (`main` vs `main@origin`) — from `jj bookmark list` or counted revsets
   `main@origin..main` / `main..main@origin`.

**jj command replacements**: dirty state via `jj diff --summary` (per-file
A/M/D/R lines vs `@-`; map adds→`+`, modifications/deletes→`~`; conflicts via
the summary's conflict marker — probe the exact form against jj 0.46) or
`jj st` (richer, also snapshots); ahead/behind via counted revsets
`<name>@origin..<name>` / `<name>..<name>@origin` where `<name>` is the
worktree name (no bookmark parsing needed for the label).

**Dual-mode detection (the one deliberate fallback-by-design)**: detect repo
kind cheaply (`.jj` at/above cwd = jj; `.git` as dir **or file** = plain
git). Route: jj → jj reader; plain git → the existing porcelain path
**byte-identical** (add an orthogonal reader, don't rewrite). Keep failure
semantics (non-zero/timeout/missing binary → `undefined` → branch-only or
`🌿 no-git`). Reuse the entire refresh state machine; only `readGitStatus`
forks into `readJjStatus` / dual dispatch (the branch label is now the
worktree name in both modes — no label forking at all; whether plain-git
mode keeps showing the git branch for non-wt repos or also shows the dir
name for uniformity is a small open design choice).
moves — jj commits move `@` without touching HEAD, so the 30 s clock +
turn-end debounces are the reliable triggers (and `jj` commands themselves
snapshot, so each refresh sees fresh state).

## 4. Preserve-exactly checklist

**ayu**: three JSONs verbatim (all hexes, var names, the `muted→dimGray`
indirection, key order), directory manifest, theme ids.

**statusline**: every segment's exact emoji/text/format; `ALL_SEGMENTS`
order + default-except-`turn`; all `/statusline` strings; the settings
schema + atomic writes + legacy migration + notices; `PI_STATUSLINE_PRESET`
(default `ayu`); all preset hex constants + glyphs (`░▒▓`, `\ue0b4`,
separators); palettes; wrap/merge/truncate rules (no `…`); the
extension-status pipeline (icons, aliases, defaults, 5-cap, PR-link
extraction); the refresh state machine with exact constants (30 000 /
250 / 3 000 ms); the public export surface (the re-export list from
`src/statusline.ts`); the test suite incl. the `PI_CODING_AGENT_DIR`
isolation; biome/tsconfig/lockfile discipline.

**Deltas for pi-garnish**: (1) root manifest moves to pi-garnish's own root
`package.json` (extensions + themes); (2) jj support per §3; (3) carry the
ayu-preset ↔ ayu-dark.json provenance mapping (§1) into pi-garnish's docs —
both halves now live in one repo, so a future ayu edit should update the
preset hexes deliberately.
