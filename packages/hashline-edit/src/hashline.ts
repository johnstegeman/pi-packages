const HASH_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HASH_LENGTH = 3;
const HASH_MASK = 0x3ffff; // 18 bits = 3 chars * 6 bits

function fnv1a32(bytes: Uint8Array): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		hash ^= bytes[i];
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function encodeHash(value: number): string {
	let v = value & HASH_MASK;
	let out = "";
	for (let i = 0; i < HASH_LENGTH; i++) {
		out = HASH_ALPHABET[v & 0x3f] + out;
		v >>>= 6;
	}
	return out;
}

function canonicalizeLine(line: string): string {
	return line.replace(/\r/g, "").replace(/\s+$/, "");
}

function hashForLine(prev: string, curr: string, next: string, retry: number): string {
	const base = `${prev}\n${curr}\n${next}`;
	const input = retry === 0 ? base : `${base}\u0000${retry}`;
	const bytes = new TextEncoder().encode(input);
	return encodeHash(fnv1a32(bytes));
}

/** Compute one 3-character content hash per line, fresh, with no caching. */
export function computeLineHashes(content: string): string[] {
	const rawLines = content.split("\n");
	const lines = rawLines.map(canonicalizeLine);
	const used = new Set<string>();
	const hashes: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const prev = i > 0 ? lines[i - 1] : "";
		const curr = lines[i];
		const next = i < lines.length - 1 ? lines[i + 1] : "";
		let retry = 0;
		let hash = hashForLine(prev, curr, next, retry);
		while (used.has(hash)) {
			retry++;
			hash = hashForLine(prev, curr, next, retry);
		}
		used.add(hash);
		hashes.push(hash);
	}
	return hashes;
}

/** Format a line number and hash as the wire-format anchor string, e.g. "9#Xy_". */
export function formatAnchor(line: number, hash: string): string {
	return `${line}#${hash}`;
}

const ANCHOR_PATTERN = /^([1-9][0-9]*)#([A-Za-z0-9_-]{3})$/;

/** Parse a "LINE#HASH" anchor string. Returns null if malformed. */
export function parseAnchor(anchor: string): { line: number; hash: string } | null {
	const match = ANCHOR_PATTERN.exec(anchor);
	if (!match) return null;
	return { line: Number(match[1]), hash: match[2] };
}
