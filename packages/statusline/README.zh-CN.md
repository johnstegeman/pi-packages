# pi-inline-statusline

[English](./README.md) | **简体中文**

一个为 [Pi coding agent](https://pi.dev) 提供的响应式状态栏插件：空间足够时尽量保持单行，空间不足时按完整 segment 换行。

不会出现只显示一半的 segment，也不会静默丢失上下文、Token、费用或扩展状态。每一项都会作为整体移动到下一行，同时保证信息完整和易读性。

```text
宽终端
π • 模型 • 思考等级 • 项目 • 分支 • 工具 • 上下文 • Token • 费用 • 时间 • MCP

窄终端
π • 模型 • 思考等级 • 项目 • 分支
工具 • 上下文 • Token • 费用 • 时间
MCP
```

## 为什么维护这个分支

很多状态栏要么直接截断整个 footer，要么始终为扩展状态额外占用一行。`pi-inline-statusline` 会根据终端当前的可用宽度动态布局：

- **空间足够时保持行内展示**：主状态栏和扩展状态完整放得下时，共用同一行。
- **按完整 segment 换行**：模型、分支、上下文、Token 和费用等 segment 不会被拆到两行。
- **不丢失信息**：超出当前行的内容会移动到下一行，而不是消失在终端边缘。
- **严格控制行宽**：包括 ANSI 彩色文本在内，每一行的可见宽度都不会超过终端宽度。
- **响应式扩展状态**：MCP 和其他 Pi 扩展状态会优先加入最后一行，只有空间不足时才移动到下方。

## 功能

- 显示模型和思考等级。
- 显示当前项目目录和 Git 分支。
- 显示精简 Git 状态：领先、落后、已暂存、已修改、未跟踪和冲突。
- 显示正在执行或最近完成的工具。
- 显示上下文窗口占用、Token 总量、预估费用和时间。
- 显示最近一轮的首字时间（TTFT）与输出速度（tokens/s）。
- 显示其他 Pi 扩展发布的通用状态。
- 支持自定义或隐藏扩展状态图标。
- 检测重复安装的扩展包。
- 提供 Tokyo Night 和 classic 两种视觉预设。
- 无需配置即可使用。

## 安装

### npm

安装最新稳定版本：

```bash
pi install npm:pi-inline-statusline
```

### GitHub

安装最新开发版本：

```bash
pi install git:github.com/LuckyYunPeng/pi-inline-statusline
```

### 本地开发

```bash
pi install /absolute/path/to/pi-inline-statusline
```

修改本地源码后，在 Pi 中执行 `/reload` 即可应用变更。

## 视觉预设

通过 `PI_STATUSLINE_PRESET` 环境变量选择预设：

```bash
PI_STATUSLINE_PRESET=tokyo-night pi
PI_STATUSLINE_PRESET=classic pi
```

支持的预设：

- `tokyo-night`：默认预设，灵感来自 [Starship Tokyo Night preset](https://starship.rs/presets/tokyo-night)，使用 `░▒▓`、`` Powerline 区块和 Tokyo Night 配色。
- `classic`：紧凑的 Pi 风格状态栏，使用左对齐的 `•` 分隔符。

未设置或设置了无效值时，将回退到 `tokyo-night`。两种预设显示相同的信息和 emoji 标识。

## 扩展状态图标

扩展状态会根据状态 key 使用内置图标。可以在 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-statusline.json` 中覆盖或隐藏图标：

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

兼容性：有效的旧配置文件 `pi-statusline-settings.json` 会自动迁移为 `pi-statusline.json`。如果两个文件同时存在，新文件优先。

- 精确状态 key 始终优先，例如 `"goal"` 或 `"foo:server"`。
- 对于已安装的扩展，可以使用包名或来源，例如 `"@vendor/pi-foo"`、`"npm:@vendor/pi-foo@1.2.3"`、`"pi-foo"` 或派生 key `"foo"`。
- 命名空间状态 key：包 `@vendor/pi-foo` 可以匹配 `foo`、`foo:server` 和 `foo/server`，但不会模糊匹配 `foobar`。
- 未配置时使用内置图标；未知状态 key 使用 `🔌`。
- 字符串值会作为图标显示。
- 空字符串表示仅显示状态文本，不显示图标。
- 如果多个已安装包派生出同一个 key，请使用精确状态 key 消除歧义。
- `PI_STATUSLINE_PRESET` 仍是唯一的预设配置；该 JSON 文件控制扩展状态图标和持久化的 segment 可见性。

在 `PI_CAFFEINATE_ICON` 的弃用过渡期内，如果 JSON 未配置 `caffeinate`，仍会使用 `pi-caffeinate` 提供的前导 emoji。两者同时存在时 JSON 配置优先。

## 切换 Segment 显示

使用 `/statusline` 命令持久化显示或隐藏单个 segment：

```text
/statusline                  # 打开交互式 Toggle 选择器
/statusline list             # 以文本查看当前显示状态
/statusline off ttft         # 隐藏某个 segment
/statusline on ttft          # 显示某个 segment
/statusline reset            # 恢复默认可见集合
```

切换会立即生效并持久化到 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-statusline.json`，重启后仍然有效。在交互式选择器中使用上下键移动，按 Enter 或 Space 切换且光标位置保持不变，按 Esc 关闭。选择 `Reset defaults` 会删除已保存的 segment 列表并恢复包默认值。`turn` 这个 segment 存在但默认隐藏。

## 响应式布局

footer 由多个独立 segment 组成：

```text
brand | model | thinking | cwd | branch | tools | context | tokens | cost | time | ttft | speed
```

segment 会从左到右依次加入当前行。如果加入下一个完整 segment 后会超过终端宽度，该 segment 会从下一行开始。只有当单个 segment 本身就比终端更宽时，才允许截断这个 segment。

扩展状态使用相同的可用空间。空间足够时，它们会追加到最后一条状态栏行；否则会从下一行开始，并在需要时安全换行。

默认的 `tokyo-night` 预设会将每一条换行后的状态栏渲染为独立、完整闭合的 Powerline。`classic` 预设使用简单分隔符，但采用相同的布局规则。

### Git 状态

仓库干净时不会显示 Git 状态标记。出现标记时含义如下：

- `⇡` 领先
- `⇣` 落后
- `+` 已暂存
- `~` 已修改或删除
- `?` 未跟踪
- `!` 冲突

示例：`🌿 main ⇡1 +2 ~1 ?3`。

### 扩展状态示例

`pi-inline-statusline` 使用 Pi 通用扩展状态 API，不依赖特定的状态生产扩展：

- `🎯 active`：`goal: active` 使用内置 `goal` 图标。
- `🔎 PR #123 checks passing`：`github-pr` 状态使用内置图标。
- `☕ display`：JSON 中配置 `"caffeinate": "☕"`。
- `🧪 running`：已安装包名为 `@vendor/pi-foo`，JSON 中配置 `"@vendor/pi-foo": "🧪"`。
- `receiving`：JSON 中配置 `"unknown-error-retry": ""`，隐藏图标。
- `🔌 running`：未知扩展状态 key 且没有配置图标。
- `⚠️ dup biome-lsp`：检测到同一个扩展通过多个来源重复安装。

## 包结构

```txt
pi-inline-statusline/
├── src/
│   ├── statusline.ts  # Pi 入口和监听器生命周期
│   └── *.ts           # Git、扩展状态、配置和渲染模块
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

只有 `statusline.ts` 是 Pi 入口，其他源码模块均为包内实现。`package.json` 通过以下配置声明 Pi 扩展：

```json
{
  "pi": {
    "extensions": ["./src/statusline.ts"]
  }
}
```

## 上游与许可证

本项目是 [`@narumitw/pi-statusline`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-statusline) 的社区维护分支，保留了上游包的 Git 历史，并由 [`LuckyYunPeng/pi-inline-statusline`](https://github.com/LuckyYunPeng/pi-inline-statusline) 独立维护。

项目使用 MIT 许可证，详情见 [`LICENSE`](./LICENSE)。
