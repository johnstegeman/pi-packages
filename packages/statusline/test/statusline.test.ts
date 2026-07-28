import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { consumeStatuslineSettingsNotice } from "../src/settings.js";
import type { ExtensionStatusIconAliasMap } from "../src/statusline.js";
import statusline, {
	buildExtensionStatusIconAliases,
	contextColor,
	extensionColor,
	formatCount,
	formatExtensionStatus,
	formatGitBranchText,
	formatGitStatusSummary,
	formatToolActivity,
	mergeStatuslineLines,
	npmPackageName,
	parseGitStatusPorcelain,
	prLinkFromStatuses,
	readStatuslineSettings,
	shortenModel,
	simplifyExtensionStatusText,
	splitExtensionStatusIcon,
	stripExtensionStatusPrefix,
	wrapExtensionStatusline,
	wrapStatuslineSegments,
} from "../src/statusline.js";
import { createMockContext, createMockPi } from "./support.js";

const EMPTY_STATUS_ALIASES: ExtensionStatusIconAliasMap = new Map();
void EMPTY_STATUS_ALIASES;

async function emit(
	events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
	name: string,
	...args: unknown[]
) {
	for (const handler of events.get(name) ?? []) await handler(...args);
}

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

function deferred<T>() {
	let resolveValue: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolveValue = resolve;
	});
	return {
		promise,
		resolve(value: T) {
			resolveValue?.(value);
		},
	};
}

async function flushAsync() {
	await new Promise((resolve) => setImmediate(resolve));
}

test("statusline registers lifecycle handlers without reading thinking level at load time", () => {
	const mock = createMockPi();
	mock.rawPi.getThinkingLevel = () => {
		throw new Error("should be deferred until session_start");
	};

	assert.doesNotThrow(() => statusline(mock.pi));
	assert.ok(mock.events.has("session_start"));
	assert.ok(mock.events.has("tool_execution_start"));
});

test("statusline skips git status refreshes outside TUI mode", async () => {
	const mock = createMockPi();
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
	statusline(mock.pi);
	const { ctx } = createMockContext({ mode: "print" });

	await emit(mock.events, "session_start", {}, ctx);
	await emit(mock.events, "tool_execution_end", { toolName: "write" }, ctx);

	assert.equal(execCalls, 0);

	async function execGitStatus() {
		execCalls += 1;
		return { stdout: "## main\n", stderr: "", code: 0, killed: false };
	}
});

test("statusline renders cached git status without executing git during render", async () => {
	const mock = createMockPi();
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
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
	const callsBeforeRender = execCalls;

	footer.render(120);
	footer.dispose();

	assert.equal(execCalls, callsBeforeRender);
	assert.equal(callsBeforeRender, 1);

	async function execGitStatus() {
		execCalls += 1;
		return { stdout: "## main\n M changed.ts\n", stderr: "", code: 0, killed: false };
	}
});

test("statusline ignores stale git refresh events from a previous cwd", async () => {
	const mock = createMockPi();
	const cwdCalls: string[] = [];
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
	statusline(mock.pi);
	const oldCwd = join(tmpdir(), "stale-a");
	const newCwd = join(tmpdir(), "current-b");
	const oldContext = createMockContext({ mode: "tui", cwd: oldCwd });
	const newContext = createMockContext({ mode: "tui", cwd: newCwd });

	await emit(mock.events, "session_start", {}, oldContext.ctx);
	await emit(mock.events, "session_shutdown", {}, oldContext.ctx);
	await emit(mock.events, "session_start", {}, newContext.ctx);
	await emit(mock.events, "tool_execution_end", { toolName: "write" }, oldContext.ctx);
	await new Promise((resolve) => setTimeout(resolve, 300));

	assert.deepEqual(cwdCalls, [oldCwd, newCwd]);

	async function execGitStatus(_command: string, _args: string[], options?: { cwd?: string }) {
		cwdCalls.push(options?.cwd ?? "");
		return { stdout: "## main\n", stderr: "", code: 0, killed: false };
	}
});

