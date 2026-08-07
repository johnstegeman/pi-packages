import { randomUUID } from "node:crypto";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ToolDefinition, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HashlineConfig } from "./config.js";
import {
	badRefError,
	editConflictError,
	invalidArgumentError,
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

/**
 * Escapes literal control characters (newline, carriage return, tab) that appear
 * inside double-quoted JSON string values. Some LLMs emit raw newlines within
 * string values when stringifying the `edits` parameter, which makes JSON.parse
 * fail with "Bad control character in string literal". This scanner only touches
 * characters inside quotes, leaving inter-token whitespace (including newlines
 * between array elements) intact.
 */
function escapeControlCharsInStrings(text: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				result += ch;
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				result += ch;
				escaped = true;
				continue;
			}
			if (ch === '"') {
				result += ch;
				inString = false;
				continue;
			}
			if (ch === "\n") {
				result += "\\n";
				continue;
			}
			if (ch === "\r") {
				result += "\\r";
				continue;
			}
			if (ch === "\t") {
				result += "\\t";
				continue;
			}
			result += ch;
		} else {
			if (ch === '"') {
				inString = true;
			}
			result += ch;
		}
	}
	return result;
}

/**
 * Parses a stringified `edits` value back into an array of EditEntry objects.
 * Tries strict JSON.parse first, then retries after escaping literal control
 * characters (raw newlines, tabs, carriage returns) that some models emit inside
 * string values. Throws a clear E_INVALID_ARGUMENT error if parsing fails so the
 * agent gets actionable feedback instead of a generic validation failure.
 */
function parseStringEdits(editsString: string): EditEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(editsString);
	} catch {
		try {
			// Retry after escaping literal control characters inside string values,
			// which some models emit as raw newlines in multi-line array elements.
			const sanitized = escapeControlCharsInStrings(editsString);
			parsed = JSON.parse(sanitized);
		} catch (e) {
			throw invalidArgumentError(
				`edits was passed as a JSON string but could not be parsed. Pass edits as an array of objects directly — do not stringify it. (Parse error: ${e instanceof Error ? e.message : String(e)})`,
			);
		}
	}
	if (!Array.isArray(parsed)) {
		throw invalidArgumentError(
			`edits was passed as a JSON string that parsed to ${typeof parsed}, not an array. Pass edits as an array of objects directly.`,
		);
	}
	return parsed as EditEntry[];
}

/**
 * Normalizes a single edit entry to repair common structural mistakes that some
 * models make before schema validation runs. The key deformations handled:
 *
 * 1. **Op as bare array**: The model sends `append`/`prepend`/`replace` as an
 *    array of lines instead of an object, e.g.
 *    `{ pos: "3#Abc", append: ["line1", "line2"] }` instead of
 *    `{ append: { pos: "3#Abc", lines: ["line1", "line2"] } }`.
 *
 * 2. **Anchor keys promoted to entry level**: The model puts `pos`/`anchor`/`end`
 *    at the entry root instead of inside the op object, e.g.
 *    `{ pos: "3#Abc", append: { lines: [...] } }` instead of
 *    `{ append: { pos: "3#Abc", lines: [...] } }`.
 *
 * Both deformations can occur simultaneously. This function is idempotent:
 * already-well-formed entries are returned unchanged.
 */
function normalizeEditEntry(entry: Record<string, unknown>): Record<string, unknown> {
	const entryPos = typeof entry.pos === "string" ? entry.pos : undefined;
	const entryAnchor = typeof entry.anchor === "string" ? entry.anchor : undefined;
	const entryEnd = typeof entry.end === "string" ? entry.end : undefined;
	const resolvedPos = entryPos ?? entryAnchor;

	// If no anchor keys were promoted and no ops are bare arrays, nothing to do.
	const hasPromotedAnchors = resolvedPos !== undefined || entryEnd !== undefined;
	const hasFlatOp = ["replace", "append", "prepend"].some((k) => Array.isArray(entry[k]));
	if (!hasPromotedAnchors && !hasFlatOp) return entry;

	const result: Record<string, unknown> = {};
	for (const key of Object.keys(entry)) {
		if (key === "pos" || key === "anchor" || key === "end") continue;
		result[key] = entry[key];
	}

	for (const opKey of ["replace", "append", "prepend"] as const) {
		const op = result[opKey];
		if (op == null) continue;

		if (Array.isArray(op)) {
			// Case 1: op is a bare array of lines — wrap it into an object.
			const normalized: Record<string, unknown> = { lines: op };
			if (resolvedPos !== undefined) normalized.pos = resolvedPos;
			if (opKey === "replace" && entryEnd !== undefined) normalized.end = entryEnd;
			result[opKey] = normalized;
		} else if (typeof op === "object" && op !== null) {
			// Case 2: op is already an object — inject missing anchor keys from the entry level.
			const opObj = op as Record<string, unknown>;
			if (opObj.pos == null && resolvedPos !== undefined) opObj.pos = resolvedPos;
			if (opKey === "replace" && opObj.end == null && entryEnd !== undefined) {
				opObj.end = entryEnd;
			}
		}
	}

	return result;
}

