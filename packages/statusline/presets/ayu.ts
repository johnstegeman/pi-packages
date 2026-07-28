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
		if (previous) line += ansiStyle("\ue0b4", { fg: previous.bg, bg: colors.bg });
		line += ansiStyle(formatAyuBlockText(block), colors);
	}

	const lastBlock = blocks.at(-1);
	if (lastBlock) line += ansiFg(getAyuBlockColors(lastBlock.name).bg, "\ue0b4");

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
