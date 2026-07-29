import os from "node:os";
import path from "node:path";

/** Resolve a CLI/tool path argument against cwd, expanding a leading ~. */
export function resolvePathArg(rawPath: string, cwd: string): string {
	if (rawPath === "~" || rawPath.startsWith("~/")) {
		const rest = rawPath.slice(1).replace(/^\/+/, "");
		return path.resolve(os.homedir(), rest);
	}
	if (path.isAbsolute(rawPath)) {
		return path.resolve(rawPath);
	}
	return path.resolve(cwd, rawPath);
}

export type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Sniff magic bytes for jpg/png/gif/webp. Returns null for anything else or too-short input. */
export function detectImageMimeType(buffer: Buffer): SupportedImageMimeType | null {
	if (
		buffer.length >= 8 &&
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47 &&
		buffer[4] === 0x0d &&
		buffer[5] === 0x0a &&
		buffer[6] === 0x1a &&
		buffer[7] === 0x0a
	) {
		return "image/png";
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return "image/jpeg";
	}
	if (buffer.length >= 6) {
		const header6 = buffer.subarray(0, 6).toString("ascii");
		if (header6 === "GIF87a" || header6 === "GIF89a") {
			return "image/gif";
		}
	}
	if (
		buffer.length >= 12 &&
		buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
		buffer.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return null;
}