/**
 * Compatibility shim invoked by the framework before schema validation. Some
 * models (e.g. Opus 4.6, GLM-5.1) pass `edits` as a JSON string instead of an
 * array. This function detects that case and parses the string back into an
 * array so validation passes. If the string cannot be parsed, a clear error is
 * thrown so the agent gets actionable feedback instead of a generic
 * "edits.0: must be object" validation failure.
 *
 * Additionally, individual edit entries are normalized to repair flattened
 * structures (e.g. `append` sent as a bare array with `pos` at the entry level).
 */
function prepareEditArguments(args: unknown): { path: string; edits: EditEntry[] } {
	if (!args || typeof args !== "object") {
		return args as { path: string; edits: EditEntry[] };
	}
	const obj = args as Record<string, unknown>;
	if (typeof obj.edits !== "string") {
		if (Array.isArray(obj.edits)) {
			obj.edits = (obj.edits as unknown[]).map((entry) =>
				entry && typeof entry === "object"
					? normalizeEditEntry(entry as Record<string, unknown>)
					: entry,
			);
		}
		return args as { path: string; edits: EditEntry[] };
	}
	const parsed = parseStringEdits(obj.edits);
	const normalized = parsed.map((entry) =>
		entry && typeof entry === "object"
			? normalizeEditEntry(entry as Record<string, unknown>)
			: entry,
	);
	return { ...obj, edits: normalized } as { path: string; edits: EditEntry[] };
}

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

function isInsertion(op: ResolvedOp): boolean {
	return op.endIndex < op.startIndex;
}

function validateResolvedOps(resolvedOps: ResolvedOp[]): void {
	for (let i = 0; i < resolvedOps.length; i++) {
		const first = resolvedOps[i];
		const firstIsInsertion = isInsertion(first);
		for (let j = i + 1; j < resolvedOps.length; j++) {
			const second = resolvedOps[j];
			const secondIsInsertion = isInsertion(second);
			let conflicts: boolean;

			if (firstIsInsertion && secondIsInsertion) {
				conflicts = first.startIndex === second.startIndex;
			} else if (firstIsInsertion || secondIsInsertion) {
				const insertion = firstIsInsertion ? first : second;
				const replacement = firstIsInsertion ? second : first;
				conflicts =
					insertion.startIndex >= replacement.startIndex &&
					insertion.startIndex <= replacement.endIndex;
			} else {
				conflicts = first.startIndex <= second.endIndex && second.startIndex <= first.endIndex;
			}

			if (conflicts) {
				const describe = (op: ResolvedOp, index: number): string =>
					isInsertion(op)
						? `edit ${index + 1} insertion point ${op.startIndex}`
						: `edit ${index + 1} replacement lines ${op.startIndex + 1}-${op.endIndex + 1}`;
				throw editConflictError(`${describe(first, i)} overlaps ${describe(second, j)}`);
			}
		}
	}
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

		let matchCount = 0;
		let searchIndex = 0;
		while (true) {
			const foundIndex = fullText.indexOf(oldText, searchIndex);
			if (foundIndex === -1) break;
			matchCount++;
			searchIndex = foundIndex + 1;
		}
		if (matchCount !== 1) throw multipleMatchesError(oldText, matchCount);

		const matchEnd = firstIndex + oldText.length;
		const lineStart = fullText.lastIndexOf("\n", firstIndex - 1) + 1;
		const afterMatch = fullText.slice(matchEnd);
		const nextNewline = afterMatch.indexOf("\n");
		const suffix = nextNewline === -1 ? afterMatch : afterMatch.slice(0, nextNewline);
		const prefix = fullText.slice(lineStart, firstIndex);
		const replacementLines = (prefix + newText + suffix).split("\n");
		const startIndex = fullText.slice(0, firstIndex).split("\n").length - 1;
		const endIndex = fullText.slice(0, matchEnd).split("\n").length - 1;
		return { kind: "replace", startIndex, endIndex, lines: replacementLines };
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
			"Edit a file using hash-anchored line references (from a prior read/grep). Ops: replace, append, prepend, replace_text. All anchors and replacement ranges are resolved against the original file content before any write occurs.",
		promptGuidelines: [
			"Pass the edits parameter as an array of objects, not as a JSON string. Do not stringify or escape the array.",
			'Example: edits=[{"replace":{"pos":"2#TmR","lines":["  console.log(\'hi\');"]}}]',
		],
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, { path, edits: rawEdits }, _signal, _onUpdate, ctx) {
			// Defensive fallback: if edits arrived as a string (e.g. a direct call
			// that bypassed prepareArguments), coerce it now.
			let edits = typeof rawEdits === "string" ? parseStringEdits(rawEdits) : rawEdits;
			// Defensive fallback: normalize flattened entries even if prepareArguments was bypassed.
			edits = edits.map((entry) =>
				entry && typeof entry === "object"
					? (normalizeEditEntry(entry as Record<string, unknown>) as EditEntry)
					: entry,
			);
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

				const entries = edits as EditEntry[];

				// Resolve every entry against the same pre-edit snapshot, then validate all ranges
				// before applying any operation or writing the file.
				const resolvedOps = entries.map((entry) => resolveEntry(entry, lines, hashes, config));
				validateResolvedOps(resolvedOps);

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
