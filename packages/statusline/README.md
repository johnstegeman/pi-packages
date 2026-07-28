# pi-inline-statusline

**English** | [简体中文](./README.zh-CN.md)

A responsive statusline for the [Pi coding agent](https://pi.dev) that keeps everything on one line when space allows and wraps by complete segments when it does not.

No half-visible segments. No silently dropped context, token, cost, or extension status. Each item moves as a whole to the next line, preserving both readability and information.

```text
Wide terminal
π • model • thinking • project • branch • tools • context • tokens • cost • time • MCP

Narrow terminal
π • model • thinking • project • branch
tools • context • tokens • cost • time
MCP
```

## Why This Fork

Most statuslines either truncate the entire footer or always reserve extra lines for extension statuses. `pi-inline-statusline` uses the available terminal width instead:

- **Inline when possible**: main and extension statuses share one line when the complete result fits.
- **Segment-aware wrapping**: a model, branch, context meter, token count, or cost meter is never split across lines.
- **No information loss**: overflow moves to the next line instead of disappearing at the terminal edge.
- **Width-safe output**: every rendered line stays within the terminal's visible width, including ANSI-colored text.
- **Responsive extension statuses**: MCP and other Pi extension statuses join the last line when possible and wrap below only when necessary.

## Features

- Model and thinking level.
- Current project directory and Git branch.
- Compact Git state: ahead, behind, staged, modified, untracked, and conflicts.
- Active or most recently completed tool.
- Context-window usage, token totals, estimated cost, and clock.
- Time to first token (TTFT) and output token throughput for the last turn.
- Generic statuses published by other Pi extensions.
- Configurable extension icons, including icon suppression.
- Duplicate extension-package warnings.
- Tokyo Night and classic visual presets.
- Zero required configuration.

## Install

### npm

Install the latest stable release:

```bash
pi install npm:pi-inline-statusline
```

### GitHub

Install the latest development version:

```bash
pi install git:github.com/LuckyYunPeng/pi-inline-statusline
```

### Local development

```bash
pi install /absolute/path/to/pi-inline-statusline
```

After editing the local source, run `/reload` inside Pi to apply the changes.

## Presets

`pi-inline-statusline` supports presets through the `PI_STATUSLINE_PRESET` environment variable:

```bash
PI_STATUSLINE_PRESET=tokyo-night pi
PI_STATUSLINE_PRESET=classic pi
```

Supported presets:

- `tokyo-night` — the default, inspired by the [Starship Tokyo Night preset](https://starship.rs/presets/tokyo-night), using `░▒▓` / `` powerline blocks and the Tokyo Night color ramp.
- `classic` — a compact Pi-themed statusline with left-aligned `•` separators.

Unset or invalid values fall back to `tokyo-night`. Both presets keep the same emoji-labeled information.

## Extension Status Icons

Extension statuses use built-in icons by status key. Override or suppress them in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-statusline.json`:

```json
{
  "extensionStatusIcons": {
    "caffeinate": "☕",
    "github-pr": "🔎",
    "goal": "🎯",
    "pisync": "☁️",
    "unknown-error-retry": "",
    "plan-mode": "📝",
    "subagents": "🤖",
    "@vendor/pi-foo": "🧪"
  }
}
```

Compatibility: a valid legacy `pi-statusline-settings.json` is migrated automatically to `pi-statusline.json`. If both files exist, the new filename takes precedence.

- Exact status key: always wins, e.g. `"goal"` or `"foo:server"`.
- Installed extension id: for installed packages, use the package name/source such as `"@vendor/pi-foo"`, `"npm:@vendor/pi-foo@1.2.3"`, `"pi-foo"`, or the derived key `"foo"`.
- Namespaced status keys: package `@vendor/pi-foo` can match `foo`, `foo:server`, and `foo/server`, but not fuzzy matches like `foobar`.
- Missing key: use the built-in icon, or `🔌` for an unknown status key.
- String value: use that string as the icon.
- Empty string: show the status text without an icon.
- If multiple installed packages derive the same key, use the exact status key to disambiguate.
- `PI_STATUSLINE_PRESET` remains the only preset setting; the JSON file controls extension status icons and persisted segment visibility.

During the `PI_CAFFEINATE_ICON` deprecation window, a leading emoji from `pi-caffeinate` is still used when JSON does not configure `caffeinate`. JSON wins when both are set.

## Toggling Segments

Use the `/statusline` command to persistently show or hide individual segments:

```text
/statusline                  # open the interactive toggle selector
/statusline list             # show current visibility as text
/statusline off ttft         # hide a segment
/statusline on ttft          # show a segment
/statusline reset            # restore the default visible set
```

Changes apply immediately and are persisted in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-statusline.json`, so they survive restarts. In the interactive selector, use Up/Down to move, Enter or Space to toggle without losing the cursor position, and Esc to close. Select `Reset defaults` to remove the saved segment list and restore the package defaults. `turn` is available but hidden by default.

## Responsive Layout

The footer is composed of independent segments:

```text
brand | model | thinking | cwd | branch | tools | context | tokens | cost | time | ttft | speed
```

Segments are added from left to right. If adding the next complete segment would exceed the terminal width, that segment starts a new line. Only a single segment that is wider than the terminal by itself may be truncated.

Extension statuses use the same available space. They are appended to the final statusline row when they fit; otherwise they begin on the following row and wrap safely when needed.

The default `tokyo-night` preset renders every wrapped row as a complete, independently closed Powerline. The `classic` preset applies the same layout behavior with simple separators.

### Git status

Git status markers are hidden for clean repositories. When shown, they mean:

- `⇡` ahead
- `⇣` behind
- `+` staged
- `~` modified or deleted
- `?` untracked
- `!` conflicts

Example: `🌿 main ⇡1 +2 ~1 ?3`.

### Extension status examples

`pi-inline-statusline` consumes Pi's generic extension status API without depending on specific status-producing extensions:

- `🎯 active` for `goal: active` using the built-in `goal` icon.
- `🔎 PR #123 checks passing` for `github-pr: PR #123 checks passing` using the built-in `github-pr` icon.
- `☕ display` when JSON config sets `"caffeinate": "☕"`.
- `🧪 running` for third-party status `foo:server` when an installed package is named `@vendor/pi-foo` and JSON config sets `"@vendor/pi-foo": "🧪"`.
- `receiving` when JSON config sets `"unknown-error-retry": ""`.
- `🔌 running` for an unknown extension status key with no configured icon.
- `⚠️ dup biome-lsp` when local and npm installs register the same extension.

## Package Layout

```txt
pi-inline-statusline/
├── src/
│   ├── statusline.ts  # Pi entrypoint and watcher lifecycle
│   └── *.ts           # Package-local git, extension status, settings, and render modules
├── presets/
│   ├── ansi.ts
│   ├── classic.ts
│   ├── tokyo-night.ts
│   └── types.ts
├── README.md
├── README.zh-CN.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `statusline.ts` is a Pi entrypoint; the other source modules are internal. The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/statusline.ts"]
  }
}
```

## Upstream And License

This project is a community-maintained fork of [`@narumitw/pi-statusline`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-statusline). It preserves the upstream package history and is independently maintained at [`LuckyYunPeng/pi-inline-statusline`](https://github.com/LuckyYunPeng/pi-inline-statusline).

MIT licensed. See [`LICENSE`](./LICENSE).
