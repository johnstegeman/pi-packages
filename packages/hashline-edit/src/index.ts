import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { createHashlineEditTool } from "./edit.js";
import { createHashlineGrepTool, isRipgrepAvailable } from "./grep.js";
import { createHashlineReadTool } from "./read.js";

export default async function (pi: ExtensionAPI) {
	const { config, warning } = loadConfig();

	pi.registerTool(createHashlineReadTool());
	pi.registerTool(createHashlineEditTool(() => config));

	if (config.grep && (await isRipgrepAvailable())) {
		pi.registerTool(createHashlineGrepTool());
	}

	if (warning) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(warning, "warning");
		});
	}
}