test("statusline stops git refreshes after its footer is disposed", async () => {
	const mock = createMockPi();
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
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
	) => { dispose(): void; render(width: number): string[] };
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (_color, text) => text, bold: (text) => text },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
	footer.dispose();
	await emit(mock.events, "tool_execution_end", { toolName: "write" }, context.ctx);
	await new Promise((resolve) => setTimeout(resolve, 300));

	assert.equal(execCalls, 1);

	async function execGitStatus() {
		execCalls += 1;
		return { stdout: "## main\n", stderr: "", code: 0, killed: false };
	}
});

test("statusline computes TTFT and output token speed from turn events", async () => {
	const mock = createMockPi();
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
	) => { dispose(): void; render(width: number): string[] };
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (_color, text) => text, bold: (text) => text },
		{
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);

	assert.equal(footer.render(200).join(" ").includes("⚡"), false);
	assert.equal(footer.render(200).join(" ").includes("🚀"), false);

	await emit(mock.events, "turn_start", { turnIndex: 0, timestamp: Date.now() }, context.ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await emit(mock.events, "message_update", {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} },
	});
	await new Promise((resolve) => setTimeout(resolve, 20));

	const afterFirstToken = footer.render(200).join(" ");
	assert.match(afterFirstToken, /⚡ TTFT \d+m?s/);

	await emit(
		mock.events,
		"turn_end",
		{
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", usage: { input: 10, output: 40 } },
			toolResults: [],
		},
		context.ctx,
	);

	const afterTurnEnd = footer.render(200).join(" ");
	assert.match(afterTurnEnd, /🚀 [\d.]+tok\/s/);

	footer.dispose();
});

