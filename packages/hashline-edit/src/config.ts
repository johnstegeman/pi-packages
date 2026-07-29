import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE_NAME = "hashline.json";

export interface HashlineConfig {
	grep: boolean;
	replaceText: boolean;
}

const DEFAULT_CONFIG: HashlineConfig = { grep: false, replaceText: true };

/**
 * Loads the hashline config from `<agentDir>/hashline.json`. When `agentDir`
 * is omitted, resolves it via `getAgentDir()`. Missing file yields defaults
 * with no warning; invalid JSON or wrong-typed fields yield defaults plus a
 * one-line warning; unrecognized extra keys are ignored silently.
 */
export function loadConfig(agentDir?: string): { config: HashlineConfig; warning?: string } {
	const dir = agentDir ?? getAgentDir();
	const filePath = join(dir, CONFIG_FILE_NAME);
	if (!existsSync(filePath)) {
		return { config: { ...DEFAULT_CONFIG } };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return {
			config: { ...DEFAULT_CONFIG },
			warning: `${CONFIG_FILE_NAME} is invalid JSON and was ignored; using defaults.`,
		};
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			config: { ...DEFAULT_CONFIG },
			warning: `${CONFIG_FILE_NAME} is invalid (expected an object) and was ignored; using defaults.`,
		};
	}
	const obj = raw as Record<string, unknown>;
	const grepValid = obj.grep === undefined || typeof obj.grep === "boolean";
	const replaceTextValid = obj.replaceText === undefined || typeof obj.replaceText === "boolean";
	if (!grepValid || !replaceTextValid) {
		return {
			config: { ...DEFAULT_CONFIG },
			warning: `${CONFIG_FILE_NAME} has invalid field types and was ignored; using defaults.`,
		};
	}
	return {
		config: {
			grep: typeof obj.grep === "boolean" ? obj.grep : DEFAULT_CONFIG.grep,
			replaceText:
				typeof obj.replaceText === "boolean" ? obj.replaceText : DEFAULT_CONFIG.replaceText,
		},
	};
}
