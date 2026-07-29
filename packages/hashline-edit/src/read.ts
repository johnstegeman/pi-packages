import { readFile, stat } from "node:fs/promises";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { notFoundError } from "./errors.js";
import { computeLineHashes } from "./hashline.js";
import { detectImageMimeType, resolvePathArg } from "./paths.js";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Number({ description: "Line number to start reading from (1-indexed)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

function formatHashlineRows(lines: string[], hashes: string[], startLine: number): string {
	const endLine = startLine + lines.length - 1;
	const width = String(endLine).length;
	return lines
		.map((line, i) => {
			const lineNumber = String(startLine + i).padStart(width, " ");
			return `${lineNumber}#${hashes[i]}:${line}`;
		})
		.join("\n");
}

export function createHashlineReadTool(): ToolDefinition<typeof readSchema, undefined> {
	return {
		name: "read",
		label: "read (hashline)",
		description:
			"Read a file's contents with hash-anchored line numbers (LINE#HASH:content). Use the anchors with edit to make precise, verified changes. Supports text files and images (jpg, png, gif, webp).",
		parameters: readSchema,
		async execute(_toolCallId, { path, offset, limit }, _signal, _onUpdate, ctx) {
			const absolutePath = resolvePathArg(path, ctx.cwd);
			let stats: Awaited<ReturnType<typeof stat>>;
			try {
				stats = await stat(absolutePath);
			} catch {
				throw notFoundError(path, "file does not exist");
			}
			if (stats.isDirectory()) {
				throw notFoundError(path, "path is a directory, not a file");
			}
			const buffer = await readFile(absolutePath);
			const mimeType = detectImageMimeType(buffer);
			if (mimeType) {
				const content: AgentToolResult<undefined>["content"] = [
					{ type: "text", text: `Read image file [${mimeType}]` },
					{ type: "image", data: buffer.toString("base64"), mimeType },
				];
				return { content, details: undefined };
			}
			const text = buffer.toString("utf-8");
			const allLines = text.split("\n");
			const allHashes = computeLineHashes(text);
			const startIndex = offset ? Math.max(0, offset - 1) : 0;
			if (startIndex >= allLines.length) {
				throw notFoundError(
					path,
					`offset ${offset} is beyond end of file (${allLines.length} lines total)`,
				);
			}
			const endIndex =
				limit !== undefined ? Math.min(startIndex + limit, allLines.length) : allLines.length;
			const shownLines = allLines.slice(startIndex, endIndex);
			const shownHashes = allHashes.slice(startIndex, endIndex);
			const outputText = formatHashlineRows(shownLines, shownHashes, startIndex + 1);
			return {
				content: [{ type: "text", text: outputText }],
				details: undefined,
			};
		},
	};
}