test("/statusline command persists, lists, and resets segment visibility", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		writeFileSync(
			join(root, "pi-statusline.json"),
			JSON.stringify({ extensionStatusIcons: { goal: "🎯" }, futureOption: true }),
		);
		const mock = createMockPi();
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
		) => { dispose(): void; render(width: number): string[] };
		const footer = footerFactory(
			{ requestRender() {} },
			{ fg: (_color, text) => text, bold: (text) => text },
			{
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => undefined,
			},
		);

		const command = mock.commands.get("statusline");
		assert.ok(command);
		const notifications: string[] = [];
		const commandCtx = {
			...JSON.parse(JSON.stringify(context.ctx)),
			cwd: process.cwd(),
			hasUI: false,
			model: undefined,
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: () => undefined,
				setFooter: () => undefined,
				select: async () => undefined,
				editor: async () => undefined,
				custom: async () => undefined,
			},
		} as never;

		assert.match(footer.render(200).join(" "), /🕒/);

		await command.handler("off time", commandCtx);
		assert.equal(footer.render(200).join(" ").includes("🕒"), false);
		assert.match(notifications.at(-1) ?? "", /turned off/);
		const saved = JSON.parse(readFileSync(join(root, "pi-statusline.json"), "utf8"));
		assert.equal(saved.segments.includes("time"), false);
		assert.deepEqual(saved.extensionStatusIcons, { goal: "🎯" });
		assert.equal(saved.futureOption, true);
		assert.equal(readStatuslineSettings().segments?.includes("time"), false);

		await command.handler("on time", commandCtx);
		assert.match(footer.render(200).join(" "), /🕒/);

		const selectorRenders: string[][] = [];
		(
			commandCtx as {
				ui: {
					custom(
						factory: (
							tui: { requestRender(): void },
							theme: {
								fg(color: string, text: string): string;
								bold(text: string): string;
							},
							keybindings: object,
							done: () => void,
						) => unknown,
					): Promise<void>;
				};
			}
		).ui.custom = async (factory) => {
			let close!: () => void;
			const closed = new Promise<void>((resolve) => {
				close = resolve;
			});
			const component = factory(
				{ requestRender() {} },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
				{},
				close,
			) as { render(width: number): string[]; handleInput(data: string): void };
			for (let index = 0; index < 9; index += 1) component.handleInput("\x1b[B");
			selectorRenders.push(component.render(80));
			component.handleInput("\r");
			selectorRenders.push(component.render(80));
			component.handleInput("\x1b");
			await closed;
		};
		await command.handler("", commandCtx);
		footer.dispose();
		assert.equal(footer.render(200).join(" ").includes("🕒"), false);
		assert.match(selectorRenders[0]?.join("\n") ?? "", /→ .*time.*enabled/);
		assert.match(selectorRenders[1]?.join("\n") ?? "", /→ .*time.*disabled/);
		assert.equal(readStatuslineSettings().segments?.includes("time"), false);

		await command.handler("off bogus-segment", commandCtx);
		assert.match(notifications.at(-1) ?? "", /Unknown segment/);

		await command.handler("list", commandCtx);
		assert.match(notifications.at(-1) ?? "", /○? time| {2}time/);

		await command.handler("off time", commandCtx);
		await command.handler("reset", commandCtx);
		assert.match(footer.render(200).join(" "), /🕒/);
		const reset = JSON.parse(readFileSync(join(root, "pi-statusline.json"), "utf8"));
		assert.equal("segments" in reset, false);
		assert.deepEqual(reset.extensionStatusIcons, { goal: "🎯" });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("statusline does not render stale in-flight git status after a branch change", async () => {
	const mock = createMockPi();
	const firstStatus = deferred<ExecResult>();
	const secondStatus = deferred<ExecResult>();
	const execResults = [firstStatus.promise, secondStatus.promise];
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
	statusline(mock.pi);
	const context = createMockContext({ mode: "tui" });

	await emit(mock.events, "session_start", {}, context.ctx);
	let branchChange: (() => void) | undefined;
	const footerFactory = context.footer as (
		tui: { requestRender(): void },
		theme: { fg(_color: string, text: string): string; bold(text: string): string },
		footerData: {
			getGitBranch(): string | null;
			getExtensionStatuses(): ReadonlyMap<string, string>;
			onBranchChange(callback: () => void): () => void;
		},
	) => { dispose(): void; render(width: number): string[] };
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (_color, text) => text, bold: (text) => text },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			onBranchChange(callback) {
				branchChange = callback;
				return () => {
					branchChange = undefined;
				};
			},
		},
	);

	assert.equal(execCalls, 1);
	assert.ok(branchChange);
	branchChange();
	firstStatus.resolve({ stdout: "## main\n M stale.ts\n", stderr: "", code: 0, killed: false });
	await flushAsync();

	assert.equal(execCalls, 2);
	assert.equal(footer.render(120).join("\n").includes("~1"), false);

	secondStatus.resolve({ stdout: "## main\n?? fresh.ts\n", stderr: "", code: 0, killed: false });
	await flushAsync();

	assert.match(footer.render(120).join("\n"), /\?1/u);
	footer.dispose();

	async function execGitStatus() {
		const result = execResults[execCalls];
		execCalls += 1;
		if (!result) throw new Error("unexpected git status refresh");
		return result;
	}
});

test("statusline invalidates in-flight git status while a debounced refresh is pending", async () => {
	const mock = createMockPi();
	const firstStatus = deferred<ExecResult>();
	const secondStatus = deferred<ExecResult>();
	const execResults = [firstStatus.promise, secondStatus.promise];
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
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
	) => { dispose(): void; render(width: number): string[] };
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (_color, text) => text, bold: (text) => text },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);

	assert.equal(execCalls, 1);
	await emit(mock.events, "tool_execution_end", { toolName: "write" }, context.ctx);
	firstStatus.resolve({ stdout: "## main\n M stale.ts\n", stderr: "", code: 0, killed: false });
	await flushAsync();

	assert.equal(execCalls, 1);
	assert.equal(footer.render(120).join("\n").includes("~1"), false);

	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(execCalls, 2);
	secondStatus.resolve({ stdout: "## main\n?? fresh.ts\n", stderr: "", code: 0, killed: false });
	await flushAsync();

	assert.match(footer.render(120).join("\n"), /\?1/u);
	footer.dispose();

	async function execGitStatus() {
		const result = execResults[execCalls];
		execCalls += 1;
		if (!result) throw new Error("unexpected git status refresh");
		return result;
	}
});

