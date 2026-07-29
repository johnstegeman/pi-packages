export type HashlineErrorCode =
	| "E_STALE_ANCHOR"
	| "E_BAD_REF"
	| "E_INVALID_PATCH"
	| "E_NOT_FOUND"
	| "E_NO_MATCH"
	| "E_MULTIPLE_MATCHES";

export class HashlineError extends Error {
	readonly code: HashlineErrorCode;
	constructor(code: HashlineErrorCode, message: string) {
		super(`[${code}] ${message}`);
		this.code = code;
		this.name = "HashlineError";
	}
}

export function staleAnchorError(anchor: string, reason: string): HashlineError {
	return new HashlineError(
		"E_STALE_ANCHOR",
		`Anchor ${anchor} is stale (${reason}). Call read again to get fresh anchors, then retry.`,
	);
}

export function badRefError(anchor: string, reason: string): HashlineError {
	return new HashlineError("E_BAD_REF", `Anchor "${anchor}" is invalid: ${reason}.`);
}

export function invalidPatchError(detail: string): HashlineError {
	return new HashlineError("E_INVALID_PATCH", `Replacement text is invalid: ${detail}.`);
}

export function notFoundError(path: string, reason: string): HashlineError {
	return new HashlineError("E_NOT_FOUND", `Could not access "${path}": ${reason}.`);
}

export function noMatchError(oldText: string): HashlineError {
	return new HashlineError(
		"E_NO_MATCH",
		`oldText ${JSON.stringify(oldText)} was not found in the file.`,
	);
}

export function multipleMatchesError(oldText: string, count: number): HashlineError {
	return new HashlineError(
		"E_MULTIPLE_MATCHES",
		`oldText ${JSON.stringify(oldText)} matched ${count} times; it must match exactly once.`,
	);
}
