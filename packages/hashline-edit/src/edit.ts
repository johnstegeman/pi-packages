import { randomUUID } from "node:crypto";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ToolDefinition, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HashlineConfig } from "./config.js";
import {
	badRefError,
	invalidPatchError,
	multipleMatchesError,
	noMatchError,
	notFoundError,
	staleAnchorError,
} from "./errors.js";
import { computeLineHashes, formatAnchor, parseAnchor } from "./hashline.js";
import { resolvePathArg } from "./paths.js";

const replaceOpSchema = Type.Object({
	pos: Type.String({ description: "Start anchor LINE#HASH." }),
	end: Type.Optional(
		Type.String({ description: "End anchor LINE#HASH (inclusive). Omit for a single line." }),
	),
	lines: Type.Array(Type.String(), {
		description: "Replacement lines. Empty array deletes the range.",
	}),
});
const appendOpSchema = Type.Object({
	pos: Type.Optional(
		Type.String({ description: "Anchor LINE#HASH to insert after. Omit to append at EOF." }),
	),
	lines: Type.Array(Type.String()),
});
const prependOpSchema = Type.Object({
	pos: Type.Optional(
		Type.String({ description: "Anchor LINE#HASH to insert before. Omit to prepend at BOF." }),
	),
	lines: Type.Array(Type.String()),
});
const replaceTextOpSchema = Type.Object({
	oldText: Type.String({ description: "Exact substring to replace. Must match exactly once." }),
	newText: Type.String(),
});

const editEntrySchema = Type.Object({
	replace: Type.Optional(replaceOpSchema),
	append: Type.Optional(appendOpSchema),
	prepend: Type.Optional(prependOpSchema),
	replace_text: Type.Optional(replaceTextOpSchema),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(editEntrySchema, {
		description: "One or more hash-anchored edits, applied atomically.",
	}),
});

type EditEntry = {
	replace?: { pos: string; end?: string; lines: string[] };
	append?: { pos?: string; lines: string[] };
	prepend?: { pos?: string; lines: string[] };
	replace_text?: { oldText: string; newText: string };
};

const HASHLINE_ANCHOR_PATTERN = /(?:^|\n)\s*\d+#[A-Za-z0-9_-]{3}:/;

function looksLikePastedAnchorOutput(text: string): boolean {
	return HASHLINE_ANCHOR_PATTERN.test(text);
}

function resolveAnchorToIndex(anchor: string, lines: string[], hashes: string[]): number {
	const parsed = parseAnchor(anchor);
	if (!parsed) throw badRefError(anchor, "does not parse as LINE#HASH");
	const index = parsed.line - 1;
	if (index < 0 || index >= lines.length) {
		throw staleAnchorError(
			anchor,
			`line ${parsed.line} is out of range (file has ${lines.length} lines)`,
		);
	}
	if (hashes[index] !== parsed.hash) {
		throw staleAnchorError(anchor, "content hash does not match the current file");
	}
	return index;
}

interface ResolvedOp {
	kind: "replace";
	startIndex: number;
	endIndex: number;
	lines: string[];
}

function resolveEntry(
	entry: EditEntry,
	lines: string[],
	hashes: string[],
	config: HashlineConfig,
): ResolvedOp {
	const opCount = [entry.replace, entry.append, entry.prepend, entry.replace_text].filter(
		(op) => op != null,
	).length;
	if (opCount > 1) {
		throw badRefError(
			"(entry)",
			"edit entry must specify exactly one of replace, append, prepend, replace_text; multiple were provided",
		);
	}
	if (entry.replace) {
		const startIndex = resolveAnchorToIndex(entry.replace.pos, lines, hashes);
		const endIndex = entry.replace.end
			? resolveAnchorToIndex(entry.replace.end, lines, hashes)
			: startIndex;
		if (endIndex < startIndex) {
			throw badRefError(
				entry.replace.end ?? entry.replace.pos,
				"end anchor resolves before pos anchor",
			);
		}
		return { kind: "replace", startIndex, endIndex, lines: entry.replace.lines };
	}
	if (entry.append) {
		const startIndex =
			entry.append.pos !== undefined
				? resolveAnchorToIndex(entry.append.pos, lines, hashes)
				: lines.length - 1;
		return {
			kind: "replace",
			startIndex: startIndex + 1,
			endIndex: startIndex,
			lines: entry.append.lines,
		};
	}
	if (entry.prepend) {
		const startIndex =
			entry.prepend.pos !== undefined ? resolveAnchorToIndex(entry.prepend.pos, lines, hashes) : 0;
		return { kind: "replace", startIndex, endIndex: startIndex - 1, lines: entry.prepend.lines };
	}
	if (entry.replace_text) {
		if (!config.replaceText) {
			throw invalidPatchError("replace_text is disabled by config (replaceText: false)");
		}
		const { oldText, newText } = entry.replace_text;
		if (looksLikePastedAnchorOutput(newText) || looksLikePastedAnchorOutput(oldText)) {
			throw invalidPatchError(
				"input looks like pasted LINE#HASH: tool output; send literal file content instead",
			);
		}
		const fullText = lines.join("\n");
		const firstIndex = fullText.indexOf(oldText);
		if (firstIndex === -1) throw noMatchError(oldText);
		const secondIndex = fullText.indexOf(oldText, firstIndex + oldText.length);
		if (secondIndex !== -1) {
			let count = 0;
			let cursor = 0;
			while (true) {
				const found = fullText.indexOf(oldText, cursor);
				if (found === -1) break;
				count++;
				cursor = found + oldText.length;
			}
			throw multipleMatchesError(oldText, count);
		}
		const before = fullText.slice(0, firstIndex);
		const after = fullText.slice(firstIndex + oldText.length);
		const newFullText = before + newText + after;
		const newLines = newFullText.split("\n");
		// Represent as a whole-file replace so the generic apply step below handles it uniformly.
		return { kind: "replace", startIndex: 0, endIndex: lines.length - 1, lines: newLines };
	}
	throw badRefError(
		"(missing)",
		"edit entry must specify exactly one of replace, append, prepend, replace_text",
	);
}