test("formatToolActivity prioritizes active tools, streaming, completed tools, and idle", () => {
	type Runtime = Parameters<typeof formatToolActivity>[0];
	const runtime = (value: Partial<Runtime> & Pick<Runtime, "activeTools" | "isStreaming">) =>
		value as Runtime;

	assert.equal(
		formatToolActivity(runtime({ activeTools: new Map([["read", 2]]), isStreaming: false })),
		"⚙ read×2",
	);
	assert.equal(
		formatToolActivity(runtime({ activeTools: new Map(), isStreaming: true })),
		"💭 thinking",
	);
	assert.equal(
		formatToolActivity(
			runtime({
				activeTools: new Map(),
				isStreaming: false,
				lastCompletedTool: "bash",
			}),
		),
		"✅ bash",
	);
	assert.equal(
		formatToolActivity(runtime({ activeTools: new Map(), isStreaming: false })),
		"💤 idle",
	);
});

test("extension status helpers strip prefixes, icons, and simplify text", () => {
	assert.deepEqual(splitExtensionStatusIcon("🔥 running crawl"), {
		icon: "🔥",
		text: "running crawl",
	});
	assert.deepEqual(splitExtensionStatusIcon("plain status"), { text: "plain status" });
	assert.equal(stripExtensionStatusPrefix("firecrawl", "firecrawl: ready"), "ready");
	assert.equal(simplifyExtensionStatusText("ready, missing (details)"), "✓ ✗");
	assert.equal(extensionColor("codex", "checking"), "accent");
	assert.equal(extensionColor("lsp", "command missing"), "warning");
});

test("prLinkFromStatuses keeps the linked PR token and drops the tail and non-PR states", () => {
	const link = "\x1b]8;;https://github.com/o/r/pull/123\x07#123\x1b]8;;\x07";
	assert.equal(
		prLinkFromStatuses(new Map([["github-pr", `PR ${link}: checks failing (1), approved`]])),
		link,
	);
	assert.equal(prLinkFromStatuses(new Map([["github-pr", "PR gh missing"]])), undefined);
	assert.equal(prLinkFromStatuses(new Map()), undefined);
});

test("git status parser and formatter produce compact dirty tokens", () => {
	const summary = parseGitStatusPorcelain(`## main...origin/main [ahead 2, behind 1]
M  staged-modified.ts
A  staged-added.ts
 M modified.ts
 D deleted.ts
?? new-file.ts
UU conflicted.ts
`);

	assert.deepEqual(summary, {
		ahead: 2,
		behind: 1,
		staged: 2,
		modified: 2,
		untracked: 1,
		conflicts: 1,
	});
	assert.equal(formatGitStatusSummary(summary), "⇡2 ⇣1 +2 ~2 ?1 !1");
});

test("git status formatter omits clean markers", () => {
	const summary = parseGitStatusPorcelain("## main...origin/main\n");

	assert.deepEqual(summary, {
		ahead: 0,
		behind: 0,
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicts: 0,
	});
	assert.equal(formatGitStatusSummary(summary), "");
	assert.equal(formatGitBranchText("main", summary), "🌿 main");
});

test("git branch text includes compact status before PR link", () => {
	const link = "\x1b]8;;https://github.com/o/r/pull/123\x07#123\x1b]8;;\x07";

	assert.equal(
		formatGitBranchText(
			"feature",
			{ ahead: 1, behind: 0, staged: 3, modified: 0, untracked: 2, conflicts: 0 },
			link,
		),
		`🌿 feature ⇡1 +3 ?2 (${link})`,
	);
	assert.equal(formatGitBranchText(null, undefined), "🌿 no-git");
});

