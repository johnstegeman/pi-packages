import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
	buildExtensionStatusIconAliases,
	type ExtensionStatusIconAliasMap,
	findDuplicateExtensions,
	readInstalledExtensionPackages,
} from "./extension-status.js";
import { type GitStatusSummary, gitStatusSummaryEqual, readGitStatus } from "./git-status.js";
import {
	mergeStatuslineLines,
	type RuntimeState,
	renderExtensionStatusline,
	renderStatusline,
} from "./render.js";
import {
	consumeStatuslineSettingsNotice,
	createDefaultConfig,
	isSegmentName,
	listAllSegments,
	listDefaultSegments,
	writeStatuslineSegments,
} from "./settings.js";

const STATUSLINE_KEY = "statusline";
const GIT_STATUS_REFRESH_INTERVAL_MS = 30_000;
const GIT_STATUS_EVENT_DEBOUNCE_MS = 250;
const EMPTY_EXTENSION_STATUS_ICON_ALIASES: ExtensionStatusIconAliasMap = new Map();

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function statusline(pi: ExtensionAPI) {
	const config = createDefaultConfig();
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: EMPTY_EXTENSION_STATUS_ICON_ALIASES,
	};

	const refresh = () => runtime.requestRender?.();

	const describeSegments = () =>
		listAllSegments()
			.map((name) => `${config.segments.includes(name) ? "\u2713" : " "} ${name}`)
			.join("\n");

	const applySegmentVisibility = (
		name: string,
		visible: boolean,
		ctx: ExtensionContext,
		notify = true,
	): boolean => {
		if (!isSegmentName(name)) {
			ctx.ui.notify(
				`Unknown segment "${name}". Run /statusline list to see all segments.`,
				"warning",
			);
			return false;
		}
		const selected = new Set(config.segments);
		if (visible) selected.add(name);
		else selected.delete(name);
		const segments = listAllSegments().filter((segment) => selected.has(segment));
		try {
			writeStatuslineSegments(segments);
			config.segments = segments;
			if (notify) ctx.ui.notify(`Segment "${name}" turned ${visible ? "on" : "off"}.`, "info");
			refresh();
			return true;
		} catch (error) {
			ctx.ui.notify(`Could not save statusline settings: ${formatError(error)}`, "error");
			return false;
		}
	};

	const resetSegments = (ctx: ExtensionContext, notify = true): boolean => {
		try {
			writeStatuslineSegments();
			config.segments = listDefaultSegments();
			if (notify) ctx.ui.notify("Statusline segments reset to defaults.", "info");
			refresh();
			return true;
		} catch (error) {
			ctx.ui.notify(`Could not save statusline settings: ${formatError(error)}`, "error");
			return false;
		}
	};

	const openSegmentSelector = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/statusline requires TUI mode", "error");
			return;
		}
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const items: SettingItem[] = [
				...listAllSegments().map((name) => ({
					id: name,
					label: name,
					currentValue: config.segments.includes(name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				})),
				{
					id: "reset",
					label: "Reset defaults",
					currentValue: "",
					values: [""],
				},
			];
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Statusline segments")), 1, 1));
			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				{
					label: (text, selected) => (selected ? theme.fg("accent", text) : text),
					value: (text, selected) =>
						selected ? theme.fg("accent", text) : theme.fg("muted", text),
					description: (text) => theme.fg("dim", text),
					cursor: theme.fg("accent", "→ "),
					hint: (text) => theme.fg("dim", text),
				},
				(id, newValue) => {
					if (id === "reset") {
						if (resetSegments(ctx, false)) {
							for (const name of listAllSegments()) {
								settingsList.updateValue(
									name,
									config.segments.includes(name) ? "enabled" : "disabled",
								);
							}
						}
					} else if (!applySegmentVisibility(id, newValue === "enabled", ctx, false)) {
						settingsList.updateValue(id, newValue === "enabled" ? "disabled" : "enabled");
					}
					tui.requestRender();
				},
				() => done(undefined),
			);
			container.addChild(settingsList);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	pi.registerCommand("statusline", {
		description: "Toggle statusline segments: /statusline <on|off> <segment>, list, reset",
		handler: async (args, ctx) => {
			const [cmd, name] = args.trim().split(/\s+/);

			if (!cmd) {
				await openSegmentSelector(ctx);
				return;
			}

			if (cmd === "list") {
				ctx.ui.notify(describeSegments(), "info");
				return;
			}

			if (cmd === "reset") {
				resetSegments(ctx);
				return;
			}

			if (cmd === "on" || cmd === "off") {
				if (!name) {
					ctx.ui.notify("Usage: /statusline <on|off> <segment>", "warning");
					return;
				}
				applySegmentVisibility(name, cmd === "on", ctx);
				return;
			}

			ctx.ui.notify("Usage: /statusline [list|reset|on <segment>|off <segment>]", "warning");
		},
		getArgumentCompletions: (argumentPrefix: string) => {
			const tokens = argumentPrefix.split(/\s+/);
			if (tokens.length <= 1) {
				const prefix = tokens[0] ?? "";
				return ["on", "off", "list", "reset"]
					.filter((word) => word.startsWith(prefix))
					.map((value) => ({ value, label: value }));
			}
			if (tokens[0] !== "on" && tokens[0] !== "off") return null;
			const prefix = tokens.at(-1) ?? "";
			return listAllSegments()
				.filter((name) => name.startsWith(prefix))
				.map((value) => ({ value, label: value }));
		},
	});

	let sessionGeneration = 0;
	let gitStatusRequestId = 0;
	let activeGitStatusTarget: { cwd: string; generation: number } | undefined;
	let gitStatusRefreshInFlight = false;
	let gitStatusDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingGitStatusRefresh: { cwd: string; generation: number; requestId: number } | undefined;

	const setGitStatus = (summary: GitStatusSummary | undefined) => {
		if (gitStatusSummaryEqual(runtime.gitStatus, summary)) return;
		runtime.gitStatus = summary;
		refresh();
	};

	const clearGitStatusDebounce = () => {
		if (!gitStatusDebounceTimer) return;
		clearTimeout(gitStatusDebounceTimer);
		gitStatusDebounceTimer = undefined;
	};

	const isActiveGitStatusTarget = (cwd: string, generation: number) =>
		activeGitStatusTarget?.cwd === cwd &&
		activeGitStatusTarget.generation === generation &&
		generation === sessionGeneration;

	const isCurrentGitStatusRequest = (cwd: string, generation: number, requestId: number) =>
		isActiveGitStatusTarget(cwd, generation) && requestId === gitStatusRequestId;

	const runGitStatusRefresh = (cwd: string, generation: number, requestId: number) => {
		if (!isCurrentGitStatusRequest(cwd, generation, requestId)) return;
		if (gitStatusRefreshInFlight) {
			pendingGitStatusRefresh = { cwd, generation, requestId };
			return;
		}

		gitStatusRefreshInFlight = true;
		void (async () => {
			try {
				const summary = await readGitStatus(pi, cwd);
				if (isCurrentGitStatusRequest(cwd, generation, requestId)) setGitStatus(summary);
			} catch {
				if (isCurrentGitStatusRequest(cwd, generation, requestId)) setGitStatus(undefined);
			} finally {
				gitStatusRefreshInFlight = false;
				const pending = pendingGitStatusRefresh;
				pendingGitStatusRefresh = undefined;
				if (pending) runGitStatusRefresh(pending.cwd, pending.generation, pending.requestId);
			}
		})();
	};

	const refreshGitStatus = (cwd: string, generation = sessionGeneration) => {
		if (!isActiveGitStatusTarget(cwd, generation)) return;
		runGitStatusRefresh(cwd, generation, ++gitStatusRequestId);
	};

	const scheduleGitStatusRefresh = (cwd: string, generation = sessionGeneration) => {
		if (!isActiveGitStatusTarget(cwd, generation)) return;
		const requestId = ++gitStatusRequestId;
		clearGitStatusDebounce();
		gitStatusDebounceTimer = setTimeout(() => {
			gitStatusDebounceTimer = undefined;
			runGitStatusRefresh(cwd, generation, requestId);
		}, GIT_STATUS_EVENT_DEBOUNCE_MS);
	};

	const scheduleGitStatusRefreshForContext = (ctx: ExtensionContext) => {
		if (!activeGitStatusTarget || activeGitStatusTarget.cwd !== ctx.cwd) return;
		scheduleGitStatusRefresh(activeGitStatusTarget.cwd, activeGitStatusTarget.generation);
	};

	const installFooter = (ctx: ExtensionContext) => {
		const generation = ++sessionGeneration;
		const cwd = ctx.cwd;
		clearGitStatusDebounce();
		activeGitStatusTarget = ctx.mode === "tui" ? { cwd, generation } : undefined;
		runtime.gitStatus = undefined;
		runtime.duplicateExtensions = [];
		runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		if (!activeGitStatusTarget) return;
		const installedPackages = readInstalledExtensionPackages(cwd);
		runtime.duplicateExtensions = findDuplicateExtensions(installedPackages);
		runtime.extensionStatusIconAliases = buildExtensionStatusIconAliases(installedPackages);
		ctx.ui.setFooter((tui, theme, footerData) => {
			runtime.requestRender = () => tui.requestRender();

			const refreshFooterGitStatus = () => refreshGitStatus(cwd, generation);
			const branchUnsubscribe = footerData.onBranchChange(() => {
				runtime.gitStatus = undefined;
				clearGitStatusDebounce();
				refreshFooterGitStatus();
				tui.requestRender();
			});
			const clock = setInterval(() => {
				clearGitStatusDebounce();
				refreshFooterGitStatus();
				tui.requestRender();
			}, GIT_STATUS_REFRESH_INTERVAL_MS);

			return {
				dispose() {
					branchUnsubscribe();
					clearInterval(clock);
					if (isActiveGitStatusTarget(cwd, generation)) {
						activeGitStatusTarget = undefined;
						clearGitStatusDebounce();
						pendingGitStatusRefresh = undefined;
						runtime.gitStatus = undefined;
						runtime.duplicateExtensions = [];
						runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
						runtime.requestRender = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					const mainLines = renderStatusline(width, ctx, footerData, theme, config, runtime);
					const extensionLines = renderExtensionStatusline(
						width,
						footerData,
						theme,
						config,
						runtime,
					);
					return mergeStatuslineLines(mainLines, extensionLines, width, theme.fg("dim", " • "));
				},
			};
		});
		refreshGitStatus(cwd, generation);
	};

	pi.on("session_start", (_event, ctx) => {
		const settingsNotice = consumeStatuslineSettingsNotice();
		if (settingsNotice) ctx.ui.notify(settingsNotice, "warning");
		runtime.thinkingLevel = pi.getThinkingLevel();
		installFooter(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		installFooter(ctx);
		refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionGeneration += 1;
		activeGitStatusTarget = undefined;
		clearGitStatusDebounce();
		pendingGitStatusRefresh = undefined;
		runtime.gitStatus = undefined;
		runtime.duplicateExtensions = [];
		runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
		ctx.ui.setFooter(undefined);
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		runtime.requestRender = undefined;
	});

	pi.on("model_select", () => refresh());

	pi.on("thinking_level_select", (event) => {
		runtime.thinkingLevel = event.level;
		refresh();
	});

	pi.on("agent_start", () => {
		runtime.isStreaming = true;
		refresh();
	});

	pi.on("agent_end", (_event, ctx) => {
		runtime.isStreaming = false;
		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});

	pi.on("turn_start", () => {
		runtime.turnCount += 1;
		runtime.isStreaming = true;
		runtime.turnStartedAt = Date.now();
		runtime.firstTokenAt = undefined;
		refresh();
	});

	pi.on("message_update", (event) => {
		if (runtime.firstTokenAt !== undefined || runtime.turnStartedAt === undefined) return;
		const deltaType = event.assistantMessageEvent.type;
		if (
			deltaType !== "text_delta" &&
			deltaType !== "thinking_delta" &&
			deltaType !== "toolcall_delta"
		)
			return;
		runtime.firstTokenAt = Date.now();
		runtime.lastTtftMs = runtime.firstTokenAt - runtime.turnStartedAt;
		refresh();
	});

	pi.on("turn_end", (event, ctx) => {
		const message = event.message;
		if (
			runtime.firstTokenAt !== undefined &&
			message.role === "assistant" &&
			message.usage.output > 0
		) {
			const elapsedSec = (Date.now() - runtime.firstTokenAt) / 1000;
			if (elapsedSec > 0) runtime.lastOutputTokensPerSec = message.usage.output / elapsedSec;
		}
		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});

	pi.on("tool_execution_start", (event) => {
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		runtime.activeTools.set(event.toolName, currentCount + 1);
		runtime.lastTool = event.toolName;
		refresh();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		if (currentCount <= 1) runtime.activeTools.delete(event.toolName);
		else runtime.activeTools.set(event.toolName, currentCount - 1);

		runtime.lastCompletedTool = event.toolName;
		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});
}

export {
	buildExtensionStatusIconAliases,
	type ExtensionStatusIconAliasMap,
	extensionColor,
	formatExtensionStatus,
	npmPackageName,
	simplifyExtensionStatusText,
	splitExtensionStatusIcon,
	stripExtensionStatusPrefix,
	wrapExtensionStatusline,
} from "./extension-status.js";
export {
	formatGitBranchText,
	formatGitStatusSummary,
	type GitStatusSummary,
	parseGitStatusPorcelain,
} from "./git-status.js";
export {
	contextColor,
	formatCount,
	formatToolActivity,
	mergeStatuslineLines,
	prLinkFromStatuses,
	shortenModel,
	wrapStatuslineSegments,
} from "./render.js";
export { normalizeStatuslineSettings, readStatuslineSettings } from "./settings.js";