async function writeAtomic(absolutePath: string, content: string): Promise<void> {
	const realPath = await realpath(absolutePath).catch(() => absolutePath);
	const stats = await stat(realPath).catch(() => undefined);
	if (stats && stats.nlink > 1) {
		// Hard-linked: update in place to preserve the shared inode.
		await writeFile(realPath, content, "utf-8");
		return;
	}
	const dir = dirname(realPath);
	const tempPath = join(dir, `.hashline-edit-${randomUUID()}.tmp`);
	await writeFile(tempPath, content, "utf-8");
	if (stats) {
		await chmod(tempPath, stats.mode).catch(() => undefined);
	}
	try {
		await rename(tempPath, realPath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

export function createHashlineEditTool(
	getConfig: () => HashlineConfig,
): ToolDefinition<typeof editSchema, undefined> {
	return {
		name: "edit",
		label: "edit (hashline)",
		description:
			"Edit a file using hash-anchored line references (from a prior read/grep). Ops: replace, append, prepend, replace_text. All anchors are validated against the current file content before any write occurs. replace_text must be the only entry in edits[] when used; it cannot be combined with other ops in the same call.",
		parameters: editSchema,
		async execute(_toolCallId, { path, edits }, _signal, _onUpdate, ctx) {
			const absolutePath = resolvePathArg(path, ctx.cwd);
			return withFileMutationQueue(absolutePath, async () => {
				let buffer: Buffer;
				try {
					buffer = await readFile(absolutePath);
				} catch {
					throw notFoundError(path, "file does not exist or is not readable");
				}
				const originalText = buffer.toString("utf-8");
				const lines = originalText.split("\n");
				const hashes = computeLineHashes(originalText);
				const config = getConfig();

				// replace_text is modeled as a whole-file replace computed from the original content;
				// combining it with other ops in the same batch (or more than one replace_text) would
				// apply against stale line indices once the bottom-up loop starts mutating newLines.
				const entries = edits as EditEntry[];
				const replaceTextCount = entries.filter((entry) => entry.replace_text).length;
				if (replaceTextCount > 0 && entries.length > 1) {
					throw badRefError(
						"(batch)",
						"replace_text cannot be combined with other edits in the same call; send it alone",
					);
				}

				// Resolve and validate every entry against the same pre-edit snapshot before any write.
				const resolvedOps = entries.map((entry) => resolveEntry(entry, lines, hashes, config));

				// Apply bottom-up (highest startIndex first) so earlier edits are unaffected by later ones.
				const sortedOps = [...resolvedOps].sort((a, b) => b.startIndex - a.startIndex);
				const newLines = [...lines];
				for (const op of sortedOps) {
					const deleteCount = Math.max(0, op.endIndex - op.startIndex + 1);
					newLines.splice(op.startIndex, deleteCount, ...op.lines);
				}
				const newText = newLines.join("\n");

				await writeAtomic(absolutePath, newText);

				const addedLines = newLines.length - lines.length;
				const changeStart = Math.min(...resolvedOps.map((op) => op.startIndex));
				const changeEndInOld = Math.max(...resolvedOps.map((op) => op.endIndex));
				const shiftedEnd = changeEndInOld + addedLines;
				const finalHashes = computeLineHashes(newText);
				const regionStart = Math.max(0, changeStart);
				const regionEnd = Math.min(newLines.length - 1, Math.max(shiftedEnd, changeStart));
				const anchorLines = newLines.slice(regionStart, regionEnd + 1);
				const anchorHashes = finalHashes.slice(regionStart, regionEnd + 1);
				const anchorText = anchorLines
					.map((line, i) => `${formatAnchor(regionStart + i + 1, anchorHashes[i])}:${line}`)
					.join("\n");

				const summary = `Successfully applied ${edits.length} edit(s) to ${path}. Lines: ${lines.length} -> ${newLines.length}.`;
				return {
					content: [
						{
							type: "text",
							text: `${summary}\n\n--- Anchors ${regionStart + 1}-${regionEnd + 1} ---\n${anchorText}`,
						},
					],
					details: undefined,
				};
			});
		},
	};
}
