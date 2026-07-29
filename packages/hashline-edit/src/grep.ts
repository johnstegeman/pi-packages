import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computeLineHashes, formatAnchor } from "./hashline.js";
import { resolvePathArg } from "./paths.js";

const execFileAsync = promisify(execFile);

export async function isRipgrepAvailable(): Promise<boolean> {
	try {
		await execFileAsync("rg", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex by default)." }),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as a fixed string. Default: false." }),
	),
	path: Type.Optional(Type.String({ description: "Directory or file to search. Default: cwd." })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob, e.g. '*.ts'." })),
	context: Type.Optional(
		Type.Number({ description: "Lines of context before/after each match (0-5). Default: 0." }),
	),
	limit: Type.Optional(
		Type.Number({ description: "Max matches to return (default 50, max 200)." }),
	),
});

interface RgMatch {
	path: string;
	lineNumber: number;
}

async function runRipgrep(args: string[], cwd: string): Promise<RgMatch[]> {
	let stdout: string;
	try {
		const result = await execFileAsync("rg", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
		stdout = result.stdout;
	} catch (error) {
		const execError = error as { code?: number; stdout?: string };
		if (execError.code === 1) return []; // no matches
		throw error;
	}
	const matches: RgMatch[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event: { type: string; data?: { path?: { text?: string }; line_number?: number } };
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			event.type === "match" &&
			event.data?.path?.text &&
			typeof event.data.line_number === "number"
		) {
			matches.push({ path: event.data.path.text, lineNumber: event.data.line_number });
		}
	}
	return matches;
}

export function createHashlineGrepTool(): ToolDefinition<typeof grepSchema, undefined> {
	return {
		name: "grep",
		label: "grep (hashline)",
		description:
			"Search file contents with ripgrep, returning LINE#HASH:content anchors usable directly in edit. Respects .gitignore.",
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{ pattern, literal, path, glob, context, limit },
			_signal,
			_onUpdate,
			ctx,
		) {
			const searchPath = path ? resolvePathArg(path, ctx.cwd) : ctx.cwd;
			const effectiveLimit = Math.min(200, Math.max(1, limit ?? 50));
			const effectiveContext = Math.min(5, Math.max(0, context ?? 0));
			const args = ["--json", "--line-number", "--color=never", "--hidden"];
			if (literal) args.push("--fixed-strings");
			if (glob) args.push("--glob", glob);
			args.push("--", pattern, searchPath);

			const matches = await runRipgrep(args, ctx.cwd);
			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			}
			const limited = matches.slice(0, effectiveLimit);

			const fileCache = new Map<string, { lines: string[]; hashes: string[] }>();
			const rows: string[] = [];
			for (const match of limited) {
				let fileData = fileCache.get(match.path);
				if (!fileData) {
					const text = await readFile(match.path, "utf-8");
					fileData = { lines: text.split("\n"), hashes: computeLineHashes(text) };
					fileCache.set(match.path, fileData);
				}
				const displayPath = relative(searchPath, match.path) || match.path;
				const start = Math.max(1, match.lineNumber - effectiveContext);
				const end = Math.min(fileData.lines.length, match.lineNumber + effectiveContext);
				for (let lineNumber = start; lineNumber <= end; lineNumber++) {
					const idx = lineNumber - 1;
					const anchor = formatAnchor(lineNumber, fileData.hashes[idx]);
					rows.push(`${displayPath}:${anchor}:${fileData.lines[idx]}`);
				}
			}
			return { content: [{ type: "text", text: rows.join("\n") }], details: undefined };
		},
	};
}