test("statusline settings load extension icon overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-test-"));
	const settingsPath = join(root, "pi-statusline.json");

	assert.deepEqual(readStatuslineSettings(settingsPath), { extensionStatusIcons: {} });

	writeFileSync(
		settingsPath,
		JSON.stringify({ extensionStatusIcons: { goal: "", caffeinate: "☕", bad: 1 } }),
	);
	assert.deepEqual(readStatuslineSettings(settingsPath), {
		extensionStatusIcons: { goal: "", caffeinate: "☕" },
	});

	writeFileSync(settingsPath, JSON.stringify({ segments: ["speed", "bogus", "brand", "speed"] }));
	assert.deepEqual(readStatuslineSettings(settingsPath), {
		extensionStatusIcons: {},
		segments: ["brand", "speed"],
	});

	writeFileSync(settingsPath, "not json");
	assert.deepEqual(readStatuslineSettings(settingsPath), { extensionStatusIcons: {} });
});

test("statusline settings migrate to the canonical package filename", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-migration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		const legacyPath = join(root, "pi-statusline-settings.json");
		const canonicalPath = join(root, "pi-statusline.json");
		writeFileSync(
			legacyPath,
			JSON.stringify({ extensionStatusIcons: { goal: "🎯" }, futureOption: true }),
		);
		assert.deepEqual(readStatuslineSettings(), { extensionStatusIcons: { goal: "🎯" } });
		assert.deepEqual(JSON.parse(readFileSync(canonicalPath, "utf8")), {
			extensionStatusIcons: { goal: "🎯" },
			futureOption: true,
		});
		assert.equal(existsSync(legacyPath), false);

		writeFileSync(legacyPath, JSON.stringify({ extensionStatusIcons: { goal: "old" } }));
		writeFileSync(canonicalPath, JSON.stringify({ extensionStatusIcons: { goal: "new" } }));
		assert.deepEqual(readStatuslineSettings(), { extensionStatusIcons: { goal: "new" } });
		assert.equal(existsSync(legacyPath), true);

		writeFileSync(canonicalPath, "invalid");
		assert.deepEqual(readStatuslineSettings(), { extensionStatusIcons: {} });
		assert.equal(readFileSync(legacyPath, "utf8").includes("old"), true);
		unlinkSync(legacyPath);
		writeFileSync(canonicalPath, JSON.stringify({ extensionStatusIcons: { goal: "fixed" } }));
		assert.deepEqual(readStatuslineSettings(), { extensionStatusIcons: { goal: "fixed" } });
		assert.equal(consumeStatuslineSettingsNotice(), undefined);
		unlinkSync(canonicalPath);
		writeFileSync(legacyPath, "invalid");
		assert.deepEqual(readStatuslineSettings(), { extensionStatusIcons: {} });
		assert.equal(existsSync(canonicalPath), false);

		writeFileSync(legacyPath, JSON.stringify({ extensionStatusIcons: { goal: "fallback" } }));
		symlinkSync("missing-target", canonicalPath);
		assert.deepEqual(readStatuslineSettings(), { extensionStatusIcons: { goal: "fallback" } });
		assert.equal(existsSync(legacyPath), true);
		const mock = createMockPi();
		statusline(mock.pi);
		const context = createMockContext();
		await emit(mock.events, "session_start", {}, context.ctx);
		assert.match(context.notifications[0]?.message ?? "", /migration failed/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("extension status icons use config, leading emoji, defaults, and fallback", () => {
	const theme = { fg: (_color: string, text: string) => text } as never;
	const config = (extensionStatusIcons: Record<string, string>) => ({ extensionStatusIcons });

	assert.equal(formatExtensionStatus("goal", "active", theme, config({})), "🎯 active");
	assert.equal(
		formatExtensionStatus("github-pr", "PR #123 checks passing", theme, config({})),
		"🔎 PR #123 checks passing",
	);
	assert.equal(
		formatExtensionStatus(
			"github-pr",
			"PR #123: checks pending (12), changes requested, 45 comments",
			theme,
			config({}),
		),
		"🔎 PR #123: checks pending (12) changes requested 45 comments",
	);
	assert.equal(
		formatExtensionStatus("caffeinate", "☕ display", theme, config({ caffeinate: "🍵" })),
		"🍵 display",
	);
	assert.equal(formatExtensionStatus("caffeinate", "☕ display", theme, config({})), "☕ display");
	assert.equal(formatExtensionStatus("goal", "active", theme, config({ goal: "" })), "active");
	assert.equal(formatExtensionStatus("unknown", "running", theme, config({})), "🔌 running");
});

test("statusline render uses installed package id icon aliases from settings", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-alias-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		writeFileSync(
			join(agentDir, "pi-statusline.json"),
			JSON.stringify({ extensionStatusIcons: { "@vendor/pi-foo": "🧪" } }),
		);
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:@vendor/pi-foo@1.2.3"] }),
		);

		const mock = createMockPi();
		(mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => ({
			stdout: "## main\n",
			stderr: "",
			code: 0,
			killed: false,
		});
		statusline(mock.pi);
		const context = createMockContext({ mode: "tui", cwd });

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
				getExtensionStatuses: () => new Map([["foo:server", "running"]]),
				onBranchChange: () => () => undefined,
			},
		);

		const wideLines = footer.render(240);
		const narrowLines = footer.render(30);
		footer.dispose();

		assert.equal(wideLines.length, 1, wideLines.join("\n"));
		assert.match(wideLines[0] ?? "", /🧪 running/u);
		assert.ok(narrowLines.length > 1, narrowLines.join("\n"));
		assert.ok(
			narrowLines.some((line) => line.includes("🧪 running")),
			narrowLines.join("\n"),
		);
		assert.ok(narrowLines.every((line) => visibleWidth(line) <= 30));
		assert.match(narrowLines.join("\n"), /ctx \?/u);
		assert.match(narrowLines.join("\n"), /tok 0/u);
		assert.match(narrowLines.join("\n"), /\$0\.000/u);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("extension status icons use installed package id aliases without fuzzy matching", () => {
	const theme = { fg: (_color: string, text: string) => text } as never;
	const config = (extensionStatusIcons: Record<string, string>) => ({ extensionStatusIcons });
	const aliases = buildExtensionStatusIconAliases([
		{ packageName: "@vendor/pi-foo", source: "npm:@vendor/pi-foo@1.2.3" },
		{ packageName: "@vendor/bar" },
	]);

	assert.deepEqual(
		[...aliases],
		[
			[
				"foo",
				["npm:@vendor/pi-foo@1.2.3", "npm:@vendor/pi-foo", "@vendor/pi-foo", "pi-foo", "foo"],
			],
			["bar", ["@vendor/bar", "bar"]],
		],
	);
	assert.equal(
		formatExtensionStatus("foo", "running", theme, config({ "@vendor/pi-foo": "🧪" }), aliases),
		"🧪 running",
	);
	assert.equal(
		formatExtensionStatus("foo:server", "running", theme, config({ "pi-foo": "🧬" }), aliases),
		"🧬 running",
	);
	assert.equal(
		formatExtensionStatus(
			"foo/server",
			"running",
			theme,
			config({ "npm:@vendor/pi-foo@1.2.3": "📦" }),
			aliases,
		),
		"📦 running",
	);
	assert.equal(
		formatExtensionStatus("bar", "running", theme, config({ "@vendor/bar": "🍫" }), aliases),
		"🍫 running",
	);
	assert.equal(
		formatExtensionStatus("foobar", "running", theme, config({ "@vendor/pi-foo": "🧪" }), aliases),
		"🔌 running",
	);
});

test("extension status icon aliases preserve exact-key precedence and skip ambiguous packages", () => {
	const theme = { fg: (_color: string, text: string) => text } as never;
	const config = (extensionStatusIcons: Record<string, string>) => ({ extensionStatusIcons });
	const aliases = buildExtensionStatusIconAliases([
		{ packageName: "@first/pi-foo" },
		{ packageName: "@second/pi-foo" },
	]);

	assert.deepEqual([...aliases], []);
	assert.equal(
		formatExtensionStatus(
			"foo:server",
			"running",
			theme,
			config({ "@first/pi-foo": "1️⃣", "foo:server": "✅" }),
			aliases,
		),
		"✅ running",
	);
	assert.equal(
		formatExtensionStatus(
			"foo:server",
			"running",
			theme,
			config({ "@first/pi-foo": "1️⃣" }),
			aliases,
		),
		"🔌 running",
	);

	const unambiguousAliases = buildExtensionStatusIconAliases([{ packageName: "@vendor/pi-foo" }]);
	assert.equal(
		formatExtensionStatus(
			"foo:server",
			"running",
			theme,
			config({ "@vendor/pi-foo": "🧪", "foo:server": "" }),
			unambiguousAliases,
		),
		"running",
	);
	assert.equal(
		formatExtensionStatus(
			"foo:server",
			"running",
			theme,
			config({ "@vendor/pi-foo": "" }),
			unambiguousAliases,
		),
		"running",
	);
});

test("long extension status lines wrap to terminal width without ellipsis", () => {
	const lines = wrapExtensionStatusline(
		"🔎 PR #123: checks pending (12) changes requested 45 comments",
		30,
	);

	assert.ok(lines.length > 1);
	assert.ok(lines.every((line) => visibleWidth(line) <= 30));
	assert.equal(lines.join(" ").includes("…"), false);
	assert.match(lines.join(" "), /45 comments/);
});

test("statusline wraps complete segments without losing content", () => {
	const segments = ["model", "thinking", "context", "tokens"].map((text) => ({ text })) as never;
	const lines = wrapStatuslineSegments(segments, 16, (lineSegments) =>
		lineSegments.map((segment) => segment.text).join(" • "),
	);

	assert.deepEqual(lines, ["model • thinking", "context • tokens"]);
	assert.equal(lines.join(" • "), "model • thinking • context • tokens");
});

test("statusline truncates only a segment that cannot fit on its own", () => {
	const segments = [{ text: "segment-too-wide" }, { text: "ok" }] as never;
	const lines = wrapStatuslineSegments(segments, 8, (lineSegments) =>
		lineSegments.map((segment) => segment.text).join(" • "),
	);

	assert.equal(lines[0]?.startsWith("segment-"), true);
	assert.equal(visibleWidth(lines[0] ?? ""), 8);
	assert.equal(lines[1], "ok");
});

test("statusline merges extension status into the last main line when it fits", () => {
	assert.deepEqual(mergeStatuslineLines(["first", "main"], ["MCP: 1/1"], 20, " • "), [
		"first",
		"main • MCP: 1/1",
	]);
	assert.deepEqual(mergeStatuslineLines(["main"], ["MCP: 1/1"], 15, " • "), ["main • MCP: 1/1"]);
});

test("statusline moves extension status below when the complete line does not fit", () => {
	assert.deepEqual(mergeStatuslineLines(["main"], ["MCP: 1/1"], 14, " • "), ["main", "MCP: 1/1"]);
	assert.deepEqual(mergeStatuslineLines(["main"], ["first", "second"], 80, " • "), [
		"main",
		"first",
		"second",
	]);
});

test("statusline compact formatting helpers", () => {
	assert.equal(contextColor(undefined), "dim");
	assert.equal(contextColor(75), "warning");
	assert.equal(formatCount(1530), "1.5k");
	assert.equal(formatCount(1_200_000), "1.2m");
	assert.equal(shortenModel("claude-sonnet-20241022"), "sonnet");
	assert.equal(shortenModel("gpt-5.3-codex-latest"), "gpt 5.3-codex");
	assert.equal(npmPackageName("npm:@narumitw/pi-goal@0.4.1"), "@narumitw/pi-goal");
	assert.equal(npmPackageName("npm:typescript@latest"), "typescript");
});
